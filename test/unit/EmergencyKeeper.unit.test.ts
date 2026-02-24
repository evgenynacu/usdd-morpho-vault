import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { EmergencyKeeper, MockVault } from "../../typechain-types";

const IDLE_MODE = ethers.MaxUint256;

describe("EmergencyKeeper Unit Tests", function () {
  let owner: SignerWithAddress;
  let nonOwner: SignerWithAddress;

  let keeper: EmergencyKeeper;
  let vault1: MockVault;
  let vault2: MockVault;
  let vault3: MockVault;

  let vault1Addr: string;
  let vault2Addr: string;
  let vault3Addr: string;

  beforeEach(async function () {
    [owner, nonOwner] = await ethers.getSigners();

    const KeeperFactory = await ethers.getContractFactory("EmergencyKeeper");
    keeper = (await KeeperFactory.deploy(owner.address)) as unknown as EmergencyKeeper;
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
    it("owner can call idleAll", async function () {
      await expect(keeper.connect(owner).idleAll([vault1Addr])).to.not.be.reverted;
    });

    it("owner can call pauseAll", async function () {
      await expect(keeper.connect(owner).pauseAll([vault1Addr])).to.not.be.reverted;
    });

    it("owner can call emergencyAll", async function () {
      await expect(keeper.connect(owner).emergencyAll([vault1Addr])).to.not.be.reverted;
    });

    it("non-owner cannot call idleAll", async function () {
      await expect(keeper.connect(nonOwner).idleAll([vault1Addr]))
        .to.be.revertedWithCustomError(keeper, "OwnableUnauthorizedAccount")
        .withArgs(nonOwner.address);
    });

    it("non-owner cannot call pauseAll", async function () {
      await expect(keeper.connect(nonOwner).pauseAll([vault1Addr]))
        .to.be.revertedWithCustomError(keeper, "OwnableUnauthorizedAccount")
        .withArgs(nonOwner.address);
    });

    it("non-owner cannot call emergencyAll", async function () {
      await expect(keeper.connect(nonOwner).emergencyAll([vault1Addr]))
        .to.be.revertedWithCustomError(keeper, "OwnableUnauthorizedAccount")
        .withArgs(nonOwner.address);
    });
  });

  // ============================================================
  // 2. idleAll
  // ============================================================
  describe("idleAll", function () {
    it("calls rebalance(type(uint256).max) on each vault", async function () {
      await keeper.connect(owner).idleAll([vault1Addr, vault2Addr, vault3Addr]);

      expect(await vault1.lastRebalanceLTV()).to.equal(IDLE_MODE);
      expect(await vault2.lastRebalanceLTV()).to.equal(IDLE_MODE);
      expect(await vault3.lastRebalanceLTV()).to.equal(IDLE_MODE);

      expect(await vault1.rebalanceCallCount()).to.equal(1);
      expect(await vault2.rebalanceCallCount()).to.equal(1);
      expect(await vault3.rebalanceCallCount()).to.equal(1);
    });

    it("returns true for successful vaults", async function () {
      const ok = await keeper.connect(owner).idleAll.staticCall([vault1Addr, vault2Addr]);

      expect(ok.length).to.equal(2);
      expect(ok[0]).to.equal(true);
      expect(ok[1]).to.equal(true);
    });

    it("returns false for reverting vaults", async function () {
      await vault2.setRevertOnRebalance(true);

      const ok = await keeper.connect(owner).idleAll.staticCall([vault1Addr, vault2Addr, vault3Addr]);

      expect(ok[0]).to.equal(true);
      expect(ok[1]).to.equal(false);
      expect(ok[2]).to.equal(true);
    });

    it("emits IdleResult events for each vault", async function () {
      await vault2.setRevertOnRebalance(true);

      await expect(keeper.connect(owner).idleAll([vault1Addr, vault2Addr, vault3Addr]))
        .to.emit(keeper, "IdleResult").withArgs(vault1Addr, true)
        .and.to.emit(keeper, "IdleResult").withArgs(vault2Addr, false)
        .and.to.emit(keeper, "IdleResult").withArgs(vault3Addr, true);
    });

    it("works with empty array", async function () {
      const tx = keeper.connect(owner).idleAll([]);
      await expect(tx).to.not.emit(keeper, "IdleResult");
      const ok = await keeper.connect(owner).idleAll.staticCall([]);
      expect(ok.length).to.equal(0);
    });

    it("continues calling remaining vaults when one reverts", async function () {
      await vault1.setRevertOnRebalance(true);

      await keeper.connect(owner).idleAll([vault1Addr, vault2Addr, vault3Addr]);

      // vault1 reverted, should not have been called successfully
      expect(await vault1.rebalanceCallCount()).to.equal(0);
      // vault2 and vault3 should still have been called
      expect(await vault2.rebalanceCallCount()).to.equal(1);
      expect(await vault3.rebalanceCallCount()).to.equal(1);
      expect(await vault2.lastRebalanceLTV()).to.equal(IDLE_MODE);
      expect(await vault3.lastRebalanceLTV()).to.equal(IDLE_MODE);
    });
  });

  // ============================================================
  // 3. pauseAll
  // ============================================================
  describe("pauseAll", function () {
    it("calls pause() on each vault", async function () {
      await keeper.connect(owner).pauseAll([vault1Addr, vault2Addr, vault3Addr]);

      expect(await vault1.paused()).to.equal(true);
      expect(await vault2.paused()).to.equal(true);
      expect(await vault3.paused()).to.equal(true);

      expect(await vault1.pauseCallCount()).to.equal(1);
      expect(await vault2.pauseCallCount()).to.equal(1);
      expect(await vault3.pauseCallCount()).to.equal(1);
    });

    it("returns true for successful vaults", async function () {
      const ok = await keeper.connect(owner).pauseAll.staticCall([vault1Addr, vault2Addr]);

      expect(ok.length).to.equal(2);
      expect(ok[0]).to.equal(true);
      expect(ok[1]).to.equal(true);
    });

    it("returns false for reverting vaults", async function () {
      await vault1.setRevertOnPause(true);
      await vault3.setRevertOnPause(true);

      const ok = await keeper.connect(owner).pauseAll.staticCall([vault1Addr, vault2Addr, vault3Addr]);

      expect(ok[0]).to.equal(false);
      expect(ok[1]).to.equal(true);
      expect(ok[2]).to.equal(false);
    });

    it("emits PauseResult events for each vault", async function () {
      await vault1.setRevertOnPause(true);

      await expect(keeper.connect(owner).pauseAll([vault1Addr, vault2Addr]))
        .to.emit(keeper, "PauseResult").withArgs(vault1Addr, false)
        .and.to.emit(keeper, "PauseResult").withArgs(vault2Addr, true);
    });

    it("works with empty array", async function () {
      const tx = keeper.connect(owner).pauseAll([]);
      await expect(tx).to.not.emit(keeper, "PauseResult");
      const ok = await keeper.connect(owner).pauseAll.staticCall([]);
      expect(ok.length).to.equal(0);
    });

    it("continues calling remaining vaults when one reverts", async function () {
      await vault2.setRevertOnPause(true);

      await keeper.connect(owner).pauseAll([vault1Addr, vault2Addr, vault3Addr]);

      expect(await vault1.paused()).to.equal(true);
      // vault2 reverted
      expect(await vault2.pauseCallCount()).to.equal(0);
      expect(await vault3.paused()).to.equal(true);
    });
  });

  // ============================================================
  // 4. emergencyAll
  // ============================================================
  describe("emergencyAll", function () {
    it("calls both rebalance and pause on each vault", async function () {
      await keeper.connect(owner).emergencyAll([vault1Addr, vault2Addr]);

      expect(await vault1.lastRebalanceLTV()).to.equal(IDLE_MODE);
      expect(await vault1.paused()).to.equal(true);
      expect(await vault1.rebalanceCallCount()).to.equal(1);
      expect(await vault1.pauseCallCount()).to.equal(1);

      expect(await vault2.lastRebalanceLTV()).to.equal(IDLE_MODE);
      expect(await vault2.paused()).to.equal(true);
      expect(await vault2.rebalanceCallCount()).to.equal(1);
      expect(await vault2.pauseCallCount()).to.equal(1);
    });

    it("emits both IdleResult and PauseResult events", async function () {
      await expect(keeper.connect(owner).emergencyAll([vault1Addr]))
        .to.emit(keeper, "IdleResult").withArgs(vault1Addr, true)
        .and.to.emit(keeper, "PauseResult").withArgs(vault1Addr, true);
    });

    it("continues with pause even if rebalance reverts on a vault", async function () {
      await vault1.setRevertOnRebalance(true);

      await keeper.connect(owner).emergencyAll([vault1Addr]);

      // rebalance reverted, so not called
      expect(await vault1.rebalanceCallCount()).to.equal(0);
      // pause should still be called
      expect(await vault1.paused()).to.equal(true);
      expect(await vault1.pauseCallCount()).to.equal(1);
    });

    it("continues with rebalance even if pause reverts on a vault", async function () {
      await vault1.setRevertOnPause(true);

      await keeper.connect(owner).emergencyAll([vault1Addr]);

      // rebalance should succeed
      expect(await vault1.lastRebalanceLTV()).to.equal(IDLE_MODE);
      expect(await vault1.rebalanceCallCount()).to.equal(1);
      // pause reverted
      expect(await vault1.pauseCallCount()).to.equal(0);
    });

    it("emits correct events when rebalance fails but pause succeeds", async function () {
      await vault1.setRevertOnRebalance(true);

      await expect(keeper.connect(owner).emergencyAll([vault1Addr]))
        .to.emit(keeper, "IdleResult").withArgs(vault1Addr, false)
        .and.to.emit(keeper, "PauseResult").withArgs(vault1Addr, true);
    });

    it("emits correct events when rebalance succeeds but pause fails", async function () {
      await vault1.setRevertOnPause(true);

      await expect(keeper.connect(owner).emergencyAll([vault1Addr]))
        .to.emit(keeper, "IdleResult").withArgs(vault1Addr, true)
        .and.to.emit(keeper, "PauseResult").withArgs(vault1Addr, false);
    });

    it("emits correct events when both fail", async function () {
      await vault1.setRevertOnRebalance(true);
      await vault1.setRevertOnPause(true);

      await expect(keeper.connect(owner).emergencyAll([vault1Addr]))
        .to.emit(keeper, "IdleResult").withArgs(vault1Addr, false)
        .and.to.emit(keeper, "PauseResult").withArgs(vault1Addr, false);
    });

    it("works with empty array", async function () {
      const tx = keeper.connect(owner).emergencyAll([]);
      await expect(tx).to.not.emit(keeper, "IdleResult");
      await expect(tx).to.not.emit(keeper, "PauseResult");
    });

    it("handles mix of working and failing vaults", async function () {
      // vault1: both work
      // vault2: rebalance fails, pause works
      // vault3: rebalance works, pause fails
      await vault2.setRevertOnRebalance(true);
      await vault3.setRevertOnPause(true);

      const tx = keeper.connect(owner).emergencyAll([vault1Addr, vault2Addr, vault3Addr]);

      await expect(tx)
        .to.emit(keeper, "IdleResult").withArgs(vault1Addr, true)
        .and.to.emit(keeper, "PauseResult").withArgs(vault1Addr, true)
        .and.to.emit(keeper, "IdleResult").withArgs(vault2Addr, false)
        .and.to.emit(keeper, "PauseResult").withArgs(vault2Addr, true)
        .and.to.emit(keeper, "IdleResult").withArgs(vault3Addr, true)
        .and.to.emit(keeper, "PauseResult").withArgs(vault3Addr, false);

      // vault1: both succeeded
      expect(await vault1.rebalanceCallCount()).to.equal(1);
      expect(await vault1.pauseCallCount()).to.equal(1);

      // vault2: rebalance failed, pause succeeded
      expect(await vault2.rebalanceCallCount()).to.equal(0);
      expect(await vault2.pauseCallCount()).to.equal(1);

      // vault3: rebalance succeeded, pause failed
      expect(await vault3.rebalanceCallCount()).to.equal(1);
      expect(await vault3.pauseCallCount()).to.equal(0);
    });

    it("processes all vaults even when all rebalances fail", async function () {
      await vault1.setRevertOnRebalance(true);
      await vault2.setRevertOnRebalance(true);
      await vault3.setRevertOnRebalance(true);

      await keeper.connect(owner).emergencyAll([vault1Addr, vault2Addr, vault3Addr]);

      // All rebalances failed
      expect(await vault1.rebalanceCallCount()).to.equal(0);
      expect(await vault2.rebalanceCallCount()).to.equal(0);
      expect(await vault3.rebalanceCallCount()).to.equal(0);

      // But all pauses should still succeed
      expect(await vault1.paused()).to.equal(true);
      expect(await vault2.paused()).to.equal(true);
      expect(await vault3.paused()).to.equal(true);
    });
  });

  // ============================================================
  // 5. CONSTRUCTOR
  // ============================================================
  describe("Constructor", function () {
    it("sets the correct owner", async function () {
      expect(await keeper.owner()).to.equal(owner.address);
    });

    it("can deploy with a different owner", async function () {
      const KeeperFactory = await ethers.getContractFactory("EmergencyKeeper");
      const keeper2 = await KeeperFactory.deploy(nonOwner.address);
      await keeper2.waitForDeployment();

      expect(await keeper2.owner()).to.equal(nonOwner.address);
    });
  });

});
