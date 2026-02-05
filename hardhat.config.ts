import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import "dotenv/config";

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL || "";
const MAINNET_DEPLOY_RPC_URL = process.env.MAINNET_DEPLOY_RPC_URL || "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 50,
      },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      forking: {
        url: MAINNET_RPC_URL,
        enabled: !!MAINNET_RPC_URL,
      },
    },
    mainnet: {
      url: MAINNET_DEPLOY_RPC_URL,
      timeout: 60000,
    },
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
};

export default config;
