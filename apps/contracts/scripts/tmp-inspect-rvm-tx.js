const hre = require('hardhat');
async function rpc(method, params){
  const res = await fetch('https://lasna-rpc.rnk.dev', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({jsonrpc:'2.0', id:1, method, params})});
  const json = await res.json();
  if (json.error) throw new Error(method + ': ' + JSON.stringify(json.error));
  return json.result;
}
async function main(){
  const { ethers } = hre;
  const rvm='0x00a03955454427953cc8947f23cf04269cab38ee';
  const txNum = process.env.TXNUM || '0x117';
  const tx = await rpc('rnk_getTransactionByNumber', [rvm, txNum]);
  const iface = new ethers.Interface([
    'function react((uint256 chain_id,address _contract,uint256 topic_0,uint256 topic_1,uint256 topic_2,uint256 topic_3,bytes data,uint256 block_number,uint256 op_code,uint256 block_hash,uint256 tx_hash,uint256 log_index) log)'
  ]);
  const parsed = iface.parseTransaction({ data: tx.data });
  const log = parsed.args.log;
  const out = {
    txNum,
    status: tx.status,
    to: tx.to,
    err: tx.err || null,
    rData: tx.rData || null,
    log: {
      chain_id: log.chain_id.toString(),
      contract: log._contract,
      topic0: ethers.toBeHex(log.topic_0, 32),
      topic1: ethers.toBeHex(log.topic_1, 32),
      topic2: ethers.toBeHex(log.topic_2, 32),
      topic3: ethers.toBeHex(log.topic_3, 32),
      block_number: log.block_number.toString(),
      op_code: log.op_code.toString(),
      tx_hash: ethers.toBeHex(log.tx_hash, 32),
      log_index: log.log_index.toString(),
      data: log.data,
    }
  };
  console.log(JSON.stringify(out,null,2));
}
main().catch((e)=>{console.error(e);process.exit(1);});
