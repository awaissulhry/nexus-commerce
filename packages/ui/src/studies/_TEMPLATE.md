# Study NN — <Feature / Surface>

**Route(s):** `/...`
**Owner:** <name>  ·  **Date:** YYYY-MM-DD  ·  **Status:** draft | in-review | final

## 1. What it does
One paragraph: the job this surface does for the operator, and the primary user
flows.

## 2. Data flow
- **Reads:** endpoints / hooks / SSE channels and what they return.
- **Writes:** mutations, their payload shapes, optimistic vs server-confirmed.
- **State:** local vs lifted vs URL-driven; caching; real-time/refresh behavior.

## 3. Components used
Map this surface to the design system. Which DS primitives/components/patterns it
consumes; anything still bespoke (a migration target); any one-offs that should
be promoted into the DS.

| Element | DS home | Status |
|---|---|---|
| | | reuse / migrate / promote |

## 4. Cross-platform parity (Amazon · eBay · Shopify)
How the capability differs per channel; where Nexus's data model aligns or
diverges; channel-specific constraints.

## 5. Gaps & risks
Correctness, accessibility, performance, i18n, and UX gaps observed.

## 6. Upgrade / automation roadmap
Concrete, prioritized improvements — including what can be **automated** (rules,
AI assist, background jobs) and what should become a reusable DS pattern.

## 7. Open questions
Things to confirm with the user / further research.
