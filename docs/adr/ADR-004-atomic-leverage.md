# ADR-004: Atomic Leverage

## Question
How do we achieve leverage atomically in a single transaction?

## Decision
**Flash loan from Morpho Blue** (0% fee) to build/unwind leverage in one transaction.

## Flow: Deposit (Build Leverage)

1. Receive user USDT deposit
2. Take flash loan (USDT) from Morpho
3. Swap all USDT to sUSDD (via swap contract)
4. Supply sUSDD as collateral to Morpho
5. Borrow USDT against collateral
6. Repay flash loan with borrowed USDT

Result: Leveraged sUSDD position built atomically.

## Flow: Withdraw (Unwind Leverage)

1. Take flash loan (USDT) from Morpho
2. Repay portion of USDT debt
3. Withdraw proportional sUSDD collateral
4. Swap sUSDD to USDT
5. Repay flash loan
6. Return remaining USDT to user

Result: Position reduced, user receives USDT.

## Rationale

1. **No intermediate state** - Position never exists in partial/risky state.

2. **Gas efficient** - Single transaction vs multiple.

3. **Zero flash loan fee** - Morpho Blue provides free flash loans.

4. **Standard pattern** - Flash loans for atomic leverage is a well-established DeFi pattern.

## Key Insight

The flash loan amount depends on target leverage. For 4x leverage:
- 1000 USDT deposit needs ~3000 USDT flash loan
- Total 4000 USDT converts to sUSDD collateral
- Borrow 3000 USDT to repay flash loan
