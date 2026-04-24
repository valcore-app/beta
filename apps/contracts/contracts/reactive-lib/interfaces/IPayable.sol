// SPDX-License-Identifier: UNLICENSED

pragma solidity >=0.8.0;

interface IPayable {
  receive() external payable;

  function debt(address _contract) external view returns (uint256);
}
