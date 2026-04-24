// SPDX-License-Identifier: UNLICENSED

pragma solidity >=0.8.0;

interface IPayer {
  function pay(uint256 amount) external;

  receive() external payable;
}
