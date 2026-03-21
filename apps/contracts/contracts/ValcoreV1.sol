// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract ValcoreV1 is AccessControl, Pausable, ReentrancyGuard {
  using SafeERC20 for IERC20;

  // ==================== CUSTOM ERRORS ====================
  error InvalidAddress();
  error InvalidRatio();
  error InvalidFee();
  error InvalidMinDeposit();
  error WeekAlreadyExists();
  error InvalidTimeRange();
  error DraftNotOpen();
  error DraftClosed();
  error WeekNotLocked();
  error WeekNotActive();
  error WeekNotFinalizePending();
  error InvalidHash();
  error InvalidDeposit();
  error BelowMinDeposit();
  error DepositTooLarge();
  error NoLineup();
  error SwapLimitReached();
  error WeekNotFinalized();
  error AlreadyClaimed();
  error InvalidProof();
  error InvalidMerkleRoot();
  error InvalidTreasuryAddress();
  error LockTimeNotReached();
  error StartTimeNotReached();
  error EndTimeNotReached();
  error WeekEnded();
  error EmergencyExitNotAllowed();
  error RewardSweepNotAvailable();
  error RewardAlreadySwept();
  error NoSweepableReward();
  error NoCommittedStrategies();

  // ==================== CONSTANTS ====================
  bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
  bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
  bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");

  uint256 public constant BPS = 10_000;
  uint8 public constant MAX_SWAPS = 10;
  uint256 public constant REWARD_SWEEP_DELAY = 180 days;

  enum WeekStatus {
    NONE,
    DRAFT_OPEN,
    LOCKED,
    ACTIVE,
    FINALIZE_PENDING,
    FINALIZED
  }

  // ==================== STRUCTS ====================
  struct WeekState {
    uint64 startAt;
    uint64 lockAt;
    uint64 endAt;
    uint64 finalizedAt;
    uint8 status;
    uint128 riskCommitted;
    uint128 retainedFee;
    bytes32 merkleRoot;
    bytes32 metadataHash;
  }

  struct UserPosition {
    uint128 principal;
    uint128 risk;
    uint128 forfeitedReward;
    bytes32 lineupHash;
    uint8 swaps;
    bool claimed;
  }

  IERC20 public immutable stablecoin;
  address public immutable treasury;
  uint16 public immutable principalRatioBps;
  uint16 public immutable feeBps;
  uint256 public immutable minDeposit;
  bool public testMode;

  mapping(uint256 => WeekState) public weekStates;
  mapping(uint256 => mapping(address => UserPosition)) public positions;

  event WeekCreated(uint256 indexed weekId, uint64 startAt, uint64 lockAt, uint64 endAt);
  event WeekLocked(uint256 indexed weekId);
  event WeekStarted(uint256 indexed weekId);
  event WeekFinalizePending(
    uint256 indexed weekId, bytes32 merkleRoot, bytes32 metadataHash, uint256 retainedFee
  );
  event WeekFinalized(uint256 indexed weekId, bytes32 merkleRoot, bytes32 metadataHash);
  event WeekFinalizationRejected(uint256 indexed weekId);
  event ProtocolFeeTransferred(uint256 indexed weekId, address indexed treasury, uint256 amount);
  event LineupCommitted(uint256 indexed weekId, address indexed user, bytes32 lineupHash, uint256 deposit);
  event LineupUpdated(uint256 indexed weekId, address indexed user, bytes32 lineupHash, uint256 deposit);
  event LineupSwapped(uint256 indexed weekId, address indexed user, bytes32 lineupHash, uint8 swapsUsed);
  event Claimed(uint256 indexed weekId, address indexed user, uint256 amount);
  event EmergencyExit(uint256 indexed weekId, address indexed user, uint256 amount);
  event RewardSwept(uint256 indexed weekId, address indexed user, address indexed caller, uint256 amount);
  event TestModeChanged(bool enabled);

  constructor(
    address stablecoinToken,
    uint16 principalRatio,
    uint16 fee,
    uint256 minDepositAmount,
    address admin,
    address treasuryAddress,
    address pauser,
    address auditor
  ) {
    if (stablecoinToken == address(0)) revert InvalidAddress();
    if (principalRatio > BPS) revert InvalidRatio();
    if (fee > BPS) revert InvalidFee();
    if (minDepositAmount == 0) revert InvalidMinDeposit();
    if (admin == address(0)) revert InvalidAddress();
    if (treasuryAddress == address(0)) revert InvalidTreasuryAddress();
    if (pauser == address(0)) revert InvalidAddress();
    if (auditor == address(0)) revert InvalidAddress();

    stablecoin = IERC20(stablecoinToken);
    treasury = treasuryAddress;
    principalRatioBps = principalRatio;
    feeBps = fee;
    minDeposit = minDepositAmount;

    _grantRole(DEFAULT_ADMIN_ROLE, admin);
    _grantRole(ORACLE_ROLE, admin);
    _grantRole(PAUSER_ROLE, pauser);
    _grantRole(AUDITOR_ROLE, auditor);
  }

  function createWeek(uint256 weekId, uint64 startAt, uint64 lockAt, uint64 endAt)
    external
    onlyRole(ORACLE_ROLE)
  {
    WeekState storage week = weekStates[weekId];
    if (week.status != uint8(WeekStatus.NONE)) revert WeekAlreadyExists();
    if (lockAt > startAt || startAt >= endAt) revert InvalidTimeRange();

    week.startAt = startAt;
    week.lockAt = lockAt;
    week.endAt = endAt;
    week.status = uint8(WeekStatus.DRAFT_OPEN);

    emit WeekCreated(weekId, startAt, lockAt, endAt);
  }

  function lockWeek(uint256 weekId) external onlyRole(ORACLE_ROLE) {
    WeekState storage week = weekStates[weekId];
    if (week.status != uint8(WeekStatus.DRAFT_OPEN)) revert DraftNotOpen();
    if (week.riskCommitted == 0) revert NoCommittedStrategies();
    if (block.timestamp < week.lockAt) revert LockTimeNotReached();
    week.status = uint8(WeekStatus.LOCKED);
    emit WeekLocked(weekId);
  }

  function startWeek(uint256 weekId) external onlyRole(ORACLE_ROLE) {
    WeekState storage week = weekStates[weekId];
    if (week.status != uint8(WeekStatus.LOCKED)) revert WeekNotLocked();
    if (block.timestamp < week.startAt) revert StartTimeNotReached();
    week.status = uint8(WeekStatus.ACTIVE);
    emit WeekStarted(weekId);
  }

  function forceLockWeek(uint256 weekId) external onlyRole(ORACLE_ROLE) {
    WeekState storage week = weekStates[weekId];
    if (week.status != uint8(WeekStatus.DRAFT_OPEN)) revert DraftNotOpen();
    if (week.riskCommitted == 0) revert NoCommittedStrategies();
    week.status = uint8(WeekStatus.LOCKED);
    emit WeekLocked(weekId);
  }

  function forceStartWeek(uint256 weekId) external onlyRole(ORACLE_ROLE) {
    WeekState storage week = weekStates[weekId];
    if (week.status != uint8(WeekStatus.LOCKED)) revert WeekNotLocked();
    week.status = uint8(WeekStatus.ACTIVE);
    emit WeekStarted(weekId);
  }

  function forceFinalizeWeek(uint256 weekId, bytes32 merkleRoot, bytes32 metadataHash, uint256 retainedFee)
    external
    onlyRole(ORACLE_ROLE)
  {
    WeekState storage week = weekStates[weekId];
    if (week.status != uint8(WeekStatus.ACTIVE)) revert WeekNotActive();
    if (merkleRoot == bytes32(0)) revert InvalidMerkleRoot();

    if (retainedFee > type(uint128).max) revert DepositTooLarge();
    if (retainedFee > week.riskCommitted) revert InvalidFee();

    _markFinalizePending(week, weekId, merkleRoot, metadataHash, retainedFee);
  }

  function finalizeWeek(uint256 weekId, bytes32 merkleRoot, bytes32 metadataHash, uint256 retainedFee)
    external
    onlyRole(ORACLE_ROLE)
  {
    WeekState storage week = weekStates[weekId];
    if (week.status != uint8(WeekStatus.ACTIVE)) revert WeekNotActive();
    if (block.timestamp < week.endAt) revert EndTimeNotReached();
    if (merkleRoot == bytes32(0)) revert InvalidMerkleRoot();

    if (retainedFee > type(uint128).max) revert DepositTooLarge();
    if (retainedFee > week.riskCommitted) revert InvalidFee();

    _markFinalizePending(week, weekId, merkleRoot, metadataHash, retainedFee);
  }

  function approveFinalization(uint256 weekId) external onlyRole(AUDITOR_ROLE) {
    WeekState storage week = weekStates[weekId];
    if (week.status != uint8(WeekStatus.FINALIZE_PENDING)) revert WeekNotFinalizePending();

    week.status = uint8(WeekStatus.FINALIZED);
    uint256 retainedFee = uint256(week.retainedFee);
    if (retainedFee > 0) {
      stablecoin.safeTransfer(treasury, retainedFee);
      emit ProtocolFeeTransferred(weekId, treasury, retainedFee);
    }

    emit WeekFinalized(weekId, week.merkleRoot, week.metadataHash);
  }

  function rejectFinalization(uint256 weekId) external onlyRole(AUDITOR_ROLE) {
    WeekState storage week = weekStates[weekId];
    if (week.status != uint8(WeekStatus.FINALIZE_PENDING)) revert WeekNotFinalizePending();

    week.status = uint8(WeekStatus.ACTIVE);
    week.finalizedAt = 0;
    week.retainedFee = 0;
    week.merkleRoot = bytes32(0);
    week.metadataHash = bytes32(0);

    emit WeekFinalizationRejected(weekId);
  }

  function commitLineup(uint256 weekId, bytes32 lineupHash, uint256 depositAmount)
    external
    whenNotPaused
    nonReentrant
  {
    WeekState storage week = weekStates[weekId];
    if (week.status != uint8(WeekStatus.DRAFT_OPEN)) revert DraftNotOpen();
    if (!testMode && block.timestamp >= week.lockAt) revert DraftClosed();
    if (lineupHash == bytes32(0)) revert InvalidHash();
    if (depositAmount == 0) revert InvalidDeposit();
    if (depositAmount < minDeposit) revert BelowMinDeposit();

    UserPosition storage position = positions[weekId][msg.sender];
    if (position.claimed) revert AlreadyClaimed();

    uint256 previousDeposit = uint256(position.principal) + uint256(position.risk);
    if (depositAmount > previousDeposit) {
      stablecoin.safeTransferFrom(msg.sender, address(this), depositAmount - previousDeposit);
    } else if (depositAmount < previousDeposit) {
      stablecoin.safeTransfer(msg.sender, previousDeposit - depositAmount);
    }

    uint256 principal = (depositAmount * principalRatioBps) / BPS;
    uint256 risk = depositAmount - principal;
    if (principal > type(uint128).max || risk > type(uint128).max) revert DepositTooLarge();

    uint128 prevRisk = position.risk;
    if (risk > prevRisk) {
      week.riskCommitted += uint128(risk - prevRisk);
    } else if (risk < prevRisk) {
      week.riskCommitted -= uint128(prevRisk - risk);
    }

    position.principal = uint128(principal);
    position.risk = uint128(risk);
    position.forfeitedReward = 0;
    position.lineupHash = lineupHash;
    position.swaps = 0;
    position.claimed = false;

    if (previousDeposit == 0) {
      emit LineupCommitted(weekId, msg.sender, lineupHash, depositAmount);
    } else {
      emit LineupUpdated(weekId, msg.sender, lineupHash, depositAmount);
    }
  }

  function swapLineup(uint256 weekId, bytes32 newHash) external whenNotPaused {
    WeekState storage week = weekStates[weekId];
    if (week.status != uint8(WeekStatus.ACTIVE)) revert WeekNotActive();
    if (!testMode && block.timestamp >= week.endAt) revert WeekEnded();

    UserPosition storage position = positions[weekId][msg.sender];
    if (position.lineupHash == bytes32(0)) revert NoLineup();
    if (position.swaps >= MAX_SWAPS) revert SwapLimitReached();
    if (newHash == bytes32(0)) revert InvalidHash();

    position.lineupHash = newHash;
    unchecked {
      position.swaps += 1;
    }

    emit LineupSwapped(weekId, msg.sender, newHash, position.swaps);
  }

  function claim(
    uint256 weekId,
    uint256 principal,
    uint256 riskPayout,
    uint256 totalWithdraw,
    bytes32[] calldata proof
  ) external nonReentrant {
    WeekState storage week = weekStates[weekId];
    if (week.status != uint8(WeekStatus.FINALIZED)) revert WeekNotFinalized();

    UserPosition storage position = positions[weekId][msg.sender];
    if (position.claimed) revert AlreadyClaimed();

    bytes32 leaf = keccak256(abi.encodePacked(address(this), block.chainid, weekId, msg.sender, principal, riskPayout, totalWithdraw));
    if (!MerkleProof.verify(proof, week.merkleRoot, leaf)) revert InvalidProof();

    uint256 payout = totalWithdraw;
    uint256 forfeitedReward = uint256(position.forfeitedReward);
    if (forfeitedReward == 0 && _isRewardSweepWindowOpen(week)) {
      uint256 rewardToSweep = _computeSweepableReward(position, principal, totalWithdraw);
      if (rewardToSweep > 0) {
        if (rewardToSweep > type(uint128).max) revert DepositTooLarge();
        position.forfeitedReward = uint128(rewardToSweep);
        forfeitedReward = rewardToSweep;
        stablecoin.safeTransfer(treasury, rewardToSweep);
        emit RewardSwept(weekId, msg.sender, msg.sender, rewardToSweep);
      }
    }

    if (forfeitedReward > payout) {
      forfeitedReward = payout;
    }
    payout -= forfeitedReward;

    position.claimed = true;

    stablecoin.safeTransfer(msg.sender, payout);
    emit Claimed(weekId, msg.sender, payout);
  }

  function sweepExpiredReward(
    uint256 weekId,
    address user,
    uint256 principal,
    uint256 riskPayout,
    uint256 totalWithdraw,
    bytes32[] calldata proof
  ) external nonReentrant {
    WeekState storage week = weekStates[weekId];
    if (week.status != uint8(WeekStatus.FINALIZED)) revert WeekNotFinalized();
    if (!_isRewardSweepWindowOpen(week)) revert RewardSweepNotAvailable();

    UserPosition storage position = positions[weekId][user];
    if (position.claimed) revert AlreadyClaimed();
    if (position.forfeitedReward > 0) revert RewardAlreadySwept();

    bytes32 leaf = keccak256(abi.encodePacked(address(this), block.chainid, weekId, user, principal, riskPayout, totalWithdraw));
    if (!MerkleProof.verify(proof, week.merkleRoot, leaf)) revert InvalidProof();

    uint256 rewardToSweep = _computeSweepableReward(position, principal, totalWithdraw);
    if (rewardToSweep == 0) revert NoSweepableReward();
    if (rewardToSweep > type(uint128).max) revert DepositTooLarge();

    position.forfeitedReward = uint128(rewardToSweep);
    stablecoin.safeTransfer(treasury, rewardToSweep);
    emit RewardSwept(weekId, user, msg.sender, rewardToSweep);
  }

  function setTestMode(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
    testMode = enabled;
    emit TestModeChanged(enabled);
  }

  function pause() external onlyRole(PAUSER_ROLE) {
    _pause();
  }

  function unpause() external onlyRole(PAUSER_ROLE) {
    _unpause();
  }

  function emergencyExit(uint256 weekId) external whenPaused nonReentrant {
    WeekState storage week = weekStates[weekId];
    if (week.status == uint8(WeekStatus.FINALIZED)) revert EmergencyExitNotAllowed();

    UserPosition storage position = positions[weekId][msg.sender];
    if (position.claimed) revert AlreadyClaimed();

    uint256 deposit = uint256(position.principal) + uint256(position.risk);
    if (deposit == 0) revert NoLineup();

    uint128 prevRisk = position.risk;
    if (prevRisk > 0) {
      week.riskCommitted -= prevRisk;
    }

    position.principal = 0;
    position.risk = 0;
    position.forfeitedReward = 0;
    position.lineupHash = bytes32(0);
    position.swaps = 0;
    position.claimed = true;

    stablecoin.safeTransfer(msg.sender, deposit);
    emit EmergencyExit(weekId, msg.sender, deposit);
  }

  function rewardSweepAvailableAt(uint256 weekId) external view returns (uint256) {
    WeekState storage week = weekStates[weekId];
    if (week.status != uint8(WeekStatus.FINALIZED) || week.finalizedAt == 0) {
      return 0;
    }
    return uint256(week.finalizedAt) + REWARD_SWEEP_DELAY;
  }

  function _computeSweepableReward(UserPosition storage position, uint256 principal, uint256 totalWithdraw)
    internal
    view
    returns (uint256)
  {
    uint256 baseline = principal + uint256(position.risk);
    if (totalWithdraw <= baseline) return 0;
    return totalWithdraw - baseline;
  }

  function _isRewardSweepWindowOpen(WeekState storage week) internal view returns (bool) {
    if (week.finalizedAt == 0) return false;
    return block.timestamp >= uint256(week.finalizedAt) + REWARD_SWEEP_DELAY;
  }

  function _markFinalizePending(
    WeekState storage week,
    uint256 weekId,
    bytes32 merkleRoot,
    bytes32 metadataHash,
    uint256 retainedFee
  ) internal {
    week.status = uint8(WeekStatus.FINALIZE_PENDING);
    week.finalizedAt = uint64(block.timestamp);
    week.retainedFee = uint128(retainedFee);
    week.merkleRoot = merkleRoot;
    week.metadataHash = metadataHash;

    emit WeekFinalizePending(weekId, merkleRoot, metadataHash, retainedFee);
  }
}
