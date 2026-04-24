const hre = require('hardhat');
async function main(){
  const { ethers } = hre;
  const sigs = [
    'DispatchRequested(bytes32,uint64)',
    'DispatchForwarded(bytes32,uint64)',
    'Callback(uint256,address,uint64,bytes)',
    'DispatchTrigger(bytes,uint64)',
    'ReactiveLifecycleExecuted(bytes32,uint8,uint256)'
  ];
  for (const s of sigs) console.log(s, ethers.id(s));
}
main().catch((e)=>{console.error(e); process.exit(1);});
