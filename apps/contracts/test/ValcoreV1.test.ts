import { expect } from "chai";
import { ethers } from "hardhat";
import { ValcoreV1, StablecoinMock } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("ValcoreV1", function () {
  let league: ValcoreV1;
  let stablecoin: StablecoinMock;
  let admin: SignerWithAddress;
  let oracle: SignerWithAddress;
  let pauser: SignerWithAddress;
  let auditor: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  const PRINCIPAL_RATIO = 9000;
  const PROTOCOL_FEE = 500;
  const MIN_DEPOSIT = ethers.parseEther("50");

  const claimLeaf = async (
    weekId: number,
    userAddress: string,
    principal: bigint,
    riskPayout: bigint,
    totalWithdraw: bigint,
  ) => {
    const { chainId } = await ethers.provider.getNetwork();
    return ethers.keccak256(
      ethers.solidityPacked(
        ["address", "uint256", "uint256", "address", "uint256", "uint256", "uint256"],
        [await league.getAddress(), chainId, weekId, userAddress, principal, riskPayout, totalWithdraw],
      ),
    );
  };

  beforeEach(async function () {
    [admin, oracle, pauser, auditor, user1, user2] = await ethers.getSigners();

    const StablecoinMockFactory = await ethers.getContractFactory("StablecoinMock");
    stablecoin = await StablecoinMockFactory.deploy(admin.address, "Mock Tether", "USDT");

    const ValcoreFactory = await ethers.getContractFactory("ValcoreV1");
    league = await ValcoreFactory.deploy(
      await stablecoin.getAddress(),
      PRINCIPAL_RATIO,
      PROTOCOL_FEE,
      MIN_DEPOSIT,
      admin.address,
      admin.address,
      pauser.address,
      auditor.address,
    );

    await stablecoin.mint(user1.address, ethers.parseEther("10000"));
    await stablecoin.mint(user2.address, ethers.parseEther("10000"));

    await stablecoin.connect(user1).approve(await league.getAddress(), ethers.MaxUint256);
    await stablecoin.connect(user2).approve(await league.getAddress(), ethers.MaxUint256);

    const ORACLE_ROLE = await league.ORACLE_ROLE();
    await league.connect(admin).grantRole(ORACLE_ROLE, oracle.address);
  });

  describe("Deployment", function () {
    it("sets configured roles", async function () {
      const DEFAULT_ADMIN_ROLE = await league.DEFAULT_ADMIN_ROLE();
      const ORACLE_ROLE = await league.ORACLE_ROLE();
      const PAUSER_ROLE = await league.PAUSER_ROLE();
      const AUDITOR_ROLE = await league.AUDITOR_ROLE();

      expect(await league.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
      expect(await league.hasRole(ORACLE_ROLE, oracle.address)).to.equal(true);
      expect(await league.hasRole(PAUSER_ROLE, pauser.address)).to.equal(true);
      expect(await league.hasRole(AUDITOR_ROLE, auditor.address)).to.equal(true);
    });

    it("sets immutable values", async function () {
      expect(await league.stablecoin()).to.equal(await stablecoin.getAddress());
      expect(await league.principalRatioBps()).to.equal(PRINCIPAL_RATIO);
      expect(await league.feeBps()).to.equal(PROTOCOL_FEE);
      expect(await league.minDeposit()).to.equal(MIN_DEPOSIT);
    });
  });

  describe("Week lifecycle", function () {
    it("moves ACTIVE -> FINALIZE_PENDING -> FINALIZED", async function () {
      const now = await time.latest();
      const weekId = 1;
      const lockAt = now + 3600;
      const startAt = lockAt + 3600;
      const endAt = startAt + 3600;

      await league.connect(oracle).createWeek(weekId, startAt, lockAt, endAt);
      await league
        .connect(user1)
        .commitLineup(weekId, ethers.keccak256(ethers.toUtf8Bytes("lineup-week1")), ethers.parseEther("100"));
      await time.increaseTo(lockAt);
      await league.connect(oracle).lockWeek(weekId);
      await time.increaseTo(startAt);
      await league.connect(oracle).startWeek(weekId);
      await time.increaseTo(endAt);

      const root = ethers.keccak256(ethers.toUtf8Bytes("root"));
      const meta = ethers.keccak256(ethers.toUtf8Bytes("meta"));
      await expect(league.connect(oracle).finalizeWeek(weekId, root, meta, 0))
        .to.emit(league, "WeekFinalizePending")
        .withArgs(weekId, root, meta, 0);

      const pendingWeek = await league.weekStates(weekId);
      expect(pendingWeek.status).to.equal(4);
      expect(Number(pendingWeek.finalizedAt)).to.be.greaterThan(0);

      await expect(league.connect(auditor).approveFinalization(weekId))
        .to.emit(league, "WeekFinalized")
        .withArgs(weekId, root, meta);

      const finalizedWeek = await league.weekStates(weekId);
      expect(finalizedWeek.status).to.equal(5);
    });

    it("allows auditor to reject and return week to ACTIVE", async function () {
      const now = await time.latest();
      const weekId = 2;
      const lockAt = now + 3600;
      const startAt = lockAt + 3600;
      const endAt = startAt + 3600;

      await league.connect(oracle).createWeek(weekId, startAt, lockAt, endAt);
      await league
        .connect(user1)
        .commitLineup(weekId, ethers.keccak256(ethers.toUtf8Bytes("lineup-week2")), ethers.parseEther("100"));
      await time.increaseTo(lockAt);
      await league.connect(oracle).lockWeek(weekId);
      await time.increaseTo(startAt);
      await league.connect(oracle).startWeek(weekId);
      await time.increaseTo(endAt);

      const root = ethers.keccak256(ethers.toUtf8Bytes("root-2"));
      const meta = ethers.keccak256(ethers.toUtf8Bytes("meta-2"));
      await league.connect(oracle).finalizeWeek(weekId, root, meta, 0);

      await expect(league.connect(auditor).rejectFinalization(weekId))
        .to.emit(league, "WeekFinalizationRejected")
        .withArgs(weekId);

      const week = await league.weekStates(weekId);
      expect(week.status).to.equal(3);
      expect(week.finalizedAt).to.equal(0);
      expect(week.merkleRoot).to.equal(ethers.ZeroHash);
      expect(week.metadataHash).to.equal(ethers.ZeroHash);
    });

    it("rejects lock when no strategy is committed", async function () {
      const now = await time.latest();
      const weekId = 3;
      const lockAt = now + 3600;
      const startAt = lockAt + 3600;
      const endAt = startAt + 3600;

      await league.connect(oracle).createWeek(weekId, startAt, lockAt, endAt);
      await time.increaseTo(lockAt);

      await expect(league.connect(oracle).lockWeek(weekId)).to.be.revertedWithCustomError(league, "NoCommittedStrategies");
      await expect(league.connect(oracle).forceLockWeek(weekId)).to.be.revertedWithCustomError(league, "NoCommittedStrategies");
    });

  });

  describe("Claims", function () {
    it("allows claim only after auditor approval", async function () {
      const now = await time.latest();
      const weekId = 10;
      const lockAt = now + 3600;
      const startAt = lockAt + 3600;
      const endAt = startAt + 3600;

      const depositAmount = ethers.parseEther("100");
      await league.connect(oracle).createWeek(weekId, startAt, lockAt, endAt);
      await league
        .connect(user1)
        .commitLineup(weekId, ethers.keccak256(ethers.toUtf8Bytes("lineup-user1")), depositAmount);
      await league
        .connect(user2)
        .commitLineup(weekId, ethers.keccak256(ethers.toUtf8Bytes("lineup-user2")), depositAmount);

      await time.increaseTo(lockAt);
      await league.connect(oracle).lockWeek(weekId);
      await time.increaseTo(startAt);
      await league.connect(oracle).startWeek(weekId);

      const principal = (depositAmount * BigInt(PRINCIPAL_RATIO)) / 10000n;
      const risk = depositAmount - principal;
      const riskPayout = risk / 2n;
      const totalWithdraw = principal + riskPayout;
      const leaf = await claimLeaf(weekId, user1.address, principal, riskPayout, totalWithdraw);

      await time.increaseTo(endAt);
      await league.connect(oracle).finalizeWeek(weekId, leaf, ethers.keccak256(ethers.toUtf8Bytes("meta")), 0);

      await expect(
        league.connect(user1).claim(weekId, principal, riskPayout, totalWithdraw, []),
      ).to.be.revertedWithCustomError(league, "WeekNotFinalized");

      await league.connect(auditor).approveFinalization(weekId);

      const balanceBefore = await stablecoin.balanceOf(user1.address);
      await league.connect(user1).claim(weekId, principal, riskPayout, totalWithdraw, []);
      const balanceAfter = await stablecoin.balanceOf(user1.address);
      expect(balanceAfter - balanceBefore).to.equal(totalWithdraw);
    });
  });

  describe("Pause and emergency", function () {
    it("allows only PAUSER_ROLE to pause/unpause", async function () {
      await expect(league.connect(admin).pause()).to.be.reverted;
      await league.connect(pauser).pause();
      await league.connect(pauser).unpause();
    });

    it("returns full deposit on emergencyExit while non-finalized", async function () {
      const now = await time.latest();
      const weekId = 20;
      const lockAt = now + 3600;
      const startAt = lockAt + 3600;
      const endAt = startAt + 3600;

      await league.connect(oracle).createWeek(weekId, startAt, lockAt, endAt);
      const depositAmount = ethers.parseEther("100");
      await league
        .connect(user1)
        .commitLineup(weekId, ethers.keccak256(ethers.toUtf8Bytes("lineup")), depositAmount);

      await league.connect(pauser).pause();
      const balanceBefore = await stablecoin.balanceOf(user1.address);
      await expect(league.connect(user1).emergencyExit(weekId))
        .to.emit(league, "EmergencyExit")
        .withArgs(weekId, user1.address, depositAmount);
      const balanceAfter = await stablecoin.balanceOf(user1.address);
      expect(balanceAfter - balanceBefore).to.equal(depositAmount);
    });
  });
});
