const hre = require('hardhat');

async function main() {
  const { ethers } = hre;
  const reactiveRpc = 'https://lasna-rpc.rnk.dev';
  const sepoliaRpc = 'https://ethereum-sepolia-rpc.publicnode.com';
  const txHash = process.env.TX || '0x9e5ca87ecc27429fbeeaf148ba46a65cbc7611c6e841a21d7011f82d9816e563';
  const receiver = '0x84e1b415e3A772Dc22be854856B9f294FDDb6F1c';
  const callbackProxy = '0xc9f36411C9897e7F959D99ffca2a0Ba7ee0D7bDA';

  const rp = new ethers.JsonRpcProvider(reactiveRpc, 5318007);
  const sp = new ethers.JsonRpcProvider(sepoliaRpc, 11155111);

  const triggerIface = new ethers.Interface(['event DispatchTrigger(bytes payload, uint64 gasLimit)']);
  const receiverIface = new ethers.Interface([
    'function rxFinalize(address sender, bytes32 intentId, uint256 weekId, bytes32 merkleRoot, bytes32 metadataHash, uint256 retainedFee, bool useForce)',
    'function rxTransition(address sender, bytes32 intentId, uint8 action, uint256 weekId, bool useForce)',
    'function rxCreateWeek(address sender, bytes32 intentId, uint256 weekId, uint64 startAt, uint64 lockAt, uint64 endAt)',
    'function rxApprove(address sender, bytes32 intentId, uint256 weekId)',
    'function rxReject(address sender, bytes32 intentId, uint256 weekId)'
  ]);

  const rec = await rp.getTransactionReceipt(txHash);
  if (!rec) throw new Error('receipt not found');

  let payload = null;
  for (const log of rec.logs) {
    try {
      const parsed = triggerIface.parseLog(log);
      payload = parsed.args.payload;
      console.log('trigger log address', log.address, 'gasLimit', String(parsed.args.gasLimit));
      break;
    } catch {}
  }
  if (!payload) throw new Error('DispatchTrigger log not found');

  const decoded = receiverIface.parseTransaction({ data: payload });
  console.log('decoded method:', decoded.name);
  console.log('decoded args:', decoded.args.map((x) => (typeof x === 'bigint' ? x.toString() : x)));

  try {
    const out = await sp.call({
      to: receiver,
      from: callbackProxy,
      data: payload,
    });
    console.log('eth_call success, return:', out);
  } catch (e) {
    console.log('eth_call revert:', e.shortMessage || e.message || String(e));
    if (e.data) console.log('revert data:', e.data);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
