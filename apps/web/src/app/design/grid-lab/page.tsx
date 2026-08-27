/**
 * AG.2 — /design/grid-lab. The migration's parity harness.
 *
 * A tab under the existing /design living style guide rather than a new top-level route: the
 * style guide is already where this codebase judges a rendering decision, and a grid engine
 * swap is exactly that kind of decision.
 *
 * Needs no API. The ads console cannot be verified locally — its data regions 401 with no CORS —
 * so the lab runs off a frozen fixture and works in local dev, on Vercel, and on prod alike.
 */
import { GridLabClient } from './GridLabClient'

export const metadata = { title: 'Grid parity lab' }

export default function GridLabPage() {
  return <GridLabClient />
}
