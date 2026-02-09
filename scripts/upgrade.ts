import { ethers, upgrades } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Upgrading contract with account:", deployer.address);

  // Get proxy address from environment
  const proxyAddress = process.env.PROXY_ADDRESS;
  if (!proxyAddress) {
    console.error("Error: PROXY_ADDRESS environment variable not set");
    console.log("Usage: PROXY_ADDRESS=0x... npx hardhat run scripts/upgrade.ts --network mainnet");
    process.exit(1);
  }

  console.log("Proxy address:", proxyAddress);

  // Get current implementation
  const currentImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  console.log("Current implementation:", currentImpl);

  // Get contract factory
  const VaultFactory = await ethers.getContractFactory("SUSDDVault");

  // Upgrade
  console.log("\nUpgrading to new implementation...");
  const vault = await upgrades.upgradeProxy(proxyAddress, VaultFactory);
  await vault.waitForDeployment();

  // Get new implementation
  const newImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  console.log("New implementation:", newImpl);

  // Verify upgrade worked by calling new function
  console.log("\nVerifying new function...");
  const currentLTV = await vault.getCurrentLTV();
  console.log("getCurrentLTV():", ethers.formatUnits(currentLTV, 16) + "%");

  // Also check existing state is preserved
  console.log("\nVerifying state preservation...");
  console.log("  totalAssets:", ethers.formatUnits(await vault.totalAssets(), 6), "USDT");
  console.log("  totalSupply:", ethers.formatUnits(await vault.totalSupply(), 6), "shares");
  console.log("  targetLTV:", ethers.formatUnits(await vault.targetLTV(), 16) + "%");
  console.log("  whitelistEnabled:", await vault.whitelistEnabled());

  console.log("\n=== Upgrade Complete ===");
  console.log("Proxy:", proxyAddress);
  console.log("Old Implementation:", currentImpl);
  console.log("New Implementation:", newImpl);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
