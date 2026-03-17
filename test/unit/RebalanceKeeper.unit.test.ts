import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { RebalanceKeeper, MockVault } from "../../typechain-types";

const IDLE_MODE = ethers.MaxUint256;

describe("RebalanceKeeper Unit Tests", function () {
  let owner: SignerWithAddress;
  let nonOwner: SignerWithAddress;

  let keeper: RebalanceKeeper;
  let vault1: MockVault;
  let vault2: MockVault;
  let vault3: MockVault;

  let vault1Addr: string;
  let vault2Addr: string;
  let vault3Addr: string;

  beforeEach(async function () {
    [owner, nonOwner] = await ethers.getSigners();

    const KeeperFactory = await ethers.getContractFactory("RebalanceKeeper");
    keeper = (await KeeperFactory.deploy(owner.address)) as unknown as RebalanceKeeper;
    await keeper.waitForDeployment();

    const MockVaultFactory = await ethers.getContractFactory("MockVault");
    vault1 = (await MockVaultFactory.deploy()) as unknown as MockVault;
    vault2 = (await MockVaultFactory.deploy()) as unknown as MockVault;
    vault3 = (await MockVaultFactory.deploy()) as unknown as MockVault;
    await vault1.waitForDeployment();
    await vault2.waitForDeployment();
    await vault3.waitForDeployment();

    vault1Addr = await vault1.getAddress();
    vault2Addr = await vault2.getAddress();
    vault3Addr = await vault3.getAddress();
  });

  // ============================================================
  // 1. ACCESS CONTROL
  // ============================================================
  describe("Access Control", function () {
    it("owner can call rebalanceAll", async function () {
      await expect(keeper.connect(owner).rebalanceAll([vault1Addr], ethers.parseEther("0.75"))).to.not.be.reverted;
    });

    it("non-owner cannot call rebalanceAll", async function () {
      await expect(keeper.connect(nonOwner).rebalanceAll([vault1Addr], ethers.parseEther("0.75")))
        .to.be.revertedWithCustomError(keeper, "OwnableUnauthorizedAccount")
        .withArgs(nonOwner.address);
    });
  });

  // ============================================================
  // 2. rebalanceAll
  // ============================================================
  describe("rebalanceAll", function () {
    const NEW_LTV = ethers.parseEther("0.75");

    it("calls rebalance(newLTV) on each vault", async function () {
      await keeper.connect(owner).rebalanceAll([vault1Addr, vault2Addr, vault3Addr], NEW_LTV);

      expect(await vault1.lastRebalanceLTV()).to.equal(NEW_LTV);
      expect(await vault2.lastRebalanceLTV()).to.equal(NEW_LTV);
      expect(await vault3.lastRebalanceLTV()).to.equal(NEW_LTV);

      expect(await vault1.rebalanceCallCount()).to.equal(1);
      expect(await vault2.rebalanceCallCount()).to.equal(1);
      expect(await vault3.rebalanceCallCount()).to.equal(1);
    });

    it("returns true for successful vaults", async function () {
      const ok = await keeper.connect(owner).rebalanceAll.staticCall([vault1Addr, vault2Addr], NEW_LTV);

      expect(ok.length).to.equal(2);
      expect(ok[0]).to.equal(true);
      expect(ok[1]).to.equal(true);
    });

    it("skips vaults in IDLE_MODE", async function () {
      await vault2.setTargetLTV(IDLE_MODE);

      const ok = await keeper.connect(owner).rebalanceAll.staticCall([vault1Addr, vault2Addr, vault3Addr], NEW_LTV);

      expect(ok[0]).to.equal(true);
      expect(ok[1]).to.equal(false);
      expect(ok[2]).to.equal(true);
    });

    it("does not call rebalance on vaults in IDLE_MODE", async function () {
      await vault2.setTargetLTV(IDLE_MODE);

      await keeper.connect(owner).rebalanceAll([vault1Addr, vault2Addr, vault3Addr], NEW_LTV);

      expect(await vault1.rebalanceCallCount()).to.equal(1);
      expect(await vault2.rebalanceCallCount()).to.equal(0);
      expect(await vault3.rebalanceCallCount()).to.equal(1);
    });

    it("reverts when newTargetLTV is IDLE_MODE", async function () {
      await expect(keeper.connect(owner).rebalanceAll([vault1Addr], IDLE_MODE))
        .to.be.revertedWith("Cannot set IDLE_MODE");
    });

    it("emits RebalanceResult events", async function () {
      await vault2.setTargetLTV(IDLE_MODE);

      await expect(keeper.connect(owner).rebalanceAll([vault1Addr, vault2Addr, vault3Addr], NEW_LTV))
        .to.emit(keeper, "RebalanceResult").withArgs(vault1Addr, true)
        .and.to.emit(keeper, "RebalanceResult").withArgs(vault2Addr, false)
        .and.to.emit(keeper, "RebalanceResult").withArgs(vault3Addr, true);
    });

    it("continues when one vault reverts on rebalance", async function () {
      await vault1.setRevertOnRebalance(true);

      await keeper.connect(owner).rebalanceAll([vault1Addr, vault2Addr, vault3Addr], NEW_LTV);

      expect(await vault1.rebalanceCallCount()).to.equal(0);
      expect(await vault2.rebalanceCallCount()).to.equal(1);
      expect(await vault3.rebalanceCallCount()).to.equal(1);
    });

    it("returns false for reverting vaults", async function () {
      await vault2.setRevertOnRebalance(true);

      const ok = await keeper.connect(owner).rebalanceAll.staticCall([vault1Addr, vault2Addr, vault3Addr], NEW_LTV);

      expect(ok[0]).to.equal(true);
      expect(ok[1]).to.equal(false);
      expect(ok[2]).to.equal(true);
    });

    it("works with empty array", async function () {
      const tx = keeper.connect(owner).rebalanceAll([], NEW_LTV);
      await expect(tx).to.not.emit(keeper, "RebalanceResult");
      const ok = await keeper.connect(owner).rebalanceAll.staticCall([], NEW_LTV);
      expect(ok.length).to.equal(0);
    });

    it("allows newTargetLTV = 0 (unleveraged)", async function () {
      await keeper.connect(owner).rebalanceAll([vault1Addr], 0);

      expect(await vault1.lastRebalanceLTV()).to.equal(0);
      expect(await vault1.rebalanceCallCount()).to.equal(1);
    });
  });

  // ============================================================
  // 3. CONSTRUCTOR
  // ============================================================
  describe("Constructor", function () {
    it("sets the correct owner", async function () {
      expect(await keeper.owner()).to.equal(owner.address);
    });

    it("can deploy with a different owner", async function () {
      const KeeperFactory = await ethers.getContractFactory("RebalanceKeeper");
      const keeper2 = await KeeperFactory.deploy(nonOwner.address);
      await keeper2.waitForDeployment();

      expect(await keeper2.owner()).to.equal(nonOwner.address);
    });
  });
});
