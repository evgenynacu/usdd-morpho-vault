import { expect } from "chai";
import { ethers } from "hardhat";
import { ADDRESSES, MARKET_ID, WAD } from "./helpers/constants";

describe("Interface Compatibility Tests (Fork)", function () {
  // Skip if not forking mainnet
  before(async function () {
    const network = await ethers.provider.getNetwork();
    if (network.chainId !== 1n && network.chainId !== 31337n) {
      this.skip();
    }
    // Check if we have forked mainnet by checking if a known contract exists
    const code = await ethers.provider.getCode(ADDRESSES.MORPHO);
    if (code === "0x") {
      console.log("Skipping fork tests - no mainnet fork detected");
      this.skip();
    }
  });

  describe("PSM Interface", function () {
    it("should read PSM parameters", async function () {
      const psm = await ethers.getContractAt("IPSM", ADDRESSES.PSM);

      // Read fees
      const tin = await psm.tin();
      const tout = await psm.tout();

      console.log(`PSM tin (sell fee): ${tin} (${Number(tin) / 1e16}%)`);
      console.log(`PSM tout (buy fee): ${tout} (${Number(tout) / 1e16}%)`);

      // Fees should be reasonable (0-5%)
      expect(tin).to.be.lte(WAD / 20n);
      expect(tout).to.be.lte(WAD / 20n);

      // Read gemJoin address
      const gemJoin = await psm.gemJoin();
      console.log(`PSM gemJoin: ${gemJoin}`);
      expect(gemJoin).to.not.equal(ethers.ZeroAddress);

      // Note: psm.dai() may not exist on all PSM implementations
      // The key verification is that swaps work (tested in SwapHelper tests)
    });
  });

  describe("Morpho Interface", function () {
    it("should read market parameters", async function () {
      const morpho = await ethers.getContractAt("contracts/interfaces/IMorpho.sol:IMorpho", ADDRESSES.MORPHO);

      // Get market params from ID
      const marketParams = await morpho.idToMarketParams(MARKET_ID);

      console.log("Market Params:");
      console.log(`  Loan Token: ${marketParams.loanToken}`);
      console.log(`  Collateral Token: ${marketParams.collateralToken}`);
      console.log(`  Oracle: ${marketParams.oracle}`);
      console.log(`  IRM: ${marketParams.irm}`);
      console.log(`  LLTV: ${marketParams.lltv} (${Number(marketParams.lltv) / 1e16}%)`);

      // Verify market params
      expect(marketParams.loanToken.toLowerCase()).to.equal(ADDRESSES.USDT.toLowerCase());
      expect(marketParams.collateralToken.toLowerCase()).to.equal(ADDRESSES.SUSDD.toLowerCase());
      expect(marketParams.lltv).to.be.gt(0);
    });

    it("should read market state", async function () {
      const morpho = await ethers.getContractAt("contracts/interfaces/IMorpho.sol:IMorpho", ADDRESSES.MORPHO);

      const market = await morpho.market(MARKET_ID);

      console.log("Market State:");
      console.log(`  Total Supply Assets: ${ethers.formatUnits(market.totalSupplyAssets, 6)} USDT`);
      console.log(`  Total Borrow Assets: ${ethers.formatUnits(market.totalBorrowAssets, 6)} USDT`);
      console.log(`  Last Update: ${market.lastUpdate}`);

      // Market should have some activity (unless brand new)
      // Just verify it doesn't revert
      expect(market.totalSupplyAssets).to.be.gte(0);
    });
  });

  describe("sUSDD Interface", function () {
    it("should read sUSDD rate", async function () {
      const susdd = await ethers.getContractAt("ISUSDD", ADDRESSES.SUSDD);

      // Get the exchange rate (assets per share)
      const oneShare = ethers.parseUnits("1", 18);
      const assetsPerShare = await susdd.convertToAssets(oneShare);

      console.log(`sUSDD rate: 1 sUSDD = ${ethers.formatUnits(assetsPerShare, 18)} USDD`);

      // Rate should be >= 1 (sUSDD accrues value)
      expect(assetsPerShare).to.be.gte(oneShare);

      // Check total assets
      const totalAssets = await susdd.totalAssets();
      console.log(`sUSDD total assets: ${ethers.formatUnits(totalAssets, 18)} USDD`);
    });

    it("should read sUSDD token info", async function () {
      const susdd = await ethers.getContractAt("ISUSDD", ADDRESSES.SUSDD);

      const name = await susdd.name();
      const symbol = await susdd.symbol();
      const decimals = await susdd.decimals();
      const asset = await susdd.asset();

      console.log(`sUSDD name: ${name}`);
      console.log(`sUSDD symbol: ${symbol}`);
      console.log(`sUSDD decimals: ${decimals}`);
      console.log(`sUSDD underlying asset: ${asset}`);

      expect(decimals).to.equal(18);
      expect(asset.toLowerCase()).to.equal(ADDRESSES.USDD.toLowerCase());
    });
  });
});
