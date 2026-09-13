'use client'

/**
 * VP.4 — §4.4's four sections. One file because they share the draft's shape and nothing else
 * consumes them; splitting four 40-line sections across four modules would buy an import graph.
 */
import { Lock } from 'lucide-react'
import { memo, useState } from 'react'

import { Banner, Field, Modal, SummaryTable, OrderedList } from '@/design-system/components'
import { AxesPanel, axesCellFromProjection, projectionDraftFromAxesCell } from '@/design-system/grid/editors'
import type { VariationThemeCell } from '@/design-system/grid/renderers/variationTheme'
import { Button, Radio, Tag } from '@/design-system/primitives'

import {
  LOCK_TITLE, VALUES_HINT, specificsHint, splitHint, sameAsSharedNote,
  splitPerAxisLabel, splitSingleLabel, usedCount,
} from '../copy'
import type { ProjectionDraft, ProjectionPage } from '../types'

/* ── 1 · Variation specifics ──────────────────────────────────────────────────────────────── */

export interface SpecificsSectionProps {
  page: ProjectionPage
  draft: ProjectionDraft
  onDraft(next: ProjectionDraft): void
}

/**
 * §4.4.1 — grip · axis name (92px) · arrow · `Listbox sm` of the channel's target options ·
 * `+ Add a specific` · `Tag` `<n> of <limit> used`.
 *
 * 🔴 The DRAG ORDER IS THE BUYER-FACING ORDER. That is the §1.4 verdict's fold, and it is measured
 * rather than assumed: `OrderEditor` (the surface this replaces) drags the same sequence under the
 * sentence "Which option buyers choose first", and the server stores it as `_variationAxes` on the
 * listing (`ebay-presentation-order.service.ts:98–126`), capped at 5 by
 * `ebay-cockpit.routes.ts:617` — the same limit `vocabulary.limits.axes` carries here. The full
 * verdict, including which endpoint must own that write, is in `docs/pes-claims.md`.
 *
 * 🔴 It uses the DS `OrderedList`, not a hand-rolled grip: that component already pairs the pointer
 * drag with ↑/↓ buttons and a live region, so the order is reachable without a mouse. A second
 * drag list would be the fork the programme's shared-component rule exists to prevent.
 *
 * A LOCKED axis (§4.4.4) keeps its row and loses its listbox — disabled with the lock's own
 * sentence on it, never removed. Removing it would hide the thing the banner is talking about.
 */
export const SpecificsSection = memo(function SpecificsSection({ page, draft, onDraft }: SpecificsSectionProps) {
  const { vocabulary, limits, coordinate } = page
  const channelLabel = coordinate.channelLabel ?? coordinate.channel
  /* §4.4.1's tag counts MAPPED specifics, not rows — an axis with no target is not "used". */
  const used = draft.mapping.filter(m => m.target !== null).length

  /**
   * The panel reports the whole edited cell; this turns it back into the dock's draft.
   *
   * 🔴 `presentationOrder` is re-applied HERE and not in the adapter, because it is the DOCK's fact:
   * §1.4's verdict is that the drag order IS the buyer-facing order, the server stores it as
   * `_variationAxes` behind its OWN CAS token (`page.order.token`,
   * `ebay-presentation-order.service.ts:98–126`), and `projectionDraftFromAxesCell` deliberately
   * preserves every draft field it does not own rather than guessing at one. Dropping this would
   * have left `Save mapping` sending the OLD axis order for the presentation order after a drag —
   * the exact silent half-write the shared-component swap had to not introduce.
   */
  const onPanel = (next: VariationThemeCell) => {
    const mapped = projectionDraftFromAxesCell(next, draft)
    onDraft(page.order?.token
      ? { ...mapped, presentationOrder: { expectedToken: page.order.token, change: { ...draft.presentationOrder?.change, axes: mapped.mapping.map(m => m.axisKey) } } }
      : mapped)
  }

  return (
    <section className="nds-vp-dock-section" aria-labelledby="vp-dock-specifics">
      <h3 id="vp-dock-specifics" className="nds-vp-dock-title">
        {/* The channel's OWN section title, from the wire: `Variation specifics` on eBay,
            `Variation theme` on Amazon, `Options` on Shopify, `Properties` on Etsy (§9). */}
        {vocabulary.sectionTitle}
        <Tag tone="neutral">{usedCount(used, limits.axes)}</Tag>
      </h3>
      <p className="nds-vp-dock-hint">{specificsHint(channelLabel, vocabulary, limits.axes)}</p>
      {/**
        * 🔴 VT.2c — section 1's rows, its `+ Add a <noun>` and its two lock states are the SHARED
        * `AxesPanel`, the same component the sheet's variation-theme cell opens (design §3.5's last
        * clause, D-VT4; prompt step 4). Two editors for one projection is the fork the programme's
        * shared-component rule exists to prevent, and the two states that kept this section local
        * until now — the per-axis lock and the endpoint's order-writability — are expressed on the
        * panel from the WIRE (`locked.lockedAxisKeys`, `order.writableHere`), not from a flag here.
        *
        * 🔴 `key={page.version}` is the 409 contract. `MappingDock` re-derives its draft when the
        * version moves (a conflict repaint replaces the operator's stale edits with the server's
        * mapping); the panel holds its own draft for the life of its mount, so without this key a
        * repaint would leave the rows showing the edits the server had just refused.
        */}
      <AxesPanel
        key={page.version}
        host="dock"
        cell={axesCellFromProjection(page, draft)}
        onChange={onPanel}
      />
    </section>
  )
})

/* ── 2 · Values ───────────────────────────────────────────────────────────────────────────── */

export interface ValuesSectionProps {
  page: ProjectionPage
  draft: ProjectionDraft
  onDraft(next: ProjectionDraft): void
}

/**
 * §4.4.2 — one mini-table per axis whose values can DIFFER from the shared ones, and a one-line
 * note for each axis that is identical. Counts are INCLUDED variants only, which is §4.4.2's own
 * sentence and the reason the count is computed from `included` rather than from the child list.
 *
 * 🔴 The last line is §1.4's "no capability is dropped silently". The eBay `Variation order` page
 * carries TWO dimensions: the axis order (folded into §4.4.1's drag above) and the per-axis VALUE
 * order, which this spec does not move. So the surface says where that one still lives instead of
 * letting it disappear with the nav item. Measured: `OrderEditor.tsx:113–115` renders one
 * `OrderedList` per axis for exactly that, and it writes `_axisValueOrder`.
 */
export const ValuesSection = memo(function ValuesSection({ page, draft, onDraft }: ValuesSectionProps) {
  const channelLabel = page.coordinate.channelLabel ?? page.coordinate.channel
  const [ordering, setOrdering] = useState(false)
  const [orders, setOrders] = useState<Record<string, string[]>>({})
  const orderAxes = page.order?.resolvedAxes ?? []
  const openOrder = () => {
    setOrders(Object.fromEntries(orderAxes.map(axis => [axis.key, draft.presentationOrder?.change.values?.[axis.key] ?? axis.values])))
    setOrdering(true)
  }
  return <section className="nds-vp-dock-section" aria-labelledby="vp-dock-values">
    <h3 id="vp-dock-values" className="nds-vp-dock-title">Values
      {page.coordinate.channel === 'EBAY' && <Button size="sm" variant="ghost" disabled={!page.order?.writableHere}
        title={page.order?.reason != null ? page.order.reason : page.order?.writableHere ? 'Choose the order buyers see each value in.' : 'The server did not report why this action is unavailable.'} onClick={openOrder}>Order values</Button>}
    </h3>
    <p className="nds-vp-dock-hint">{VALUES_HINT}</p>
    {(page.axes ?? []).map(axis => {
      const children = page.children.filter(child => child.included)
      const differing = children.filter(child => child.values[axis.key]?.source === 'pinned')
      if (!differing.length) return <p key={axis.key} className="nds-vp-dock-note">{sameAsSharedNote(axis.label, axis.valueOrder?.codes.length ?? axis.values.length, children.length)}</p>
      const groups = new Map<string, { shared: string; value: string; count: number }>()
      for (const child of differing) {
        const shared = child.sharedAxisValues?.[axis.key] ?? '—', value = child.values[axis.key]?.value ?? '—'
        const key = JSON.stringify([shared, value]), group = groups.get(key)
        groups.set(key, { shared, value, count: (group?.count ?? 0) + 1 })
      }
      return <div key={axis.key} className="nds-vp-dock-values">
        <SummaryTable label={`${axis.label} values on ${channelLabel}`} columns={[`${axis.label} value`, `On ${channelLabel}`, 'Included']}
          rows={[...groups].map(([id, row]) => ({ id, cells: [row.shared, row.value, row.count] }))} />
        {children.length > differing.length && <p className="nds-vp-dock-note">Other values — same as shared · {children.length - differing.length} included</p>}
      </div>
    })}
    <Modal open={ordering} onClose={() => setOrdering(false)} title="Order values" subtitle={`The order buyers see on ${page.coordinate.label}. Save mapping applies this order.`}
      footer={<><Button size="sm" onClick={() => setOrdering(false)}>Cancel</Button><Button size="sm" variant="primary" onClick={() => {
        if (page.order?.token) onDraft({ ...draft, presentationOrder: { expectedToken: page.order.token, change: { ...draft.presentationOrder?.change, values: orders } } })
        setOrdering(false)
      }}>Use this order</Button></>}>
      {orderAxes.map(axis => <Field key={axis.key} label={axis.name}><OrderedList compact keyboardGrip label={`${axis.name} value order`} items={orders[axis.key] ?? axis.values}
        onChange={values => setOrders(current => ({ ...current, [axis.key]: values }))} /></Field>)}
    </Modal>
  </section>
})

/* ── 3 · Listing split ────────────────────────────────────────────────────────────────────── */

export interface SplitSectionProps {
  page: ProjectionPage
  draft: ProjectionDraft
  onDraft(next: ProjectionDraft): void
}

/**
 * §4.4.3 — `One listing` / `One listing per <axis>`.
 *
 * 🔴 The per-axis option is RENDERED and HELD until VP.2 confirms `creatable`. `aria-disabled` with
 * the reason in the tooltip, **never a silent disable** — §4.4.3's own words, and the shape of
 * every "the control was there and nothing said why it did nothing" defect in this ledger. A held
 * radio keeps its label and its counts, so an operator can see what the option WOULD do.
 */
export const SplitSection = memo(function SplitSection({ page, draft, onDraft }: SplitSectionProps) {
  const { vocabulary, limits, coordinate, split } = page
  const channelLabel = coordinate.channelLabel ?? coordinate.channel
  const included = page.children.filter(c => c.included)
  /** The first mapped axis is the one a split would cut on — the axis buyers pick first. */
  const cutAxis = draft.mapping.find(m => m.target !== null) ?? draft.mapping[0]
  const axis = cutAxis ? (page.axes ?? []).find(a => a.key === cutAxis.axisKey) : undefined
  const counts = axis
    ? axis.values.map(v => included.filter(c => c.sharedAxisValues?.[axis.key] === v.code).length).filter(n => n > 0)
    : []
  const held = !split.creatable
  const heldReason = split.heldReason == null ? 'The server did not report why this action is unavailable.' : split.heldReason

  return (
    <section className="nds-vp-dock-section" aria-labelledby="vp-dock-split">
      <h3 id="vp-dock-split" className="nds-vp-dock-title">Listing split</h3>
      <p className="nds-vp-dock-hint">{splitHint(channelLabel, limits.variants, limits.axes, vocabulary)}</p>
      <Radio
        name="vp-split"
        checked={draft.split.mode === 'single'}
        label={splitSingleLabel(included.length, limits.variants)}
        onChange={() => onDraft({ ...draft, split: { mode: 'single' } })}
      />
      <span
        className="nds-vp-dock-held"
        /* The reason travels with the control, on the element an operator hovers and on the one a
           screen reader reaches — not in a paragraph beside it that nobody associates with it. */
        title={held ? heldReason : undefined}
      >
        <Radio
          name="vp-split"
          checked={draft.split.mode === 'per-axis'}
          disabled={held}
          aria-disabled={held || undefined}
          aria-describedby={held ? 'vp-split-held' : undefined}
          label={axis ? splitPerAxisLabel(axis.label, counts.length, counts) : 'One listing per axis'}
          onChange={() => { if (!held && axis) onDraft({ ...draft, split: { mode: 'per-axis', axisKey: axis.key } }) }}
        />
      </span>
      {held && <span id="vp-split-held" className="sr-only">{heldReason}</span>}
    </section>
  )
})

/* ── 4 · Collisions (VT.4) ────────────────────────────────────────────────────────────────── */

export interface CollisionsSectionProps {
  page: ProjectionPage
  draft: ProjectionDraft
}

/**
 * VT.4 — VX §6's Collisions section, added beside VP.4's three.
 *
 * A COLLISION is two INCLUDED variants that arrive at the channel with the same key on the surviving
 * axes. It is the one mapping failure whose remedy is not in the cell that shows it, which is why the
 * sixth projection word `Collides` sends an operator here (`grid/renderers/projection.ts`).
 *
 * 🔴 **Three states, three sentences — never two.** `page.collisions` absent = this server does not
 * report them (an older API); `null` = nothing is dropped on this coordinate, so nothing could collide
 * (NOT COMPUTED); `unresolved: 0` = computed and empty. The section that printed "No collisions on this
 * listing." for all three would be asserting a measurement in the two cases where none was taken —
 * `reference_could_not_measure_vs_measured_empty`, inside a contract field.
 *
 * 🔴 **The resolver radios are READ-ONLY here, and the section says why.** Measured 2026-09-13: the
 * projection PATCH accepts no resolver (it REFUSES a colliding mapping with `400 collision_unresolved`),
 * and a resolver is stored on the category's mapping RULE (`MarketplaceSchemaMapping.variations`, VX
 * §11.1 — VT.3's page), not per coordinate. A radio an operator could click that saved nothing would be
 * the silent-no-op this programme's control rules exist to prevent, so each one is held with the reason
 * it cannot run here, and the available ones say where they ARE set.
 *
 * 🔴 **`fold` availability is the server's, and it is wider than the write path.** Also measured: the
 * server reports `fold: available` whenever any axis survives, but folding writes through the PIN on the
 * child's axis cell, and on this fixture every `values[axis].write` is `null` with the server's own
 * sentence ("…offers no options for this family yet, so there is no per-market <axis> to pin here").
 * So the section ANDs the two: the server's availability and a writable cell. When the cells hold it,
 * the cell's reason is shown, because that is the refusal an operator would actually hit.
 */
export const CollisionsSection = memo(function CollisionsSection({ page, draft }: CollisionsSectionProps) {
  const { collisions, coordinate } = page
  const channelLabel = coordinate.channelLabel ?? coordinate.channel
  const mapped = draft.mapping.filter(m => m.target !== null).map(m => m.axisKey)
  const dropped = (page.axes ?? []).filter(a => !mapped.includes(a.key))

  /* Can a FOLD actually be written on this coordinate? The first surviving axis is where it would land. */
  const foldInto = (page.axes ?? []).find(a => mapped.includes(a.key))
  const foldCell = foldInto ? page.children.find(c => c.values?.[foldInto.key])?.values?.[foldInto.key] : undefined
  const foldHeldByCell = foldInto && foldCell ? (!foldCell.write ? (foldCell.writeBlockedReason ?? null) : null) : null

  const resolverLabel: Record<'split' | 'fold' | 'exclude', string> = {
    split: 'Split per dropped axis',
    fold: foldInto ? `Fold into ${foldInto.label}` : 'Fold into the surviving axis',
    exclude: 'Exclude the duplicates',
  }

  return (
    <section className="nds-vp-dock-section" aria-labelledby="vp-dock-collisions">
      <h3 id="vp-dock-collisions" className="nds-vp-dock-title">Collisions</h3>

      {collisions === undefined ? (
        <p className="nds-vp-dock-hint">
          This server does not report collisions for {channelLabel} · {coordinate.market} yet, so none are shown —
          that is not the same as none existing.
        </p>
      ) : collisions === null ? (
        <p className="nds-vp-dock-hint">
          Every axis this family has reaches {channelLabel} · {coordinate.market}, so no two variants can arrive
          with the same combination. Nothing was counted because there is nothing to count.
        </p>
      ) : (
        <>
          {/* The server's sentence, verbatim. The dock composes no count of its own. */}
          <p className="nds-vp-dock-hint">{collisions.summary}</p>
          {collisions.unresolved === 0 ? (
            <p className="nds-vp-dock-note">
              {dropped.length > 0
                ? `${dropped.map(a => a.label).join(', ')} ${dropped.length === 1 ? 'is' : 'are'} dropped on this ${page.vocabulary.axisNoun === 'option' ? 'store' : 'listing'}, and the variants are still distinct without ${dropped.length === 1 ? 'it' : 'them'}.`
                : 'No collisions on this listing.'}
            </p>
          ) : (
            <SummaryTable
              label={`Colliding variants on ${coordinate.label}`}
              columns={['Arrives as', 'Variants', 'Told apart only by']}
              /**
               * 🔴 CAPPED at 6 SKUs, and the cap is STATED. Measured 2026-09-13 on GALE-JACKET, where every
               * axis is unmapped on Amazon·IT so all 20 variants land in ONE group: printing every SKU and
               * every dropped tuple made this section **1021px tall** inside a 420px dock. The contract caps
               * the same fact at 10 subjects for the readiness item (`docs/vt1-contracts.md` §4); a panel that
               * needs a page of scrolling to say "these twenty cannot be told apart" has buried the sentence
               * it exists to deliver. The count is always exact — only the enumeration is trimmed.
               */
              rows={collisions.groups.map((group, index) => {
                const shown = group.members.slice(0, 6)
                const rest = group.members.length - shown.length
                const axes = [...new Set(group.members.flatMap(m => Object.keys(m.droppedValues)))]
                return {
                  id: `${index}`,
                  cells: [
                    group.key.filter(Boolean).join(' · ') || '—',
                    <>
                      {shown.map(m => m.sku).join(', ')}
                      {rest > 0 && <> <span className="nds-cell-muted">+{rest} more</span></>}
                    </>,
                    group.members.length <= 3
                      ? group.members
                        .map(m => Object.entries(m.droppedValues).map(([axis, value]) => `${axis} ${value}`).join(' / '))
                        .join(' vs ')
                      : `${axes.join(', ')} — ${group.members.length} distinct combinations`,
                  ],
                }
              })}
            />
          )}

          {collisions.unresolved > 0 && collisions.resolvers.map(resolver => {
            const cellReason = resolver.kind === 'fold' ? foldHeldByCell : null
            const reason = !resolver.available
              ? (resolver.reason == null ? 'The server did not report why this action is unavailable.' : resolver.reason)
              : cellReason
                ?? `A resolver is a rule for the category, not for one listing — set it in Channels → Mapping for ${channelLabel}. This listing shows which rule applies.`
            return (
              <div key={resolver.kind}>
                {/* The reason travels ON the control — the element an operator hovers and the one a screen
                    reader reaches — never in a paragraph beside it that nothing associates with it. */}
                <span className="nds-vp-dock-held" title={reason}>
                  <Radio
                    name="vp-collision-resolver"
                    checked={false}
                    disabled
                    aria-disabled
                    aria-describedby={`vp-collision-${resolver.kind}`}
                    label={resolverLabel[resolver.kind]}
                    onChange={() => { /* read-only here — see the section docblock */ }}
                  />
                </span>
                <p id={`vp-collision-${resolver.kind}`} className="nds-vp-dock-note">{reason}</p>
              </div>
            )
          })}
        </>
      )}
    </section>
  )
})

/* ── 4 · Lock banner ──────────────────────────────────────────────────────────────────────── */

/**
 * §4.4.4 — shown ONLY when the coordinate has a live listing. `page.locked` is the server's
 * statement of that; a client that inferred "live" from an external id being present would be
 * asserting a publish state it cannot see.
 */
export const LockBanner = memo(function LockBanner({ page }: { page: ProjectionPage }) {
  if (!page.locked) return null
  return (
    <Banner tone="warning" title={LOCK_TITLE} icon={<Lock size={18} aria-hidden />}>
      {page.locked.reason}
    </Banner>
  )
})

/* Re-exported so the dock's header can label a field without importing the DS twice. */
export { Field }
