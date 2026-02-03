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
