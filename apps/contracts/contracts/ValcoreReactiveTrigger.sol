// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract ValcoreReactiveTrigger {
  error InvalidAddress();
  error UnauthorizedOwner();
  error UnauthorizedDispatcher();

  event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
  event DispatcherUpdated(address indexed previousDispatcher, address indexed newDispatcher);
  event DispatchTrigger(bytes payload, uint64 gasLimit);

  address public owner;
  address public dispatcher;

  constructor(address initialOwner) {
    if (initialOwner == address(0)) revert InvalidAddress();
    owner = initialOwner;
    emit OwnershipTransferred(address(0), initialOwner);
  }

  modifier onlyOwner() {
    if (msg.sender != owner) revert UnauthorizedOwner();
    _;
  }

  modifier onlyDispatcher() {
    if (msg.sender != dispatcher) revert UnauthorizedDispatcher();
    _;
  }

  function transferOwnership(address newOwner) external onlyOwner {
    if (newOwner == address(0)) revert InvalidAddress();
    address previousOwner = owner;
    owner = newOwner;
    emit OwnershipTransferred(previousOwner, newOwner);
  }

  function setDispatcher(address newDispatcher) external onlyOwner {
    if (newDispatcher == address(0)) revert InvalidAddress();
    address previousDispatcher = dispatcher;
    dispatcher = newDispatcher;
    emit DispatcherUpdated(previousDispatcher, newDispatcher);
  }

  function trigger(bytes calldata payload, uint64 gasLimit) external onlyDispatcher {
    emit DispatchTrigger(payload, gasLimit);
  }
}
