# ADR-003: Share Calculation

## Question
How do we calculate shares on deposit/withdraw?

## Decision
**Delta NAV approach** for deposits — shares based on actual value added, not deposited amount.
Standard ERC4626 for withdrawals with rounding in favor of the vault.

## Why Delta NAV for Deposits?

Standard ERC4626 formula `shares = assets * totalSupply / totalAssets` doesn't account for conversion costs (PSM fees). This causes **dilution** of existing holders:

```
Example with 1% PSM fee:
├── Vault: 1000 shares, NAV = 1000 USDT
├── Alice holds 100 shares (10%)
│
├── Bob deposits 100 USDT
├── Standard ERC4626: Bob gets 100 shares
├── After PSM fee: Bob actually added 99 USDT value
│
├── Result: Alice's 100 shares now worth 99.5 USDT
└── Alice lost 0.5 USDT due to Bob's deposit! ❌
```

With Delta NAV:
```
├── Bob deposits 100 USDT
├── Position built, NAV increases by 99 USDT (after fees)
├── Delta NAV: Bob gets 99 shares
│
├── Result: Alice's 100 shares still worth 100 USDT
└── No dilution! ✅
```

## Formulas

**Deposit (Delta NAV):**
```
navBefore = totalAssets()
// ... build position ...
navAfter = totalAssets()
valueAdded = navAfter - navBefore
shares = valueAdded * totalSupply / navBefore
```

**Redeem (Standard):**
```
assets = shares * totalAssets / totalSupply
```

## Rounding Rules

Always round against the user initiating the action (in favor of vault):

| Operation | User specifies | User receives | Rounding |
|-----------|----------------|---------------|----------|
| `deposit` | assets (USDT) | shares | DOWN (fewer shares) |
| `redeem` | shares | assets (USDT) | DOWN (fewer assets) |

> **Note:** `mint()` and `withdraw()` are not supported. See ADR-005 for rationale.

## Rationale

1. **Prevents rounding exploits** - Without correct rounding, attackers could extract dust amounts over many transactions.

2. **Protects existing shareholders** - Rounding errors don't dilute existing holders.

3. **Standard practice** - All secure ERC4626 implementations follow this pattern.

## NAV Calculation (totalAssets)

```
totalAssets = idle USDT
            + (sUSDD collateral * sUSDD rate)
            - USDT debt
```

All values in USDT terms. NAV assumes 1:1 USDD:USDT peg (tout is a swap fee, not included in NAV valuation).

### Component Breakdown

**1. Idle USDT:**
```solidity
idleUsdt = IERC20(USDT).balanceOf(address(this))
```

**2. Collateral Value:**
```solidity
// sUSDD → USDD via ERC4626 rate
usddValue = sUSDD.convertToAssets(collateral)

// USDD → USDT (1:1 when PSM fees = 0)
usdtValue = usddValue / 1e12
```

**3. Debt (from Morpho borrowShares):**

Morpho uses share-based accounting for borrows. We use `MorphoBalancesLib.expectedBorrowAssets()` which:
1. Reads current market state
2. Accrues interest to current timestamp
3. Converts shares to assets

```solidity
// We use the library function (includes interest accrual)
debt = morpho.expectedBorrowAssets(marketParams, address(this));
```

This conversion is necessary because:
- Borrow shares represent proportional claim on debt
- Total borrow assets grow over time with interest
- Our debt = our proportion × total debt

### Debt Rounding Behavior

**Important:** `expectedBorrowAssets()` rounds **UP** (conservative for protocol).

From MorphoBalancesLib:
```solidity
return borrowShares.toAssetsUp(totalBorrowAssets, totalBorrowShares);
```

**Edge case:** If `collateral + idle` is very close to `debt`, rounding up can cause:
- Calculated debt slightly exceeds actual collateral value
- `totalAssets()` returns 0 even though real NAV is slightly positive

**Impact:** Minimal (< 1 wei per share conversion). Positions near zero NAV report 0 rather than a tiny positive value. This is conservative and prevents issues with division by near-zero NAV.

### Final NAV

```solidity
if (collateralUsdt + idleUsdt > debtUsdt) {
    return idleUsdt + collateralUsdt - debtUsdt;
}
return 0; // Underwater protection
```

## previewDeposit Implementation

Since Delta NAV requires building the position to know exact shares, `previewDeposit` estimates the expected value:

```solidity
function _estimateDepositValue(uint256 assets) internal view returns (uint256) {
    // IDLE_MODE: USDT stays idle
    if (targetLTV == IDLE_MODE) {
        return assets;
    }

    // Unleveraged mode: convert to sUSDD, no borrowing
    if (targetLTV == 0) {
        uint256 susdd = previewSwapUSDTtoSUSDD(assets);
        return getUSDTValue(susdd);
    }

    // Leveraged mode:
    uint256 borrowAmount = assets * targetLTV / (WAD - targetLTV);
    uint256 totalUsdt = assets + borrowAmount;

    uint256 susdd = previewSwapUSDTtoSUSDD(totalUsdt);
    uint256 susddValue = getUSDTValue(susdd);

    // NAV increase = collateral value - debt
    return susddValue - borrowAmount;
}
```

**Why this works:** When PSM fees are 0, preview matches actual execution exactly. If tout > 0, preview is slightly optimistic but deposits still work (Delta NAV uses actual post-swap values).

### Preview Limitations

`previewDeposit()` and `convertToShares()` are **estimates only**. They do NOT check:
- Paused state → use `maxDeposit() == 0` to detect
- `maxTotalAssets` limit → use `maxDeposit()` to get available capacity
- `DepositTooSmall` → preview may return small non-zero value, but deposit reverts if shares round to 0

Additionally, if sUSDD rate changes between preview and deposit, actual shares may differ slightly.

## Edge Cases

> Operating modes (IDLE_MODE, unleveraged, leveraged) are defined in [requirements.md](../requirements.md#411-operating-modes).

| Case | Handling |
|------|----------|
| First deposit (totalSupply = 0) | shares = navAfter (actual NAV of built position) |
| ZeroNAV (NAV = 0, supply > 0) | `previewDeposit` returns 0, `deposit` reverts with `ZeroNAV` |
| Dust deposit (shares round to 0) | Reverts with `DepositTooSmall` (protects existing holders) |

### ZeroNAV and Underwater

See [requirements.md](../requirements.md#zeronav-vs-underwater) for full ZeroNAV/Underwater behavior.

**Relevance to share calculation:** Deposits check `totalSupply() > 0 && NAV == 0` because `shares = value * supply / NAV` would divide by zero.
