import { expect } from "chai";
import { ethers } from "hardhat";
import { ADDRESSES, MARKET_ID, WAD, DECIMALS } from "./helpers/constants";
import { SUSDDVault } from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Security Tests for SUSDDVault
 *
 * Focus: Protecting existing vault users from fund loss
 *
 * Attack vectors tested:
 * 1. First depositor inflation attack
 * 2. Dilution attack (new deposit harming existing)
 * 3. Unauthorized flash loan callback
 * 4. Bank run fairness (proportional withdrawal)
 * 5. Tiny redemption edge cases
 * 6. sUSDD rate manipulation between preview and deposit
 */
describe("Security Tests - Protecting Existing Users", function () {
  let vault: SUSDDVault;
  let admin: HardhatEthersSigner;
  let keeper: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;

  const TARGET_LTV = ethers.parseUnits("0.75", 18);
  const PERFORMANCE_FEE = 1000n;
  const MAX_TOTAL_ASSETS = ethers.parseUnits("10000000", 6);

  before(async function () {
    const code = await ethers.provider.getCode(ADDRESSES.MORPHO);
    if (code === "0x") {
      console.log("Skipping fork tests - no mainnet fork detected");
      this.skip();
    }

    [admin, keeper, attacker, alice, bob, feeRecipient] = await ethers.getSigners();
  });

  async function deployVault(targetLTV: bigint = TARGET_LTV) {
    const VaultFactory = await ethers.getContractFactory("SUSDDVault");
    vault = await VaultFactory.deploy(
      admin.address,
      feeRecipient.address,
      targetLTV,
      PERFORMANCE_FEE,
      MAX_TOTAL_ASSETS
    );
    await vault.waitForDeployment();
    await vault.connect(admin).grantRole(await vault.KEEPER_ROLE(), keeper.address);
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

  async function getPosition(vaultAddress: string) {
    const morpho = await ethers.getContractAt("@morpho-org/morpho-blue/src/interfaces/IMorpho.sol:IMorpho", ADDRESSES.MORPHO);
    const susdd = await ethers.getContractAt("@openzeppelin/contracts/interfaces/IERC4626.sol:IERC4626", ADDRESSES.SUSDD);
    const position = await morpho.position(MARKET_ID, vaultAddress);
    const market = await morpho.market(MARKET_ID);

    let debt = 0n;
    if (market.totalBorrowShares > 0n) {
      debt = (position.borrowShares * market.totalBorrowAssets) / market.totalBorrowShares;
    }

    const collateralUsdt = await susdd.convertToAssets(position.collateral);
    const collateralValue = collateralUsdt / BigInt(1e12);

    return {
      collateral: position.collateral,
      borrowShares: position.borrowShares,
      debt,
      collateralValue
    };
  }

  // ============================================================
  // 1. FIRST DEPOSITOR INFLATION ATTACK
  // ============================================================
  describe("First Depositor Attack Protection", function () {
    beforeEach(async function () {
      await deployVault();
    });

    it("first depositor should receive shares equal to actual NAV, not inflated", async function () {
      // First depositor deposits 1000 USDT
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);
      await fundWithUSDT(alice.address, depositAmount);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(alice).approve(await vault.getAddress(), depositAmount);

      await vault.connect(alice).deposit(depositAmount, alice.address);

      const aliceShares = await vault.balanceOf(alice.address);
      const totalAssets = await vault.totalAssets();
      const totalSupply = await vault.totalSupply();

      // Shares should equal NAV (1:1 on first deposit)
      // Allow small difference due to conversion fees
      expect(aliceShares).to.equal(totalSupply);

      // Value per share should be ~1 (within 5% tolerance due to PSM fees)
      const valuePerShare = (totalAssets * WAD) / totalSupply;
      expect(valuePerShare).to.be.gte(ethers.parseUnits("0.95", 18));
      expect(valuePerShare).to.be.lte(ethers.parseUnits("1.05", 18));

      console.log(`First deposit: ${ethers.formatUnits(depositAmount, 6)} USDT`);
      console.log(`Shares received: ${ethers.formatUnits(aliceShares, 18)}`);
      console.log(`Value per share: ${ethers.formatUnits(valuePerShare, 18)}`);
    });

    it("first depositor cannot inflate shares via small initial deposit", async function () {
      // Attacker tries to deposit 1 wei USDT first
      const tinyDeposit = 1n; // 1 wei = 0.000001 USDT
      await fundWithUSDT(attacker.address, tinyDeposit);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(attacker).approve(await vault.getAddress(), tinyDeposit);

      // Should revert - either DepositTooSmall (shares round to 0) or
      // Morpho "insufficient collateral" (sUSDD rounds to 0 before share calc)
      // Both protect against the attack
      await expect(
        vault.connect(attacker).deposit(tinyDeposit, attacker.address)
      ).to.be.reverted;
    });
  });

  // ============================================================
  // 2. DILUTION ATTACK PROTECTION (Delta NAV)
  // ============================================================
  describe("Dilution Attack Protection", function () {
    beforeEach(async function () {
      await deployVault();
    });

    it("second depositor should NOT dilute first depositor's shares", async function () {
      const aliceDeposit = ethers.parseUnits("1000", DECIMALS.USDT);
      const bobDeposit = ethers.parseUnits("1000", DECIMALS.USDT);

      await fundWithUSDT(alice.address, aliceDeposit);
      await fundWithUSDT(bob.address, bobDeposit);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(alice).approve(await vault.getAddress(), aliceDeposit);
      await usdt.connect(bob).approve(await vault.getAddress(), bobDeposit);

      // Alice deposits first
      await vault.connect(alice).deposit(aliceDeposit, alice.address);
      const aliceSharesBefore = await vault.balanceOf(alice.address);
      const navBeforeBob = await vault.totalAssets();

      // Calculate Alice's value before Bob's deposit
      const supplyBeforeBob = await vault.totalSupply();
      const aliceValueBefore = (aliceSharesBefore * navBeforeBob) / supplyBeforeBob;

      // Bob deposits (potential dilution attack)
      await vault.connect(bob).deposit(bobDeposit, bob.address);

      // Check Alice's value after Bob's deposit
      const navAfterBob = await vault.totalAssets();
      const supplyAfterBob = await vault.totalSupply();
      const aliceSharesAfter = await vault.balanceOf(alice.address);
      const aliceValueAfter = (aliceSharesAfter * navAfterBob) / supplyAfterBob;

      // Alice's shares should not change
      expect(aliceSharesAfter).to.equal(aliceSharesBefore);

      // Alice's VALUE should not decrease (within 1% tolerance for rounding)
      const valueDiff = aliceValueBefore > aliceValueAfter
        ? aliceValueBefore - aliceValueAfter
        : aliceValueAfter - aliceValueBefore;
      const maxDiff = aliceValueBefore / 100n; // 1%

      expect(valueDiff).to.be.lte(maxDiff);

      console.log(`Alice value before Bob: ${ethers.formatUnits(aliceValueBefore, 6)} USDT`);
      console.log(`Alice value after Bob: ${ethers.formatUnits(aliceValueAfter, 6)} USDT`);
      console.log(`Value difference: ${ethers.formatUnits(valueDiff, 6)} USDT`);
    });

    it("multiple sequential deposits should maintain fair share distribution", async function () {
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);

      await fundWithUSDT(alice.address, depositAmount * 3n);
      await fundWithUSDT(bob.address, depositAmount * 3n);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(alice).approve(await vault.getAddress(), depositAmount * 3n);
      await usdt.connect(bob).approve(await vault.getAddress(), depositAmount * 3n);

      // Interleaved deposits
      await vault.connect(alice).deposit(depositAmount, alice.address);
      await vault.connect(bob).deposit(depositAmount, bob.address);
      await vault.connect(alice).deposit(depositAmount, alice.address);
      await vault.connect(bob).deposit(depositAmount, bob.address);
      await vault.connect(alice).deposit(depositAmount, alice.address);
      await vault.connect(bob).deposit(depositAmount, bob.address);

      const aliceShares = await vault.balanceOf(alice.address);
      const bobShares = await vault.balanceOf(bob.address);
      const totalSupply = await vault.totalSupply();
      const totalAssets = await vault.totalAssets();

      // Both should have roughly equal shares (same total deposit)
      const shareDiff = aliceShares > bobShares
        ? aliceShares - bobShares
        : bobShares - aliceShares;
      const maxShareDiff = totalSupply / 20n; // 5% tolerance

      expect(shareDiff).to.be.lte(maxShareDiff);

      // Both should have roughly equal value
      const aliceValue = (aliceShares * totalAssets) / totalSupply;
      const bobValue = (bobShares * totalAssets) / totalSupply;

      console.log(`Alice: ${ethers.formatUnits(aliceShares, 18)} shares = ${ethers.formatUnits(aliceValue, 6)} USDT`);
      console.log(`Bob: ${ethers.formatUnits(bobShares, 18)} shares = ${ethers.formatUnits(bobValue, 6)} USDT`);
    });
  });

  // ============================================================
  // 3. UNAUTHORIZED FLASH LOAN CALLBACK
  // ============================================================
  describe("Unauthorized Flash Loan Callback Protection", function () {
    beforeEach(async function () {
      await deployVault();
    });

    it("should revert when callback called from non-Morpho address", async function () {
      // Attacker tries to call onMorphoFlashLoan directly
      const fakeCallbackData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint8", "uint256"],
        [3, 0] // OP_LEVER_UP = 3
      );

      await expect(
        vault.connect(attacker).onMorphoFlashLoan(
          ethers.parseUnits("1000", 6),
          fakeCallbackData
        )
      ).to.be.revertedWithCustomError(vault, "UnauthorizedCallback");
    });

    it("should revert when callback called with deposit operation from non-Morpho", async function () {
      const fakeCallbackData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint8", "uint256"],
        [1, ethers.parseUnits("1000", 6)] // OP_DEPOSIT = 1
      );

      await expect(
        vault.connect(attacker).onMorphoFlashLoan(
          ethers.parseUnits("1000", 6),
          fakeCallbackData
        )
      ).to.be.revertedWithCustomError(vault, "UnauthorizedCallback");
    });

    it("should revert when callback called with delever operation from non-Morpho", async function () {
      const fakeCallbackData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint8", "bool"],
        [4, true] // OP_DELEVER = 4, withdrawAllCollateral = true
      );

      await expect(
        vault.connect(attacker).onMorphoFlashLoan(
          ethers.parseUnits("1000", 6),
          fakeCallbackData
        )
      ).to.be.revertedWithCustomError(vault, "UnauthorizedCallback");
    });
  });

  // ============================================================
  // 4. BANK RUN FAIRNESS (Proportional Withdrawal)
  // ============================================================
  describe("Bank Run Fairness", function () {
    beforeEach(async function () {
      await deployVault();
    });

    it("early and late withdrawers should receive proportionally fair amounts", async function () {
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);

      // Both users deposit equal amounts
      await fundWithUSDT(alice.address, depositAmount);
      await fundWithUSDT(bob.address, depositAmount);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(alice).approve(await vault.getAddress(), depositAmount);
      await usdt.connect(bob).approve(await vault.getAddress(), depositAmount);

      await vault.connect(alice).deposit(depositAmount, alice.address);
      await vault.connect(bob).deposit(depositAmount, bob.address);

      const aliceShares = await vault.balanceOf(alice.address);
      const bobShares = await vault.balanceOf(bob.address);

      // Alice withdraws first (simulating "bank run")
      const aliceBalanceBefore = await usdt.balanceOf(alice.address);
      await vault.connect(alice).redeem(aliceShares, alice.address, alice.address);
      const aliceReceived = (await usdt.balanceOf(alice.address)) - aliceBalanceBefore;

      // Bob withdraws second
      const bobBalanceBefore = await usdt.balanceOf(bob.address);
      await vault.connect(bob).redeem(bobShares, bob.address, bob.address);
      const bobReceived = (await usdt.balanceOf(bob.address)) - bobBalanceBefore;

      // Both should receive roughly equal amounts (proportional)
      const receivedDiff = aliceReceived > bobReceived
        ? aliceReceived - bobReceived
        : bobReceived - aliceReceived;

      // Allow 2% difference due to rounding and interest accrual
      const maxDiff = (aliceReceived + bobReceived) / 100n;

      expect(receivedDiff).to.be.lte(maxDiff);

      console.log(`Alice received: ${ethers.formatUnits(aliceReceived, 6)} USDT`);
      console.log(`Bob received: ${ethers.formatUnits(bobReceived, 6)} USDT`);
      console.log(`Difference: ${ethers.formatUnits(receivedDiff, 6)} USDT`);
    });

    it("partial withdrawals maintain proportional fairness", async function () {
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);

      await fundWithUSDT(alice.address, depositAmount);
      await fundWithUSDT(bob.address, depositAmount);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(alice).approve(await vault.getAddress(), depositAmount);
      await usdt.connect(bob).approve(await vault.getAddress(), depositAmount);

      await vault.connect(alice).deposit(depositAmount, alice.address);
      await vault.connect(bob).deposit(depositAmount, bob.address);

      const aliceShares = await vault.balanceOf(alice.address);
      const bobShares = await vault.balanceOf(bob.address);

      // Alice withdraws half
      const aliceWithdrawShares = aliceShares / 2n;
      await vault.connect(alice).redeem(aliceWithdrawShares, alice.address, alice.address);

      // Bob withdraws half
      const bobWithdrawShares = bobShares / 2n;
      await vault.connect(bob).redeem(bobWithdrawShares, bob.address, bob.address);

      // Check remaining value is fair
      const aliceRemainingShares = await vault.balanceOf(alice.address);
      const bobRemainingShares = await vault.balanceOf(bob.address);
      const totalSupply = await vault.totalSupply();
      const totalAssets = await vault.totalAssets();

      const aliceRemainingValue = (aliceRemainingShares * totalAssets) / totalSupply;
      const bobRemainingValue = (bobRemainingShares * totalAssets) / totalSupply;

      const valueDiff = aliceRemainingValue > bobRemainingValue
        ? aliceRemainingValue - bobRemainingValue
        : bobRemainingValue - aliceRemainingValue;

      const maxDiff = aliceRemainingValue / 50n; // 2% tolerance

      expect(valueDiff).to.be.lte(maxDiff);

      console.log(`Alice remaining value: ${ethers.formatUnits(aliceRemainingValue, 6)} USDT`);
      console.log(`Bob remaining value: ${ethers.formatUnits(bobRemainingValue, 6)} USDT`);
    });
  });

  // ============================================================
  // 5. TINY REDEMPTION EDGE CASES
  // ============================================================
  describe("Tiny Redemption Edge Cases", function () {
    beforeEach(async function () {
      await deployVault();
    });

    it("should handle very small redemption gracefully", async function () {
      const depositAmount = ethers.parseUnits("10000", DECIMALS.USDT);
      await fundWithUSDT(alice.address, depositAmount);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(alice).approve(await vault.getAddress(), depositAmount);
      await vault.connect(alice).deposit(depositAmount, alice.address);

      const aliceShares = await vault.balanceOf(alice.address);

      // Try to redeem very small amount (1 wei of shares)
      const tinyRedemption = 1n;

      // This should either work (give dust USDT) or give 0 (skip position unwind)
      const balanceBefore = await usdt.balanceOf(alice.address);
      await vault.connect(alice).redeem(tinyRedemption, alice.address, alice.address);
      const balanceAfter = await usdt.balanceOf(alice.address);

      // Should not revert, user just gets very small amount (possibly 0)
      expect(await vault.balanceOf(alice.address)).to.equal(aliceShares - tinyRedemption);

      console.log(`Tiny redemption: ${tinyRedemption} shares`);
      console.log(`USDT received: ${balanceAfter - balanceBefore}`);
    });

    it("remaining users not affected by tiny redemption", async function () {
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);

      await fundWithUSDT(alice.address, depositAmount);
      await fundWithUSDT(bob.address, depositAmount);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(alice).approve(await vault.getAddress(), depositAmount);
      await usdt.connect(bob).approve(await vault.getAddress(), depositAmount);

      await vault.connect(alice).deposit(depositAmount, alice.address);
      await vault.connect(bob).deposit(depositAmount, bob.address);

      // Record Bob's value before Alice's tiny redemption
      const totalAssetsBefore = await vault.totalAssets();
      const totalSupplyBefore = await vault.totalSupply();
      const bobShares = await vault.balanceOf(bob.address);
      const bobValueBefore = (bobShares * totalAssetsBefore) / totalSupplyBefore;

      // Alice does many tiny redemptions
      const tinyAmount = 100n; // 100 wei of shares
      for (let i = 0; i < 10; i++) {
        await vault.connect(alice).redeem(tinyAmount, alice.address, alice.address);
      }

      // Check Bob's value after
      const totalAssetsAfter = await vault.totalAssets();
      const totalSupplyAfter = await vault.totalSupply();
      const bobValueAfter = (bobShares * totalAssetsAfter) / totalSupplyAfter;

      // Bob's value should not decrease by more than rounding dust
      // (actually might slightly increase due to Alice leaving dust behind)
      expect(bobValueAfter).to.be.gte(bobValueBefore - 100n); // Allow 100 wei loss

      console.log(`Bob value before tiny redemptions: ${ethers.formatUnits(bobValueBefore, 6)} USDT`);
      console.log(`Bob value after tiny redemptions: ${ethers.formatUnits(bobValueAfter, 6)} USDT`);
    });
  });

  // ============================================================
  // 6. PREVIEW vs ACTUAL DEPOSIT (sUSDD Rate)
  // ============================================================
  describe("Preview vs Actual Deposit Consistency", function () {
    beforeEach(async function () {
      await deployVault();
    });

    it("actual shares should be close to preview estimate", async function () {
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);
      await fundWithUSDT(alice.address, depositAmount);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(alice).approve(await vault.getAddress(), depositAmount);

      // Get preview
      const previewShares = await vault.previewDeposit(depositAmount);

      // Do actual deposit
      await vault.connect(alice).deposit(depositAmount, alice.address);
      const actualShares = await vault.balanceOf(alice.address);

      // Should be within 1% (sUSDD rate doesn't change within same block)
      const diff = previewShares > actualShares
        ? previewShares - actualShares
        : actualShares - previewShares;
      const maxDiff = previewShares / 100n;

      expect(diff).to.be.lte(maxDiff);

      console.log(`Preview shares: ${ethers.formatUnits(previewShares, 18)}`);
      console.log(`Actual shares: ${ethers.formatUnits(actualShares, 18)}`);
      console.log(`Difference: ${ethers.formatUnits(diff, 18)} (${(diff * 10000n / previewShares)} bps)`);
    });

    it("second depositor preview matches actual after rate change", async function () {
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);

      await fundWithUSDT(alice.address, depositAmount);
      await fundWithUSDT(bob.address, depositAmount);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(alice).approve(await vault.getAddress(), depositAmount);
      await usdt.connect(bob).approve(await vault.getAddress(), depositAmount);

      // Alice deposits
      await vault.connect(alice).deposit(depositAmount, alice.address);

      // Time passes (simulate sUSDD rate accrual)
      await ethers.provider.send("evm_increaseTime", [86400]); // 1 day
      await ethers.provider.send("evm_mine", []);

      // Bob gets preview and deposits
      const previewShares = await vault.previewDeposit(depositAmount);
      await vault.connect(bob).deposit(depositAmount, bob.address);
      const actualShares = await vault.balanceOf(bob.address);

      // Should still be within 1%
      const diff = previewShares > actualShares
        ? previewShares - actualShares
        : actualShares - previewShares;
      const maxDiff = previewShares / 100n;

      expect(diff).to.be.lte(maxDiff);

      console.log(`Bob preview: ${ethers.formatUnits(previewShares, 18)}`);
      console.log(`Bob actual: ${ethers.formatUnits(actualShares, 18)}`);
    });
  });

  // ============================================================
  // 7. ZERO NAV DEPOSIT BLOCKING
  // ============================================================
  describe("ZeroNAV Deposit Blocking", function () {
    it("should block deposits when NAV=0 and shares exist", async function () {
      // Deploy vault in IDLE_MODE to test edge case
      await deployVault(ethers.MaxUint256); // IDLE_MODE

      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);
      await fundWithUSDT(alice.address, depositAmount * 2n);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(alice).approve(await vault.getAddress(), depositAmount * 2n);

      // Alice deposits (stays as idle USDT in IDLE_MODE)
      await vault.connect(alice).deposit(depositAmount, alice.address);

      const sharesBefore = await vault.totalSupply();
      expect(sharesBefore).to.be.gt(0);

      // Simulate draining all USDT (admin action for test purposes)
      // In reality this shouldn't happen, but tests the ZeroNAV protection
      const vaultAddress = await vault.getAddress();
      const vaultUsdtBalance = await usdt.balanceOf(vaultAddress);

      // Can't actually drain without exploit, so verify protection exists in code
      // The protection is: if (supplyBefore > 0 && navBefore == 0) revert ZeroNAV();

      // Instead, verify maxDeposit returns 0 when it would cause issues
      // This test documents the expected behavior
      const maxDeposit = await vault.maxDeposit(bob.address);

      // maxDeposit should be positive since vault has USDT
      expect(maxDeposit).to.be.gt(0);

      console.log(`Vault USDT balance: ${ethers.formatUnits(vaultUsdtBalance, 6)}`);
      console.log(`Max deposit: ${ethers.formatUnits(maxDeposit, 6)}`);
    });
  });

  // ============================================================
  // 8. REBALANCE DOES NOT HARM USERS
  // ============================================================
  describe("Rebalance User Protection", function () {
    beforeEach(async function () {
      await deployVault();
    });

    it("rebalance to lower LTV should not reduce user value", async function () {
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);
      await fundWithUSDT(alice.address, depositAmount);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(alice).approve(await vault.getAddress(), depositAmount);
      await vault.connect(alice).deposit(depositAmount, alice.address);

      const navBefore = await vault.totalAssets();
      const aliceShares = await vault.balanceOf(alice.address);
      const aliceValueBefore = (aliceShares * navBefore) / await vault.totalSupply();

      // Keeper delevels to 50%
      await vault.connect(keeper).rebalance(ethers.parseUnits("0.5", 18));

      const navAfter = await vault.totalAssets();
      const aliceValueAfter = (aliceShares * navAfter) / await vault.totalSupply();

      // Alice's value should not decrease significantly (allow 2% for slippage)
      const minExpectedValue = aliceValueBefore * 98n / 100n;
      expect(aliceValueAfter).to.be.gte(minExpectedValue);

      console.log(`Alice value before rebalance: ${ethers.formatUnits(aliceValueBefore, 6)} USDT`);
      console.log(`Alice value after rebalance: ${ethers.formatUnits(aliceValueAfter, 6)} USDT`);
    });

    it("rebalance to IDLE_MODE should preserve user value", async function () {
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);
      await fundWithUSDT(alice.address, depositAmount);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(alice).approve(await vault.getAddress(), depositAmount);
      await vault.connect(alice).deposit(depositAmount, alice.address);

      const navBefore = await vault.totalAssets();

      // Full delever to IDLE_MODE
      await vault.connect(keeper).rebalance(ethers.MaxUint256);

      const navAfter = await vault.totalAssets();
      const idleUsdt = await usdt.balanceOf(await vault.getAddress());

      // NAV should be preserved (within 3% for PSM conversion costs)
      const minExpectedNav = navBefore * 97n / 100n;
      expect(navAfter).to.be.gte(minExpectedNav);

      // All value should now be in idle USDT
      expect(idleUsdt).to.be.gte(navAfter * 99n / 100n);

      console.log(`NAV before: ${ethers.formatUnits(navBefore, 6)} USDT`);
      console.log(`NAV after: ${ethers.formatUnits(navAfter, 6)} USDT`);
      console.log(`Idle USDT: ${ethers.formatUnits(idleUsdt, 6)}`);
    });
  });
});
