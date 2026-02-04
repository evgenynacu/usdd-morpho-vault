// Mainnet addresses
export const ADDRESSES = {
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  USDD: "0x4f8e5DE400DE08B164E7421B3EE387f461beCD1A",
  SUSDD: "0xC5d6A7B61d18AfA11435a889557b068BB9f29930",
  PSM: "0xcE355440c00014A229bbEc030A2B8f8EB45a2897",
  MORPHO: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
} as const;

export const MARKET_ID = "0x29ae8cad946d861464d5e829877245a863a18157c0cde2c3524434dafa34e476";

// Token holders for impersonation in fork tests
export const WHALES = {
  USDT: "0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503", // Binance 8
  USDD: "0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852", // Uniswap V2 pair
} as const;

// Decimals
export const DECIMALS = {
  USDT: 6,
  USDD: 18,
  SUSDD: 18,
} as const;

// WAD for fixed-point math
export const WAD = 10n ** 18n;
