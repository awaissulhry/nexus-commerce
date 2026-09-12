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
import { getBackendUrl } from '@/lib/backend-url'

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
 * Liveness is therefore "the channel has an id for it", and it is an ALIAS-level fact.
 */
const liveAliasKeys = (aliases: AliasGroup[]) =>
  new Set(aliases.filter((a) => !!a.externalListingId).map((a) => aliasKeyOf(a.id)))

const externalIdFor = (aliases: AliasGroup[], r: ChannelSheetRow) =>
  aliases.find((a) => aliasKeyOf(a.id) === aliasKeyOf(r.aliasId))?.externalListingId ?? null

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Offer pause / activate (#112, D3)
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ONE offer verb whose label follows state (#327·17), replacing the Pause/Activate pair.
 *
 * Both used to be listed together on every row — correct registry behaviour (one enabled, one
 * disabled with "Already active on …", which is #114's rule that a disabled verb teaches), and
 * still two entries for one decision. Collapsing keeps the teaching where it actually matters: a
 * MIXED selection now says how it is mixed, which the pair could never express — each half simply
 * went available because "not all rows agree" fell through to enabled.
 */
function offerVerb(deps: ChannelActionDeps): GridAction<ChannelSheetRow> {
  /**
   * What this verb would DO to a given set of rows — the one place that decision is made, so the
   * label, the availability and the run cannot disagree about it.
   *
   * Paused → Activate; active or unknown → Pause. It names the ACTION, never the state, so the
   * label can never be misread as a status badge.
   */
  const plan = (rows: readonly ChannelSheetRow[]) => {
    const known = variantsOf([...rows]).filter((r) => r.listing)
    const on = known.filter((r) => r.listing!.offerActive).length
    const off = known.length - on
    /**
     * 🔴 The verb is the one that CHANGES MORE ROWS, not "activate only if all are paused".
     *
     * With 2 paused and 1 active, the first draft chose Pause and read "Pause 1 of 3" — true (the
     * two already-paused rows are no-ops) and almost certainly not what was wanted. Neither reading
     * is wrong in isolation, so the tie-break is which one does more work; and it is the same rule
     * that makes the even-split refusal coherent, because an even split is exactly where "changes
     * more rows" has no answer.
     */
    return { known: known.length, on, off, activate: off > on }
  }
  return {
    id: 'offer-toggle',
    /**
     * 🔴 Wording follows the SELECTION now (#363/#371), not the sheet.
     *
     * It used to read `deps.offerState` — the scope's overall state — because `GridAction.label`
     * was a fixed string, so a verb could not word itself from the rows an operator had ticked. I
     * filed that as a substrate limit; PES.2 lifted it, and this is the call site that asked for it.
     *
     * The mixed case is why it matters and why the resolver takes ROWS rather than a count: with 2
     * of 3 paused, "Activate 3 offers" would be a lie about one of them, so the honest wording is
     * **"Activate 2 of 3 offers"** — a sentence no count-based signature could produce.
     */
    label: (rows) => {
      const { known, on, off, activate } = plan(rows)
      const word = activate ? 'Activate' : 'Pause'
      if (known === 0) return `${word} offer on ${deps.scopeLabel}`
      const n = activate ? off : on
      const offers = n === 1 ? 'offer' : 'offers'
      return n === known
        ? `${word} ${n} ${offers} on ${deps.scopeLabel}`
        : `${word} ${n} of ${known} ${offers} on ${deps.scopeLabel}`
    },
    scope: ROW,
    available: (rows) => {
      const refusal = permissionRefusal(deps.permission)
      if (refusal) return disabled(refusal)
      const vs = variantsOf(rows)
      if (vs.length === 0) return disabled('Select a listing row — the alias band is not an offer')
      /**
       * `offerActive` IS on the wire now (#112 landed), so the verb can read current state instead
       * of guessing. A row with NO listing is left offered: the endpoint creates one, and refusing
       * would hide a legitimate action behind an absence.
       */
      const { known: knownCount, on, off } = plan(rows)
      const known = vs.filter((r) => r.listing)
      // 🔴 No listing = no offer. Pausing something that does not exist is not an action, and the
      // §14 upsert would create a DRAFT row purely as a side effect of asking to pause it.
      if (knownCount === 0) {
        return disabled(`No listing on ${deps.scopeLabel} yet — there is no offer to pause or activate`)
      }
      // 🔴 A mixed selection is now NAMED by the label ("Activate 2 of 3 offers") rather than
      // refused — the wording says exactly what will happen to which rows, which is what the refusal
      // was standing in for while the label could not move. It stays refused only when the two
      // halves are equal, where no verb is more useful than the other.
      if (on > 0 && off > 0 && on === off) {
        return disabled(`${on} active and ${off} paused — an even split, so pause or activate them separately`)
      }
      const activate = plan(rows).activate
      if (known.every((r) => r.listing!.offerActive === activate)) {
        return disabled(`Already ${activate ? 'active' : 'paused'} on ${deps.scopeLabel}`)
      }
      return AVAILABLE
    },
    preflight: async (rows): Promise<ActionImpact> => {
      const vs = variantsOf(rows)
      const liveKeys = liveAliasKeys(deps.aliases)
      const live = vs.filter((r) => liveKeys.has(aliasKeyOf(r.aliasId)))
      // Same `plan` the label and the availability used — the confirmation cannot describe a
      // different action from the one the operator read on the menu item.
      const { activate } = plan(rows)
      const word = activate ? 'Activate' : 'Pause'
      return {
        level: 'confirm',
        title: `${word} the offer for ${vs.length} ${vs.length === 1 ? 'SKU' : 'SKUs'} on ${deps.scopeLabel}?`,
        consequences: [
          activate
            ? 'The offer becomes buyable again on this channel and market.'
            : 'Buyers stop seeing this offer on this channel and market. The listing itself is not ended and its reviews and identifiers are untouched.',
          'Other markets are unaffected — this is per channel × marketplace.',
        ],
        // The endpoint auto-creates a ChannelListing row when none exists. Naming it because the
        // verb's name does not, and an operator who paused something can be surprised to find a
        // row now exists where there was none.
        sideEffects: live.length
          ? [`${live.length} of these are LIVE listings with a channel id — the change is visible to buyers.`]
          : ['No live channel id on these rows — the change stays local until they are published.'],
        findings: vs.map((r) => {
          const ext = externalIdFor(deps.aliases, r)
          return {
            rowId: r.rowId,
            label: `${r.sku}${ext ? ` · ${ext}` : ' · not on the channel yet'}`,
            severity: ext ? ('warn' as const) : ('info' as const),
          }
        }),
        // 🔴 Wave-1: the outward-facing half does not ship. Stated in the impact so the operator
        // learns it BEFORE confirming, not from a failure afterwards.
        unavailable: live.length
          ? `Refused for now: ${live.length} of these are live listings, and wave-1 verbs do not send to a channel. Preview only.`
          : undefined,
      }
    },
    run: async (rows): Promise<ActionResult> => {
      const vs = variantsOf(rows)
      // One plan, resolved from the same rows the label and the confirmation described.
      const { activate } = plan(rows)
      const liveKeys = liveAliasKeys(deps.aliases)
      if (vs.some((r) => liveKeys.has(aliasKeyOf(r.aliasId)))) {
        return { ok: false, message: 'Refused: this would change a live listing, and wave-1 channel verbs are preview-only.' }
      }
      try {
        const results = await Promise.all(
          vs.map((r) =>
            fetch(`${getBackendUrl()}/api/products/${r.id}/offer-availability`, {
              method: 'PATCH',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                markets: [{ channel: deps.channel, marketplace: deps.marketplace, offerActive: activate }],
              }),
            }),
          ),
        )
        const bad = results.find((r) => !r.ok)
        if (bad) {
          const body = await bad.json().catch(() => null)
          return { ok: false, message: body?.error ?? `Refused (HTTP ${bad.status})` }
        }
        // This lane has no per-row refetch, and says so rather than claiming one (#114).
        return { ok: true, invalidates: { kind: 'page' } }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}

export const offerToggle = (deps: ChannelActionDeps) => offerVerb(deps)

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
        level: 'type-to-confirm',
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
        confirmPhrase: deps.channel,
        unavailable: vs.some((r) => liveAliasKeys(deps.aliases).has(aliasKeyOf(r.aliasId)))
          ? 'Refused for now: broadcasting would write to live listings, and wave-1 channel verbs are preview-only.'
          : undefined,
      }
    },
    run: async (rows): Promise<ActionResult> => {
      const vs = variantsOf(rows)
      if (vs.some((r) => liveAliasKeys(deps.aliases).has(aliasKeyOf(r.aliasId)))) {
        return { ok: false, message: 'Refused: this would write to live listings, and wave-1 channel verbs are preview-only.' }
      }
      if (chosen.length === 0) return { ok: false, message: 'No target markets were chosen.' }
      return {
        ok: false,
        message: `Not sent. ${vs.length} rows would have gone to ${chosen.join(', ')} via the marketplaceContexts fan-out.`,
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

export function channelActions(deps: ChannelActionDeps): GridAction<ChannelSheetRow>[] {
  const actions = [openRecordAction(deps), offerToggle(deps), broadcastToListings(deps)]
  return deps.accountSpecific ? actions.map(action => action.id === 'open-record' ? action : { ...action, available: () => disabled('This bulk action currently uses the primary account. Edit this account’s cells or use explicit account destinations in Catalog import.') }) : actions
}
