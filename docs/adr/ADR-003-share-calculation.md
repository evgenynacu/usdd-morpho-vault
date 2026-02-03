# ADR-003: Share Calculation

## Question
How do we calculate shares on deposit/withdraw?

## Decision
**Standard ERC4626 share calculation** with rounding in favor of the vault.

## Formulas

```
shares = assets * totalSupply / totalAssets
assets = shares * totalAssets / totalSupply
```

## Rounding Rules

Always round against the user initiating the action (in favor of vault):

| Operation | User receives | Rounding | Effect |
|-----------|---------------|----------|--------|
| `deposit` | shares | DOWN | user gets fewer shares |
| `mint` | (pays assets) | UP | user pays more assets |
| `withdraw` | (pays shares) | UP | user pays more shares |
| `redeem` | assets | DOWN | user gets fewer assets |

OpenZeppelin ERC4626 handles this via `Math.Rounding.Floor` / `Math.Rounding.Ceil`.

## Rationale

1. **Prevents rounding exploits** - Without correct rounding, attackers could extract dust amounts over many transactions.

2. **Protects existing shareholders** - Rounding errors don't dilute existing holders.

3. **Standard practice** - All secure ERC4626 implementations follow this pattern.

## NAV Calculation (totalAssets)

```
totalAssets = idle USDT
            + (sUSDD collateral * sUSDD rate * PSM adjustment)
            - USDT debt
```

All values in USDT terms.

### Component Breakdown

**1. Idle USDT:**
```solidity
idleUsdt = IERC20(USDT).balanceOf(address(this))
```

**2. Collateral Value:**
```solidity
// sUSDD → USDD via ERC4626 rate
usddValue = sUSDD.convertToAssets(collateral)

// USDD → USDT accounting for PSM tout fee
usdtValue = usddValue * WAD / (WAD + tout)
```

**3. Debt (from Morpho borrowShares):**

Morpho uses share-based accounting for borrows. Converting shares to assets:

```solidity
// Get position
Position memory pos = morpho.position(marketId, address(this))
// pos.borrowShares = our share of total borrow

// Get market state
Market memory mkt = morpho.market(marketId)
// mkt.totalBorrowAssets = total USDT borrowed in market
// mkt.totalBorrowShares = total shares for all borrowers

// Convert our shares to assets
debt = pos.borrowShares * mkt.totalBorrowAssets / mkt.totalBorrowShares
```

This conversion is necessary because:
- Borrow shares represent proportional claim on debt
- Total borrow assets grow over time with interest
- Our debt = our proportion × total debt

### Final NAV

```solidity
if (collateralUsdt + idleUsdt > debtUsdt) {
    return idleUsdt + collateralUsdt - debtUsdt;
}
return 0; // Underwater protection
```

## Edge Cases

| Case | Handling |
|------|----------|
| First deposit (totalSupply = 0) | OpenZeppelin uses 1:1 ratio |
| Zero NAV | Returns 0, withdrawal reverts with `ZeroNAV` |
| Underwater position | totalAssets returns 0, protects against negative values |
