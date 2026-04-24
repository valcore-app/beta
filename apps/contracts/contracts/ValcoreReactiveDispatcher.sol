// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AbstractReactive} from "./reactive-lib/abstract-base/AbstractReactive.sol";

interface IValcoreReactiveTrigger {
  function trigger(bytes calldata payload, uint64 gasLimit) external;
}

contract ValcoreReactiveDispatcher is AbstractReactive {
  error InvalidAddress();
  error Unauthorized();
  error InvalidDispatchPayload();

  event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
  event SubscriptionActivated(uint256 indexed chainId, address indexed sourceContract, uint256 indexed topic0);
  event DispatchRequested(bytes32 indexed payloadHash, uint64 gasLimit);
  event DispatchForwarded(bytes32 indexed payloadHash, uint64 gasLimit);

  uint256 private constant DISPATCH_TRIGGER_TOPIC_0 =
    uint256(keccak256("DispatchTrigger(bytes,uint64)"));

  uint256 public immutable destinationChainId;
  address public immutable destinationReceiver;
  address public immutable triggerContract;
  address public operator;
  bool public subscriptionActive;

  constructor(uint256 targetChainId, address targetReceiver, address initialOperator, address triggerAddress) payable {
    if (
      targetChainId == 0 ||
      targetReceiver == address(0) ||
      initialOperator == address(0) ||
      triggerAddress == address(0)
    ) {
      revert InvalidAddress();
    }

    destinationChainId = targetChainId;
    destinationReceiver = targetReceiver;
    triggerContract = triggerAddress;
    operator = initialOperator;

    emit OperatorUpdated(address(0), initialOperator);
  }

  modifier onlyOperator() {
    if (msg.sender != operator) revert Unauthorized();
    _;
  }

  function setOperator(address newOperator) external onlyOperator {
    if (newOperator == address(0)) revert InvalidAddress();
    address previous = operator;
    operator = newOperator;
    emit OperatorUpdated(previous, newOperator);
  }

  function dispatch(bytes calldata payload, uint64 gasLimit) external onlyOperator {
    if (payload.length == 0 || gasLimit == 0) revert InvalidDispatchPayload();
    bytes32 payloadHash = keccak256(payload);
    emit DispatchRequested(payloadHash, gasLimit);
    IValcoreReactiveTrigger(triggerContract).trigger(payload, gasLimit);
  }

  function activateSubscription() external onlyOperator rnOnly {
    if (subscriptionActive) return;
    service.subscribe(
      block.chainid,
      triggerContract,
      DISPATCH_TRIGGER_TOPIC_0,
      REACTIVE_IGNORE,
      REACTIVE_IGNORE,
      REACTIVE_IGNORE
    );
    subscriptionActive = true;
    emit SubscriptionActivated(block.chainid, triggerContract, DISPATCH_TRIGGER_TOPIC_0);
  }

  function withdraw(address payable recipient, uint256 amount) external onlyOperator {
    if (recipient == address(0)) revert InvalidAddress();
    _pay(recipient, amount);
  }

  function react(LogRecord calldata log) external override vmOnly {
    if (log.topic_0 != DISPATCH_TRIGGER_TOPIC_0) return;
    if (log._contract != triggerContract) return;
    (bytes memory payload, uint64 gasLimit) = abi.decode(log.data, (bytes, uint64));
    if (payload.length == 0 || gasLimit == 0) return;

    emit Callback(destinationChainId, destinationReceiver, gasLimit, payload);
    emit DispatchForwarded(keccak256(payload), gasLimit);
  }
}
