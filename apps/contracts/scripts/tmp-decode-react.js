const hre = require('hardhat');
async function main(){
  const { ethers } = hre;
  const data = process.env.DATA;
  const iface = new ethers.Interface([
    'function react((uint256 chain_id,address _contract,uint256 topic_0,uint256 topic_1,uint256 topic_2,uint256 topic_3,bytes data,uint256 block_number,uint256 op_code,uint256 block_hash,uint256 tx_hash,uint256 log_index) log)'
  ]);
  const parsed = iface.parseTransaction({ data });
  const log = parsed.args.log;
  const out = {
    chain_id: log.chain_id.toString(),
    contract: log._contract,
    topic0: '0x'+log.topic_0.toString(16),
    topic1: '0x'+log.topic_1.toString(16),
    block_number: log.block_number.toString(),
    tx_hash: '0x'+log.tx_hash.toString(16),
    log_index: log.log_index.toString(),
    dataLen: log.data.length,
  };
  console.log(JSON.stringify(out,null,2));
}
main().catch((e)=>{console.error(e);process.exit(1);});
