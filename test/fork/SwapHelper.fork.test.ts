import { expect } from "chai";
import { ethers } from "hardhat";
import { ADDRESSES, DECIMALS, WAD } from "./helpers/constants";
import { SwapHelperHarness } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("SwapHelper Tests (Fork)", function () {
  let harness: SwapHelperHarness;
  let signer: HardhatEthersSigner;

  // Skip if not forking mainnet
  before(async function () {
    const network = await ethers.provider.getNetwork();
    if (network.chainId !== 1n && network.chainId !== 31337n) {
      this.skip();
    }
    // Check if we have forked mainnet
    const code = await ethers.provider.getCode(ADDRESSES.MORPHO);
    if (code === "0x") {
      console.log("Skipping fork tests - no mainnet fork detected");
      this.skip();
    }

    [signer] = await ethers.getSigners();

    // Deploy test harness
    const HarnessFactory = await ethers.getContractFactory("SwapHelperHarness");
    harness = await HarnessFactory.deploy();
    await harness.waitForDeployment();
  });

  describe("View Functions", function () {
    it("should get sUSDD rate", async function () {
      const rate = await harness.getSUSDDRate();

      console.log(`sUSDD rate: ${ethers.formatUnits(rate, 18)} USDD per sUSDD`);

      // Rate should be >= 1 (sUSDD accrues value over time)
      expect(rate).to.be.gte(WAD);
    });

    it("should calculate USDT value of sUSDD", async function () {
      const susddAmount = ethers.parseUnits("1000", DECIMALS.SUSDD);
      const usdtValue = await harness.getUSDTValue(susddAmount);

      console.log(`1000 sUSDD = ${ethers.formatUnits(usdtValue, DECIMALS.USDT)} USDT`);

      // Value should be positive and reasonable (accounting for rate and fees)
      expect(usdtValue).to.be.gt(0);
      // Should be at least 900 USDT (accounting for fees and rounding)
      expect(usdtValue).to.be.gte(ethers.parseUnits("900", DECIMALS.USDT));
    });

    it("should preview USDT to sUSDD swap", async function () {
      const usdtAmount = ethers.parseUnits("1000", DECIMALS.USDT);
      const susddPreview = await harness.previewSwapUSDTtoSUSDD(usdtAmount);

      console.log(`1000 USDT -> ${ethers.formatUnits(susddPreview, DECIMALS.SUSDD)} sUSDD (preview)`);

      // Should get some sUSDD back
      expect(susddPreview).to.be.gt(0);
    });

    it("should preview sUSDD to USDT swap", async function () {
      const susddAmount = ethers.parseUnits("1000", DECIMALS.SUSDD);
      const usdtPreview = await harness.previewSwapSUSDDtoUSDT(susddAmount);

      console.log(`1000 sUSDD -> ${ethers.formatUnits(usdtPreview, DECIMALS.USDT)} USDT (preview)`);

      // Should get some USDT back
      expect(usdtPreview).to.be.gt(0);
    });

    it("should handle zero amounts", async function () {
      expect(await harness.getUSDTValue(0)).to.equal(0);
      expect(await harness.previewSwapUSDTtoSUSDD(0)).to.equal(0);
      expect(await harness.previewSwapSUSDDtoUSDT(0)).to.equal(0);
    });
  });

  describe("Swap Functions", function () {
    async function fundWithUSDT(recipient: string, amount: bigint) {
      // Find a USDT whale and impersonate
      const whaleAddress = "0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503"; // Binance 8
      await ethers.provider.send("hardhat_impersonateAccount", [whaleAddress]);
      const whale = await ethers.getSigner(whaleAddress);

      // Fund whale with ETH for gas
      await signer.sendTransaction({
        to: whaleAddress,
        value: ethers.parseEther("1"),
      });

      // Transfer USDT to recipient
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      await usdt.connect(whale).transfer(recipient, amount);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [whaleAddress]);
    }

    it("should swap USDT to sUSDD", async function () {
      const usdtAmount = ethers.parseUnits("1000", DECIMALS.USDT);

      // Fund harness with USDT
      await fundWithUSDT(await harness.getAddress(), usdtAmount);

      // Check initial balances
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      const susdd = await ethers.getContractAt("IERC20", ADDRESSES.SUSDD);

      const usdtBefore = await usdt.balanceOf(await harness.getAddress());
      const susddBefore = await susdd.balanceOf(await harness.getAddress());

      console.log(`Before: ${ethers.formatUnits(usdtBefore, DECIMALS.USDT)} USDT, ${ethers.formatUnits(susddBefore, DECIMALS.SUSDD)} sUSDD`);

      // Execute swap
      const tx = await harness.swapUSDTtoSUSDD(usdtAmount);
      const receipt = await tx.wait();

      const usdtAfter = await usdt.balanceOf(await harness.getAddress());
      const susddAfter = await susdd.balanceOf(await harness.getAddress());

      console.log(`After: ${ethers.formatUnits(usdtAfter, DECIMALS.USDT)} USDT, ${ethers.formatUnits(susddAfter, DECIMALS.SUSDD)} sUSDD`);
      console.log(`Gas used: ${receipt?.gasUsed}`);

      // USDT should be spent
      expect(usdtAfter).to.equal(usdtBefore - usdtAmount);
      // Should have received sUSDD
      expect(susddAfter).to.be.gt(susddBefore);

      // Received sUSDD should be reasonable (accounting for fees)
      const susddReceived = susddAfter - susddBefore;
      // Expect at least 900 sUSDD worth (with fees and rate)
      const rate = await harness.getSUSDDRate();
      const minExpected = (ethers.parseUnits("900", 18) * WAD) / rate;
      expect(susddReceived).to.be.gte(minExpected);
    });

    it("should swap sUSDD to USDT", async function () {
      // Harness should have sUSDD from previous test
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      const susdd = await ethers.getContractAt("IERC20", ADDRESSES.SUSDD);

      const susddBefore = await susdd.balanceOf(await harness.getAddress());
      const usdtBefore = await usdt.balanceOf(await harness.getAddress());

      // Skip if no sUSDD
      if (susddBefore === 0n) {
        this.skip();
      }

      console.log(`Before: ${ethers.formatUnits(usdtBefore, DECIMALS.USDT)} USDT, ${ethers.formatUnits(susddBefore, DECIMALS.SUSDD)} sUSDD`);

      // Swap half of sUSDD back
      const swapAmount = susddBefore / 2n;
      const tx = await harness.swapSUSDDtoUSDT(swapAmount);
      const receipt = await tx.wait();

      const usdtAfter = await usdt.balanceOf(await harness.getAddress());
      const susddAfter = await susdd.balanceOf(await harness.getAddress());

      console.log(`After: ${ethers.formatUnits(usdtAfter, DECIMALS.USDT)} USDT, ${ethers.formatUnits(susddAfter, DECIMALS.SUSDD)} sUSDD`);
      console.log(`Gas used: ${receipt?.gasUsed}`);

      // sUSDD should be spent
      expect(susddAfter).to.equal(susddBefore - swapAmount);
      // Should have received USDT
      expect(usdtAfter).to.be.gt(usdtBefore);
    });

    it("should handle zero amount swaps", async function () {
      const usdt = await ethers.getContractAt("IERC20", ADDRESSES.USDT);
      const susdd = await ethers.getContractAt("IERC20", ADDRESSES.SUSDD);

      const usdtBefore = await usdt.balanceOf(await harness.getAddress());
      const susddBefore = await susdd.balanceOf(await harness.getAddress());

      // Swap 0 USDT
      await harness.swapUSDTtoSUSDD(0);

      const usdtAfter = await usdt.balanceOf(await harness.getAddress());
      const susddAfter = await susdd.balanceOf(await harness.getAddress());

      // Balances should be unchanged
      expect(usdtAfter).to.equal(usdtBefore);
      expect(susddAfter).to.equal(susddBefore);
    });
  });
});
