// Deploy RebalanceKeeper and optionally configure vault roles
//
// Usage:
//   # Deploy only
//   npx hardhat run scripts/deploy-rebalance-keeper.ts --network mainnet
//
//   # Deploy and configure vaults
//   VAULTS=0x123...,0x456... npx hardhat run scripts/deploy-rebalance-keeper.ts --network mainnet
//
//   # Skip deploy, use existing keeper (e.g. after partial failure)
//   KEEPER_ADDRESS=0x789... VAULTS=0x123...,0x456... npx hardhat run scripts/deploy-rebalance-keeper.ts --network mainnet

import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Account:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  const KeeperFactory = await ethers.getContractFactory("RebalanceKeeper");
  let keeperAddress: string;

  if (process.env.KEEPER_ADDRESS) {
    keeperAddress = process.env.KEEPER_ADDRESS;
    console.log("\nUsing existing RebalanceKeeper:", keeperAddress);
  } else {
    console.log("\nDeploying RebalanceKeeper...");
    const keeper = await KeeperFactory.deploy(deployer.address);
    await keeper.waitForDeployment();
    keeperAddress = await keeper.getAddress();
    console.log("RebalanceKeeper deployed:", keeperAddress);
  }

  // Configure vault roles if VAULTS env var is provided
  const vaultsEnv = process.env.VAULTS;
  const vaultAddresses = vaultsEnv
    ? vaultsEnv.split(",").map((v) => v.trim()).filter((v) => v.length > 0)
    : [];

  if (vaultAddresses.length > 0) {
    console.log("\nConfiguring vault roles...");
    const VaultFactory = await ethers.getContractFactory("SUSDDVault");

    for (const vaultAddr of vaultAddresses) {
      console.log(`\n  Vault: ${vaultAddr}`);

      if (!ethers.isAddress(vaultAddr)) {
        console.error("    SKIP: invalid address");
        continue;
      }

      const code = await ethers.provider.getCode(vaultAddr);
      if (code === "0x") {
        console.error("    SKIP: no contract at this address");
        continue;
      }

      const vault = VaultFactory.attach(vaultAddr);

      const KEEPER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("KEEPER_ROLE"));

      if (await vault.hasRole(KEEPER_ROLE, keeperAddress)) {
        console.log("    KEEPER_ROLE already granted, skipping");
        continue;
      }

      const grantKeeperTx = await vault.grantRole(KEEPER_ROLE, keeperAddress);
      await grantKeeperTx.wait();
      console.log("    KEEPER_ROLE granted:", await vault.hasRole(KEEPER_ROLE, keeperAddress));
    }
  }

  // Summary
  console.log("\n=== Deployment Summary ===");
  console.log("RebalanceKeeper:", keeperAddress);
  console.log("Owner:", deployer.address);
  if (vaultAddresses.length > 0) {
    console.log("Configured vaults:", vaultAddresses.length);
    for (const vaultAddr of vaultAddresses) {
      console.log("  -", vaultAddr);
    }
  } else {
    console.log("No vaults configured (set VAULTS env var to configure)");
  }

  return { keeperAddress };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
