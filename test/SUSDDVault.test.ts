import { expect } from "chai";
import { ethers } from "hardhat";
import { ADDRESSES, MARKET_ID, WAD, DECIMALS } from "./helpers/constants";
import { SUSDDVault } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("SUSDDVault Tests", function () {
  let vault: SUSDDVault;
  let admin: HardhatEthersSigner;
  let keeper: HardhatEthersSigner;
  let manager: HardhatEthersSigner;
  let pauser: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;

  const TARGET_LTV = ethers.parseUnits("0.75", 18); // 75%
  const PERFORMANCE_FEE = 1000n; // 10%
  const MAX_TOTAL_ASSETS = ethers.parseUnits("10000000", 6); // 10M USDT

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

    [admin, keeper, manager, pauser, user1, user2, feeRecipient] = await ethers.getSigners();
  });

  async function deployVault() {
    const VaultFactory = await ethers.getContractFactory("SUSDDVault");
    vault = await VaultFactory.deploy(
      admin.address,
      feeRecipient.address,
      TARGET_LTV,
      PERFORMANCE_FEE,
      MAX_TOTAL_ASSETS
    );
    await vault.waitForDeployment();

    // Grant roles
    await vault.connect(admin).grantRole(await vault.KEEPER_ROLE(), keeper.address);
    await vault.connect(admin).grantRole(await vault.MANAGER_ROLE(), manager.address);
    await vault.connect(admin).grantRole(await vault.PAUSER_ROLE(), pauser.address);
  }

  async function fundWithUSDT(recipient: string, amount: bigint) {
    const whaleAddress = "0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503";
    await ethers.provider.send("hardhat_impersonateAccount", [whaleAddress]);
    const whale = await ethers.getSigner(whaleAddress);
    await admin.sendTransaction({ to: whaleAddress, value: ethers.parseEther("1") });
    const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
    await usdt.connect(whale).transfer(recipient, amount);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [whaleAddress]);
  }

  describe("Deployment", function () {
    it("should deploy with correct parameters", async function () {
      await deployVault();

      expect(await vault.targetLTV()).to.equal(TARGET_LTV);
      expect(await vault.performanceFeeBps()).to.equal(PERFORMANCE_FEE);
      expect(await vault.maxTotalAssets()).to.equal(MAX_TOTAL_ASSETS);
      expect(await vault.feeRecipient()).to.equal(feeRecipient.address);
      expect(await vault.highWaterMark()).to.equal(WAD);
    });

    it("should set correct roles", async function () {
      await deployVault();

      expect(await vault.hasRole(await vault.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
      expect(await vault.hasRole(await vault.KEEPER_ROLE(), admin.address)).to.be.true;
      expect(await vault.hasRole(await vault.MANAGER_ROLE(), admin.address)).to.be.true;
      expect(await vault.hasRole(await vault.PAUSER_ROLE(), admin.address)).to.be.true;
    });

    it("should revert with invalid LTV", async function () {
      const VaultFactory = await ethers.getContractFactory("SUSDDVault");
      await expect(
        VaultFactory.deploy(
          admin.address,
          feeRecipient.address,
          ethers.parseUnits("0.95", 18), // 95% > 90% max
          PERFORMANCE_FEE,
          MAX_TOTAL_ASSETS
        )
      ).to.be.revertedWithCustomError(VaultFactory, "InvalidLTV");
    });

    it("should revert with invalid fee", async function () {
      const VaultFactory = await ethers.getContractFactory("SUSDDVault");
      await expect(
        VaultFactory.deploy(
          admin.address,
          feeRecipient.address,
          TARGET_LTV,
          5000n, // 50% > 30% max
          MAX_TOTAL_ASSETS
        )
      ).to.be.revertedWithCustomError(VaultFactory, "InvalidFee");
    });

    it("should revert with zero fee recipient", async function () {
      const VaultFactory = await ethers.getContractFactory("SUSDDVault");
      await expect(
        VaultFactory.deploy(
          admin.address,
          ethers.ZeroAddress,
          TARGET_LTV,
          PERFORMANCE_FEE,
          MAX_TOTAL_ASSETS
        )
      ).to.be.revertedWithCustomError(VaultFactory, "InvalidRecipient");
    });
  });

  describe("Role Management", function () {
    beforeEach(async function () {
      await deployVault();
    });

    it("should allow admin to grant/revoke roles", async function () {
      const KEEPER_ROLE = await vault.KEEPER_ROLE();

      // Grant role
      await vault.connect(admin).grantRole(KEEPER_ROLE, user1.address);
      expect(await vault.hasRole(KEEPER_ROLE, user1.address)).to.be.true;

      // Revoke role
      await vault.connect(admin).revokeRole(KEEPER_ROLE, user1.address);
      expect(await vault.hasRole(KEEPER_ROLE, user1.address)).to.be.false;
    });

    it("should not allow non-admin to grant roles", async function () {
      const KEEPER_ROLE = await vault.KEEPER_ROLE();
      await expect(
        vault.connect(user1).grantRole(KEEPER_ROLE, user2.address)
      ).to.be.reverted;
    });
  });

  describe("Pausable", function () {
    beforeEach(async function () {
      await deployVault();
    });

    it("should allow pauser to pause", async function () {
      await vault.connect(pauser).pause();
      expect(await vault.paused()).to.be.true;
    });

    it("should allow pauser to unpause", async function () {
      await vault.connect(pauser).pause();
      await vault.connect(pauser).unpause();
      expect(await vault.paused()).to.be.false;
    });

    it("should not allow non-pauser to pause", async function () {
      await expect(vault.connect(user1).pause()).to.be.reverted;
    });

    it("should block deposits when paused", async function () {
      await vault.connect(pauser).pause();
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);
      await fundWithUSDT(user1.address, depositAmount);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(user1).approve(await vault.getAddress(), depositAmount);

      await expect(
        vault.connect(user1).deposit(depositAmount, user1.address)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");
    });

    it("should return 0 for maxDeposit when paused", async function () {
      await vault.connect(pauser).pause();
      expect(await vault.maxDeposit(user1.address)).to.equal(0);
    });
  });

  describe("Manager Functions", function () {
    beforeEach(async function () {
      await deployVault();
    });

    it("should allow manager to set performance fee", async function () {
      await vault.connect(manager).setPerformanceFee(2000n); // 20%
      expect(await vault.performanceFeeBps()).to.equal(2000n);
    });

    it("should revert if fee too high", async function () {
      await expect(
        vault.connect(manager).setPerformanceFee(5000n) // 50% > 30% max
      ).to.be.revertedWithCustomError(vault, "InvalidFee");
    });

    it("should allow manager to set fee recipient", async function () {
      await vault.connect(manager).setFeeRecipient(user1.address);
      expect(await vault.feeRecipient()).to.equal(user1.address);
    });

    it("should revert if fee recipient is zero", async function () {
      await expect(
        vault.connect(manager).setFeeRecipient(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vault, "InvalidRecipient");
    });

    it("should allow manager to set max total assets", async function () {
      const newMax = ethers.parseUnits("5000000", 6);
      await vault.connect(manager).setMaxTotalAssets(newMax);
      expect(await vault.maxTotalAssets()).to.equal(newMax);
    });

    it("should not allow non-manager to change parameters", async function () {
      await expect(
        vault.connect(user1).setPerformanceFee(2000n)
      ).to.be.reverted;
    });
  });

  describe("Deposit (Integration)", function () {
    beforeEach(async function () {
      await deployVault();
    });

    it("should accept first deposit", async function () {
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);
      await fundWithUSDT(user1.address, depositAmount);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(user1).approve(await vault.getAddress(), depositAmount);

      const sharesBefore = await vault.balanceOf(user1.address);
      expect(sharesBefore).to.equal(0);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      const sharesAfter = await vault.balanceOf(user1.address);
      expect(sharesAfter).to.be.gt(0);

      console.log(`Deposited: ${ethers.formatUnits(depositAmount, 6)} USDT`);
      console.log(`Shares received: ${ethers.formatUnits(sharesAfter, 18)}`);

      // Check position was created
      const [collateral, debt, currentLTV] = await vault.getPosition();
      console.log(`Collateral: ${ethers.formatUnits(collateral, 18)} sUSDD`);
      console.log(`Debt: ${ethers.formatUnits(debt, 6)} USDT`);
      console.log(`Current LTV: ${ethers.formatUnits(currentLTV, 16)}%`);

      // LTV should be close to target
      const ltvDiff = currentLTV > TARGET_LTV ? currentLTV - TARGET_LTV : TARGET_LTV - currentLTV;
      expect(ltvDiff).to.be.lt(ethers.parseUnits("0.05", 18)); // Within 5%
    });

    it("should accept multiple deposits from same user", async function () {
      const depositAmount = ethers.parseUnits("500", DECIMALS.USDT);
      await fundWithUSDT(user1.address, depositAmount * 2n);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(user1).approve(await vault.getAddress(), depositAmount * 2n);

      // First deposit
      await vault.connect(user1).deposit(depositAmount, user1.address);
      const sharesAfterFirst = await vault.balanceOf(user1.address);

      // Second deposit
      await vault.connect(user1).deposit(depositAmount, user1.address);
      const sharesAfterSecond = await vault.balanceOf(user1.address);

      expect(sharesAfterSecond).to.be.gt(sharesAfterFirst);
    });

    it("should accept deposits from multiple users", async function () {
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);
      await fundWithUSDT(user1.address, depositAmount);
      await fundWithUSDT(user2.address, depositAmount);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(user1).approve(await vault.getAddress(), depositAmount);
      await usdt.connect(user2).approve(await vault.getAddress(), depositAmount);

      await vault.connect(user1).deposit(depositAmount, user1.address);
      await vault.connect(user2).deposit(depositAmount, user2.address);

      expect(await vault.balanceOf(user1.address)).to.be.gt(0);
      expect(await vault.balanceOf(user2.address)).to.be.gt(0);

      const totalAssets = await vault.totalAssets();
      console.log(`Total assets: ${ethers.formatUnits(totalAssets, 6)} USDT`);

      // Total assets should be close to total deposited (minus fees)
      expect(totalAssets).to.be.gte(ethers.parseUnits("1800", DECIMALS.USDT)); // At least 90%
    });

    it("should respect maxTotalAssets limit", async function () {
      // Set a small max
      await vault.connect(manager).setMaxTotalAssets(ethers.parseUnits("1000", DECIMALS.USDT));

      const depositAmount = ethers.parseUnits("2000", DECIMALS.USDT);
      await fundWithUSDT(user1.address, depositAmount);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(user1).approve(await vault.getAddress(), depositAmount);

      await expect(
        vault.connect(user1).deposit(depositAmount, user1.address)
      ).to.be.revertedWithCustomError(vault, "MaxTotalAssetsExceeded");
    });
  });

  describe("Withdraw (Integration)", function () {
    beforeEach(async function () {
      await deployVault();
      // Setup: deposit some USDT first
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);
      await fundWithUSDT(user1.address, depositAmount);
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);
    });

    it("should allow partial withdrawal", async function () {
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      const sharesBefore = await vault.balanceOf(user1.address);
      const usdtBefore = await usdt.balanceOf(user1.address);

      // Withdraw half
      const withdrawShares = sharesBefore / 2n;
      await vault.connect(user1).redeem(withdrawShares, user1.address, user1.address);

      const sharesAfter = await vault.balanceOf(user1.address);
      const usdtAfter = await usdt.balanceOf(user1.address);

      expect(sharesAfter).to.be.lt(sharesBefore);
      expect(usdtAfter).to.be.gt(usdtBefore);

      console.log(`Shares redeemed: ${ethers.formatUnits(withdrawShares, 18)}`);
      console.log(`USDT received: ${ethers.formatUnits(usdtAfter - usdtBefore, 6)}`);
    });

    it("should allow full withdrawal", async function () {
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      const sharesBefore = await vault.balanceOf(user1.address);

      await vault.connect(user1).redeem(sharesBefore, user1.address, user1.address);

      const sharesAfter = await vault.balanceOf(user1.address);
      const usdtAfter = await usdt.balanceOf(user1.address);

      expect(sharesAfter).to.equal(0);
      expect(usdtAfter).to.be.gt(0);

      console.log(`Full withdrawal USDT: ${ethers.formatUnits(usdtAfter, 6)}`);

      // Check position is unwound
      const [collateral, debt,] = await vault.getPosition();
      // Some dust might remain
      expect(collateral).to.be.lt(ethers.parseUnits("10", 18)); // Less than 10 sUSDD
    });

    it("should allow withdrawals when paused", async function () {
      await vault.connect(pauser).pause();

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      const sharesBefore = await vault.balanceOf(user1.address);
      const usdtBefore = await usdt.balanceOf(user1.address);

      // Should still be able to withdraw
      await vault.connect(user1).redeem(sharesBefore, user1.address, user1.address);

      const usdtAfter = await usdt.balanceOf(user1.address);
      expect(usdtAfter).to.be.gt(usdtBefore);
    });
  });

  describe("Rebalance (Integration)", function () {
    beforeEach(async function () {
      await deployVault();
      // Setup: deposit some USDT
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);
      await fundWithUSDT(user1.address, depositAmount);
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);
    });

    it("should allow keeper to rebalance", async function () {
      const [, , ltvBefore] = await vault.getPosition();
      console.log(`LTV before: ${ethers.formatUnits(ltvBefore, 16)}%`);

      // Rebalance to lower LTV
      const newLTV = ethers.parseUnits("0.5", 18); // 50%
      await vault.connect(keeper).rebalance(newLTV);

      const [, , ltvAfter] = await vault.getPosition();
      console.log(`LTV after: ${ethers.formatUnits(ltvAfter, 16)}%`);

      // LTV should be closer to new target
      const diffFromTarget = ltvAfter > newLTV ? ltvAfter - newLTV : newLTV - ltvAfter;
      expect(diffFromTarget).to.be.lt(ethers.parseUnits("0.1", 18)); // Within 10%
    });

    it("should allow full delever (LTV = 0)", async function () {
      await vault.connect(keeper).rebalance(0);

      const [collateral, debt, ltv] = await vault.getPosition();
      console.log(`After delever - Collateral: ${ethers.formatUnits(collateral, 18)}, Debt: ${ethers.formatUnits(debt, 6)}, LTV: ${ethers.formatUnits(ltv, 16)}%`);

      // Debt should be zero or very small
      expect(debt).to.be.lt(ethers.parseUnits("1", DECIMALS.USDT)); // Less than 1 USDT
    });

    it("should withdraw ALL collateral on full delever (rebalance(0))", async function () {
      // Get position before delever
      const [collateralBefore, debtBefore,] = await vault.getPosition();
      console.log(`Before delever - Collateral: ${ethers.formatUnits(collateralBefore, 18)} sUSDD, Debt: ${ethers.formatUnits(debtBefore, 6)} USDT`);

      // Sanity check: we have a leveraged position
      expect(collateralBefore).to.be.gt(0);
      expect(debtBefore).to.be.gt(0);

      // Full delever
      await vault.connect(keeper).rebalance(0);

      const [collateralAfter, debtAfter,] = await vault.getPosition();
      console.log(`After delever - Collateral: ${ethers.formatUnits(collateralAfter, 18)} sUSDD, Debt: ${ethers.formatUnits(debtAfter, 6)} USDT`);

      // Debt should be zero (or dust)
      expect(debtAfter).to.be.lt(ethers.parseUnits("1", DECIMALS.USDT));

      // Collateral should ALSO be zero (or dust) after full delever
      expect(collateralAfter).to.be.lt(ethers.parseUnits("1", 18),
        "Full delever should withdraw ALL collateral");

      // All value should now be in idle USDT
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      const idleUsdt = await usdt.balanceOf(await vault.getAddress());
      console.log(`Idle USDT after delever: ${ethers.formatUnits(idleUsdt, 6)}`);

      // Idle USDT should be close to original deposit (minus fees/slippage)
      expect(idleUsdt).to.be.gt(ethers.parseUnits("900", DECIMALS.USDT));
    });

    it("should not allow non-keeper to rebalance", async function () {
      await expect(
        vault.connect(user1).rebalance(ethers.parseUnits("0.5", 18))
      ).to.be.reverted;
    });

    it("should revert if LTV too high", async function () {
      await expect(
        vault.connect(keeper).rebalance(ethers.parseUnits("0.95", 18)) // 95% > 90% max
      ).to.be.revertedWithCustomError(vault, "InvalidLTV");
    });

    it("should not allow rebalance when paused", async function () {
      await vault.connect(pauser).pause();
      await expect(
        vault.connect(keeper).rebalance(ethers.parseUnits("0.5", 18))
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");
    });

    it("should do nothing when nav is zero (no position, no idle)", async function () {
      // Deploy fresh vault with no deposits
      const VaultFactory = await ethers.getContractFactory("SUSDDVault");
      const freshVault = await VaultFactory.deploy(
        admin.address,
        feeRecipient.address,
        TARGET_LTV,
        PERFORMANCE_FEE,
        MAX_TOTAL_ASSETS
      );
      await freshVault.waitForDeployment();
      await freshVault.connect(admin).grantRole(await freshVault.KEEPER_ROLE(), keeper.address);

      // NAV should be 0
      expect(await freshVault.totalAssets()).to.equal(0);

      // Rebalance should update targetLTV but not revert
      const newLTV = ethers.parseUnits("0.5", 18);
      await freshVault.connect(keeper).rebalance(newLTV);

      // targetLTV should be updated
      expect(await freshVault.targetLTV()).to.equal(newLTV);

      // But no position should exist
      const [collateral, debt,] = await freshVault.getPosition();
      expect(collateral).to.equal(0);
      expect(debt).to.equal(0);
    });

    it("should withdraw all collateral when rebalance(0) called with zero debt", async function () {
      // Edge case: collateral > 0 but debt = 0
      // This can happen if debt was repaid externally or through interest mechanics

      // Setup: Create a leveraged position, then externally repay the debt
      // We already have a position from beforeEach

      const [collateralBefore, debtBefore,] = await vault.getPosition();
      console.log(`Initial position - Collateral: ${ethers.formatUnits(collateralBefore, 18)}, Debt: ${ethers.formatUnits(debtBefore, 6)}`);
      expect(collateralBefore).to.be.gt(0);
      expect(debtBefore).to.be.gt(0);

      // Get market params from Morpho
      const morpho = await ethers.getContractAt("IMorpho", ADDRESSES.MORPHO);
      const marketParams = await morpho.idToMarketParams(MARKET_ID);

      const vaultAddress = await vault.getAddress();

      // Fund the vault with USDT to repay debt
      await fundWithUSDT(vaultAddress, debtBefore + ethers.parseUnits("10", DECIMALS.USDT));

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);

      // Impersonate vault to call repay directly on Morpho
      await ethers.provider.send("hardhat_impersonateAccount", [vaultAddress]);
      const vaultSigner = await ethers.getSigner(vaultAddress);
      await admin.sendTransaction({ to: vaultAddress, value: ethers.parseEther("1") });

      await usdt.connect(vaultSigner).approve(ADDRESSES.MORPHO, debtBefore + ethers.parseUnits("10", DECIMALS.USDT));

      // Repay all debt externally (simulating external repayment scenario)
      await morpho.connect(vaultSigner).repay(
        marketParams,
        debtBefore + ethers.parseUnits("1", DECIMALS.USDT), // Repay a bit more to cover interest
        0, // shares (0 = use assets)
        vaultAddress,
        "0x"
      );
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddress]);

      // Verify: collateral > 0, debt ~= 0
      const [collateralAfterRepay, debtAfterRepay,] = await vault.getPosition();
      console.log(`After external repay - Collateral: ${ethers.formatUnits(collateralAfterRepay, 18)}, Debt: ${ethers.formatUnits(debtAfterRepay, 6)}`);
      expect(collateralAfterRepay).to.be.gt(0);
      expect(debtAfterRepay).to.be.lt(ethers.parseUnits("1", DECIMALS.USDT)); // Near zero

      // Now call rebalance(0) - should withdraw ALL collateral even though debt is already 0
      await vault.connect(keeper).rebalance(0);

      // Verify: collateral should now be 0
      const [collateralAfter, debtAfter,] = await vault.getPosition();
      console.log(`After rebalance(0) - Collateral: ${ethers.formatUnits(collateralAfter, 18)}, Debt: ${ethers.formatUnits(debtAfter, 6)}`);

      expect(collateralAfter).to.be.lt(ethers.parseUnits("1", 18),
        "rebalance(0) should withdraw all collateral even when debt is already 0");
    });

    it("should re-lever from idle after full delever", async function () {
      // Step 1: We already have a position from beforeEach
      const [collateralBefore, debtBefore,] = await vault.getPosition();
      console.log(`Initial position - Collateral: ${ethers.formatUnits(collateralBefore, 18)}, Debt: ${ethers.formatUnits(debtBefore, 6)}`);
      expect(collateralBefore).to.be.gt(0);
      expect(debtBefore).to.be.gt(0);

      // Step 2: Full delever - convert everything to idle USDT
      await vault.connect(keeper).rebalance(0);

      const [collateralAfterDelever, debtAfterDelever,] = await vault.getPosition();
      console.log(`After delever - Collateral: ${ethers.formatUnits(collateralAfterDelever, 18)}, Debt: ${ethers.formatUnits(debtAfterDelever, 6)}`);

      // Position should be unwound (minimal dust)
      expect(debtAfterDelever).to.be.lt(ethers.parseUnits("1", DECIMALS.USDT));

      // Check idle USDT exists
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      const vaultAddress = await vault.getAddress();
      const idleUsdt = await usdt.balanceOf(vaultAddress);
      console.log(`Idle USDT after delever: ${ethers.formatUnits(idleUsdt, 6)}`);
      expect(idleUsdt).to.be.gt(0);

      // Step 3: Re-lever from idle
      const newLTV = ethers.parseUnits("0.6", 18); // 60%
      await vault.connect(keeper).rebalance(newLTV);

      const [collateralAfterRelever, debtAfterRelever, ltvAfterRelever] = await vault.getPosition();
      console.log(`After re-lever - Collateral: ${ethers.formatUnits(collateralAfterRelever, 18)}, Debt: ${ethers.formatUnits(debtAfterRelever, 6)}, LTV: ${ethers.formatUnits(ltvAfterRelever, 16)}%`);

      // Position should be rebuilt
      expect(collateralAfterRelever).to.be.gt(0);
      expect(debtAfterRelever).to.be.gt(0);

      // LTV should be close to target
      const ltvDiff = ltvAfterRelever > newLTV ? ltvAfterRelever - newLTV : newLTV - ltvAfterRelever;
      expect(ltvDiff).to.be.lt(ethers.parseUnits("0.1", 18)); // Within 10%

      // Idle USDT should be consumed
      const idleUsdtAfter = await usdt.balanceOf(vaultAddress);
      console.log(`Idle USDT after re-lever: ${ethers.formatUnits(idleUsdtAfter, 6)}`);
      expect(idleUsdtAfter).to.be.lt(idleUsdt);
    });
  });

  describe("Emergency Withdraw", function () {
    beforeEach(async function () {
      await deployVault();
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);
      await fundWithUSDT(user1.address, depositAmount);
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);
    });

    it("should allow admin to emergency withdraw", async function () {
      const [collateralBefore, debtBefore,] = await vault.getPosition();
      console.log(`Before emergency: Collateral ${ethers.formatUnits(collateralBefore, 18)}, Debt ${ethers.formatUnits(debtBefore, 6)}`);

      await vault.connect(admin).emergencyWithdraw();

      const [collateralAfter, debtAfter,] = await vault.getPosition();
      console.log(`After emergency: Collateral ${ethers.formatUnits(collateralAfter, 18)}, Debt ${ethers.formatUnits(debtAfter, 6)}`);

      // Should be paused
      expect(await vault.paused()).to.be.true;

      // Position should be unwound
      expect(debtAfter).to.be.lt(ethers.parseUnits("1", DECIMALS.USDT));

      // Users should still be able to withdraw
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      const shares = await vault.balanceOf(user1.address);
      await vault.connect(user1).redeem(shares, user1.address, user1.address);
      expect(await usdt.balanceOf(user1.address)).to.be.gt(0);
    });

    it("should not allow non-admin to emergency withdraw", async function () {
      await expect(
        vault.connect(user1).emergencyWithdraw()
      ).to.be.reverted;
    });
  });

  describe("NAV Calculation", function () {
    beforeEach(async function () {
      await deployVault();
    });

    it("should calculate totalAssets correctly with no position", async function () {
      expect(await vault.totalAssets()).to.equal(0);
    });

    it("should calculate totalAssets correctly after deposit", async function () {
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);
      await fundWithUSDT(user1.address, depositAmount);
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const totalAssets = await vault.totalAssets();
      console.log(`Total assets: ${ethers.formatUnits(totalAssets, 6)} USDT`);

      // Total assets should be close to deposited amount (accounting for fees)
      expect(totalAssets).to.be.gte(ethers.parseUnits("900", DECIMALS.USDT));
      expect(totalAssets).to.be.lte(ethers.parseUnits("1100", DECIMALS.USDT));
    });

    it("should report healthy position", async function () {
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);
      await fundWithUSDT(user1.address, depositAmount);
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      expect(await vault.isHealthy()).to.be.true;
    });
  });
});
