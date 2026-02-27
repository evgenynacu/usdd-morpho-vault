import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import fs from "fs";
import path from "path";
import { ADDRESSES, MARKET_ID, DECIMALS } from "./helpers/constants";
import { SUSDDVault } from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Upgrade Tests on Existing Production Vaults
 *
 * Tests upgrade + critical operations (redeem, rebalance) against
 * real deployed vaults with real state on mainnet fork.
 *
 * Reads vault addresses from VAULTS env var (comma-separated).
 */
describe("Upgrade Tests - Existing Vaults", function () {
  const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const KEEPER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("KEEPER_ROLE"));
  const MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MANAGER_ROLE"));
  const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
  const IDLE_MODE = 2n ** 256n - 1n; // type(uint256).max

  // Map of proxy address -> deploy tx hash from .openzeppelin/mainnet.json
  let deployTxMap: Record<string, string> = {};
  let funder: HardhatEthersSigner;

  before(async function () {
    const code = await ethers.provider.getCode(ADDRESSES.MORPHO);
    if (code === "0x") {
      console.log("Skipping fork tests - no mainnet fork detected");
      this.skip();
    }

    const vaults = process.env.VAULTS;
    if (!vaults) {
      console.log("Skipping - VAULTS env var not set");
      this.skip();
    }

    // Load deploy tx hashes from OZ manifest
    const manifestPath = path.resolve(__dirname, "../../.openzeppelin/mainnet.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      for (const proxy of manifest.proxies || []) {
        deployTxMap[proxy.address.toLowerCase()] = proxy.txHash;
      }
    }

    [funder] = await ethers.getSigners();
  });

  async function impersonate(address: string): Promise<HardhatEthersSigner> {
    await ethers.provider.send("hardhat_impersonateAccount", [address]);
    await funder.sendTransaction({ to: address, value: ethers.parseEther("10") });
    return ethers.getSigner(address);
  }

  async function stopImpersonating(address: string) {
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [address]);
  }

  async function findAdmin(vault: SUSDDVault): Promise<string> {
    const vaultAddress = (await vault.getAddress()).toLowerCase();

    // Strategy 1: Decode deploy tx from OZ manifest (works on any fork)
    const txHash = deployTxMap[vaultAddress];
    if (txHash) {
      const receipt = await ethers.provider.getTransactionReceipt(txHash);
      if (receipt) {
        const roleGrantedTopic = ethers.id("RoleGranted(bytes32,address,address)");
        for (const log of receipt.logs) {
          if (log.topics[0] === roleGrantedTopic && log.topics[1] === DEFAULT_ADMIN_ROLE) {
            const admin = ethers.getAddress("0x" + log.topics[2].slice(26));
            if (await vault.hasRole(DEFAULT_ADMIN_ROLE, admin)) {
              return admin;
            }
          }
        }
      }
    }

    // Strategy 2: Check deployer (tx.from) as fallback
    if (txHash) {
      const tx = await ethers.provider.getTransaction(txHash);
      if (tx && await vault.hasRole(DEFAULT_ADMIN_ROLE, tx.from)) {
        return tx.from;
      }
    }

    throw new Error("No admin found");
  }

  async function findShareHolder(vault: SUSDDVault): Promise<{ address: string; shares: bigint } | null> {
    const vaultAddress = (await vault.getAddress()).toLowerCase();

    // Strategy 1: Decode deploy tx for initial depositor
    const txHash = deployTxMap[vaultAddress];
    if (txHash) {
      const receipt = await ethers.provider.getTransactionReceipt(txHash);
      if (receipt) {
        const transferTopic = ethers.id("Transfer(address,address,uint256)");
        const candidates: string[] = [];
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() === vaultAddress && log.topics[0] === transferTopic) {
            const to = ethers.getAddress("0x" + log.topics[2].slice(26));
            if (to !== ethers.ZeroAddress) {
              candidates.push(to);
            }
          }
        }
        for (const addr of candidates) {
          const shares = await vault.balanceOf(addr);
          if (shares > 0n) return { address: addr, shares };
        }
      }
    }

    // Strategy 2: Check the admin (often the initial depositor)
    const admin = await findAdmin(vault);
    const adminShares = await vault.balanceOf(admin);
    if (adminShares > 0n) return { address: admin, shares: adminShares };

    return null;
  }

  async function getMorphoPosition(vaultAddress: string) {
    const morpho = await ethers.getContractAt("contracts/interfaces/IMorpho.sol:IMorpho", ADDRESSES.MORPHO);
    return morpho.position(MARKET_ID, vaultAddress);
  }

  async function performUpgrade(vaultAddress: string, adminSigner: HardhatEthersSigner) {
    const VaultFactory = await ethers.getContractFactory("SUSDDVault", adminSigner);
    await upgrades.upgradeProxy(vaultAddress, VaultFactory, {
      unsafeSkipStorageCheck: true,
    });
  }

  const vaultAddresses = (process.env.VAULTS || "").split(",").filter(Boolean);

  for (const vaultAddress of vaultAddresses) {
    describe(`Vault ${vaultAddress.slice(0, 10)}...`, function () {
      let vault: SUSDDVault;
      let adminAddress: string;

      beforeEach(async function () {
        vault = await ethers.getContractAt("SUSDDVault", vaultAddress) as unknown as SUSDDVault;

        try {
          adminAddress = await findAdmin(vault);
        } catch (e) {
          console.log(`  Skipping - could not find admin for ${vaultAddress}: ${e}`);
          this.skip();
        }
      });

      it("upgrade preserves state", async function () {
        // --- Snapshot ALL state before upgrade ---
        const [
          totalAssetsBefore, totalSupplyBefore, targetLTVBefore,
          hwmBefore, feeBpsBefore, feeRecipientBefore,
          whitelistBefore, pausedBefore, maxTotalAssetsBefore,
          nameBefore, symbolBefore, decimalsBefore,
        ] = await Promise.all([
          vault.totalAssets(), vault.totalSupply(), vault.targetLTV(),
          vault.highWaterMark(), vault.performanceFeeBps(), vault.feeRecipient(),
          vault.whitelistEnabled(), vault.paused(), vault.maxTotalAssets(),
          vault.name(), vault.symbol(), vault.decimals(),
        ]);

        const holder = await findShareHolder(vault);
        const holderBalanceBefore = holder ? holder.shares : 0n;
        const posBefore = await getMorphoPosition(vaultAddress);

        // --- Upgrade ---
        const adminSigner = await impersonate(adminAddress);
        await performUpgrade(vaultAddress, adminSigner);
        await stopImpersonating(adminAddress);

        // --- Verify state preserved ---

        // totalAssets: tiny tolerance because Morpho interest accrues between blocks
        // (upgrade tx mines a new block, expectedBorrowAssets changes)
        const totalAssetsAfter = await vault.totalAssets();
        const taTolerance = totalAssetsBefore / 10000n || 1n; // 0.01%
        expect(totalAssetsAfter).to.be.gte(totalAssetsBefore - taTolerance, "totalAssets dropped too much");
        expect(totalAssetsAfter).to.be.lte(totalAssetsBefore + taTolerance, "totalAssets grew too much");
        expect(await vault.totalSupply()).to.equal(totalSupplyBefore, "totalSupply changed");
        expect(await vault.targetLTV()).to.equal(targetLTVBefore, "targetLTV changed");
        expect(await vault.highWaterMark()).to.equal(hwmBefore, "highWaterMark changed");
        expect(await vault.performanceFeeBps()).to.equal(feeBpsBefore, "performanceFeeBps changed");
        expect(await vault.feeRecipient()).to.equal(feeRecipientBefore, "feeRecipient changed");
        expect(await vault.whitelistEnabled()).to.equal(whitelistBefore, "whitelistEnabled changed");
        expect(await vault.paused()).to.equal(pausedBefore, "paused changed");
        expect(await vault.maxTotalAssets()).to.equal(maxTotalAssetsBefore, "maxTotalAssets changed");

        // ERC20 metadata
        expect(await vault.name()).to.equal(nameBefore, "name changed");
        expect(await vault.symbol()).to.equal(symbolBefore, "symbol changed");
        expect(await vault.decimals()).to.equal(decimalsBefore, "decimals changed");

        // Individual holder balance
        if (holder) {
          expect(await vault.balanceOf(holder.address)).to.equal(holderBalanceBefore, "holder balance changed");
        }

        // Morpho position (collateral + debt untouched)
        const posAfter = await getMorphoPosition(vaultAddress);
        expect(posAfter.collateral).to.equal(posBefore.collateral, "Morpho collateral changed");
        expect(posAfter.borrowShares).to.equal(posBefore.borrowShares, "Morpho borrowShares changed");

        // All roles preserved for admin
        expect(await vault.hasRole(DEFAULT_ADMIN_ROLE, adminAddress)).to.be.true;
        expect(await vault.hasRole(KEEPER_ROLE, adminAddress)).to.be.true;
        expect(await vault.hasRole(MANAGER_ROLE, adminAddress)).to.be.true;
        expect(await vault.hasRole(PAUSER_ROLE, adminAddress)).to.be.true;

        console.log(`  ✓ State preserved (15 fields + roles + Morpho position)`);
        console.log(`    totalAssets: ${ethers.formatUnits(totalAssetsBefore, DECIMALS.USDT)} USDT`);
        console.log(`    totalSupply: ${ethers.formatUnits(totalSupplyBefore, 18)} shares`);
        console.log(`    targetLTV: ${targetLTVBefore === IDLE_MODE ? "IDLE" : ethers.formatUnits(targetLTVBefore, 16) + "%"}`);
        console.log(`    Morpho collateral: ${ethers.formatUnits(posBefore.collateral, 18)} sUSDD`);
        console.log(`    Morpho borrowShares: ${posBefore.borrowShares}`);
      });

      it("redeem works after upgrade", async function () {
        const holder = await findShareHolder(vault);
        if (!holder || holder.shares < 2n) {
          console.log("  Skipping - no shareholders with enough shares");
          this.skip();
          return;
        }

        const navBefore = await vault.totalAssets();
        const supplyBefore = await vault.totalSupply();

        // Upgrade
        const adminSigner = await impersonate(adminAddress);
        await performUpgrade(vaultAddress, adminSigner);
        await stopImpersonating(adminAddress);

        // Redeem half shares
        const holderSigner = await impersonate(holder.address);
        const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
        const redeemShares = holder.shares / 2n;

        const usdtBefore = await usdt.balanceOf(holder.address);
        const sharesBefore = await vault.balanceOf(holder.address);

        await vault.connect(holderSigner).redeem(redeemShares, holder.address, holder.address);

        const usdtAfter = await usdt.balanceOf(holder.address);
        const sharesAfter = await vault.balanceOf(holder.address);
        const supplyAfter = await vault.totalSupply();
        await stopImpersonating(holder.address);

        // 1. Shares burned correctly
        expect(sharesAfter).to.equal(sharesBefore - redeemShares, "shares not burned correctly");

        // 2. Total supply decreased (fee shares may be minted, but net effect is decrease)
        expect(supplyAfter).to.be.lt(supplyBefore, "totalSupply did not decrease");

        // 3. Received USDT > 0
        const received = usdtAfter - usdtBefore;
        expect(received).to.be.gt(0n, "received 0 USDT");

        // 4. Received amount is reasonable: at least 50% of proportional NAV
        //    (PSM fees + slippage shouldn't eat more than 50%)
        const expectedProportional = (navBefore * redeemShares) / supplyBefore;
        expect(received).to.be.gte(
          expectedProportional / 2n,
          `received ${received} < 50% of proportional NAV ${expectedProportional}`
        );

        console.log(`  ✓ Redeem: ${ethers.formatUnits(redeemShares, 18)} shares → ${ethers.formatUnits(received, DECIMALS.USDT)} USDT`);
        console.log(`    Expected proportional: ~${ethers.formatUnits(expectedProportional, DECIMALS.USDT)} USDT`);
        console.log(`    Efficiency: ${Number((received * 10000n) / expectedProportional) / 100}%`);
      });

      it("rebalance changes position after upgrade", async function () {
        const currentLTV = await vault.targetLTV();
        const isPaused = await vault.paused();

        if (isPaused) {
          console.log("  Skipping - vault is paused");
          this.skip();
          return;
        }

        if (currentLTV === IDLE_MODE || currentLTV === 0n) {
          console.log(`  Skipping - vault not in leveraged mode (targetLTV=${currentLTV === IDLE_MODE ? "IDLE" : "0"})`);
          this.skip();
          return;
        }

        const posBefore = await getMorphoPosition(vaultAddress);
        if (posBefore.borrowShares === 0n) {
          console.log("  Skipping - no active Morpho position");
          this.skip();
          return;
        }

        // Upgrade
        const adminSigner = await impersonate(adminAddress);
        await performUpgrade(vaultAddress, adminSigner);

        // Rebalance to 10% lower LTV (delever) — exercises the actual rebalance path
        const newLTV = (currentLTV * 90n) / 100n;
        const navBefore = await vault.totalAssets();

        await vault.connect(adminSigner).rebalance(newLTV);

        const navAfter = await vault.totalAssets();
        const posAfter = await getMorphoPosition(vaultAddress);
        const actualLTV = await vault.targetLTV();
        await stopImpersonating(adminAddress);

        // 1. targetLTV updated to new value
        expect(actualLTV).to.equal(newLTV, "targetLTV not updated");

        // 2. Morpho position actually changed (delever = debt decreased)
        expect(posAfter.borrowShares).to.be.lt(
          posBefore.borrowShares,
          "borrowShares did not decrease after delever"
        );

        // 3. NAV preserved within 2% (PSM fees on collateral swap)
        const tolerance = navBefore / 50n || 1n;
        expect(navAfter).to.be.gte(navBefore - tolerance, "NAV dropped more than 2%");
        expect(navAfter).to.be.lte(navBefore + tolerance, "NAV increased more than 2%");

        console.log(`  ✓ Rebalance: LTV ${ethers.formatUnits(currentLTV, 16)}% → ${ethers.formatUnits(newLTV, 16)}%`);
        console.log(`    borrowShares: ${posBefore.borrowShares} → ${posAfter.borrowShares}`);
        console.log(`    collateral: ${ethers.formatUnits(posBefore.collateral, 18)} → ${ethers.formatUnits(posAfter.collateral, 18)} sUSDD`);
        console.log(`    NAV: ${ethers.formatUnits(navBefore, DECIMALS.USDT)} → ${ethers.formatUnits(navAfter, DECIMALS.USDT)} USDT`);
      });

      it("non-admin cannot upgrade", async function () {
        const [, randomSigner] = await ethers.getSigners();
        const VaultFactory = await ethers.getContractFactory("SUSDDVault", randomSigner);

        await expect(
          upgrades.upgradeProxy(vaultAddress, VaultFactory, {
            unsafeSkipStorageCheck: true,
          })
        ).to.be.reverted;
      });

      it("proxy remains upgradeable after upgrade (double upgrade)", async function () {
        const adminSigner = await impersonate(adminAddress);

        // First upgrade
        await performUpgrade(vaultAddress, adminSigner);

        // Snapshot state between upgrades
        const navBetween = await vault.totalAssets();
        const supplyBetween = await vault.totalSupply();

        // Second upgrade — if this reverts, proxy is bricked
        await performUpgrade(vaultAddress, adminSigner);

        await stopImpersonating(adminAddress);

        // State still intact after double upgrade
        const navAfter = await vault.totalAssets();
        const tolerance = navBetween / 10000n || 1n; // 0.01%
        expect(navAfter).to.be.gte(navBetween - tolerance, "NAV changed after second upgrade");
        expect(navAfter).to.be.lte(navBetween + tolerance, "NAV changed after second upgrade");
        expect(await vault.totalSupply()).to.equal(supplyBetween, "totalSupply changed after second upgrade");
        expect(await vault.hasRole(DEFAULT_ADMIN_ROLE, adminAddress)).to.be.true;

        console.log(`  ✓ Double upgrade: proxy still upgradeable and functional`);
      });

      it("initialize cannot be called after upgrade", async function () {
        const adminSigner = await impersonate(adminAddress);
        await performUpgrade(vaultAddress, adminSigner);

        // Re-initialize on proxy — must revert (initializer already used)
        await expect(
          vault.connect(adminSigner).initialize(
            adminAddress, adminAddress, 0n, 1000n, ethers.parseUnits("1000000", 6)
          )
        ).to.be.reverted;

        await stopImpersonating(adminAddress);
      });

      it("implementation contract cannot be initialized directly", async function () {
        // Upgrade to deploy new implementation
        const adminSigner = await impersonate(adminAddress);
        await performUpgrade(vaultAddress, adminSigner);
        await stopImpersonating(adminAddress);

        // Read new implementation address from ERC1967 slot
        const ERC1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
        const implStorage = await ethers.provider.getStorage(vaultAddress, ERC1967_IMPL_SLOT);
        const implAddress = ethers.getAddress("0x" + implStorage.slice(26));

        // Initialize on bare implementation — must revert (_disableInitializers in constructor)
        const impl = await ethers.getContractAt("SUSDDVault", implAddress) as unknown as SUSDDVault;
        await expect(
          impl.initialize(funder.address, funder.address, 0n, 1000n, ethers.parseUnits("1000000", 6))
        ).to.be.reverted;

        console.log(`  ✓ Implementation ${implAddress} is not initializable`);
      });
    });
  }
});
