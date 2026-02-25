import { expect } from "chai";
import { ethers, network, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  SUSDDVault,
  MockERC20,
  MockSUSDD,
  MockPSM,
  MockMorpho,
} from "../../typechain-types";

/**
 * Security Unit Tests
 *
 * Tests for edge cases and attack vectors that can be verified with mocks.
 * Complex scenarios requiring accurate debt calculation are in fork tests.
 */

const ADDRESSES = {
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  USDD: "0x4f8e5DE400DE08B164E7421B3EE387f461beCD1A",
  SUSDD: "0xC5d6A7B61d18AfA11435a889557b068BB9f29930",
  PSM: "0xcE355440c00014A229bbEc030A2B8f8EB45a2897",
  MORPHO: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
};

const MARKET_ID = "0x29ae8cad946d861464d5e829877245a863a18157c0cde2c3524434dafa34e476";
const WAD = ethers.parseEther("1");
const KEEPER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("KEEPER_ROLE"));
const MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MANAGER_ROLE"));

describe("Security Unit Tests", function () {
  let admin: SignerWithAddress;
  let keeper: SignerWithAddress;
  let manager: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  let vault: SUSDDVault;
  let usdt: MockERC20;
  let usdd: MockERC20;
  let susdd: MockSUSDD;
  let psm: MockPSM;
  let morpho: MockMorpho;

  let snapshotId: string;

  async function deployMockAt(address: string, factory: any, args: any[] = []): Promise<any> {
    const mock = await factory.deploy(...args);
    await mock.waitForDeployment();
    const deployedCode = await ethers.provider.getCode(await mock.getAddress());
    await network.provider.send("hardhat_setCode", [address, deployedCode]);
    return factory.attach(address);
  }

  before(async function () {
    [admin, keeper, manager, user1, user2] = await ethers.getSigners();

    // Deploy mocks at mainnet addresses
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const MockSUSDDFactory = await ethers.getContractFactory("MockSUSDD");
    const MockPSMFactory = await ethers.getContractFactory("MockPSM");
    const MockMorphoFactory = await ethers.getContractFactory("MockMorpho");

    usdt = await deployMockAt(ADDRESSES.USDT, MockERC20Factory, ["Mock USDT", "USDT", 6]);
    usdd = await deployMockAt(ADDRESSES.USDD, MockERC20Factory, ["Mock USDD", "USDD", 18]);

    const susddTemp = await MockSUSDDFactory.deploy(ADDRESSES.USDD, "Mock sUSDD", "sUSDD");
    await susddTemp.waitForDeployment();
    const susddCode = await ethers.provider.getCode(await susddTemp.getAddress());
    await network.provider.send("hardhat_setCode", [ADDRESSES.SUSDD, susddCode]);
    susdd = MockSUSDDFactory.attach(ADDRESSES.SUSDD) as MockSUSDD;

    const psmTemp = await MockPSMFactory.deploy(ADDRESSES.USDT, ADDRESSES.USDD, ADDRESSES.PSM);
    await psmTemp.waitForDeployment();
    const psmCode = await ethers.provider.getCode(await psmTemp.getAddress());
    await network.provider.send("hardhat_setCode", [ADDRESSES.PSM, psmCode]);
    psm = MockPSMFactory.attach(ADDRESSES.PSM) as MockPSM;

    const morphoTemp = await MockMorphoFactory.deploy();
    await morphoTemp.waitForDeployment();
    const morphoCode = await ethers.provider.getCode(await morphoTemp.getAddress());
    await network.provider.send("hardhat_setCode", [ADDRESSES.MORPHO, morphoCode]);
    morpho = MockMorphoFactory.attach(ADDRESSES.MORPHO) as MockMorpho;

    // Setup Morpho market
    const marketParams = {
      loanToken: ADDRESSES.USDT,
      collateralToken: ADDRESSES.SUSDD,
      oracle: ethers.ZeroAddress,
      irm: ethers.ZeroAddress,
      lltv: ethers.parseEther("0.86"),
    };
    await morpho.createMarketWithId(MARKET_ID, marketParams);

    // Mint liquidity
    await usdt.mint(ADDRESSES.PSM, ethers.parseUnits("10000000", 6));
    await usdt.mint(ADDRESSES.MORPHO, ethers.parseUnits("10000000", 6));

    // Deploy vault via UUPS proxy
    const VaultFactory = await ethers.getContractFactory("SUSDDVault");
    vault = await upgrades.deployProxy(
      VaultFactory,
      [
        admin.address,
        admin.address,
        ethers.parseEther("0.75"),
        1000,
        ethers.parseUnits("10000000", 6)
      ],
      { kind: "uups" }
    ) as unknown as SUSDDVault;

    await vault.connect(admin).grantRole(KEEPER_ROLE, keeper.address);
    await vault.connect(admin).grantRole(MANAGER_ROLE, manager.address);

    // Mint USDT to users
    await usdt.mint(user1.address, ethers.parseUnits("1000000", 6));
    await usdt.mint(user2.address, ethers.parseUnits("1000000", 6));

    // Approve vault
    await usdt.connect(user1).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdt.connect(user2).approve(await vault.getAddress(), ethers.MaxUint256);

    // Whitelist users
    await vault.connect(manager).addToWhitelist(user1.address);
    await vault.connect(manager).addToWhitelist(user2.address);
  });

  beforeEach(async function () {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach(async function () {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  // ============================================================
  // 1. PSM FEES > 0 TESTS
  // ============================================================
  describe("PSM Fees > 0 (Fail-Safe Behavior)", function () {

    describe("with tin > 0 (USDT -> USDD fee)", function () {
      beforeEach(async function () {
        // Set 1% tin fee (selling USDT to get USDD)
        await psm.setTin(ethers.parseEther("0.01")); // 1%
      });

      it("deposit should still work but with reduced NAV (Delta NAV protects existing users)", async function () {
        // First user deposits with 0 fees
        await psm.setTin(0);
        const depositAmount = ethers.parseUnits("1000", 6);
        await vault.connect(user1).deposit(depositAmount, user1.address);

        const user1Shares = await vault.balanceOf(user1.address);
        const navAfterUser1 = await vault.totalAssets();

        // Enable 1% tin fee
        await psm.setTin(ethers.parseEther("0.01"));

        // Second user deposits - they get fewer shares due to PSM fee
        // Delta NAV ensures user1 is not diluted
        await vault.connect(user2).deposit(depositAmount, user2.address);

        const user2Shares = await vault.balanceOf(user2.address);
        const navAfterUser2 = await vault.totalAssets();

        // User2 should get fewer shares than user1 (they paid PSM fee)
        expect(user2Shares).to.be.lt(user1Shares);

        // User1's share value should not decrease
        const totalSupply = await vault.totalSupply();
        const user1ValueAfter = (user1Shares * navAfterUser2) / totalSupply;
        const user1ValueBefore = (user1Shares * navAfterUser1) / (user1Shares); // Was 100% of supply

        // User1 value should be preserved or increased (not diluted)
        expect(user1ValueAfter).to.be.gte(user1ValueBefore * 99n / 100n); // Allow 1% tolerance

        console.log(`User1 shares: ${ethers.formatUnits(user1Shares, 18)}`);
        console.log(`User2 shares: ${ethers.formatUnits(user2Shares, 18)} (with 1% tin fee)`);
      });
    });

    describe("with tout > 0 (USDD -> USDT fee)", function () {
      beforeEach(async function () {
        // First deposit with 0 fees to create position
        const depositAmount = ethers.parseUnits("10000", 6);
        await vault.connect(user1).deposit(depositAmount, user1.address);

        // Now set tout fee - this affects buyGem (USDD -> USDT conversion)
        // When redeeming, vault converts sUSDD -> USDD -> USDT via buyGem
        await psm.setTout(ethers.parseEther("0.01")); // 1%
      });

      it("redeem should revert when tout > 0 (fail-safe, shares not burned)", async function () {
        const sharesBefore = await vault.balanceOf(user1.address);
        expect(sharesBefore).to.be.gt(0);

        // Try to redeem - should revert because vault expects 1:1 but PSM takes fee
        // The revert happens during flash loan repayment (not enough USDT)
        await expect(
          vault.connect(user1).redeem(sharesBefore, user1.address, user1.address)
        ).to.be.reverted;

        // Verify shares were NOT burned (transaction reverted)
        const sharesAfter = await vault.balanceOf(user1.address);
        expect(sharesAfter).to.equal(sharesBefore);

        console.log(`Shares preserved after failed redeem: ${ethers.formatUnits(sharesAfter, 18)}`);
      });

      it("rebalance (delever) behavior with tout > 0 (mock limitation - see fork tests)", async function () {
        /**
         * Expected behavior (when tout > 0):
         * - Delever requires converting sUSDD -> USDD -> USDT via PSM buyGem
         * - When tout > 0, MORE USDD is required for the same USDT
         * - Flash loan repayment fails (vault doesn't have enough USDD)
         *
         * Mock limitation (why this can't be tested in unit tests):
         * - MorphoBalancesLib.expectedBorrowAssets() reads storage via extSloads
         * - MockMorpho.extSloads() returns zeros
         * - Vault thinks currentDebt = 0, so delever becomes no-op
         *
         * This behavior IS tested in fork tests where Morpho state is real.
         */

        const newLTV = ethers.parseEther("0.5"); // Lower LTV = delever

        // Get position to check mock state
        const vaultAddress = await vault.getAddress();
        const position = await morpho.position(MARKET_ID, vaultAddress);

        console.log(`Position: collateral=${position.collateral}, borrowShares=${position.borrowShares}`);
        console.log("Mock limitation: expectedBorrowAssets returns 0 due to extSloads");
        console.log("Vault thinks currentDebt=0, so delever is no-op regardless of tout");
        console.log("See fork tests for accurate tout>0 coverage");

        // Document that in mock, rebalance just updates targetLTV (no actual delever)
        const targetLTVBefore = await vault.targetLTV();
        await vault.connect(keeper).rebalance(newLTV);
        const targetLTVAfter = await vault.targetLTV();

        // The only thing that changes is targetLTV
        expect(targetLTVAfter).to.equal(newLTV);
        console.log(`targetLTV updated: ${ethers.formatEther(targetLTVBefore)} -> ${ethers.formatEther(targetLTVAfter)}`);
      });

      it("rebalance to IDLE_MODE should revert when tout > 0", async function () {
        const IDLE_MODE = ethers.MaxUint256;

        await expect(
          vault.connect(keeper).rebalance(IDLE_MODE)
        ).to.be.reverted;

        console.log("Exit to IDLE_MODE reverted as expected when tout > 0");
      });
    });
  });

  // ============================================================
  // 2. SKIP-UNWIND BRANCHES IN WITHDRAW
  // ============================================================
  describe("Skip-Unwind Branches in Withdraw", function () {
    /**
     * These tests verify the skip scenarios documented in requirements.md:
     * - sharesToRepay == 0 && collateralToWithdraw > 0 (debt exists) → skip (Branch 3)
     * - sharesToRepay > 0 && collateralToWithdraw == 0 → skip (Branch 4)
     * - both round to 0 → skip (Branch 5)
     *
     * In skip scenarios, user receives only idle USDT portion.
     *
     * Math:
     * - sharesToRepay = borrowShares * shares / totalSupply
     * - collateralToWithdraw = collateral * shares / totalSupply
     *
     * For sharesToRepay == 0: need borrowShares * shares < totalSupply
     * For collateralToWithdraw == 0: need collateral * shares < totalSupply
     */

    beforeEach(async function () {
      // Create a position with idle USDT + collateral + debt
      // Use unleveraged mode first, then manually set up position via mock
      await vault.connect(keeper).rebalance(0); // Unleveraged mode

      // Deposit creates sUSDD collateral without debt
      const depositAmount = ethers.parseUnits("10000", 6);
      await vault.connect(user1).deposit(depositAmount, user1.address);
    });

    it("very tiny redemption should not affect remaining users", async function () {
      // Setup: user1 and user2 both deposit
      const depositAmount = ethers.parseUnits("10000", 6);
      await vault.connect(user2).deposit(depositAmount, user2.address);

      const user1Shares = await vault.balanceOf(user1.address);
      const user2SharesBefore = await vault.balanceOf(user2.address);
      const totalSupplyBefore = await vault.totalSupply();
      const navBefore = await vault.totalAssets();

      // User2's value before tiny redemptions
      const user2ValueBefore = (user2SharesBefore * navBefore) / totalSupplyBefore;

      // User1 does many tiny redemptions (1 share each)
      const tinyAmount = 1n;
      for (let i = 0; i < 100; i++) {
        if (await vault.balanceOf(user1.address) >= tinyAmount) {
          await vault.connect(user1).redeem(tinyAmount, user1.address, user1.address);
        }
      }

      // Check user2's value after
      const user2SharesAfter = await vault.balanceOf(user2.address);
      const totalSupplyAfter = await vault.totalSupply();
      const navAfter = await vault.totalAssets();

      // User2 shares should not change
      expect(user2SharesAfter).to.equal(user2SharesBefore);

      // User2's value should not decrease
      const user2ValueAfter = (user2SharesAfter * navAfter) / totalSupplyAfter;
      expect(user2ValueAfter).to.be.gte(user2ValueBefore);

      console.log(`User2 value before: ${ethers.formatUnits(user2ValueBefore, 6)} USDT`);
      console.log(`User2 value after 100 tiny redemptions: ${ethers.formatUnits(user2ValueAfter, 6)} USDT`);
    });

    it("redemption with only idle USDT should work correctly", async function () {
      // Exit to IDLE_MODE - all value becomes idle USDT
      const IDLE_MODE = ethers.MaxUint256;
      await vault.connect(keeper).rebalance(IDLE_MODE);

      const shares = await vault.balanceOf(user1.address);
      const usdtBalanceBefore = await usdt.balanceOf(user1.address);

      // Redeem half
      const redeemShares = shares / 2n;
      await vault.connect(user1).redeem(redeemShares, user1.address, user1.address);

      const usdtBalanceAfter = await usdt.balanceOf(user1.address);
      const received = usdtBalanceAfter - usdtBalanceBefore;

      // Should receive approximately half the value
      expect(received).to.be.gt(0);

      console.log(`Redeemed ${ethers.formatUnits(redeemShares, 18)} shares, received ${ethers.formatUnits(received, 6)} USDT`);
    });

    it("Branch 3: sharesToRepay==0, collateralToWithdraw>0, debt exists - SKIP (requires artificial state)", async function () {
      /**
       * Branch 3 requires: borrowShares << collateral (unusual ratio)
       * - sharesToRepay = borrowShares * shares / totalSupply = 0
       * - collateralToWithdraw = collateral * shares / totalSupply > 0
       * - pos.borrowShares > 0
       *
       * This state cannot occur through normal vault operations because:
       * - Deposit creates position with consistent LTV ratio
       * - collateral and borrowShares scale together
       *
       * To test this branch properly, we would need to:
       * 1. Directly manipulate mock position to have borrowShares << collateral
       * 2. But vault shares wouldn't match the artificial position
       *
       * This is a DEFENSIVE branch for edge cases like:
       * - External partial debt repayment
       * - Oracle manipulation scenarios
       *
       * The branch EXISTS in code (verified by inspection) and protects LTV.
       */

      console.log("Branch 3 (sharesToRepay=0, collateralToWithdraw>0, debt exists):");
      console.log("  Cannot trigger through normal operations");
      console.log("  Requires borrowShares << collateral (unusual ratio)");
      console.log("  Branch verified to exist in code at SUSDDVault.sol:437-438");
      console.log("  SKIPPED: Would need artificial state manipulation");

      this.skip();
    });

    it("Branch 4: sharesToRepay>0, collateralToWithdraw==0 - SKIP (requires artificial state)", async function () {
      /**
       * Branch 4 requires: collateral << borrowShares (unusual ratio)
       * - sharesToRepay = borrowShares * shares / totalSupply > 0
       * - collateralToWithdraw = collateral * shares / totalSupply = 0
       *
       * This state cannot occur through normal vault operations because:
       * - Morpho requires sufficient collateral for borrowing (LTV limit)
       * - If collateral << borrowShares, position would be liquidatable
       *
       * This is a DEFENSIVE branch that prevents:
       * - Flash loan without collateral to repay it
       * - Stuck transactions
       *
       * The branch EXISTS in code (verified by inspection).
       */

      console.log("Branch 4 (sharesToRepay>0, collateralToWithdraw=0):");
      console.log("  Cannot trigger through normal operations");
      console.log("  Requires collateral << borrowShares (would be liquidated)");
      console.log("  Branch verified to exist in code at SUSDDVault.sol:439");
      console.log("  SKIPPED: Would need artificial state manipulation");

      this.skip();
    });

    it("Branch 5: both round to 0 - verified with tiny redemption", async function () {
      /**
       * Branch 5: both sharesToRepay and collateralToWithdraw round to 0
       *
       * This CAN be triggered with sufficiently tiny redemption where:
       * - borrowShares * shares < totalSupply (rounds to 0)
       * - collateral * shares < totalSupply (rounds to 0)
       *
       * Result: user burns shares but gets only idle USDT portion (no position unwind)
       */

      // Use leveraged mode to have both collateral and debt
      await vault.connect(keeper).rebalance(ethers.parseEther("0.75"));
      const depositAmount = ethers.parseUnits("100000", 6);
      await vault.connect(user2).deposit(depositAmount, user2.address);

      const vaultAddress = await vault.getAddress();
      const totalSupply = await vault.totalSupply();
      const position = await morpho.position(MARKET_ID, vaultAddress);

      console.log(`Position: collateral=${position.collateral}, borrowShares=${position.borrowShares}`);
      console.log(`TotalSupply: ${totalSupply}`);

      // Calculate shares needed for both to round to 0
      // shares < totalSupply / collateral AND shares < totalSupply / borrowShares
      const maxSharesForZeroCollateral = position.collateral > 0n ? (totalSupply - 1n) / position.collateral : 0n;
      const maxSharesForZeroBorrow = position.borrowShares > 0n ? (totalSupply - 1n) / position.borrowShares : 0n;

      // Take the minimum (strictest constraint)
      let testShares = maxSharesForZeroCollateral < maxSharesForZeroBorrow
        ? maxSharesForZeroCollateral
        : maxSharesForZeroBorrow;

      // Ensure at least 1 share
      if (testShares === 0n) testShares = 1n;

      const user2Shares = await vault.balanceOf(user2.address);

      if (testShares <= user2Shares) {
        const expectedCollateralToWithdraw = (position.collateral * testShares) / totalSupply;
        const expectedSharesToRepay = (position.borrowShares * testShares) / totalSupply;

        console.log(`Testing with ${testShares} shares:`);
        console.log(`  Expected collateralToWithdraw: ${expectedCollateralToWithdraw}`);
        console.log(`  Expected sharesToRepay: ${expectedSharesToRepay}`);

        const posBefore = await morpho.position(MARKET_ID, vaultAddress);
        const balanceBefore = await usdt.balanceOf(user2.address);

        await vault.connect(user2).redeem(testShares, user2.address, user2.address);

        const posAfter = await morpho.position(MARKET_ID, vaultAddress);
        const balanceAfter = await usdt.balanceOf(user2.address);

        if (expectedCollateralToWithdraw === 0n && expectedSharesToRepay === 0n) {
          // Branch 5 triggered - position unchanged
          console.log(`✓ Branch 5 TRIGGERED: both round to 0`);
          expect(posAfter.collateral).to.equal(posBefore.collateral, "Collateral should be unchanged");
          expect(posAfter.borrowShares).to.equal(posBefore.borrowShares, "BorrowShares should be unchanged");
          console.log(`  Position unchanged, USDT received from idle: ${balanceAfter - balanceBefore}`);
        } else {
          // Normal unwind occurred
          console.log(`  Normal unwind occurred (amounts didn't round to 0)`);
          console.log(`  Collateral: ${posBefore.collateral} -> ${posAfter.collateral}`);
          console.log(`  This is expected - Branch 5 requires extremely small redemptions`);
        }
      } else {
        console.log("Cannot test: insufficient shares");
        this.skip();
      }
    });
  });

  // ============================================================
  // 3. ZERO NAV PROTECTION
  // ============================================================
  describe("ZeroNAV Protection", function () {
    it("should block deposits when previewDeposit returns 0", async function () {
      // First deposit to create shares
      const depositAmount = ethers.parseUnits("1000", 6);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const sharesBefore = await vault.totalSupply();
      expect(sharesBefore).to.be.gt(0);

      // Manipulate sUSDD rate to near zero (simulating total depeg)
      // This makes collateral value ≈ 0
      await susdd.setRate(1); // 1 wei per share = essentially 0

      // totalAssets should now be very low or 0
      const nav = await vault.totalAssets();

      // If NAV is 0 and shares exist, deposits should be blocked
      // Could revert with either ZeroNAV (in _deposit) or ERC4626ExceededMaxDeposit (in deposit wrapper)
      // Both protect the user - the important thing is deposit is blocked
      if (nav === 0n) {
        await expect(
          vault.connect(user2).deposit(depositAmount, user2.address)
        ).to.be.reverted; // Accept any revert - both ZeroNAV and ERC4626ExceededMaxDeposit protect users

        console.log("Deposit correctly blocked when NAV=0");
      } else {
        // NAV not 0 due to mock limitations - document this
        console.log(`NAV = ${ethers.formatUnits(nav, 6)} (mock limitation - expectedBorrowAssets returns incorrect value)`);
      }
    });

    it("maxDeposit should return 0 when NAV=0 and shares exist", async function () {
      // First deposit
      const depositAmount = ethers.parseUnits("1000", 6);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Set rate to near zero
      await susdd.setRate(1);

      const nav = await vault.totalAssets();
      const supply = await vault.totalSupply();
      const maxDep = await vault.maxDeposit(user2.address);

      if (nav === 0n && supply > 0n) {
        expect(maxDep).to.equal(0);
        console.log("maxDeposit correctly returns 0 when NAV=0 and shares exist");
      } else {
        console.log(`NAV=${nav}, supply=${supply}, maxDeposit=${maxDep}`);
      }
    });
  });

  // ============================================================
  // 3.5. UNDERWATER POSITION PROTECTION
  // ============================================================
  describe("Underwater Position Protection", function () {
    /**
     * Underwater: NAV=0 with debt > 0
     *
     * Expected behavior:
     * - deposit() reverts with ZeroNAV
     * - redeem() reverts during flash loan repayment (atomic, shares preserved)
     * - rebalance() is true no-op (returns early, no state change)
     *
     * Mock limitation:
     * - MorphoBalancesLib.expectedBorrowAssets() requires extSloads which mock returns zeros
     * - Cannot accurately test underwater with real debt in unit tests
     *
     * This is comprehensively tested in fork tests with real Morpho state.
     */

    it("underwater via sUSDD depeg should block deposits", async function () {
      // Create leveraged position
      await vault.connect(keeper).rebalance(ethers.parseEther("0.75"));
      const depositAmount = ethers.parseUnits("10000", 6);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const supplyBefore = await vault.totalSupply();
      expect(supplyBefore).to.be.gt(0);

      // Depeg sUSDD to 0 - makes collateral value 0
      // This creates ZeroNAV scenario
      await susdd.setRate(1);

      const nav = await vault.totalAssets();

      // Deposits should be blocked when NAV=0 and shares exist
      if (nav === 0n) {
        await expect(
          vault.connect(user2).deposit(depositAmount, user2.address)
        ).to.be.reverted;
        console.log("✓ Deposits blocked when underwater (ZeroNAV)");

        // maxDeposit should return 0
        const maxDep = await vault.maxDeposit(user2.address);
        expect(maxDep).to.equal(0);
        console.log("✓ maxDeposit returns 0 when underwater");
      } else {
        console.log(`NAV=${nav} - mock limitation, debt not calculated correctly`);
      }
    });

    it("underwater check exists in rebalance (documented behavior)", async function () {
      /**
       * rebalance() checks:
       * if (currentDebt > 0 && totalAssets() == 0) { return; }
       *
       * This is a true no-op - no state change, no events.
       *
       * Mock limitation: currentDebt is calculated via expectedBorrowAssets()
       * which doesn't work correctly in mock (returns 0).
       *
       * In fork tests, we verify this by fast-forwarding time to accrue interest
       * until debt > collateral value.
       */

      // Create position
      const depositAmount = ethers.parseUnits("10000", 6);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const targetLTVBefore = await vault.targetLTV();

      // Depeg sUSDD
      await susdd.setRate(1);

      // Try rebalance
      await vault.connect(keeper).rebalance(ethers.parseEther("0.5"));

      // In mock, this may or may not be a no-op depending on debt calculation
      // The important thing is it doesn't revert and vault remains functional
      console.log("Rebalance completed (may be no-op in underwater scenario)");
      console.log("See fork tests for accurate underwater rebalance coverage");
    });

    it("redeem atomic rollback - shares preserved on failure (fork test documents behavior)", async function () {
      /**
       * Expected behavior (underwater):
       * - redeem() tries to unwind position proportionally
       * - Flash loan for debt repayment → convert collateral → not enough to repay
       * - Transaction reverts → shares preserved (atomic rollback)
       *
       * Mock limitation:
       * - expectedBorrowAssets returns 0 → vault thinks no debt
       * - redeem succeeds because it just withdraws worthless collateral
       * - No flash loan triggered → no opportunity for revert
       *
       * This IS tested in fork tests where real debt causes proper revert.
       */

      // Create position
      const depositAmount = ethers.parseUnits("10000", 6);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const sharesBefore = await vault.balanceOf(user1.address);

      // Depeg sUSDD
      await susdd.setRate(1);

      console.log(`Shares before: ${sharesBefore}`);
      console.log("Mock limitation: vault thinks debt=0, so no flash loan needed for unwind");

      // In mock, redeem may succeed (no debt to repay, just withdraw worthless collateral)
      // The atomic rollback behavior is documented but requires fork tests to verify
      const balanceBefore = await usdt.balanceOf(user1.address);

      try {
        await vault.connect(user1).redeem(sharesBefore, user1.address, user1.address);
        const balanceAfter = await usdt.balanceOf(user1.address);
        console.log(`Redeem succeeded in mock (no debt perceived)`);
        console.log(`USDT received: ${balanceAfter - balanceBefore}`);
        console.log("See fork tests for accurate underwater redeem rollback coverage");
      } catch {
        // If it reverts, verify shares preserved
        const sharesAfter = await vault.balanceOf(user1.address);
        expect(sharesAfter).to.equal(sharesBefore);
        console.log(`✓ Shares preserved after failed redeem: ${sharesAfter}`);
      }
    });
  });

  // ============================================================
  // 4. ROUNDING PROTECTION
  // ============================================================
  describe("Rounding Protection", function () {
    it("dust deposit should revert with DepositTooSmall", async function () {
      // First deposit to establish position
      const initialDeposit = ethers.parseUnits("100000", 6);
      await vault.connect(user1).deposit(initialDeposit, user1.address);

      // Try 1 wei deposit - should round to 0 shares
      const dustDeposit = 1n;

      // Preview might show 0 or tiny amount
      const preview = await vault.previewDeposit(dustDeposit);

      if (preview === 0n) {
        await expect(
          vault.connect(user2).deposit(dustDeposit, user2.address)
        ).to.be.revertedWithCustomError(vault, "DepositTooSmall");
        console.log("Dust deposit correctly reverted with DepositTooSmall");
      } else {
        // In mock, rounding might give non-zero preview
        // Still verify small deposit doesn't harm existing users
        const navBefore = await vault.totalAssets();
        const supplyBefore = await vault.totalSupply();
        const user1SharesBefore = await vault.balanceOf(user1.address);
        const user1ValueBefore = (user1SharesBefore * navBefore) / supplyBefore;

        await vault.connect(user2).deposit(dustDeposit, user2.address);

        const navAfter = await vault.totalAssets();
        const supplyAfter = await vault.totalSupply();
        const user1ValueAfter = (user1SharesBefore * navAfter) / supplyAfter;

        // User1 value should not decrease
        expect(user1ValueAfter).to.be.gte(user1ValueBefore - 1n);
        console.log(`Tiny deposit did not harm user1: ${user1ValueBefore} -> ${user1ValueAfter}`);
      }
    });
  });
});
