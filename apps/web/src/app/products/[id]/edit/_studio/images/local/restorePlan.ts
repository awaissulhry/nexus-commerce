/**
 * PES.7 — turning a restore point back into a write. Pure, tested.
 *
 * 🔴 The trap this exists to avoid is the one `edits.ts` documents: **an upsert without `id`
 * creates.** The route reconciles by id, never by coordinate, so restoring a snapshot by simply
 * upserting its rows would leave a SECOND row at every coordinate that already has one — and the
 * cascade then picks between them arbitrarily. A "rollback" that doubles every row is worse than no
 * rollback at all, because it looks like it worked.
 *
 * So the plan is built by matching the snapshot against what is on the channel *now*, coordinate by
 * coordinate, and carrying the existing row's id wherever there is one.
 *
 * 🔴 A restore is scoped to exactly the rows at the snapshot's own coordinates. Rows in other
 * markets, other slots or other buckets are left alone — a restore of the IT matrix must not touch
 * DE, and a snapshot that predates a slot must not delete pictures placed in it since.
 */
import { isPublished } from '../types'
import type { ListingUpsert } from '../channel/amazon/edits'
import type { SnapshotRow } from './publishPrefs'

/**
 * Exactly the fields the plan reads. Declared structurally rather than importing a row type, so
 * both the cascade's view of a row and the raw wire asset satisfy it without a cast — a cast here
 * would be hiding the fact that the two shapes disagree about `scope`.
 */
export interface RestoreCurrentRow {
  id: string
  marketplace: string | null
  amazonSlot: string | null
  variantGroupValue: string | null
  url: string
  publishStatus?: string
}

export interface RestorePlan {
  upserts: ListingUpsert[]
  /** Ids of rows that exist now and were not in the snapshot. */
  deletes: string[]
  /** Rows the snapshot names that have no row today — they will be created. */
  creates: number
  /**
   * 🔴 Rows currently marked PUBLISHED that this restore would touch.
   *
   * `bulk-save` resets `publishStatus` to DRAFT on every upsert (see `edits.ts`), and a snapshot
   * does not carry publish state — so a restore silently demotes live rows and there is no way to
   * put that back except by publishing again. It is the correct behaviour (the channel no longer
   * has these pictures), but it is a consequence the operator cannot see coming, so it is counted
   * here and stated before they press the button.
   */
  unpublishes: number
}

const key = (groupValue: string | null, slot: string) => `${groupValue ?? '*'}|${slot}`

/**
 * @param market the market being restored; `null` restores the all-markets (PLATFORM) layer.
 */
export function restorePlan(args: {
  snapshot: readonly SnapshotRow[]
  current: readonly RestoreCurrentRow[]
  market: string | null
  groupKey: string | null
}): RestorePlan {
  const { snapshot, current, market, groupKey } = args

  // Only rows at the layer being restored are in scope. A MARKETPLACE restore must not pick up the
  // PLATFORM row it inherits from, or it would rewrite every market at once.
  const inScope = current.filter((r) => (r.marketplace ?? null) === market && r.amazonSlot)
  const byCoord = new Map<string, RestoreCurrentRow>()
  for (const r of inScope) byCoord.set(key(r.variantGroupValue, r.amazonSlot as string), r)

  const upserts: ListingUpsert[] = []
  const wanted = new Set<string>()
  let creates = 0
  let unpublishes = 0

  for (const row of snapshot) {
    const k = key(row.groupValue, row.slot)
    wanted.add(k)
    const existing = byCoord.get(k)
    if (existing) {
      /*
       * 🔴 A row that already matches is NOT rewritten.
       *
       * Every upsert resets `publishStatus` to DRAFT, so blindly re-writing the whole snapshot
       * would demote live rows that did not need touching at all — a "restore" that unpublishes
       * pictures it did not change. Measured on GALE-JACKET: restoring an unchanged AMAZON·IT
       * layer would have rewritten both of its PUBLISHED rows for no reason.
       */
      if (existing.url === row.url) continue
      // Only a row that is live today, and whose picture genuinely changes, can be demoted.
      if (isPublished(existing.publishStatus)) unpublishes++
    } else {
      creates++
    }
    upserts.push({
      // The whole point: update in place where a row already exists.
      ...(existing ? { id: existing.id } : {}),
      scope: market ? 'MARKETPLACE' : 'PLATFORM',
      platform: 'AMAZON',
      marketplace: market,
      amazonSlot: row.slot,
      variantGroupKey: row.groupValue === null ? null : groupKey,
      variantGroupValue: row.groupValue,
      url: row.url,
      position: row.position,
    })
  }

  const deletes = inScope
    .filter((r) => !wanted.has(key(r.variantGroupValue, r.amazonSlot as string)))
    .map((r) => r.id)

  return { upserts, deletes, creates, unpublishes }
}

/** A one-line description of what a restore would do, for the confirm step. */
export function describePlan(plan: RestorePlan): string {
  const parts: string[] = []
  const updates = plan.upserts.length - plan.creates
  if (updates > 0) parts.push(`${updates} picture${updates === 1 ? '' : 's'} put back`)
  if (plan.creates > 0) parts.push(`${plan.creates} restored to a slot that is empty now`)
  if (plan.deletes.length > 0) {
    parts.push(`${plan.deletes.length} added since removed`)
  }
  if (parts.length === 0) return 'Nothing to change — the channel already matches this restore point.'
  const sentence = `${parts.join(', ')}.`
  return plan.unpublishes > 0
    ? `${sentence} ${plan.unpublishes} live row${plan.unpublishes === 1 ? '' : 's'} will go back to `
      + 'unpublished — the channel keeps the newer picture until you publish again.'
    : sentence
}
