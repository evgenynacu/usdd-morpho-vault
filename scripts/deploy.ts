import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  // Configuration - adjust these for your deployment
  const config = {
    admin: deployer.address,
    feeRecipient: deployer.address, // Change for production
    targetLTV: ethers.parseUnits("0.75", 18), // 75%
    performanceFeeBps: 1000n, // 10%
    maxTotalAssets: ethers.parseUnits("10000000", 6), // 10M USDT
  };

  console.log("\nDeployment Configuration:");
  console.log("  Admin:", config.admin);
  console.log("  Fee Recipient:", config.feeRecipient);
  console.log("  Target LTV:", ethers.formatUnits(config.targetLTV, 16) + "%");
  console.log("  Performance Fee:", Number(config.performanceFeeBps) / 100 + "%");
  console.log("  Max Total Assets:", ethers.formatUnits(config.maxTotalAssets, 6), "USDT");

  console.log("\nDeploying SUSDDVault...");

  const VaultFactory = await ethers.getContractFactory("SUSDDVault");
  const vault = await VaultFactory.deploy(
    config.admin,
    config.feeRecipient,
    config.targetLTV,
    config.performanceFeeBps,
    config.maxTotalAssets
  );

  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();

  console.log("\nSUSDDVault deployed to:", vaultAddress);

  // Verify deployment
  console.log("\nVerifying deployment...");
  console.log("  Target LTV:", ethers.formatUnits(await vault.targetLTV(), 16) + "%");
  console.log("  Performance Fee:", Number(await vault.performanceFeeBps()) / 100 + "%");
  console.log("  Max Total Assets:", ethers.formatUnits(await vault.maxTotalAssets(), 6), "USDT");
  console.log("  Fee Recipient:", await vault.feeRecipient());
  console.log("  High Water Mark:", ethers.formatUnits(await vault.highWaterMark(), 18));

  // Check roles
  const DEFAULT_ADMIN_ROLE = await vault.DEFAULT_ADMIN_ROLE();
  const KEEPER_ROLE = await vault.KEEPER_ROLE();
  const MANAGER_ROLE = await vault.MANAGER_ROLE();
  const PAUSER_ROLE = await vault.PAUSER_ROLE();

  console.log("\nRoles:");
  console.log("  Admin has DEFAULT_ADMIN_ROLE:", await vault.hasRole(DEFAULT_ADMIN_ROLE, config.admin));
  console.log("  Admin has KEEPER_ROLE:", await vault.hasRole(KEEPER_ROLE, config.admin));
  console.log("  Admin has MANAGER_ROLE:", await vault.hasRole(MANAGER_ROLE, config.admin));
  console.log("  Admin has PAUSER_ROLE:", await vault.hasRole(PAUSER_ROLE, config.admin));

  // Check market params
  const marketParams = await vault.marketParams();
  console.log("\nCached Market Params:");
  console.log("  Loan Token:", marketParams.loanToken);
  console.log("  Collateral Token:", marketParams.collateralToken);
  console.log("  Oracle:", marketParams.oracle);
  console.log("  IRM:", marketParams.irm);
  console.log("  LLTV:", ethers.formatUnits(marketParams.lltv, 16) + "%");

  console.log("\n=== Deployment Complete ===");
  console.log("Vault Address:", vaultAddress);

  // Return for testing
  return { vault, vaultAddress };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
