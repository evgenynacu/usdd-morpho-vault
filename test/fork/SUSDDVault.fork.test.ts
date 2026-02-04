import { expect } from "chai";
import { ethers } from "hardhat";
import { ADDRESSES, MARKET_ID, WAD, DECIMALS } from "./helpers/constants";
import { SUSDDVault } from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Fork Integration Tests for SUSDDVault
 *
 * These tests require a mainnet fork and verify:
 * - Real flash loan execution with Morpho
 * - Real PSM swaps with actual fees
 * - Real sUSDD rates and conversions
 * - E2E deposit/withdraw/rebalance flows
 *
 * Access control, pausable, and parameter validation are covered in unit tests.
 */
describe("SUSDDVault Fork Tests", function () {
  let vault: SUSDDVault;
  let admin: HardhatEthersSigner;
  let keeper: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;

  const TARGET_LTV = ethers.parseUnits("0.75", 18); // 75%
  const PERFORMANCE_FEE = 1000n; // 10%
  const MAX_TOTAL_ASSETS = ethers.parseUnits("10000000", 6); // 10M USDT

  // Skip if not forking mainnet
  before(async function () {
    const code = await ethers.provider.getCode(ADDRESSES.MORPHO);
    if (code === "0x") {
      console.log("Skipping fork tests - no mainnet fork detected");
      this.skip();
    }

    [admin, keeper, , , user1, , feeRecipient] = await ethers.getSigners();
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

  // Helper to get position info directly from Morpho (replaces removed getPosition view)
  async function getPosition(vaultAddress: string) {
    const morpho = await ethers.getContractAt("@morpho-org/morpho-blue/src/interfaces/IMorpho.sol:IMorpho", ADDRESSES.MORPHO);
    const susdd = await ethers.getContractAt("@openzeppelin/contracts/interfaces/IERC4626.sol:IERC4626", ADDRESSES.SUSDD);

    const position = await morpho.position(MARKET_ID, vaultAddress);
    const collateral = position.collateral;

    // Get market params for debt calculation
    const marketParams = await morpho.idToMarketParams(MARKET_ID);

    // Calculate debt (simplified - actual implementation uses MorphoBalancesLib)
    const market = await morpho.market(MARKET_ID);
    let debt = 0n;
    if (market.totalBorrowShares > 0n) {
      debt = (position.borrowShares * market.totalBorrowAssets) / market.totalBorrowShares;
    }

    // Calculate LTV
    const collateralUsdt = await susdd.convertToAssets(collateral);
    const collateralValue = collateralUsdt / BigInt(1e12); // 18 decimals -> 6 decimals
    let currentLTV = 0n;
    if (collateralValue > 0n) {
      currentLTV = (debt * WAD) / collateralValue;
    }

    return { collateral, debt, currentLTV };
  }

  describe("Deposit E2E", function () {
    beforeEach(async function () {
      await deployVault();
    });

    it("should create leveraged position with real flash loan", async function () {
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);
      await fundWithUSDT(user1.address, depositAmount);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(user1).approve(await vault.getAddress(), depositAmount);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      const shares = await vault.balanceOf(user1.address);
      expect(shares).to.be.gt(0);

      // Verify leveraged position was created
      const { collateral, debt, currentLTV } = await getPosition(await vault.getAddress());
      console.log(`Collateral: ${ethers.formatUnits(collateral, 18)} sUSDD`);
      console.log(`Debt: ${ethers.formatUnits(debt, 6)} USDT`);
      console.log(`LTV: ${ethers.formatUnits(currentLTV, 16)}%`);

      expect(collateral).to.be.gt(0);
      expect(debt).to.be.gt(0);

      // LTV should be close to target (within 5%)
      const ltvDiff = currentLTV > TARGET_LTV ? currentLTV - TARGET_LTV : TARGET_LTV - currentLTV;
      expect(ltvDiff).to.be.lt(ethers.parseUnits("0.05", 18));
    });

    it("should handle multiple deposits correctly", async function () {
      const depositAmount = ethers.parseUnits("500", DECIMALS.USDT);
      await fundWithUSDT(user1.address, depositAmount * 2n);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(user1).approve(await vault.getAddress(), depositAmount * 2n);

      await vault.connect(user1).deposit(depositAmount, user1.address);
      const sharesAfterFirst = await vault.balanceOf(user1.address);

      await vault.connect(user1).deposit(depositAmount, user1.address);
      const sharesAfterSecond = await vault.balanceOf(user1.address);

      expect(sharesAfterSecond).to.be.gt(sharesAfterFirst);

      // NAV should be close to total deposited
      const totalAssets = await vault.totalAssets();
      expect(totalAssets).to.be.gte(ethers.parseUnits("900", DECIMALS.USDT));
    });
  });

  describe("Withdraw E2E", function () {
    beforeEach(async function () {
      await deployVault();
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);
      await fundWithUSDT(user1.address, depositAmount);
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);
    });

    it("should unwind position on partial withdrawal", async function () {
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      const sharesBefore = await vault.balanceOf(user1.address);
      const posBefore = await getPosition(await vault.getAddress());

      // Withdraw half
      const withdrawShares = sharesBefore / 2n;
      await vault.connect(user1).redeem(withdrawShares, user1.address, user1.address);

      const sharesAfter = await vault.balanceOf(user1.address);
      const posAfter = await getPosition(await vault.getAddress());
      const usdtReceived = await usdt.balanceOf(user1.address);

      expect(sharesAfter).to.be.lt(sharesBefore);
      expect(usdtReceived).to.be.gt(0);
      expect(posAfter.collateral).to.be.lt(posBefore.collateral);
      expect(posAfter.debt).to.be.lt(posBefore.debt);

      console.log(`USDT received: ${ethers.formatUnits(usdtReceived, 6)}`);
    });

    it("should fully unwind position on full withdrawal", async function () {
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      const shares = await vault.balanceOf(user1.address);

      await vault.connect(user1).redeem(shares, user1.address, user1.address);

      const sharesAfter = await vault.balanceOf(user1.address);
      const usdtReceived = await usdt.balanceOf(user1.address);
      const { collateral } = await getPosition(await vault.getAddress());

      expect(sharesAfter).to.equal(0);
      expect(usdtReceived).to.be.gt(ethers.parseUnits("900", DECIMALS.USDT));
      // Some dust might remain
      expect(collateral).to.be.lt(ethers.parseUnits("10", 18));

      console.log(`Full withdrawal: ${ethers.formatUnits(usdtReceived, 6)} USDT`);
    });
  });

  describe("Rebalance E2E", function () {
    beforeEach(async function () {
      await deployVault();
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);
      await fundWithUSDT(user1.address, depositAmount);
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);
    });

    it("should delever to lower LTV", async function () {
      const posBefore = await getPosition(await vault.getAddress());
      console.log(`LTV before: ${ethers.formatUnits(posBefore.currentLTV, 16)}%`);

      const newLTV = ethers.parseUnits("0.5", 18); // 50%
      await vault.connect(keeper).rebalance(newLTV);

      const posAfter = await getPosition(await vault.getAddress());
      console.log(`LTV after: ${ethers.formatUnits(posAfter.currentLTV, 16)}%`);

      // LTV should be closer to new target
      const diffFromTarget = posAfter.currentLTV > newLTV ? posAfter.currentLTV - newLTV : newLTV - posAfter.currentLTV;
      expect(diffFromTarget).to.be.lt(ethers.parseUnits("0.1", 18));
    });

    it("should transition to unleveraged sUSDD (LTV=0)", async function () {
      const posBefore = await getPosition(await vault.getAddress());
      expect(posBefore.collateral).to.be.gt(0);
      expect(posBefore.debt).to.be.gt(0);

      await vault.connect(keeper).rebalance(0);

      const posAfter = await getPosition(await vault.getAddress());
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      const idleUsdt = await usdt.balanceOf(await vault.getAddress());

      // Debt should be cleared but collateral mostly remains (minus what was used for flash loan repayment)
      expect(posAfter.debt).to.be.lt(ethers.parseUnits("1", DECIMALS.USDT));
      // Collateral should still exist (we kept it, only withdrew enough to repay flash loan)
      expect(posAfter.collateral).to.be.gt(ethers.parseUnits("500", 18));

      // Very little idle USDT (just buffer excess)
      expect(idleUsdt).to.be.lt(ethers.parseUnits("50", DECIMALS.USDT));
      console.log(`Collateral after LTV=0: ${ethers.formatUnits(posAfter.collateral, 18)} sUSDD`);
    });

    it("should full delever to IDLE_MODE", async function () {
      const posBefore = await getPosition(await vault.getAddress());
      expect(posBefore.collateral).to.be.gt(0);
      expect(posBefore.debt).to.be.gt(0);

      // IDLE_MODE = type(uint256).max
      const IDLE_MODE = ethers.MaxUint256;
      await vault.connect(keeper).rebalance(IDLE_MODE);

      const posAfter = await getPosition(await vault.getAddress());
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      const idleUsdt = await usdt.balanceOf(await vault.getAddress());

      // Position should be fully unwound
      expect(posAfter.debt).to.be.lt(ethers.parseUnits("1", DECIMALS.USDT));
      expect(posAfter.collateral).to.be.lt(ethers.parseUnits("1", 18));

      // Value should be in idle USDT
      expect(idleUsdt).to.be.gt(ethers.parseUnits("900", DECIMALS.USDT));
      console.log(`Idle USDT: ${ethers.formatUnits(idleUsdt, 6)}`);
    });

    it("should re-lever from idle USDT", async function () {
      // First exit to IDLE_MODE
      const IDLE_MODE = ethers.MaxUint256;
      await vault.connect(keeper).rebalance(IDLE_MODE);

      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      const idleUsdtBefore = await usdt.balanceOf(await vault.getAddress());
      console.log(`Idle USDT before re-lever: ${ethers.formatUnits(idleUsdtBefore, 6)}`);
      expect(idleUsdtBefore).to.be.gt(0);

      // Check position state
      const posBefore = await getPosition(await vault.getAddress());
      console.log(`Position before: collateral=${ethers.formatUnits(posBefore.collateral, 18)}, debt=${ethers.formatUnits(posBefore.debt, 6)}`);


      // Re-lever
      const newLTV = ethers.parseUnits("0.6", 18);
      await vault.connect(keeper).rebalance(newLTV);

      const posAfter = await getPosition(await vault.getAddress());
      const idleUsdtAfter = await usdt.balanceOf(await vault.getAddress());

      expect(posAfter.collateral).to.be.gt(0);
      expect(posAfter.debt).to.be.gt(0);
      expect(idleUsdtAfter).to.be.lt(idleUsdtBefore);

      console.log(`Re-levered to LTV: ${ethers.formatUnits(posAfter.currentLTV, 16)}%`);
    });
  });

  describe("NAV with Real Rates", function () {
    beforeEach(async function () {
      await deployVault();
    });

    it("should calculate NAV correctly with leveraged position", async function () {
      const depositAmount = ethers.parseUnits("1000", DECIMALS.USDT);
      await fundWithUSDT(user1.address, depositAmount);
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const totalAssets = await vault.totalAssets();
      console.log(`NAV: ${ethers.formatUnits(totalAssets, 6)} USDT`);

      // NAV should be close to deposited (accounting for PSM fees, etc.)
      expect(totalAssets).to.be.gte(ethers.parseUnits("900", DECIMALS.USDT));
      expect(totalAssets).to.be.lte(ethers.parseUnits("1100", DECIMALS.USDT));
    });
  });
});
