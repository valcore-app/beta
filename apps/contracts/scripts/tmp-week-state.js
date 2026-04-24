const hre = require('hardhat');
async function main(){
  const { ethers } = hre;
  const p = new ethers.JsonRpcProvider('https://ethereum-sepolia-rpc.publicnode.com', 11155111);
  const c = new ethers.Contract('0x86FbdD63AE876e5152A0fdB93E67b0Db3eAa2333',[
    'function weekStates(uint256) view returns (uint64,uint64,uint64,uint64,uint8,uint128,uint128,bytes32,bytes32)'
  ], p);
  const weekId = 1776191427n;
  const s = await c.weekStates(weekId);
  console.log(JSON.stringify({
    weekId: weekId.toString(),
    status: Number(s[4]),
    startAt: s[0].toString(),
    lockAt: s[1].toString(),
    endAt: s[2].toString(),
    finalizedAt: s[3].toString(),
    retainedFee: s[6].toString(),
    merkleRoot: s[7],
    metadataHash: s[8]
  }, null, 2));
}
main().catch((e)=>{console.error(e); process.exit(1);});
