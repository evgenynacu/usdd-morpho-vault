# ADR-007: Emergency Procedures

## Question
How do we handle emergencies?

## Decision
**Simple approach**: rebalance(IDLE_MODE) then pause. No separate emergency function.

## Emergency Flow

```
1. Keeper calls rebalance(IDLE_MODE)   → converts position to idle USDT
2. Admin calls pause()                  → blocks new deposits and rebalance
3. Users call redeem()                  → withdraw their USDT
```

> **Important:** `rebalance()` has `whenNotPaused` modifier, so delever MUST happen BEFORE pause.

## Rebalance Modes for Emergencies

| Mode | Command | Result | Use Case |
|------|---------|--------|----------|
| **Full exit** | `rebalance(IDLE_MODE)` | All assets as idle USDT | Emergency, full risk-off |
| **Yield-only** | `rebalance(0)` | sUSDD collateral, no debt | Carry trade unprofitable |

## Why No Separate emergencyWithdraw()?

Removed for simplicity. The same result is achieved with:
- `pause()` — blocks deposits, allows withdrawals
- `rebalance(IDLE_MODE)` — full delever to idle USDT

A dedicated function added ~30 lines of code with no additional safety benefit.

## Pause States

| State | Deposits | Redeems | Rebalance | HarvestFees |
|-------|----------|---------|-----------|-------------|
| Normal | ✅ | ✅ | ✅ | ✅ |
| Paused | ❌ | ✅ | ❌ | ✅ |
| Paused + IDLE_MODE | ❌ | ✅ (idle USDT) | ❌ | ✅ |
| ZeroNAV (NAV=0, shares>0) | ❌ | ❌* | ❌* | ✅ |

> \* If underwater (debt > collateral): `redeem()` reverts during flash loan, `rebalance()` is no-op. If ZeroNAV without debt (sUSDD depeg): `redeem()` may succeed, `rebalance()` proceeds.

> **Note:** `harvestFees()` is intentionally allowed when paused. This lets the manager collect accrued fees during emergencies without affecting user withdrawals.

## Limitations

### ZeroNAV vs Underwater

The vault distinguishes two related conditions:

| Condition | Check | Affected Operations |
|-----------|-------|---------------------|
| **ZeroNAV** | `totalSupply() > 0 && NAV == 0` | `deposit()` reverts |
| **Underwater** | `currentDebt > 0 && NAV == 0` | `rebalance()` no-op, `redeem()` fails |

**ZeroNAV** blocks deposits to prevent division by zero when calculating shares.

**Underwater** blocks rebalance because delevering is impossible (debt > collateral value).

### Underwater Position (NAV = 0, Debt > 0)

If `currentDebt > 0` AND `idle + collateral value ≤ debt` (NAV = 0):
- `rebalance(*)` is a true no-op (no state change, no events)
- `deposit()` reverts with `ZeroNAV`
- `redeem()` reverts during flash loan repayment (insufficient USDT)

**Note:** An empty vault (no position, no shares) can still update `targetLTV`.

**Why redeem reverts during flash loan:** The proportional withdrawal attempts to repay debt via flash loan. Since collateral value < debt, swapping collateral yields less USDT than needed to repay the flash loan.

**Resolution options:**
1. Wait for Morpho liquidation (clears bad debt)
2. Inject capital externally, then delever
3. Accept the loss

### Paused State Blocks Rebalance

`rebalance()` has `whenNotPaused` modifier. If vault is already paused, delever will fail.

**Solution:** Always delever FIRST, then pause:
```
rebalance(IDLE_MODE)  // exit to idle USDT
pause()               // now safe
```

If already paused by mistake:
```
unpause()             // re-enable
rebalance(IDLE_MODE)  // delever
pause()               // block again
```

## Rationale

1. **Simplicity** — fewer functions, less attack surface
2. **Composability** — pause and rebalance are independent, can be combined as needed
3. **No loss of safety** — same protection, simpler code
