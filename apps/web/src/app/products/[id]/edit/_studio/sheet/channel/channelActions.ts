/**
 * PES.3 — the channel scope's VERBS, defined once (ruling #110's action registry).
 *
 * The registry TYPE and every adapter that renders these — row context menu, `⋯` column, selection
 * bar, later the drawer and a palette — belong to `design-system/grid` (PES.2). What lives here is
 * only what a channel operation MEANS, which is this lane's and nobody else's. One definition, so a
 * verb offered in two places cannot drift into two behaviours.
 *
 * ── The order every verb follows (ruling #118) ──────────────────────────────────────────────────
 *   COLLECT → PREFLIGHT → CONFIRM → RUN
 * The lane owns its picker and runs it FIRST, then folds the choice into the impact — so the
 * confirmation describes the ACTUAL parameterised operation rather than the verb in the abstract.
 * One honest flow, not two dialogs.
 *
 * ── Why nothing here sends to a channel ─────────────────────────────────────────────────────────
 * Wave-1 constraint: a verb that would touch a LIVE listing ships preview-first, exactly as publish
 * does. Every eBay·IT listing in the XAVIA fixture family is ACTIVE with a real ItemID (measured:
 * 40 of 40), so "test it on a fixture" is not available here — a pause on GALE is a pause on a real
 * eBay offer. So these verbs PREFLIGHT truthfully and refuse the outward-facing half, and say which
 * half they refused. A verb that quietly did it anyway would be the same dishonesty as a green
 * dry-run read as a live publish.
 */

// Imported from the registry's own module, NOT the `@/design-system/grid` barrel: the barrel pulls
// in `NexusGrid.tsx`, which a node-environment vitest file cannot transform. This module is pure so
// its verbs can be tested, and that only holds if its imports stay pure too
// (reference_test_scoping_and_hidden_assertions — the barrel trap, hit twice now).
import {
  AVAILABLE,
  HIDDEN,
  ROW,
  SELECTION,
  disabled,
  type ActionImpact,
  type ActionResult,
  type GridAction,
} from '@/design-system/grid/actions/registry'
import { isAsinPending } from '@nexus/shared/listing-risk'
import { AMAZON_NO_END, ETSY_NO_END, STATUS_TARGET_LABEL, type StatusTarget } from '@nexus/shared/listing-actions'
import { SEND_MODE_LABEL, type PublishActionCell, type PublishActionChange, type SendMode } from '@nexus/shared/publish-actions'

import { aliasKeyOf, type AliasGroup, type ChannelScopeChannel, type ChannelSheetRow } from './types'

/**
 * 🔴 The permission a channel verb needs is NOT a channel permission (ruling #123).
 *
 * Measured against the manifest rather than inferred: `PATCH /api/products/:id/offer-availability`
 * and `PATCH /api/products/bulk` are both caught by the ordered prefix rule
 * `RW(productsView, productsEdit, pfx('/api/products'))` at permissions-manifest.ts:412 — so a
 * channel operation requires **`products.edit`**, while `/api/marketplaces` requires
 * `channels.sync`. Namespaces follow the ROUTE, not the subject matter, and guessing "it is a
 * channel verb so it needs a channel permission" would have named the wrong one in every refusal.
 */
export const CHANNEL_VERB_PERMISSION = 'products.edit'

/**
 * What the browser knows about the operator's permissions — THREE states, not two (ruling #123).
 *
 * `unknown` is the one that matters: under local dev the browser holds no session for the API's
 * origin, so every gated control looks denied. A surface that renders that as "you lack permission"
 * teaches an operator something false about their own account, and teaches a developer that they
 * have found a permission defect when they have found a missing cookie.
 */
export type PermissionState = 'checking' | 'no-session' | 'granted' | 'denied'

export function permissionRefusal(state: PermissionState): string | null {
  switch (state) {
    case 'granted': return null
    case 'checking': return 'Checking your permissions…'
    case 'no-session': return `Not signed in to the API — this needs ${CHANNEL_VERB_PERMISSION}. Local dev holds no session for the API origin, so this is not a permission problem.`
    case 'denied': return `Your account lacks ${CHANNEL_VERB_PERMISSION}, which this channel operation requires.`
  }
}

export interface ChannelActionDeps {
  accountSpecific?: boolean
  /** Explicit account reported by the sheet; null is a named legacy account, never an omitted level. */
  channelConnectionId: string | null
  /** The operator's permission state for `products.edit`. Never assume `granted`. */
  permission: PermissionState
  channel: ChannelScopeChannel
  marketplace: string
  scopeLabel: string
  /**
   * The scope's alias groups. Liveness is an ALIAS fact, not a row fact: PES.5 §3.2 puts
   * `externalListingId` / `listingStatus` on `AliasGroup`, and `StudioRow` carries no listing at
   * all. Writing `row.listing` compiled in my head and not in the file — the contract was right.
   */
  aliases: AliasGroup[]
  /** Coordinates this product could broadcast to, from the frame's own options. */
  siblingMarkets: Array<{ code: string; label: string }>
  /**
   * The lane's picker, run BEFORE preflight (#118). Returns the chosen coordinates, or null if the
   * operator backed out — in which case the verb never reaches a confirmation.
   */
  pickMarkets: (offered: Array<{ code: string; label: string }>) => Promise<string[] | null>
  /**
   * Open PES.4's record drawer on a row — the frame's URL-backed record state, exactly as the
   * master sheet reaches it (`useStudioRecord().open`). Declared as a dep rather than called
   * directly so this file stays React-free and testable.
   */
  openRecord: (rowId: string) => void
  /**
   * The row the drawer is CURRENTLY open on, or null.
   *
   * Needed because today the registry has exactly one adapter — `RecordActions`, inside the drawer
   * — so an "Open record" verb would render in the one place where it does nothing. It hides itself
   * there and appears the moment a row-menu or ⋯ adapter exists, which is the point of declaring a
   * verb once instead of wiring a button.
   */
  openRecordId: string | null
}

/** A row is a real listing line, not the alias band. */
const variantsOf = (rows: ChannelSheetRow[]) => rows.filter((r) => r.rowKind === 'variant')

/**
 * Is this row's listing live on the channel?
 *
 * `listingStatus` alone is NOT the answer: a DRAFT row still carries a real ItemID, so eBay knows
 * about it — measured across 20 non-ACTIVE rows tonight, every one had an `externalListingId`.
 * Liveness is therefore "the channel has an id for it", and it is an ALIAS-level fact. One addition,
 * Amazon only: a listing Publish promoted is live before its ASIN is read back (`isAsinPending`).
 */
const liveAliasKeys = (aliases: AliasGroup[], channel: string) =>
  new Set(aliases.filter((a) => !!a.externalListingId || isAsinPending({ ...a, channel })).map((a) => aliasKeyOf(a.id)))

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Broadcast to listings (3.13n)
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Push the selected rows' values for THIS coordinate out to sibling markets.
 *
 * The write endpoint has supported this since R.1 — `PATCH /api/products/bulk` fans out over
 * `marketplaceContexts` — and no surface has ever reached it. That is why this was the cheapest of
 * the 22: the mechanism exists, only the verb was missing.
 *
 * COLLECT first (#118): the operator picks the target markets, and only then does the preflight
 * describe what those particular markets will receive.
 */
export function broadcastToListings(deps: ChannelActionDeps): GridAction<ChannelSheetRow> {
  let chosen: string[] = []

  return {
    id: 'broadcast-to-listings',
    label: 'Broadcast to other markets…',
    scope: SELECTION,
    available: (rows) => {
      const refusal = permissionRefusal(deps.permission)
      if (refusal) return disabled(refusal)
      if (variantsOf(rows).length === 0) return disabled('Select one or more listing rows')
      if (deps.siblingMarkets.length === 0) {
        return disabled(`${deps.channel} has no other market connected to broadcast to`)
      }
      return AVAILABLE
    },
    preflight: async (rows): Promise<ActionImpact> => {
      const vs = variantsOf(rows)
      const picked = await deps.pickMarkets(deps.siblingMarkets)
      if (picked === null || picked.length === 0) {
        return { level: 'none', title: 'No markets chosen', unavailable: 'Nothing was selected to broadcast to.' }
      }
      chosen = picked
      const labels = deps.siblingMarkets.filter((m) => picked.includes(m.code)).map((m) => m.label)
      return {
        level: 'none',
        title: `Broadcast ${vs.length} ${vs.length === 1 ? 'SKU' : 'SKUs'} from ${deps.scopeLabel} to ${labels.length} other ${labels.length === 1 ? 'market' : 'markets'}?`,
        consequences: [
          `Receiving markets: ${labels.join(', ')}.`,
          'Each receiving market is overwritten for the fields this scope carries — their own values for those fields are replaced, not merged.',
        ],
        sideEffects: [
          'A market that has no listing row for this product yet will have one created by the write.',
        ],
        findings: vs.map((r) => ({ rowId: r.rowId, label: r.sku, severity: 'info' as const })),
        // The phrase is the CHANNEL, not "CONFIRM": typing the thing you are about to change is
        // what makes a typed confirm more than a slower click.
        unavailable: 'Broadcast is not built. Nothing is sent on any row, live or not.',
      }
    },
    run: async (rows): Promise<ActionResult> => {
      const vs = variantsOf(rows)
      if (vs.some((r) => liveAliasKeys(deps.aliases, deps.channel).has(aliasKeyOf(r.aliasId)))) {
        return { ok: false, message: 'Broadcast is not built. Nothing is sent on any row, live or not.' }
      }
      if (chosen.length === 0) return { ok: false, message: 'No target markets were chosen.' }
      return {
        ok: false,
        message: 'Broadcast is not built. Nothing is sent on any row, live or not.',
      }
    },
  }
}

/** Every channel verb this lane defines, in the order a menu should offer them. */
// ────────────────────────────────────────────────────────────────────────────────────────────────
// Open record (#135)
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Open the record drawer on this row.
 *
 * The drawer was mounted, wired and resolvable on the channel scope — and unreachable: nothing here
 * offered to open it, so from an operator's side it did not exist (hub #135). Double-click is the
 * master sheet's precedent and is mirrored on the grid; this verb is the DISCOVERABLE half, because
 * a gesture nothing names is a feature only the person who built it can find.
 *
 * No permission gate: reading a record is not `products.edit`. Hidden on a band row — an alias band
 * is a group header, not a record, and offering to open one would promise a drawer that has nothing
 * to show.
 */
export function openRecordAction(deps: ChannelActionDeps): GridAction<ChannelSheetRow> {
  return {
    id: 'open-record',
    label: 'Open record',
    scope: ROW,
    available: (rows) => {
      const row = rows[0]
      if (!row) return HIDDEN
      // Not disabled — HIDDEN. A verb offered on the record it would open is not "unavailable", it
      // is meaningless, and a greyed-out control with no explanation is the trap #114 names.
      if (row.rowId === deps.openRecordId) return HIDDEN
      return row.rowKind === 'variant' ? AVAILABLE : HIDDEN
    },
    // No preflight: nothing is written, nothing is fetched, and a confirmation for "look at this"
    // would be noise. The registry treats an absent preflight as "run straight away".
    run: async (rows): Promise<ActionResult> => {
      const row = rows[0]
      if (!row) return { ok: false, message: 'No row to open.' }
      deps.openRecord(row.rowId)
      return { ok: true }
    },
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The listing band's verbs (aliases, Owner 2026-10-05)
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the band's ⋯ needs to show one listing alone or publish it. The band is a listing (the main listing, or an alias),
 * not a record, so these verbs are the band's own: they are offered on band rows and nowhere else.
 */
export interface ListingBandDeps {
  /** How many listings this account and market hold (the unfiltered read): one listing needs no band verbs. */
  listingCount: number
  /** The listing the studio shows alone (`''` = the main listing), or null when it shows every listing. */
  shownAliasKey: string | null
  /** The `listing=` value that shows this band's listing alone on this page (`pageListingSelection`: the alias id, or the
   *  page product's own main record), or undefined when none is known. */
  selectionOf: (aliasId: string | null) => string | undefined
  /** Write the studio's listing choice (`useStudioScope().setListing`); undefined = every listing. */
  setListing: (listing?: string) => void
  /** Open the studio's Publish window with only this listing ticked (an alias by its alias id, the main listing by none). */
  publishListing: (aliasId: string | null) => void
  /** Why the Publish window cannot open here (no account yet, a deleted product), or null. */
  publishRefusal: string | null
}

export const SHOW_ONLY_LISTING = 'Show only this listing'
export const SHOW_ALL_LISTINGS = 'Show all listings'
export const PUBLISH_THIS_LISTING = 'Publish this listing…'
/** The band's listing has no record of this page's product here (on a variation's page, the variation's own record is
 *  what keeps the page on the variation, review 2026-10-05). */
export const LISTING_NOT_RECORDED = 'This product has no record of this listing on this account and market yet, so it cannot be shown alone.'

const isBand = (row: ChannelSheetRow | undefined): row is ChannelSheetRow => row?.rowKind === 'parent'
/** The band verbs appear where a product holds more than one listing here, or one listing is shown alone. */
const bandVerbsApply = (deps: ListingBandDeps) => deps.listingCount > 1 || deps.shownAliasKey !== null

/**
 * "Show only this listing" / "Show all listings" and "Publish this listing…" on a listing band. Showing writes the same
 * `listing=` the studio bar's picker writes; publishing opens the studio's own Publish window on this listing only. Both
 * stay on this page and send nothing (reach `local`): Publish still reviews before anything goes to the channel.
 */
export function listingBandActions(deps: ListingBandDeps): GridAction<ChannelSheetRow>[] {
  return [
    {
      id: 'show-only-listing',
      label: SHOW_ONLY_LISTING,
      scope: ROW,
      reach: 'local',
      available: (rows) => {
        const row = rows[0]
        if (!isBand(row) || !bandVerbsApply(deps) || deps.shownAliasKey !== null) return HIDDEN
        return deps.selectionOf(row.aliasId) ? AVAILABLE : disabled(LISTING_NOT_RECORDED)
      },
      run: async (rows): Promise<ActionResult> => {
        const listing = rows[0] ? deps.selectionOf(rows[0].aliasId) : undefined
        if (!listing) return { ok: false, message: LISTING_NOT_RECORDED }
        deps.setListing(listing)
        return { ok: true }
      },
    },
    {
      id: 'show-all-listings',
      label: SHOW_ALL_LISTINGS,
      scope: ROW,
      reach: 'local',
      available: (rows) => (isBand(rows[0]) && deps.shownAliasKey !== null ? AVAILABLE : HIDDEN),
      run: async (): Promise<ActionResult> => {
        deps.setListing(undefined)
        return { ok: true }
      },
    },
    {
      id: 'publish-listing',
      label: PUBLISH_THIS_LISTING,
      scope: ROW,
      reach: 'local',
      available: (rows) => {
        if (!isBand(rows[0]) || !bandVerbsApply(deps)) return HIDDEN
        return deps.publishRefusal ? disabled(deps.publishRefusal) : AVAILABLE
      },
      run: async (rows): Promise<ActionResult> => {
        const row = rows[0]
        if (!row) return { ok: false, message: 'No listing to publish.' }
        if (deps.publishRefusal) return { ok: false, message: deps.publishRefusal }
        deps.publishListing(row.aliasId ?? null)
        return { ok: true }
      },
    },
  ]
}

export function channelActions(deps: ChannelActionDeps): GridAction<ChannelSheetRow>[] {
  // Build shape v2 (Owner 2026-10-04): "Mark paused / active" is gone — the Status column and the selection bar's
  // Action ▾ (`actionMenuEntries` below) set what Publish sends.
  const actions = [openRecordAction(deps), broadcastToListings(deps)]
  return deps.accountSpecific ? actions.map(action => action.id === 'open-record' ? action : { ...action, available: () => disabled('This bulk action currently uses the primary account. Edit this account’s cells or use explicit account destinations in Catalog import.') }) : actions
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Action ▾ — the selection bar's button (build shape v2, Owner 2026-10-04)
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** A ticked row as Action ▾ reads it: its waiting values and options on this destination, or null (no listing here). */
export interface ActionMenuRow { sku: string; cell: PublishActionCell | null }

export interface ActionMenuEntry {
  id: string
  group: 'Status' | 'Send as'
  change: PublishActionChange
  /** How many of the ticked rows allow it, of how many. */
  allowed: number
  total: number
  /** "Inactive — 18 of 21". */
  label: string
  /** Why the rest cannot take it ("3 not allowed: Amazon has no End…"), or why none can. */
  note: string | null
  disabled: boolean
  /** Ended and Delete: drawn in the danger tone when they can run. */
  danger: boolean
}

export const ACTION_MENU_STATUS: readonly StatusTarget[] = ['active', 'inactive', 'ended']
/** New listings: Not listed is offered when a ticked row is not on the channel yet. */
export const ACTION_MENU_NEW_STATUS: StatusTarget = 'not_listed'
/** A Status a new row cannot take (Ended): it chooses what Publish creates. */
export const ACTION_NEW_ROW_STATUS = 'Not on the channel yet: choose Active, Inactive or Not listed.'
/** Not listed on a listing that is on the channel. */
export const ACTION_NOT_LISTED_ON_CHANNEL = 'On the channel already: Not listed applies only before the first Publish.'
export const ACTION_MENU_SEND: readonly SendMode[] = ['partial', 'full', 'delete']
export const ACTION_NOT_ON_CHANNEL = 'Not on the channel yet. Publish creates it.'
export const ACTION_ROLE_CANNOT_PUBLISH = 'Your role cannot publish listings, so it cannot set what Publish sends.'
export const ACTION_ROLE_CANNOT_DELETE = 'Your role cannot end or delete listings.'

const optionOf = (cell: PublishActionCell, change: PublishActionChange): { offered: boolean; reason: string | null } => {
  if (change.column === 'send') {
    const option = cell.sendOptions.find(o => o.mode === change.mode)
    return { offered: !!option?.offered, reason: option?.reason ?? null }
  }
  const option = cell.statusOptions.find(o => o.target === change.target)
  if (!option) return { offered: false, reason: cell.create ? ACTION_NEW_ROW_STATUS : change.target === 'not_listed' ? ACTION_NOT_LISTED_ON_CHANNEL
    : change.target === 'ended' && cell.channel === 'AMAZON' ? AMAZON_NO_END : change.target === 'ended' && cell.channel === 'ETSY' ? ETSY_NO_END : null }
  return { offered: option.offered, reason: option.reason ?? null }
}

/**
 * The items of Action ▾ for the ticked rows: Status (Active, Inactive — Not listed when a ticked row is not on the
 * channel, Ended only when a ticked row's channel can end: eBay, Shopify) · Send as (Partial update, Full update,
 * Delete). Rows not on the channel take Active / Inactive / Not listed as what Publish does (the note says how many:
 * "Includes 3 new listings.", "2 deleted rows are listed again on the next Publish."); Send as holds their Partial update
 * and Delete with the server's reason, and their Full update changes nothing (they are always sent whole). Each counts
 * the rows whose own options allow it — the same options the cells' editors offer — and names the most common reason
 * for the rest. Ended and Delete need `products.delete`; the rest `products.publish`.
 */
export function actionMenuEntries(rows: readonly ActionMenuRow[], can: { publish: boolean; delete: boolean }): ActionMenuEntry[] {
  const anyNew = rows.some(row => !!row.cell?.create)
  // Ended only where a ticked row's channel ends listings (never Amazon or Etsy).
  const canEnd = rows.some(row => !!row.cell?.statusOptions.some(o => o.target === 'ended'))
  const statuses = [...ACTION_MENU_STATUS.slice(0, 2), ...(anyNew ? [ACTION_MENU_NEW_STATUS] : []), ...(canEnd ? ACTION_MENU_STATUS.slice(2) : [])]
  const changes: Array<{ group: ActionMenuEntry['group']; change: PublishActionChange; word: string; danger: boolean }> = [
    ...statuses.map(target => ({ group: 'Status' as const, change: { column: 'status' as const, target }, word: STATUS_TARGET_LABEL[target], danger: target === 'ended' })),
    ...ACTION_MENU_SEND.map(mode => ({ group: 'Send as' as const, change: { column: 'send' as const, mode }, word: SEND_MODE_LABEL[mode], danger: mode === 'delete' })),
  ]
  const total = rows.length
  return changes.map(({ group, change, word, danger }) => {
    let allowed = 0
    let newAllowed = 0
    let deletedAllowed = 0
    const reasons = new Map<string, number>()
    for (const row of rows) {
      const option = row.cell ? optionOf(row.cell, change) : { offered: false, reason: ACTION_NOT_ON_CHANNEL }
      if (option.offered) { allowed += 1; if (row.cell?.create) { if (row.cell.deleted) deletedAllowed += 1; else newAllowed += 1 } }
      else { const why = option.reason ?? 'Not possible for this listing.'; reasons.set(why, (reasons.get(why) ?? 0) + 1) }
    }
    // Ended and Delete need products.delete.
    const permitted = danger ? can.delete : can.publish
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    const refused = total - allowed
    const n = (count: number) => count.toLocaleString('en')
    const rowsNotOn = newAllowed + deletedAllowed
    // Rows not on the channel: a Status says what Publish does with them — new ones are created (or left out), deleted
    // ones listed again (or kept off). Active on such a row is no resume. Their Full update changes nothing.
    const newNote = !newAllowed || change.column !== 'status' ? null
      : `${newAllowed === allowed ? (newAllowed === 1 ? 'A new listing' : `${n(newAllowed)} new listings`) : `Includes ${newAllowed === 1 ? '1 new listing' : `${n(newAllowed)} new listings`}`}: ${change.target === 'not_listed' ? `Publish leaves ${newAllowed === 1 ? 'it' : 'them'} out.` : `Publish creates ${newAllowed === 1 ? 'it' : 'them'} ${STATUS_TARGET_LABEL[change.target as StatusTarget]}.`}`
    const deletedNote = !deletedAllowed || change.column !== 'status' ? null
      : change.target === 'not_listed' ? `${n(deletedAllowed)} deleted ${deletedAllowed === 1 ? 'row stays' : 'rows stay'} off.`
        : `${n(deletedAllowed)} deleted ${deletedAllowed === 1 ? 'row is' : 'rows are'} listed again on the next Publish.`
    const wholeNote = change.column === 'send' && change.mode === 'full' && rowsNotOn
      ? `${n(rowsNotOn)} not on the channel ${rowsNotOn === 1 ? 'is' : 'are'} always sent whole.` : null
    const note = !permitted ? (danger ? ACTION_ROLE_CANNOT_DELETE : ACTION_ROLE_CANNOT_PUBLISH)
      : [refused > 0 && top ? (allowed === 0 ? top : `${n(refused)} not allowed: ${top}`) : null, newNote, deletedNote, wholeNote].filter(Boolean).join(' ') || null
    return {
      id: `${change.column}:${change.column === 'send' ? change.mode : change.target}`,
      group, change, allowed, total, label: `${word} — ${n(allowed)} of ${n(total)}`,
      note, disabled: !permitted || allowed === 0, danger,
    }
  })
}
