import { Contract, keccak256, parseUnits, toUtf8Bytes } from "ethers";
import { createProfileWallet, getRequiredAddresses, loadActiveProfile } from "./_runtime";

const oracleUrl = process.env.ORACLE_URL || "http://localhost:3101";

const buildLineupHash = (weekId: string, address: string, slots: { slotId: string; coinId: string }[]) => {
  const payload = {
    weekId,
    address: address.toLowerCase(),
    slots,
  };
  return keccak256(toUtf8Bytes(JSON.stringify(payload)));
};

const slotOrder = [
  "GK-1",
  "DEF-1",
  "DEF-2",
  "DEF-3",
  "DEF-4",
  "MID-1",
  "MID-2",
  "MID-3",
  "MID-4",
  "FWD-1",
  "FWD-2",
];

async function main() {
  const profile = await loadActiveProfile();
  const userWallet = await createProfileWallet(profile, "user");
  const oracleWallet = await createProfileWallet(profile, "oracle");
  const { stablecoinAddress, valcoreAddress } = getRequiredAddresses(profile);
  const stablecoin = new Contract(stablecoinAddress, ["function approve(address,uint256)"], userWallet);
  const leagueRead = new Contract(
    valcoreAddress,
    ["function weekStates(uint256) view returns (uint64,uint64,uint64,uint64,uint8,uint128,uint128,bytes32,bytes32)"],
    userWallet,
  );
  const leagueOracle = new Contract(
    valcoreAddress,
    ["function createWeek(uint256,uint64,uint64,uint64)"],
    oracleWallet,
  );
  const leagueUser = new Contract(
    valcoreAddress,
    ["function commitLineup(uint256,bytes32,uint256)"],
    userWallet,
  );

  const weekRes = await fetch(`${oracleUrl}/weeks/current`);
  if (!weekRes.ok) throw new Error("week fetch failed");
  const week = await weekRes.json();

  const chainWeek = await leagueRead.weekStates(BigInt(week.id));
  const chainStatus = Number(chainWeek[4] ?? 0);
  if (chainStatus === 0) {
    const startAt = Math.floor(new Date(week.startAtUtc).getTime() / 1000);
    const lockAt = Math.floor(new Date(week.lockAtUtc).getTime() / 1000);
    const endAt = Math.floor(new Date(week.endAtUtc).getTime() / 1000);
    const tx = await leagueOracle.createWeek(BigInt(week.id), startAt, lockAt, endAt);
    await tx.wait();
  }

  const coinsRes = await fetch(`${oracleUrl}/weeks/${week.id}/coins`);
  if (!coinsRes.ok) throw new Error("coins fetch failed");
  const coins = await coinsRes.json();

  const byPos = new Map<string, any[]>();
  for (const row of coins) {
    const list = byPos.get(row.position) || [];
    list.push(row);
    byPos.set(row.position, list);
  }

  const pick = (position: string, count: number) => (byPos.get(position) || []).slice(0, count);

  const picks = [
    ...pick("GK", 1),
    ...pick("DEF", 4),
    ...pick("MID", 4),
    ...pick("FWD", 2),
  ];

  if (picks.length !== slotOrder.length) {
    throw new Error(`slot pick mismatch: ${picks.length}`);
  }

  const slots = picks.map((row, idx) => ({
    slotId: slotOrder[idx],
    coinId: row.coinId,
  }));

  const lineupHash = buildLineupHash(week.id, userWallet.address, slots);
  const deposit = parseUnits(process.env.MOCK_DEPOSIT || "1000", profile.stablecoinDecimals);

  const approveTx = await stablecoin.approve(valcoreAddress, deposit);
  await approveTx.wait();

  const commitTx = await leagueUser.commitLineup(BigInt(week.id), lineupHash, deposit);
  await commitTx.wait();

  const response = await fetch(`${oracleUrl}/lineups`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      weekId: week.id,
      address: userWallet.address,
      lineupHash,
      depositWei: deposit.toString(),
      principalWei: ((deposit * BigInt(process.env.PRINCIPAL_RATIO_BPS || "8000")) / 10000n).toString(),
      riskWei: (deposit - (deposit * BigInt(process.env.PRINCIPAL_RATIO_BPS || "8000")) / 10000n).toString(),
      swaps: 0,
      slots,
    }),
  });
  if (!response.ok && response.status !== 410) {
    throw new Error(`lineup sync failed: ${response.status}`);
  }

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
