# ADR-007: Emergency Procedures

## Question
How do we handle emergencies?

## Decision
**Simple approach**: rebalance(0) then pause. No separate emergency function.

## Emergency Flow

```
1. Keeper calls rebalance(0)   → converts position to idle USDT
2. Admin calls pause()         → blocks new deposits and rebalance
3. Users call redeem()         → withdraw their USDT
```

> **Important:** `rebalance()` has `whenNotPaused` modifier, so delever MUST happen BEFORE pause.

## Why No Separate emergencyWithdraw()?

Removed for simplicity. The same result is achieved with:
- `pause()` — blocks deposits, allows withdrawals
- `rebalance(0)` — full delever to idle USDT

A dedicated function added ~30 lines of code with no additional safety benefit.

## Pause States

| State | Deposits | Redeems | Rebalance | HarvestFees |
|-------|----------|---------|-----------|-------------|
| Normal | ✅ | ✅ | ✅ | ✅ |
| Paused | ❌ | ✅ | ❌ | ✅ |
| Paused + Deleveraged | ❌ | ✅ (idle USDT) | ❌ | ✅ |
| Underwater (NAV=0) | ❌ | ❌ (ZeroNAV) | ❌ (no-op) | ✅ |

> **Note:** `harvestFees()` is intentionally allowed when paused. This lets the manager collect accrued fees during emergencies without affecting user withdrawals.

## Limitations

### Underwater Position (NAV = 0)

If collateral value ≤ debt (NAV = 0):
- `rebalance(0)` exits early without action
- `deposit()` reverts with `ZeroNAV`
- `redeem()` reverts with `ZeroNAV`

**Why redeem reverts:** Proportional withdrawal would give 0 USDT. Burning shares for nothing is confusing — explicit revert is clearer.

**Resolution options:**
1. Wait for Morpho liquidation (clears bad debt)
2. Inject capital externally, then delever
3. Accept the loss

### Paused State Blocks Rebalance

`rebalance()` has `whenNotPaused` modifier. If vault is already paused, delever will fail.

**Solution:** Always delever FIRST, then pause:
```
rebalance(0)  // works
pause()       // now blocked
```

If already paused by mistake:
```
unpause()     // re-enable
rebalance(0)  // delever
pause()       // block again
```

## Rationale

1. **Simplicity** — fewer functions, less attack surface
2. **Composability** — pause and rebalance are independent, can be combined as needed
3. **No loss of safety** — same protection, simpler code
