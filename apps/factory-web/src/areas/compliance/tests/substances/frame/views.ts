import type { ReactNode } from 'react'
import type { Metric, MenuItemDef } from '@nexus/ui/components'
import type { ListKey } from '../../../../../list-frame/model'

/**
 * The views of Compliance › Tests & substances (design compliance.tests sec:ts-views: "Lot tests (W1) · Supplier declarations
 * (W2b) · Material profiles (W2b) · Substance list (W2b)", `?view=` in the address; keys 1–4) and the W2b tiles of
 * sec:ts-metrics (saved filters: a tile is a chip on its view). The Lot tests view keeps W1's own `?view=` saved filters
 * (onHold, waiting, …): a W2b view's name is none of them. Pure.
 */

export const DEPTH_VIEWS = ['declarations', 'profiles', 'substances'] as const
export type DepthView = (typeof DEPTH_VIEWS)[number]
export const TEST_VIEWS = ['lots', ...DEPTH_VIEWS] as const
export type TestsView = (typeof TEST_VIEWS)[number]

/** The W2b view the address names, or null (the Lot tests view, with W1's own saved filter if any). */
export function depthViewOf(params: { get(name: string): string | null } | null | undefined): DepthView | null {
  const view = params?.get('view') ?? ''
  return (DEPTH_VIEWS as readonly string[]).includes(view) ? (view as DepthView) : null
}

/** A view's address (the Lot tests view is the page itself). */
export const viewHref = (prefix: string, view: TestsView): string => `${prefix}/compliance/tests${view === 'lots' ? '' : `?view=${view}`}`

/** The view a key 1–4 opens. */
export const viewOfKey = (key: string): TestsView | null => (/^[1-4]$/.test(key) ? TEST_VIEWS[Number(key) - 1]! : null)

// ---- the W2b tiles ----------------------------------------------------------------------------------------------------

export const DEPTH_TILES = ['declarationsOverdue', 'profilesIncomplete', 'rerequest'] as const
export type DepthTile = (typeof DEPTH_TILES)[number]

/** Each tile's view and filter (pressing it again clears the filter, the view stays). */
export const DEPTH_TILE_FILTER: Readonly<Record<DepthTile, { view: DepthView; term: string; value: string }>> = {
  declarationsOverdue: { view: 'declarations', term: 'shown', value: 'OVERDUE' },
  profilesIncomplete: { view: 'profiles', term: 'state', value: 'INCOMPLETE' },
  rerequest: { view: 'declarations', term: 'shown', value: 'REREQUEST_NEEDED' },
}

export const tileHref = (prefix: string, tile: DepthTile): string => {
  const filter = DEPTH_TILE_FILTER[tile]
  return `${prefix}/compliance/tests?view=${filter.view}&${filter.term}=${filter.value}`
}

/** The tile the address shows pressed (its view and filter), or null. */
export function activeDepthTile(params: { get(name: string): string | null } | null | undefined): DepthTile | null {
  const view = params?.get('view') ?? ''
  for (const tile of DEPTH_TILES) {
    const filter = DEPTH_TILE_FILTER[tile]
    if (filter.view === view && params?.get(filter.term) === filter.value) return tile
  }
  return null
}

/** One tile's count: not read yet (undefined), unknown (null: the read failed or the person may not read it), a number. */
export type DepthCounts = Readonly<Record<DepthTile, number | null | undefined>>
export const DEPTH_COUNTS_UNREAD: DepthCounts = { declarationsOverdue: undefined, profilesIncomplete: undefined, rerequest: undefined }
export const DEPTH_COUNTS_UNKNOWN: DepthCounts = { declarationsOverdue: null, profilesIncomplete: null, rerequest: null }

/** The page's frame every W2b view draws above its content: the tiles and the view switch. */
export interface PageFrame {
  readonly tiles: readonly Metric[]
  readonly switcher: ReactNode
}

export interface LotsDepth {
  /** The view switch, drawn under the tiles. */
  readonly switcher: ReactNode
  /** The three W2b tiles after W1's four (none without compliance.certificates.view). */
  readonly tiles: readonly Metric[]
  /** The ⋯ items: Restricted substance list, Test plan rules. */
  readonly more: readonly MenuItemDef[]
  /** The keys it adds to the list's own: 1–4 switch the view. */
  readonly keys: readonly ListKey[]
}
