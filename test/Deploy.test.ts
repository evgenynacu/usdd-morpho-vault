import { expect } from "chai";
import { ethers } from "hardhat";
import { ADDRESSES } from "./helpers/constants";
import { SUSDDVault } from "../typechain-types";

describe("Deploy Script Tests (Fork)", function () {
  // Skip if not forking mainnet
  before(async function () {
    const network = await ethers.provider.getNetwork();
    if (network.chainId !== 1n && network.chainId !== 31337n) {
      this.skip();
    }
    const code = await ethers.provider.getCode(ADDRESSES.MORPHO);
    if (code === "0x") {
      console.log("Skipping fork tests - no mainnet fork detected");
      this.skip();
    }
  });

  describe("Deployment", function () {
    it("should deploy vault correctly", async function () {
      const [deployer] = await ethers.getSigners();

      const config = {
        admin: deployer.address,
        feeRecipient: deployer.address,
        targetLTV: ethers.parseUnits("0.75", 18),
        performanceFeeBps: 1000n,
        maxTotalAssets: ethers.parseUnits("10000000", 6),
      };

      const VaultFactory = await ethers.getContractFactory("SUSDDVault");
      const vault = await VaultFactory.deploy(
        config.admin,
        config.feeRecipient,
        config.targetLTV,
        config.performanceFeeBps,
        config.maxTotalAssets
      );
      await vault.waitForDeployment();

      // Verify basic config
      expect(await vault.targetLTV()).to.equal(config.targetLTV);
      expect(await vault.performanceFeeBps()).to.equal(config.performanceFeeBps);
      expect(await vault.maxTotalAssets()).to.equal(config.maxTotalAssets);
      expect(await vault.feeRecipient()).to.equal(config.feeRecipient);

      // Verify roles
      const DEFAULT_ADMIN_ROLE = await vault.DEFAULT_ADMIN_ROLE();
      expect(await vault.hasRole(DEFAULT_ADMIN_ROLE, config.admin)).to.be.true;

      // Verify market params are cached correctly
      const marketParams = await vault.marketParams();
      expect(marketParams.loanToken.toLowerCase()).to.equal(ADDRESSES.USDT.toLowerCase());
      expect(marketParams.collateralToken.toLowerCase()).to.equal(ADDRESSES.SUSDD.toLowerCase());

      console.log("Vault deployed to:", await vault.getAddress());
    });

    it("should have correct ERC4626 metadata", async function () {
      const [deployer] = await ethers.getSigners();

      const VaultFactory = await ethers.getContractFactory("SUSDDVault");
      const vault = await VaultFactory.deploy(
        deployer.address,
        deployer.address,
        ethers.parseUnits("0.75", 18),
        1000n,
        ethers.parseUnits("10000000", 6)
      );
      await vault.waitForDeployment();

      expect(await vault.name()).to.equal("Leveraged sUSDD Vault");
      expect(await vault.symbol()).to.equal("lsUSDD");
      expect(await vault.decimals()).to.equal(6); // Same as underlying USDT
      expect(await vault.asset()).to.equal(ADDRESSES.USDT);
    });

    it("should have Morpho approvals set", async function () {
      const [deployer] = await ethers.getSigners();

      const VaultFactory = await ethers.getContractFactory("SUSDDVault");
      const vault = await VaultFactory.deploy(
        deployer.address,
        deployer.address,
        ethers.parseUnits("0.75", 18),
        1000n,
        ethers.parseUnits("10000000", 6)
      );
      await vault.waitForDeployment();

      const vaultAddress = await vault.getAddress();
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      const susdd = await ethers.getContractAt("IERC20", ADDRESSES.SUSDD);

      // Check unlimited approvals to Morpho
      const usdtAllowance = await usdt.allowance(vaultAddress, ADDRESSES.MORPHO);
      const susddAllowance = await susdd.allowance(vaultAddress, ADDRESSES.MORPHO);

      expect(usdtAllowance).to.equal(ethers.MaxUint256);
      expect(susddAllowance).to.equal(ethers.MaxUint256);
    });
  });

  describe("Configuration", function () {
    let vault: SUSDDVault;
    let admin: any;
    let keeper: any;
    let manager: any;
    let pauser: any;

    beforeEach(async function () {
      [admin, keeper, manager, pauser] = await ethers.getSigners();

      const VaultFactory = await ethers.getContractFactory("SUSDDVault");
      vault = await VaultFactory.deploy(
        admin.address,
        admin.address,
        ethers.parseUnits("0.75", 18),
        1000n,
        ethers.parseUnits("10000000", 6)
      );
      await vault.waitForDeployment();
    });

    it("should allow granting roles after deployment", async function () {
      const KEEPER_ROLE = await vault.KEEPER_ROLE();
      const MANAGER_ROLE = await vault.MANAGER_ROLE();
      const PAUSER_ROLE = await vault.PAUSER_ROLE();

      // Grant roles
      await vault.connect(admin).grantRole(KEEPER_ROLE, keeper.address);
      await vault.connect(admin).grantRole(MANAGER_ROLE, manager.address);
      await vault.connect(admin).grantRole(PAUSER_ROLE, pauser.address);

      // Verify
      expect(await vault.hasRole(KEEPER_ROLE, keeper.address)).to.be.true;
      expect(await vault.hasRole(MANAGER_ROLE, manager.address)).to.be.true;
      expect(await vault.hasRole(PAUSER_ROLE, pauser.address)).to.be.true;
    });

    it("should allow updating parameters after deployment", async function () {
      // Update fee recipient
      await vault.connect(admin).setFeeRecipient(keeper.address);
      expect(await vault.feeRecipient()).to.equal(keeper.address);

      // Update performance fee
      await vault.connect(admin).setPerformanceFee(2000n);
      expect(await vault.performanceFeeBps()).to.equal(2000n);

      // Update max total assets
      const newMax = ethers.parseUnits("5000000", 6);
      await vault.connect(admin).setMaxTotalAssets(newMax);
      expect(await vault.maxTotalAssets()).to.equal(newMax);
    });
  });
});
