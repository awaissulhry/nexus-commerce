/**
 * /design/grid-lab — the grid engine's lab: GDS scenarios, enterprise features, the master sheet, Matrix cells, the
 * Publish review and the module catalogue, each a tab (`?tab=`).
 *
 * A tab under the existing /design living style guide rather than a new top-level route: the style guide is already
 * where this codebase judges a rendering decision. Needs no API except `?tab=sheet` (live data): the other tabs run off
 * frozen fixtures and work in local dev and on prod alike.
 */
import { GridLabClient } from './GridLabClient'

export const metadata = { title: 'Grid lab' }

export default async function GridLabPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams
  return <GridLabClient initialTab={tab} />
}
