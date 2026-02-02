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
            + (sUSDD collateral * sUSDD rate)  // via convertToAssets()
            - USDT debt
```

All values in USDT terms. The sUSDD rate comes from the sUSDD ERC4626 contract (see ADR-002).
