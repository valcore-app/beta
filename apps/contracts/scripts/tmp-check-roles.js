const hre = require('hardhat');
async function main(){
  const { ethers } = hre;
  const p = new ethers.JsonRpcProvider('https://ethereum-sepolia-rpc.publicnode.com',11155111);
  const val = new ethers.Contract('0x86FbdD63AE876e5152A0fdB93E67b0Db3eAa2333',[
    'function ORACLE_ROLE() view returns (bytes32)',
    'function AUDITOR_ROLE() view returns (bytes32)',
    'function hasRole(bytes32,address) view returns (bool)',
    'function weekStates(uint256) view returns (uint64,uint64,uint64,uint64,uint8,uint128,uint128,bytes32,bytes32)'
  ],p);
  const recv='0x5D5B231d070BC986AbBf0A752D9AA1731b847d59';
  const [or,aud]=await Promise.all([val.ORACLE_ROLE(),val.AUDITOR_ROLE()]);
  const [h1,h2,ws]=await Promise.all([val.hasRole(or,recv),val.hasRole(aud,recv),val.weekStates(1776191427n)]);
  console.log({oracleRole:or,auditorRole:aud,hasOracle:h1,hasAuditor:h2,status:Number(ws[4]),finalizedAt:ws[3].toString()});
}
main().catch((e)=>{console.error(e);process.exit(1);});
