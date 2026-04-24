const hre = require('hardhat');
async function main() {
  const { ethers } = hre;
  const reactiveRpc = process.env.REACTIVE_CHAIN_RPC_URL || 'https://lasna-rpc.rnk.dev';
  const sepoliaRpc = process.env.CHAIN_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
  const dispatcher = process.env.REACTIVE_DISPATCHER_ADDRESS;
  const receiver = process.env.REACTIVE_RECEIVER_ADDRESS;
  const executor = process.env.REACTIVE_EXECUTOR_ADDRESS;
  const rp = new ethers.JsonRpcProvider(reactiveRpc, Number(process.env.REACTIVE_CHAIN_ID || '5318007'));
  const sp = new ethers.JsonRpcProvider(sepoliaRpc, Number(process.env.CHAIN_ID || '11155111'));

  const dispatcherC = new ethers.Contract(dispatcher, [
    'function subscriptionActive() view returns (bool)',
    'function destinationChainId() view returns (uint256)',
    'function destinationReceiver() view returns (address)',
    'function operator() view returns (address)',
    'function triggerContract() view returns (address)'
  ], rp);
  const receiverC = new ethers.Contract(receiver, ['function reactiveSender() view returns (address)'], sp);
  const system = new ethers.Contract('0x0000000000000000000000000000000000fffFfF', ['function debt(address) view returns (uint256)'], rp);
  const mapping = await rp.send('rnk_getRnkAddressMapping', [dispatcher]);
  const rvm = (mapping && (mapping.rvmId || mapping.RvmId)) || '';

  const [sub, chainId, dst, op, trig, rs, bal, debt, exBal] = await Promise.all([
    dispatcherC.subscriptionActive(),
    dispatcherC.destinationChainId(),
    dispatcherC.destinationReceiver(),
    dispatcherC.operator(),
    dispatcherC.triggerContract(),
    receiverC.reactiveSender(),
    rp.getBalance(dispatcher),
    system.debt(dispatcher),
    rp.getBalance(executor),
  ]);

  console.log(JSON.stringify({
    dispatcher,
    receiver,
    subscriptionActive: sub,
    destinationChainId: String(chainId),
    destinationReceiver: dst,
    operator: op,
    triggerContract: trig,
    mappedReactiveSender: rvm,
    receiverReactiveSender: rs,
    dispatcherBalanceEth: ethers.formatEther(bal),
    dispatcherDebtEth: ethers.formatEther(debt),
    executorBalanceEth: ethers.formatEther(exBal),
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
