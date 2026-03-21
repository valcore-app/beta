// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract StablecoinMock is ERC20, Ownable {
  constructor(address recipient, string memory tokenName, string memory tokenSymbol)
    ERC20(tokenName, tokenSymbol)
    Ownable(recipient)
  {
    _mint(recipient, 1_000_000_000 ether);
  }

  function mint(address to, uint256 amount) external onlyOwner {
    _mint(to, amount);
  }
}
