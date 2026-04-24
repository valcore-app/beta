import { config as loadEnv } from "dotenv";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import { isAbsolute, resolve } from "path";

const contractsEnvPathRaw = String(process.env.CONTRACTS_ENV_FILE ?? "").trim();
const contractsEnvPath = contractsEnvPathRaw
  ? isAbsolute(contractsEnvPathRaw)
    ? contractsEnvPathRaw
    : resolve(process.cwd(), contractsEnvPathRaw)
  : resolve(process.cwd(), ".env");
loadEnv({ path: contractsEnvPath });

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
    },
  },
};

export default config;

