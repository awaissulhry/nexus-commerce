/**
 * BUD.1 — the typed seam between this page and the six sections that follow it.
 *
 * BUD.1 builds the page; BUD.2–BUD.7 fill it. Each later section is meant to be **one new file and
 * one import line**, never a restructuring of `BudgetClient`. That only holds if the props they
 * render against are declared now, before anyone needs them — a contract written after the fact is
 * just a description of whatever the first section happened to do, and by then the second section
 * has to match it.
 *
 * The build order (the brief's §3.8):
 *
 *   BUD.2  guardrails & the baseline      → a panel under the grid + a column inside it
 *   BUD.3  the rule record & restore      → the `?rule=` / `?open=` drawer
 *   BUD.4  the rules made honest          → replaces the provisional list; the rules view
 *   BUD.5  proposals & the staged diff    → a docked tray
 *   BUD.6  reallocation                   → grid selection + a transfer dialog
 *   BUD.7  notifications                  → a panel under the grid
 *
 * ── Two rules every section inherits ────────────────────────────────────────────────────────────
 *
 * **1 · Hidden, not disabled.** A section with nothing to show renders nothing. It does not render
 * a greyed-out control, an empty card or a "coming soon". A disabled control is a promise the page
 * cannot keep and an operator has to learn to ignore; absence is honest and costs no attention.
 *
 * **2 · Every money field states its unit at the TYPE level.** On this page that is not pedantry.
 * `AdvertisingActionLog.payloadBefore/payloadAfter` hold the daily budget in **euros**
 * (`{"dailyBudget": 4.42}`) while `monthlyBudgetCents`, `costMicros`, `sales7dCents` and
 * `targetDailyCents` on adjacent models are all minor units — 41% of the audit chain is already
 * broken and a unit error here reads as a plausible finding rather than as a bug. Every field
 * crossing this seam is `…Cents` and an integer; the conversion happens once, on the server.
 *
 * 🔴 **BUD.1 is read-only and so is this contract.** `NO_WRITE_ACTIONS` exists so the grid's
 * write-capable props are passed **explicitly as absent** rather than omitted. The difference
 * between "this page has not got round to writes" and "this page does not write" is the whole of
 * BUD.1's safety story, and an omitted prop cannot say the second thing. The ratchet is live and
 * un-authorised: BUD.1 shows it, BUD.2 stops it.
 */

import type {
  BudCampaignRow, BudCursor, BudGridPayload, BudRuleRow, BudState, BudView,
} from './types'

export type { BudCampaignRow, BudCursor, BudGridPayload, BudRuleRow, BudState, BudView }

/** The four grains the page binds. Market is here as a value but `AdsPageHeader` owns its control. */
export interface BudScope {
  market: string
  /** FB.2 — `line`, the name the other ten pages use. Was `product`, and the SERVER field still is. */
  line: string
  portfolio: string
  campaign: string
  /** present on the shared `ScopeValue`; this page has no ad-group grain */
  adGroup?: string
}

/**
 * What every section receives — identical for all six, so a section cannot quietly widen what it
 * takes. Additive only: a section needing something new adds a field here and `BudgetClient` fills
 * it, rather than reaching into the client's internals.
 */
export interface BudSlotProps {
  scope: BudScope
  view: BudView
  data: BudGridPayload | null
  campaigns: BudCampaignRow[]
  rules: BudRuleRow[]
  loading: boolean
  /** write a patch into the URL; '' or a default value deletes the param */
  push: (patch: Record<string, string>) => void
  /** force a refetch — the staged tray (BUD.5) and the transfer dialog (BUD.6) will need it */
  reload: () => void
  /** reserved params, parsed by nobody in BUD.1 and declared from day one so a link survives */
  reserved: {
    /** BUD.3 — opens the rule record for one AutomationRule */
    rule: string | null
    /** BUD.3 — `campaign:<id>` | `rule:<id>`; the drawer target */
    open: string | null
    /** BUD.1 parses this one and filters the grid with it; declared here so sections can read it */
    state: BudState | null
  }
  /** the poll cursor and whether the server has moved since this payload was read */
  refresh: { stale: boolean; lastCheckedAt: string | null; cursor: BudCursor | null }
}

/**
 * The grid's write-capable props, explicitly absent.
 *
 * BUD.2 REPLACED `NO_WRITE_ACTIONS` with this object on 2026-08-15 — the read-only era was stated,
 * and its end is stated too. The page writes now: the guardrail editor and the baseline capture
 * live in `BudGuardrails` (its own panel, its own endpoints), which is why `onGuardrailChange`
 * here says where the write went rather than staying null. The GRID-level hooks stay null until
 * the section that owns each arrives: BUD.5's approve, BUD.6's transfer.
 */
export const WRITE_ACTIONS = {
  selectionActions: null,
  onRowAction: null,
  editMode: null,
  /** BUD.2 — writes via BudGuardrails' own panel (PATCH guardrails + POST budget-baselines/capture). */
  onGuardrailChange: 'bud2-panel',
  onApproveProposal: null,
  onTransfer: null,
} as const
