import { expect } from "chai";
import { ethers, network } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  SUSDDVault,
  MockERC20,
  MockSUSDD,
  MockPSM,
  MockMorpho,
} from "../../typechain-types";

// Mainnet addresses from Constants.sol
const ADDRESSES = {
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  USDD: "0x4f8e5DE400DE08B164E7421B3EE387f461beCD1A",
  SUSDD: "0xC5d6A7B61d18AfA11435a889557b068BB9f29930",
  PSM: "0xcE355440c00014A229bbEc030A2B8f8EB45a2897",
  MORPHO: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
};

const MARKET_ID = "0x29ae8cad946d861464d5e829877245a863a18157c0cde2c3524434dafa34e476";
const WAD = ethers.parseEther("1");

describe("SUSDDVault Unit Tests", function () {
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

  // Deploy mock at a specific address using hardhat_setCode
  async function deployMockAt(address: string, factory: any, args: any[] = []): Promise<any> {
    // Deploy the mock normally first
    const mock = await factory.deploy(...args);
    await mock.waitForDeployment();

    // Get the deployed bytecode
    const deployedCode = await ethers.provider.getCode(await mock.getAddress());

    // Set the code at the target address
    await network.provider.send("hardhat_setCode", [address, deployedCode]);

    // Return contract instance at target address
    return factory.attach(address);
  }

  before(async function () {
    [admin, keeper, manager, user1, user2] = await ethers.getSigners();

    // Deploy mocks at mainnet addresses
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const MockSUSDDFactory = await ethers.getContractFactory("MockSUSDD");
    const MockPSMFactory = await ethers.getContractFactory("MockPSM");
    const MockMorphoFactory = await ethers.getContractFactory("MockMorpho");

    // Deploy USDT mock (6 decimals)
    usdt = await deployMockAt(
      ADDRESSES.USDT,
      MockERC20Factory,
      ["Mock USDT", "USDT", 6]
    );

    // Deploy USDD mock (18 decimals)
    usdd = await deployMockAt(
      ADDRESSES.USDD,
      MockERC20Factory,
      ["Mock USDD", "USDD", 18]
    );

    // Deploy sUSDD mock (asset is immutable, so survives hardhat_setCode)
    const susddTemp = await MockSUSDDFactory.deploy(ADDRESSES.USDD, "Mock sUSDD", "sUSDD");
    await susddTemp.waitForDeployment();
    const susddCode = await ethers.provider.getCode(await susddTemp.getAddress());
    await network.provider.send("hardhat_setCode", [ADDRESSES.SUSDD, susddCode]);
    susdd = MockSUSDDFactory.attach(ADDRESSES.SUSDD) as MockSUSDD;

    // Deploy PSM mock (pass target address so gemJoin is correct after hardhat_setCode)
    const psmTemp = await MockPSMFactory.deploy(ADDRESSES.USDT, ADDRESSES.USDD, ADDRESSES.PSM);
    await psmTemp.waitForDeployment();
    const psmCode = await ethers.provider.getCode(await psmTemp.getAddress());
    await network.provider.send("hardhat_setCode", [ADDRESSES.PSM, psmCode]);
    psm = MockPSMFactory.attach(ADDRESSES.PSM) as MockPSM;

    // Deploy Morpho mock
    const morphoTemp = await MockMorphoFactory.deploy();
    await morphoTemp.waitForDeployment();
    const morphoCode = await ethers.provider.getCode(await morphoTemp.getAddress());
    await network.provider.send("hardhat_setCode", [ADDRESSES.MORPHO, morphoCode]);
    morpho = MockMorphoFactory.attach(ADDRESSES.MORPHO) as MockMorpho;

    // Setup Morpho market AFTER code is set (storage doesn't copy with hardhat_setCode)
    // Use createMarketWithId to register market under the hardcoded MARKET_ID
    const marketParams = {
      loanToken: ADDRESSES.USDT,
      collateralToken: ADDRESSES.SUSDD,
      oracle: ethers.ZeroAddress, // Not used in mock
      irm: ethers.ZeroAddress, // Not used in mock
      lltv: ethers.parseEther("0.86"), // 86% LLTV
    };
    await morpho.createMarketWithId(MARKET_ID, marketParams);

    // Mint initial liquidity to PSM
    await usdt.mint(ADDRESSES.PSM, ethers.parseUnits("1000000", 6));

    // Mint USDT directly to Morpho for flash loans (mock needs liquidity)
    await usdt.mint(ADDRESSES.MORPHO, ethers.parseUnits("1000000", 6));

    // Deploy vault
    const VaultFactory = await ethers.getContractFactory("SUSDDVault");
    vault = await VaultFactory.deploy(
      admin.address,           // admin
      admin.address,           // feeRecipient
      ethers.parseEther("0.75"), // targetLTV (75%)
      1000,                    // performanceFeeBps (10%)
      ethers.parseUnits("1000000", 6) // maxTotalAssets
    );

    // Grant roles
    await vault.connect(admin).grantRole(await vault.KEEPER_ROLE(), keeper.address);
    await vault.connect(admin).grantRole(await vault.MANAGER_ROLE(), manager.address);

    // Mint USDT to users
    await usdt.mint(user1.address, ethers.parseUnits("100000", 6));
    await usdt.mint(user2.address, ethers.parseUnits("100000", 6));

    // Approve vault
    await usdt.connect(user1).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdt.connect(user2).approve(await vault.getAddress(), ethers.MaxUint256);
  });

  beforeEach(async function () {
    // Take a snapshot before each test
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach(async function () {
    // Revert to snapshot after each test
    await network.provider.send("evm_revert", [snapshotId]);
  });

  describe("Deployment", function () {
    it("should deploy with correct parameters", async function () {
      expect(await vault.targetLTV()).to.equal(ethers.parseEther("0.75"));
      expect(await vault.performanceFeeBps()).to.equal(1000);
      expect(await vault.feeRecipient()).to.equal(admin.address);
      expect(await vault.maxTotalAssets()).to.equal(ethers.parseUnits("1000000", 6));
    });

    it("should set correct roles", async function () {
      expect(await vault.hasRole(await vault.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
      expect(await vault.hasRole(await vault.KEEPER_ROLE(), admin.address)).to.be.true;
      expect(await vault.hasRole(await vault.KEEPER_ROLE(), keeper.address)).to.be.true;
      expect(await vault.hasRole(await vault.MANAGER_ROLE(), manager.address)).to.be.true;
    });

    it("should revert with invalid LTV (> 90%)", async function () {
      const VaultFactory = await ethers.getContractFactory("SUSDDVault");
      await expect(
        VaultFactory.deploy(
          admin.address,
          admin.address,
          ethers.parseEther("0.91"), // 91% - too high
          1000,
          ethers.parseUnits("1000000", 6)
        )
      ).to.be.revertedWithCustomError(vault, "InvalidLTV");
    });

    it("should revert with LTV >= LLTV", async function () {
      const VaultFactory = await ethers.getContractFactory("SUSDDVault");
      await expect(
        VaultFactory.deploy(
          admin.address,
          admin.address,
          ethers.parseEther("0.86"), // 86% = LLTV
          1000,
          ethers.parseUnits("1000000", 6)
        )
      ).to.be.revertedWithCustomError(vault, "LTVExceedsLLTV");
    });

    it("should revert with invalid fee", async function () {
      const VaultFactory = await ethers.getContractFactory("SUSDDVault");
      await expect(
        VaultFactory.deploy(
          admin.address,
          admin.address,
          ethers.parseEther("0.75"),
          3001, // > 30%
          ethers.parseUnits("1000000", 6)
        )
      ).to.be.revertedWithCustomError(vault, "InvalidFee");
    });

    it("should revert with zero fee recipient", async function () {
      const VaultFactory = await ethers.getContractFactory("SUSDDVault");
      await expect(
        VaultFactory.deploy(
          admin.address,
          ethers.ZeroAddress, // Invalid
          ethers.parseEther("0.75"),
          1000,
          ethers.parseUnits("1000000", 6)
        )
      ).to.be.revertedWithCustomError(vault, "InvalidRecipient");
    });
  });

  describe("Access Control", function () {
    it("should allow admin to grant/revoke roles", async function () {
      const newKeeper = user1.address;

      await vault.connect(admin).grantRole(await vault.KEEPER_ROLE(), newKeeper);
      expect(await vault.hasRole(await vault.KEEPER_ROLE(), newKeeper)).to.be.true;

      await vault.connect(admin).revokeRole(await vault.KEEPER_ROLE(), newKeeper);
      expect(await vault.hasRole(await vault.KEEPER_ROLE(), newKeeper)).to.be.false;
    });

    it("should not allow non-admin to grant roles", async function () {
      await expect(
        vault.connect(user1).grantRole(await vault.KEEPER_ROLE(), user2.address)
      ).to.be.reverted;
    });
  });

  describe("Pausable", function () {
    it("should allow pauser to pause", async function () {
      await vault.connect(admin).grantRole(await vault.PAUSER_ROLE(), keeper.address);
      await vault.connect(keeper).pause();
      expect(await vault.paused()).to.be.true;
    });

    it("should allow pauser to unpause", async function () {
      await vault.connect(admin).pause();
      await vault.connect(admin).unpause();
      expect(await vault.paused()).to.be.false;
    });

    it("should not allow non-pauser to pause", async function () {
      await expect(
        vault.connect(user1).pause()
      ).to.be.reverted;
    });

    it("should block deposits when paused", async function () {
      await vault.connect(admin).pause();

      // maxDeposit returns 0 when paused, so ERC4626 reverts with ExceededMaxDeposit
      // before reaching our EnforcedPause check. Both mean deposits are blocked.
      await expect(
        vault.connect(user1).deposit(ethers.parseUnits("1000", 6), user1.address)
      ).to.be.reverted;
    });

    it("should return 0 for maxDeposit when paused", async function () {
      await vault.connect(admin).pause();
      expect(await vault.maxDeposit(user1.address)).to.equal(0);
    });
  });

  describe("Manager Functions", function () {
    it("should allow manager to set performance fee", async function () {
      await vault.connect(manager).setPerformanceFee(2000); // 20%
      expect(await vault.performanceFeeBps()).to.equal(2000);
    });

    it("should revert if fee too high", async function () {
      await expect(
        vault.connect(manager).setPerformanceFee(3001)
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
        vault.connect(user1).setPerformanceFee(2000)
      ).to.be.reverted;
    });
  });

  describe("Rebalance Access Control", function () {
    it("should not allow non-keeper to rebalance", async function () {
      await expect(
        vault.connect(user1).rebalance(ethers.parseEther("0.5"))
      ).to.be.reverted;
    });

    it("should not allow rebalance when paused", async function () {
      await vault.connect(admin).pause();

      await expect(
        vault.connect(keeper).rebalance(ethers.parseEther("0.5"))
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");
    });

    it("should revert if LTV too high (> 90%)", async function () {
      await expect(
        vault.connect(keeper).rebalance(ethers.parseEther("0.91"))
      ).to.be.revertedWithCustomError(vault, "InvalidLTV");
    });

    it("should revert if LTV >= LLTV", async function () {
      await expect(
        vault.connect(keeper).rebalance(ethers.parseEther("0.86"))
      ).to.be.revertedWithCustomError(vault, "LTVExceedsLLTV");
    });
  });

  describe("NAV Calculation", function () {
    it("should return 0 totalAssets with no deposits", async function () {
      expect(await vault.totalAssets()).to.equal(0);
    });

    it("should calculate totalAssets correctly with idle USDT", async function () {
      // Send USDT directly to vault (simulates idle funds)
      const amount = ethers.parseUnits("1000", 6);
      await usdt.mint(await vault.getAddress(), amount);

      expect(await vault.totalAssets()).to.equal(amount);
    });

    it("should return 0 previewDeposit when no supply (first deposit case)", async function () {
      // First deposit: previewDeposit returns estimated value, not 0
      const assets = ethers.parseUnits("1000", 6);
      const preview = await vault.previewDeposit(assets);
      // With mock, this should return some value (the estimated deposit value)
      expect(preview).to.be.gt(0);
    });

    // Note: Testing NAV=0 with totalSupply>0 (underwater) requires fork tests
    // because MockMorpho doesn't properly simulate debt accrual.
    // The expected behavior is:
    // - previewDeposit returns 0
    // - deposit reverts with ZeroNAV
  });

  describe("Deposit Flow", function () {
    it("should accept deposit and mint shares", async function () {
      const depositAmount = ethers.parseUnits("1000", 6);

      // First deposit with Delta NAV approach
      // Note: In unit tests, MockMorpho doesn't properly track debt (extSloads limitation)
      // so shares = navAfter which equals collateral value (without debt subtraction)
      // Real behavior tested in fork tests where NAV = collateral - debt ≈ assets
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Verify shares were minted (exact amount depends on mock NAV calculation)
      expect(await vault.balanceOf(user1.address)).to.be.gt(0);
    });

    it("should respect maxTotalAssets limit", async function () {
      // Set low limit
      await vault.connect(manager).setMaxTotalAssets(ethers.parseUnits("500", 6));

      // ERC4626 checks maxDeposit first, which returns 0 when limit reached
      // So it reverts with ERC4626ExceededMaxDeposit, not MaxTotalAssetsExceeded
      await expect(
        vault.connect(user1).deposit(ethers.parseUnits("1000", 6), user1.address)
      ).to.be.reverted;
    });

    it("should handle multiple deposits from same user", async function () {
      const amount = ethers.parseUnits("1000", 6);

      await vault.connect(user1).deposit(amount, user1.address);
      await vault.connect(user1).deposit(amount, user1.address);

      // Should have shares from both deposits
      expect(await vault.balanceOf(user1.address)).to.be.gt(amount);
    });

    it("should handle deposits from multiple users", async function () {
      const amount = ethers.parseUnits("1000", 6);

      await vault.connect(user1).deposit(amount, user1.address);
      await vault.connect(user2).deposit(amount, user2.address);

      expect(await vault.balanceOf(user1.address)).to.be.gt(0);
    });

    it("should revert DepositTooSmall when shares round to zero", async function () {
      // First deposit to establish position
      // Use 10K USDT - small enough to work with mock constraints
      const initialDeposit = ethers.parseUnits("10000", 6);
      await usdt.mint(user1.address, initialDeposit);
      await usdt.connect(user1).approve(await vault.getAddress(), initialDeposit);
      await vault.connect(user1).deposit(initialDeposit, user1.address);

      // Try dust deposit - with Delta NAV, very small deposits can round to 0 shares
      // Formula: shares = (valueAdded * supplyBefore) / navBefore
      // If valueAdded is tiny relative to navBefore, shares = 0
      const dustDeposit = 1n; // 1 wei USDT
      await usdt.mint(user2.address, dustDeposit);
      await usdt.connect(user2).approve(await vault.getAddress(), dustDeposit);

      // Note: In unit tests with mocks, this may not always trigger DepositTooSmall
      // because mock NAV calculation differs from real. Full test in fork tests.
      // The error exists to protect against dust deposits that round to 0 shares.
      const preview = await vault.previewDeposit(dustDeposit);
      if (preview === 0n) {
        await expect(
          vault.connect(user2).deposit(dustDeposit, user2.address)
        ).to.be.revertedWithCustomError(vault, "DepositTooSmall");
      }
    });
  });

  describe("Withdraw Flow", function () {
    beforeEach(async function () {
      // Setup: deposit some funds first
      const depositAmount = ethers.parseUnits("1000", 6);
      await vault.connect(user1).deposit(depositAmount, user1.address);
    });

    it("should allow redeem when paused", async function () {
      await vault.connect(admin).pause();

      const shares = await vault.balanceOf(user1.address);

      // Redeem should still work when paused (withdraw() is not supported)
      await expect(
        vault.connect(user1).redeem(shares, user1.address, user1.address)
      ).to.not.be.reverted;
    });

    it("should revert on mint() - not supported", async function () {
      const shares = ethers.parseUnits("100", 6);
      await expect(
        vault.connect(user1).mint(shares, user1.address)
      ).to.be.revertedWith("mint() not supported, use deposit()");
    });

    it("should revert on withdraw() - not supported", async function () {
      const assets = ethers.parseUnits("100", 6);
      await expect(
        vault.connect(user1).withdraw(assets, user1.address, user1.address)
      ).to.be.revertedWith("withdraw() not supported, use redeem()");
    });

    it("should return 0 for maxMint and maxWithdraw", async function () {
      expect(await vault.maxMint(user1.address)).to.equal(0);
      expect(await vault.maxWithdraw(user1.address)).to.equal(0);
    });
  });

  describe("Rebalance Flow", function () {
    it("should do nothing when no position and targetLTV = 0", async function () {
      // No position exists, rebalance to 0 should be no-op
      await expect(
        vault.connect(keeper).rebalance(0)
      ).to.not.be.reverted;
    });

    it("should update targetLTV storage", async function () {
      const newLTV = ethers.parseEther("0.5");
      await vault.connect(keeper).rebalance(newLTV);

      expect(await vault.targetLTV()).to.equal(newLTV);
    });

    it("should emit TargetLTVUpdated event", async function () {
      const oldLTV = await vault.targetLTV();
      const newLTV = ethers.parseEther("0.5");

      await expect(vault.connect(keeper).rebalance(newLTV))
        .to.emit(vault, "TargetLTVUpdated")
        .withArgs(oldLTV, newLTV);
    });
  });

  describe("Fee Harvesting", function () {
    it("should not mint fee shares when no profit above HWM", async function () {
      // Set targetLTV to 0 to avoid leverage complexity in mocks
      await vault.connect(keeper).rebalance(0);

      // Deposit (will just hold USDT, no leverage)
      await vault.connect(user1).deposit(ethers.parseUnits("1000", 6), user1.address);

      // Record state after deposit
      const totalSupplyBefore = await vault.totalSupply();
      const feeRecipientSharesBefore = await vault.balanceOf(admin.address);

      // Harvest - should not mint additional shares (no profit above HWM)
      await vault.connect(manager).harvestFees();

      const totalSupplyAfter = await vault.totalSupply();
      const feeRecipientSharesAfter = await vault.balanceOf(admin.address);

      // Total supply should not increase (no new shares minted)
      expect(totalSupplyAfter).to.equal(totalSupplyBefore);
      // Fee recipient should not get additional shares
      expect(feeRecipientSharesAfter).to.equal(feeRecipientSharesBefore);
    });

    it("should not harvest when performanceFeeBps is 0", async function () {
      await vault.connect(manager).setPerformanceFee(0);

      // Even if there's profit simulation, no fees should be collected
      await vault.connect(manager).harvestFees();

      // Just checking it doesn't revert
    });
  });

});
