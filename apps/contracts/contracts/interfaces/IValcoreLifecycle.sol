// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IValcoreLifecycle {
  function createWeekWithIntent(bytes32 intentId, uint256 weekId, uint64 startAt, uint64 lockAt, uint64 endAt)
    external;

  function lockWeekWithIntent(bytes32 intentId, uint256 weekId) external;
  function startWeekWithIntent(bytes32 intentId, uint256 weekId) external;
  function forceLockWeekWithIntent(bytes32 intentId, uint256 weekId) external;
  function forceStartWeekWithIntent(bytes32 intentId, uint256 weekId) external;

  function finalizeWeekWithIntent(
    bytes32 intentId,
    uint256 weekId,
    bytes32 merkleRoot,
    bytes32 metadataHash,
    uint256 retainedFee
  ) external;

  function forceFinalizeWeekWithIntent(
    bytes32 intentId,
    uint256 weekId,
    bytes32 merkleRoot,
    bytes32 metadataHash,
    uint256 retainedFee
  ) external;

  function approveFinalizationWithIntent(bytes32 intentId, uint256 weekId) external;
  function rejectFinalizationWithIntent(bytes32 intentId, uint256 weekId) external;
}
