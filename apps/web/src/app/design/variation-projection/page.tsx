/**
 * /design/variation-projection — the Variation projection design (VX), MOCKED.
 *
 * Decides nothing and writes nothing. Every scenario renders from a frozen fixture so the Owner can
 * see each proposed surface at true size, in both themes, on the running dev server — and exercise
 * it: the controls recompute the collision report, the counts and the payload from the fixture.
 * The design and the implementation plan: `docs/2026-09-12-variation-projection-design.md`;
 * the lane prompts: `docs/vx-prompts.md`.
 */
import { VariationProjectionClient } from './VariationProjectionClient'

export const metadata = { title: 'Variation projection · design mock' }

export default function VariationProjectionPage() {
  return <VariationProjectionClient />
}
