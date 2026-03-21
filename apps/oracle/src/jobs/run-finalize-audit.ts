import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { ethers } from "ethers";
import { MerkleTree } from "merkletreejs";
import keccak256 from "keccak256";
import { getWeeks, updateWeekStatus, countCompletedLifecycleIntents } from "../store.js";
import { resolveDataDir } from "../paths.js";
import {
  getRequiredRuntimeValcoreAddress,
  getRuntimeChainIdBigInt,
  getConfiguredRuntimeChainIdBigInt,
  getRuntimeChainConfig,
  isValcoreChainEnabled,
} from "../network/chain-runtime.js";
import {
  getOnchainWeekState,
  sendApproveFinalizationOnchain,
} from "../network/valcore-chain-client.js";
import {
  ensureLifecycleIntent,
  markLifecycleIntentCompleted,
  markLifecycleIntentFailed,
  markLifecycleIntentSubmitted,
} from "./lifecycle-intent.js";
import { assertWeekChainSync } from "./week-sync-guard.js";

type ClaimRow = {
  address: string;
  principal: string;
  riskPayout: string;
  totalWithdraw: string;
};

type FinalizeMetadata = {
  root?: string;
  metadataHash?: string;
  retainedFeeWei?: string;
};

const encodeClaimAddressForLeaf = (address: string, chainType: string) => {
  const raw = String(address ?? "").trim();
  if (chainType === "starknet") {
    if (!/^0x[0-9a-fA-F]{1,64}$/u.test(raw)) {
      throw new Error("Invalid Starknet address for finalize leaf: " + String(address ?? ""));
    }
    return ethers.toBeHex(BigInt(raw), 32);
  }
  return ethers.getAddress(raw);
};

const buildFinalizeLeaf = (
  chainType: string,
  contractAddress: string,
  chainId: bigint,
  weekId: bigint,
  address: string,
  principal: bigint,
  riskPayout: bigint,
  totalWithdraw: bigint,
) => {
  if (chainType === "starknet") {
    return ethers.solidityPackedKeccak256(
      ["bytes32", "uint256", "uint256", "bytes32", "uint256", "uint256", "uint256"],
      [
        encodeClaimAddressForLeaf(contractAddress, "starknet"),
        chainId,
        weekId,
        encodeClaimAddressForLeaf(address, "starknet"),
        principal,
        riskPayout,
        totalWithdraw,
      ],
    );
  }

  return ethers.solidityPackedKeccak256(
    ["address", "uint256", "uint256", "address", "uint256", "uint256", "uint256"],
    [
      encodeClaimAddressForLeaf(contractAddress, "evm"),
      chainId,
      weekId,
      encodeClaimAddressForLeaf(address, "evm"),
      principal,
      riskPayout,
      totalWithdraw,
    ],
  );
};

const parseJsonFile = <T>(path: string): T => {
  if (!existsSync(path)) {
    throw new Error(`Missing finalize artifact: ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as T;
};

const normalizeHashForChain = (value: string, chainType: string) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]+$/u.test(normalized)) {
    throw new Error("Invalid hash for finalize audit payload: " + String(value ?? ""));
  }
  if (chainType !== "starknet") {
    return normalized;
  }
  const starknetFieldPrime = BigInt("0x800000000000011000000000000000000000000000000000000000000000001");
  return ethers.toBeHex(BigInt(normalized) % starknetFieldPrime, 32).toLowerCase();
};

const run = async () => {
  const weeks = await getWeeks();
  const week = weeks[0];
  if (!week) throw new Error("No week found");
  if (String(week.status ?? "").toUpperCase() !== "FINALIZE_PENDING") {
    throw new Error(`Audit requires FINALIZE_PENDING week; got ${String(week.status ?? "UNKNOWN")}`);
  }

  const weekId = BigInt(week.id);
  const chainEnabled = isValcoreChainEnabled();
  const contractAddress = await getRequiredRuntimeValcoreAddress();
  const chainId = chainEnabled
    ? await getRuntimeChainIdBigInt()
    : await getConfiguredRuntimeChainIdBigInt();

  if (chainEnabled) {
    await assertWeekChainSync({
      context: "run-finalize-audit",
      leagueAddress: contractAddress,
      weekId: week.id,
      dbStatus: String(week.status ?? ""),
      expectedOnchainStatus: 4,
    });
  }

  const chainType = (await getRuntimeChainConfig()).chainType;

  const outDir = resolveDataDir();
  const claimsPath = resolve(outDir, `claims-${week.id}.json`);
  const metadataPath = resolve(outDir, `metadata-${week.id}.json`);
  const claims = parseJsonFile<ClaimRow[]>(claimsPath);
  const metadata = parseJsonFile<FinalizeMetadata>(metadataPath);

  if (!Array.isArray(claims) || claims.length === 0) {
    throw new Error("Finalize audit failed: claims artifact is empty");
  }

  const leaves = claims.map((entry) =>
    buildFinalizeLeaf(
      chainType,
      contractAddress,
      chainId,
      weekId,
      entry.address,
      BigInt(entry.principal),
      BigInt(entry.riskPayout),
      BigInt(entry.totalWithdraw),
    ),
  );

  const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const computedRootRaw = tree.getHexRoot();
  const computedRoot = normalizeHashForChain(computedRootRaw, chainType);

  const metadataJson = JSON.stringify(metadata, null, 2);
  const computedMetadataHashRaw = ethers.keccak256(ethers.toUtf8Bytes(metadataJson));
  const computedMetadataHash = normalizeHashForChain(computedMetadataHashRaw, chainType);
  const metadataRoot = normalizeHashForChain(String(metadata.root ?? "0x0"), chainType);

  if (!metadataRoot || metadataRoot !== computedRoot.toLowerCase()) {
    throw new Error("Finalize audit failed: metadata root does not match computed root");
  }

  const finalizeRound = Math.max(
    0,
    (await countCompletedLifecycleIntents(String(week.id), "finalize")) - 1,
  );
  const opKey = `week:${week.id}:finalize-approve:r${finalizeRound}`;
  let intent = await ensureLifecycleIntent({
    opKey,
    weekId: String(week.id),
    operation: "finalize-approve",
    details: {
      round: finalizeRound,
      computedRoot,
      computedMetadataHash,
      status: "FINALIZED",
    },
  });
  if (String(intent.status ?? "").toLowerCase() === "completed") {
    console.log(`finalize-audit skipped: lifecycle intent already completed for week ${week.id}`);
    return;
  }

  const expectedRetainedFee = BigInt(metadata.retainedFeeWei ?? "0");
  let txHash: string | null = intent.tx_hash ? String(intent.tx_hash).toLowerCase() : null;

  try {
    if (chainEnabled) {
      const state = await getOnchainWeekState(contractAddress, weekId);
      const onchainStatus = Number(state.status ?? 0);
      const onchainRetainedFee = BigInt(state.retainedFee ?? 0n);
      const onchainRoot = normalizeHashForChain(String(state.merkleRoot ?? "0x0"), chainType);
      const onchainMetadataHash = normalizeHashForChain(String(state.metadataHash ?? "0x0"), chainType);

      if (onchainStatus !== 4) {
        throw new Error(`Finalize audit failed: onchain status is ${onchainStatus}, expected 4 (FINALIZE_PENDING)`);
      }
      if (onchainRoot !== computedRoot.toLowerCase()) {
        throw new Error("Finalize audit failed: onchain merkle root mismatch");
      }
      if (onchainMetadataHash !== computedMetadataHash.toLowerCase()) {
        throw new Error("Finalize audit failed: onchain metadata hash mismatch");
      }
      if (onchainRetainedFee !== expectedRetainedFee) {
        throw new Error("Finalize audit failed: retained fee mismatch");
      }

      if (!txHash) {
        txHash = await sendApproveFinalizationOnchain(contractAddress, weekId);
        intent =
          (await markLifecycleIntentSubmitted(intent, txHash, {
            txHash,
            computedRoot,
            computedMetadataHash,
            retainedFeeWei: expectedRetainedFee.toString(),
            chainExecuted: true,
          })) ?? intent;
      }
    }

    await updateWeekStatus(week.id, "FINALIZED");

    await markLifecycleIntentCompleted(intent, {
      txHash,
      computedRoot,
      computedMetadataHash,
      retainedFeeWei: expectedRetainedFee.toString(),
      status: "FINALIZED",
      chainExecuted: chainEnabled && Boolean(txHash),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markLifecycleIntentFailed(intent, message, {
      txHash,
      computedRoot,
      computedMetadataHash,
      retainedFeeWei: expectedRetainedFee.toString(),
      status: "FINALIZED",
      chainExecuted: chainEnabled && Boolean(txHash),
    });
    throw error;
  }
};

run().catch((error) => {
  console.error("finalize-audit job failed", error);
  process.exit(1);
});
