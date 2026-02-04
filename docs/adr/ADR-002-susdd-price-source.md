# ADR-002: sUSDD Price Source

## Question
Where do we get the sUSDD price for NAV calculation?

## Decision
**Use sUSDD ERC4626 rate** via `convertToAssets()`, assuming PSM tin/tout = 0.

## Swap Path

USDT ↔ sUSDD requires two steps:

```
USDT ↔ USDD ↔ sUSDD
     PSM    ERC4626
```

### Step 1: PSM (USDT ↔ USDD)

Contract: `0xcE355440c00014A229bbEc030A2B8f8EB45a2897`
USDD Token: `0x4f8e5de400de08b164e7421b3ee387f461becd1a`

| Direction | Function | Fee |
|-----------|----------|-----|
| USDT → USDD | `sellGem(address usr, uint256 gemAmt)` | tin |
| USDD → USDT | `buyGem(address usr, uint256 gemAmt)` | tout |

**Fee Mechanics:**
- `tin` - fee for selling gems (USDT → USDD): `usddOut = gemAmt - (gemAmt * tin / WAD)`
- `tout` - fee for buying gems (USDD → USDT): `usddRequired = gemAmt + (gemAmt * tout / WAD)`

**Current State:** `tin = 0` and `tout = 0` (1:1 swap).

> **Assumption:** The implementation assumes tin/tout remain 0. If PSM governance enables fees, withdraw/delever operations will revert (fail-safe). See requirements.md "PSM Fee Assumption" for rationale.

### Step 2: sUSDD (USDD ↔ sUSDD)

Contract: `0xc5d6a7b61d18afa11435a889557b068bb9f29930` (ERC4626)

| Direction | Function |
|-----------|----------|
| USDD → sUSDD | `deposit(uint256 assets, address receiver)` |
| sUSDD → USDD | `redeem(uint256 shares, address receiver, address owner)` |
| Rate query | `convertToAssets(uint256 shares)` |

## NAV Price Calculation

```
sUSDD_value_in_USDT = sUSDD_amount
                    * sUSDD.convertToAssets(1e18) / 1e18  // sUSDD → USDD
                    / 1e12                                 // USDD (18 dec) → USDT (6 dec)
```

Note: No PSM fee adjustment since we assume tin/tout = 0.

## Rationale

1. **Authoritative source** - sUSDD contract defines the actual conversion rate.

2. **No oracle risk** - No external oracle dependency.

3. **Simplicity** - Assumes 1:1 PSM, reducing code complexity.

## Implementation

`SwapHelper` library encapsulates all swap logic:
- `swapUSDTtoSUSDD(uint256 usdtAmount)` - full path swap
- `swapSUSDDtoUSDT(uint256 susddAmount)` - full path swap
- `getSUSDDRate()` - returns USDD per 1 sUSDD
- `getUSDTValue(uint256 susddAmount)` - for NAV calculation (assumes 1:1 PSM)
- `previewSwapUSDTtoSUSDD(uint256 usdtAmount)` - preview swap result
- `previewSwapSUSDDtoUSDT(uint256 susddAmount)` - preview swap result
- `previewSUSDDNeededForUSDT(uint256 usdtAmount)` - inverse calculation for delever

All functions assume PSM tin/tout = 0. If fees are enabled, swap functions will revert due to balance mismatches.
