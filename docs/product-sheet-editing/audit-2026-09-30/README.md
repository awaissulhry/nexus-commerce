# Product sheet audit — 2026-09-30

Scope: the open product-sheet stack (#186 P0 → #193 P1 → #194 P2 → #220 sweep) merged with `main`, on branch
`claude/ultra-code-subagents-product-sheet-neormx`. Nine independent reviewers, one lens each (editors, save pipeline,
API write path, channel truth, wire/prefetch, speed, UX, tests, integration). Every finding is reproduced with a
failing test before it is fixed.

- `findings.json` — the findings from the first six lenses (ids A01–A32, B01–B35): file:line, failure scenario,
  evidence and suggested fix. A finding is a claim until its fix commit names the test that reproduced it.
- The outcome of each finding (fixed / not reproduced / intended) is recorded in this folder once the work packages land.
