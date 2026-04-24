const hre = require('hardhat');
async function main(){
  const { ethers } = hre;
  const p = new ethers.JsonRpcProvider('https://ethereum-sepolia-rpc.publicnode.com', 11155111);
  const addr='0xc9f36411C9897e7F959D99ffca2a0Ba7ee0D7bDA';
  const b = await p.getBalance(addr);
  console.log('callbackProxy', addr, 'balanceETH', ethers.formatEther(b));
}
main().catch((e)=>{console.error(e);process.exit(1);});
