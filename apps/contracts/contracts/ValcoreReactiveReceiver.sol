// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IValcoreLifecycle} from "./interfaces/IValcoreLifecycle.sol";
import {AbstractCallback} from "./reactive-lib/abstract-base/AbstractCallback.sol";

contract ValcoreReactiveReceiver is AbstractCallback {
  error InvalidAddress();
  error InvalidReactiveSender();
  error UnauthorizedOwner();
  error UnauthorizedCallbackSender();
  error UnauthorizedReactiveSender();
  error InvalidTransitionAction();

  event ReactiveSenderUpdated(address indexed previousSender, address indexed newSender);
  event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
  event AuthorizedSenderUpdated(address indexed sender, bool allowed);
  event ReactiveLifecycleExecuted(bytes32 indexed intentId, uint8 indexed action, uint256 indexed weekId);
  event ReactiveLifecycleDuplicate(bytes32 indexed intentId, uint8 indexed action, uint256 indexed weekId);

  // 1=create, 2=lock, 3=start, 4=finalize, 5=approve, 6=reject
  uint8 private constant ACTION_CREATE = 1;
  uint8 private constant ACTION_LOCK = 2;
  uint8 private constant ACTION_START = 3;
  uint8 private constant ACTION_FINALIZE = 4;
  uint8 private constant ACTION_APPROVE = 5;
  uint8 private constant ACTION_REJECT = 6;

  IValcoreLifecycle public immutable valcore;
  mapping(bytes32 => bool) public processedIntents;

  address public owner;

  constructor(address callbackProxyAddress, address valcoreAddress, address initialReactiveSender)
    AbstractCallback(callbackProxyAddress)
    payable
  {
    if (
      callbackProxyAddress == address(0) ||
      valcoreAddress == address(0) ||
      initialReactiveSender == address(0)
    ) {
      revert InvalidAddress();
    }

    valcore = IValcoreLifecycle(valcoreAddress);
    owner = msg.sender;
    rvm_id = initialReactiveSender;

    emit OwnershipTransferred(address(0), msg.sender);
    emit ReactiveSenderUpdated(address(0), initialReactiveSender);
    emit AuthorizedSenderUpdated(callbackProxyAddress, true);
  }

  modifier onlyOwner() {
    if (msg.sender != owner) revert UnauthorizedOwner();
    _;
  }

  modifier onlyReactiveCallback(address sender) {
    if (!senders[msg.sender]) revert UnauthorizedCallbackSender();
    if (sender != rvm_id) revert UnauthorizedReactiveSender();
    _;
  }

  function reactiveSender() external view returns (address) {
    return rvm_id;
  }

  function _beginIntent(bytes32 intentId, uint8 action, uint256 weekId) private returns (bool) {
    if (processedIntents[intentId]) {
      emit ReactiveLifecycleDuplicate(intentId, action, weekId);
      return false;
    }
    processedIntents[intentId] = true;
    return true;
  }

  function transferOwnership(address newOwner) external onlyOwner {
    if (newOwner == address(0)) revert InvalidAddress();
    address previous = owner;
    owner = newOwner;
    emit OwnershipTransferred(previous, newOwner);
  }

  function setReactiveSender(address newReactiveSender) external onlyOwner {
    if (newReactiveSender == address(0)) revert InvalidReactiveSender();
    address previous = rvm_id;
    rvm_id = newReactiveSender;
    emit ReactiveSenderUpdated(previous, newReactiveSender);
  }

  function setAuthorizedSender(address sender, bool allowed) external onlyOwner {
    if (sender == address(0)) revert InvalidAddress();
    if (allowed) {
      addAuthorizedSender(sender);
    } else {
      removeAuthorizedSender(sender);
    }
    emit AuthorizedSenderUpdated(sender, allowed);
  }

  function rxCreateWeek(
    address sender,
    bytes32 intentId,
    uint256 weekId,
    uint64 startAt,
    uint64 lockAt,
    uint64 endAt
  ) external onlyReactiveCallback(sender) {
    if (!_beginIntent(intentId, ACTION_CREATE, weekId)) return;
    valcore.createWeekWithIntent(intentId, weekId, startAt, lockAt, endAt);
    emit ReactiveLifecycleExecuted(intentId, ACTION_CREATE, weekId);
  }

  function rxTransition(
    address sender,
    bytes32 intentId,
    uint8 action,
    uint256 weekId,
    bool useForce
  ) external onlyReactiveCallback(sender) {
    if (!_beginIntent(intentId, action, weekId)) return;
    if (action == ACTION_LOCK) {
      if (useForce) {
        valcore.forceLockWeekWithIntent(intentId, weekId);
      } else {
        valcore.lockWeekWithIntent(intentId, weekId);
      }
    } else if (action == ACTION_START) {
      if (useForce) {
        valcore.forceStartWeekWithIntent(intentId, weekId);
      } else {
        valcore.startWeekWithIntent(intentId, weekId);
      }
    } else {
      revert InvalidTransitionAction();
    }

    emit ReactiveLifecycleExecuted(intentId, action, weekId);
  }

  function rxFinalize(
    address sender,
    bytes32 intentId,
    uint256 weekId,
    bytes32 merkleRoot,
    bytes32 metadataHash,
    uint256 retainedFee,
    bool useForce
  ) external onlyReactiveCallback(sender) {
    if (!_beginIntent(intentId, ACTION_FINALIZE, weekId)) return;
    if (useForce) {
      valcore.forceFinalizeWeekWithIntent(intentId, weekId, merkleRoot, metadataHash, retainedFee);
    } else {
      valcore.finalizeWeekWithIntent(intentId, weekId, merkleRoot, metadataHash, retainedFee);
    }
    emit ReactiveLifecycleExecuted(intentId, ACTION_FINALIZE, weekId);
  }

  function rxApprove(address sender, bytes32 intentId, uint256 weekId)
    external
    onlyReactiveCallback(sender)
  {
    if (!_beginIntent(intentId, ACTION_APPROVE, weekId)) return;
    valcore.approveFinalizationWithIntent(intentId, weekId);
    emit ReactiveLifecycleExecuted(intentId, ACTION_APPROVE, weekId);
  }

  function rxReject(address sender, bytes32 intentId, uint256 weekId)
    external
    onlyReactiveCallback(sender)
  {
    if (!_beginIntent(intentId, ACTION_REJECT, weekId)) return;
    valcore.rejectFinalizationWithIntent(intentId, weekId);
    emit ReactiveLifecycleExecuted(intentId, ACTION_REJECT, weekId);
  }
}
