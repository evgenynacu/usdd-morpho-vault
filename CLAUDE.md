# Project Guidelines

## Architecture Decision Records (docs/adr/)

ADRs document architectural decisions with rationale.

### ADR Rules:

1. **One question per ADR** - each ADR answers exactly one architectural question
2. **Concise** - brief decision + rationale, no lengthy explanations
3. **No implementation code** - describe approach, not specific code

### ADR Format:
- Title + Question
- Decision (brief answer)
- Rationale (why this approach)
- References (if applicable)

---

## Requirements Documents (docs/requirements.md)

Requirements should describe **WHAT** needs to be done, not **HOW** to implement it.

### Rules for requirements:

1. **No duplication** - each concept is described in one place only
2. **No implementation details** - no code, no specific implementation steps, no function/contract names
3. **No contradictions** - information in different sections must not contradict each other
4. **No obvious things** - don't repeat the same thing in different words

### What should NOT be in requirements:
- Solidity code
- Function signatures
- Contract inheritance
- Step-by-step algorithms (a, b, c, d, e...)
- Implementation details (which libraries to use, how to call functions)

### What SHOULD be in requirements:
- Purpose and goals of the system
- External dependencies
- Roles and their capabilities
- Business logic and rules
- Configuration parameters
- Risks
- Open questions

---

## Bug Fix Process

When a bug is discovered, follow this process:

### 1. Write a Failing Test First

Before fixing the bug, write a test that:
- Reproduces the bug scenario
- Contains assertions that will **fail** with the current (buggy) code
- Clearly documents what the expected behavior should be

### 2. Verify the Test Fails

Run the test to confirm it fails. This proves the bug is real and reproducible.

### 3. Fix the Bug

Implement the fix in the code.

### 4. Verify the Test Passes

Run the test again to confirm the fix works and no regressions occurred.

### 5. Update Documentation

If the bug revealed a gap in documentation, update relevant ADRs or requirements.

---

## Testing Strategy

### Principle: Unit Tests First, Fork Tests for Integration

**80% unit tests (mocks) / 20% fork tests**

### Unit Tests (with mocks)

Fast, stable, run always. Cover:
- Access control (roles, permissions)
- Pausable behavior
- Parameter validation (LTV limits, fee limits)
- NAV calculation logic
- Fee calculation
- Flash loan callback flow
- Error conditions and reverts

Mocks needed:
- `MockMorpho` - stateful, tracks positions, executes flash loan callbacks
- `MockPSM` - simulates sellGem/buyGem with configurable tin/tout
- `MockSUSDD` - ERC4626 mock with configurable exchange rate
- `MockERC20` - for USDT/USDD tokens

### Fork Tests (mainnet fork)

Slower, require RPC, can be flaky. Use for:
- PSM swap math verification (real tin/tout, decimals)
- Interest accrual (MorphoBalancesLib)
- E2E scenarios (full deposit → rebalance → withdraw)
- Interface compatibility with mainnet contracts
- Gas estimation

**Always use fixed `blockNumber`** for stability.

### Why This Split?

Fork test problems for this project:
1. **Flakiness** - sUSDD rate, Morpho state, PSM fees change constantly
2. **Infrastructure dependency** - RPC can be rate-limited or unavailable
3. **Speed** - RPC latency adds up
4. **Debugging difficulty** - hard to tell if failure is bug or mainnet state change

### Test File Structure

```
test/
├── unit/
│   ├── SUSDDVault.unit.test.ts
│   └── mocks/
│       ├── MockMorpho.sol
│       ├── MockPSM.sol
│       └── MockSUSDD.sol
└── fork/
    ├── SUSDDVault.fork.test.ts
    └── SwapHelper.fork.test.ts
```
