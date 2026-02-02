# ADR-006: Rebalance Interface

## Question
How does the keeper interact with the vault for rebalancing?

## Decision
**Simple lever/delever functions** with target LTV parameter.

## Interface

```
rebalance(uint256 targetLTV)
```

- `targetLTV > currentLTV` -> Lever up (borrow more, buy more sUSDD)
- `targetLTV < currentLTV` -> Delever (sell sUSDD, repay debt)
- `targetLTV == currentLTV` -> No-op

## Rationale

1. **Single parameter** - Keeper specifies desired end state, vault figures out the steps.

2. **Atomic execution** - Uses same flash loan pattern as deposits/withdrawals.

3. **Guardrails** - Vault enforces min/max LTV bounds regardless of keeper input.

4. **Simplicity** - No complex command arrays or multi-step orchestration needed for single-strategy vault.

## Keeper Responsibilities

1. Monitor sUSDD yield vs borrow rate
2. Monitor current LTV vs target range
3. Call `rebalance()` when adjustment needed
4. Delever if strategy becomes unprofitable
