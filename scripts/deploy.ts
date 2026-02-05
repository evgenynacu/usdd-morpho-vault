import { ethers, upgrades } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  // Configuration - adjust these for your deployment
  const config = {
    admin: deployer.address,
    feeRecipient: deployer.address, // Change for production
    targetLTV: ethers.parseUnits("0.9", 18), // 75%
    performanceFeeBps: 0n, // 0%
    maxTotalAssets: ethers.parseUnits("500000", 6), // 500k USDT
  };

  console.log("\nDeployment Configuration:");
  console.log("  Admin:", config.admin);
  console.log("  Fee Recipient:", config.feeRecipient);
  console.log("  Target LTV:", ethers.formatUnits(config.targetLTV, 16) + "%");
  console.log("  Performance Fee:", Number(config.performanceFeeBps) / 100 + "%");
  console.log("  Max Total Assets:", ethers.formatUnits(config.maxTotalAssets, 6), "USDT");

  console.log("\nDeploying SUSDDVault via UUPS proxy...");

  const VaultFactory = await ethers.getContractFactory("SUSDDVault");
  const vault = await upgrades.deployProxy(
    VaultFactory,
    [
      config.admin,
      config.feeRecipient,
      config.targetLTV,
      config.performanceFeeBps,
      config.maxTotalAssets
    ],
    { kind: "uups" }
  );

  await vault.waitForDeployment();
  const proxyAddress = await vault.getAddress();
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

  console.log("\nSUSDDVault deployed:");
  console.log("  Proxy address:", proxyAddress);
  console.log("  Implementation address:", implementationAddress);

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

  // Add admin to whitelist
  console.log("\nAdding admin to whitelist...");
  const whitelistTx = await vault.addToWhitelist(config.admin);
  await whitelistTx.wait();
  console.log("  Admin whitelisted:", await vault.whitelisted(config.admin));
  console.log("  Whitelist enabled:", await vault.whitelistEnabled());

  console.log("\n=== Deployment Complete ===");
  console.log("Proxy Address:", proxyAddress);
  console.log("Implementation Address:", implementationAddress);

  // Return for testing
  return { vault, proxyAddress, implementationAddress };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
