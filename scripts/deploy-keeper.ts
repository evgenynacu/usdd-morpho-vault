// Deploy EmergencyKeeper and optionally configure vault roles
//
// Usage:
//   # Deploy only
//   npx hardhat run scripts/deploy-keeper.ts --network mainnet
//
//   # Deploy and configure vaults
//   VAULTS=0x123...,0x456... npx hardhat run scripts/deploy-keeper.ts --network mainnet

import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying EmergencyKeeper with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  // Deploy EmergencyKeeper
  console.log("\nDeploying EmergencyKeeper...");
  const KeeperFactory = await ethers.getContractFactory("EmergencyKeeper");
  const keeper = await KeeperFactory.deploy(deployer.address);
  await keeper.waitForDeployment();
  const keeperAddress = await keeper.getAddress();
  console.log("EmergencyKeeper deployed:", keeperAddress);
  console.log("  Owner:", await keeper.owner());

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

      const KEEPER_ROLE = await vault.KEEPER_ROLE();
      const PAUSER_ROLE = await vault.PAUSER_ROLE();

      const grantKeeperTx = await vault.grantRole(KEEPER_ROLE, keeperAddress);
      await grantKeeperTx.wait();
      console.log("    KEEPER_ROLE granted:", await vault.hasRole(KEEPER_ROLE, keeperAddress));

      const grantPauserTx = await vault.grantRole(PAUSER_ROLE, keeperAddress);
      await grantPauserTx.wait();
      console.log("    PAUSER_ROLE granted:", await vault.hasRole(PAUSER_ROLE, keeperAddress));
    }
  }

  // Summary
  console.log("\n=== Deployment Summary ===");
  console.log("EmergencyKeeper:", keeperAddress);
  console.log("Owner:", deployer.address);
  if (vaultAddresses.length > 0) {
    console.log("Configured vaults:", vaultAddresses.length);
    for (const vaultAddr of vaultAddresses) {
      console.log("  -", vaultAddr);
    }
  } else {
    console.log("No vaults configured (set VAULTS env var to configure)");
  }

  return { keeper, keeperAddress };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
