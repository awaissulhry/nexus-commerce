/**
 * NEG.1 — the seam.
 *
 * Seven sections follow this one. Each gets a slot in `NegativeTargetingClient`, in order, each
 * importing from its own file and rendering null until its session lands. This file is the typed
 * contract between them, and it exists so that **a later session adds one file and one import line
 * and nobody restructures the client.**
 *
 * Two rules the sections inherit:
 *
 *   1. **Hidden, not disabled.** A section whose data does not exist yet renders nothing. A
 *      disabled button that will never enable is the same lie as a Remove button that mutates
 *      `useState`.
 *   2. **A term row carries no write action, ever.** A term is a Nexus-side grouping over
 *      negations, not an Amazon object: Amazon has no account-level negative list. Every bulk
 *      action is N real writes reporting N outcomes.
 */

import type { ReactNode } from 'react'

export type NegView = 'negations' | 'terms'
export type NegMatchType = 'EXACT' | 'PHRASE' | 'ASIN' | 'OTHER'
export type NegAttribution = 'user' | 'engine' | 'unattributed' | 'actor-not-recorded'
export type NegGrain = 'market' | 'line' | 'portfolio' | 'campaign' | 'adGroup'

export interface NegationRow {
  id: string
  term: string
  termKey: string
  match: NegMatchType
  /** the raw stored spelling. Carried because the column is rewritten by an ingest — see the
   *  service header. A section that filters on it rather than on `match` will be wrong by
   *  hundreds of rows within the hour. */
  matchRaw: string
  level: 'AD_GROUP' | 'CAMPAIGN'
  campaignId: string
  campaignName: string
  campaignStatus: string
  adGroupId: string
  adGroupName: string
  market: string
  status: string
  atAmazon: boolean
  blockingNow: boolean
  addedAt: string
  attribution: NegAttribution
  attributionLabel: string
  spread: { rows: number; adGroups: number; campaigns: number }
}

export interface TermRow {
  termKey: string
  term: string
  rows: number
  adGroups: number
  campaigns: number
  markets: string[]
  matches: NegMatchType[]
  blockingNow: number
  notAtAmazon: number
  campaignLevel: number
  firstAddedAt: string
  lastAddedAt: string
  attributions: NegAttribution[]
}

export interface NegCensus {
  negations: number
  terms: number
  blockingNow: number
  notAtAmazon: number
  inInertCampaign: number
  archived: number
  campaignLevel: number
  addedInWindow: number
}

export interface NegScopeState {
  market: string
  line: string
  portfolio: string
  campaign: string
  adGroup: string
  boundBy: NegGrain | null
}

/**
 * What every slot receives. Identical for all seven, so a section cannot quietly widen what it
 * takes and make the client its dependency.
 */
export interface NegSlotProps {
  scope: NegScopeState
  census: NegCensus | null
  rows: NegationRow[]
  terms: TermRow[]
  view: NegView
  loading: boolean
  /** patch the URL — the single writer of page state, so every view stays linkable */
  push: (patch: Record<string, string>) => void
  /** the term the URL is focused on (`?focus=`), or null. NEG.2 opens its drawer from this. */
  focus: string | null
  /** the alert class the URL selected (`?alert=`), or null. NEG.4 filters from this. */
  alert: string | null
  /** re-run the page's read after a write lands. NEG.3 onward call it; NEG.1 never does. */
  reload: () => void
}

/**
 * Write actions the inventory grid will accept, declared on day one and supplied by nobody yet.
 *
 * NEG.3 (removal) and NEG.4 (conflicts) inject these; NEG.1 passes `null` for both and the grid
 * renders no selection bar and no row menu. That is the seam that lets those sections ship without
 * opening this client.
 *
 * `selectionActions` is handed the selected NEGATION ids only. There is deliberately no term-row
 * equivalent: see rule 2 in this file's header.
 */
export interface NegWriteActions {
  selectionActions: ((ids: string[], clear: () => void) => ReactNode) | null
  onRowAction: ((row: NegationRow) => void) | null
}

export const NO_WRITE_ACTIONS: NegWriteActions = { selectionActions: null, onRowAction: null }
