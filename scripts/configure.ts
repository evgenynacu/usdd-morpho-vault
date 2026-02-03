import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Configuring vault with account:", deployer.address);

  // Get vault address from environment or hardcode for local testing
  const vaultAddress = process.env.VAULT_ADDRESS;
  if (!vaultAddress) {
    console.error("Error: VAULT_ADDRESS environment variable not set");
    console.log("Usage: VAULT_ADDRESS=0x... npx hardhat run scripts/configure.ts --network <network>");
    process.exit(1);
  }

  const vault = await ethers.getContractAt("SUSDDVault", vaultAddress);
  console.log("Connected to vault at:", vaultAddress);

  // Configuration - adjust these addresses for production
  const config = {
    // Addresses to grant roles to (set to zero address to skip)
    keeper: process.env.KEEPER_ADDRESS || ethers.ZeroAddress,
    manager: process.env.MANAGER_ADDRESS || ethers.ZeroAddress,
    pauser: process.env.PAUSER_ADDRESS || ethers.ZeroAddress,

    // Optional parameter updates (set to undefined to skip)
    newFeeRecipient: process.env.FEE_RECIPIENT || undefined,
    newTargetLTV: process.env.TARGET_LTV ? ethers.parseUnits(process.env.TARGET_LTV, 18) : undefined,
    newPerformanceFee: process.env.PERFORMANCE_FEE ? BigInt(process.env.PERFORMANCE_FEE) : undefined,
    newMaxTotalAssets: process.env.MAX_TOTAL_ASSETS ? ethers.parseUnits(process.env.MAX_TOTAL_ASSETS, 6) : undefined,
  };

  // Get role constants
  const KEEPER_ROLE = await vault.KEEPER_ROLE();
  const MANAGER_ROLE = await vault.MANAGER_ROLE();
  const PAUSER_ROLE = await vault.PAUSER_ROLE();

  // Grant roles
  if (config.keeper !== ethers.ZeroAddress) {
    console.log("\nGranting KEEPER_ROLE to:", config.keeper);
    if (!(await vault.hasRole(KEEPER_ROLE, config.keeper))) {
      const tx = await vault.grantRole(KEEPER_ROLE, config.keeper);
      await tx.wait();
      console.log("  Done. TX:", tx.hash);
    } else {
      console.log("  Already has role, skipping");
    }
  }

  if (config.manager !== ethers.ZeroAddress) {
    console.log("\nGranting MANAGER_ROLE to:", config.manager);
    if (!(await vault.hasRole(MANAGER_ROLE, config.manager))) {
      const tx = await vault.grantRole(MANAGER_ROLE, config.manager);
      await tx.wait();
      console.log("  Done. TX:", tx.hash);
    } else {
      console.log("  Already has role, skipping");
    }
  }

  if (config.pauser !== ethers.ZeroAddress) {
    console.log("\nGranting PAUSER_ROLE to:", config.pauser);
    if (!(await vault.hasRole(PAUSER_ROLE, config.pauser))) {
      const tx = await vault.grantRole(PAUSER_ROLE, config.pauser);
      await tx.wait();
      console.log("  Done. TX:", tx.hash);
    } else {
      console.log("  Already has role, skipping");
    }
  }

  // Update parameters
  if (config.newFeeRecipient) {
    console.log("\nUpdating fee recipient to:", config.newFeeRecipient);
    const currentRecipient = await vault.feeRecipient();
    if (currentRecipient.toLowerCase() !== config.newFeeRecipient.toLowerCase()) {
      const tx = await vault.setFeeRecipient(config.newFeeRecipient);
      await tx.wait();
      console.log("  Done. TX:", tx.hash);
    } else {
      console.log("  Already set, skipping");
    }
  }

  if (config.newPerformanceFee !== undefined) {
    console.log("\nUpdating performance fee to:", Number(config.newPerformanceFee) / 100 + "%");
    const currentFee = await vault.performanceFeeBps();
    if (currentFee !== config.newPerformanceFee) {
      const tx = await vault.setPerformanceFee(config.newPerformanceFee);
      await tx.wait();
      console.log("  Done. TX:", tx.hash);
    } else {
      console.log("  Already set, skipping");
    }
  }

  if (config.newMaxTotalAssets !== undefined) {
    console.log("\nUpdating max total assets to:", ethers.formatUnits(config.newMaxTotalAssets, 6), "USDT");
    const currentMax = await vault.maxTotalAssets();
    if (currentMax !== config.newMaxTotalAssets) {
      const tx = await vault.setMaxTotalAssets(config.newMaxTotalAssets);
      await tx.wait();
      console.log("  Done. TX:", tx.hash);
    } else {
      console.log("  Already set, skipping");
    }
  }

  // Final state
  console.log("\n=== Final Configuration ===");
  console.log("Target LTV:", ethers.formatUnits(await vault.targetLTV(), 16) + "%");
  console.log("Performance Fee:", Number(await vault.performanceFeeBps()) / 100 + "%");
  console.log("Max Total Assets:", ethers.formatUnits(await vault.maxTotalAssets(), 6), "USDT");
  console.log("Fee Recipient:", await vault.feeRecipient());
  console.log("Paused:", await vault.paused());

  console.log("\n=== Configuration Complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
