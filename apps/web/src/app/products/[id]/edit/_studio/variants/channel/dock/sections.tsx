'use client'

/**
 * VP.4 — §4.4's four sections. One file because they share the draft's shape and nothing else
 * consumes them; splitting four 40-line sections across four modules would buy an import graph.
 */
import { Lock } from 'lucide-react'
import { memo, useState } from 'react'

import { Banner, Field, Modal, SummaryTable, Listbox, OrderedList } from '@/design-system/components'
import { Button, Radio, Tag } from '@/design-system/primitives'

import {
  LOCK_TITLE, VALUES_HINT, axisNounPlural, specificsHint, splitHint, sameAsSharedNote,
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
  const { vocabulary, limits, coordinate, targetOptions, locked } = page
  const channelLabel = coordinate.channelLabel ?? coordinate.channel
  const order = draft.mapping.map(m => m.axisKey)
  const byKey = new Map(draft.mapping.map(m => [m.axisKey, m]))
  const used = draft.mapping.filter(m => m.target !== null).length
  /** Axes the family has that this channel is not yet showing — what `+ Add a specific` adds. */
  const unmapped = (page.axes ?? []).filter(a => !byKey.has(a.key))
  /* `null` is 'no limit this repository can source', not 'zero' — so it never holds the button. */
  const atLimit = limits.axes !== null && draft.mapping.length >= limits.axes

  const reorder = (keys: string[]) => onDraft({
    ...draft,
    mapping: keys.map((key, index) => ({ ...byKey.get(key)!, order: index })),
    ...(page.order?.token ? { presentationOrder: { expectedToken: page.order.token, change: { ...draft.presentationOrder?.change, axes: keys } } } : {}),
  })
  const retarget = (key: string, target: string) => onDraft({
    ...draft,
    mapping: draft.mapping.map(m => m.axisKey === key ? { ...m, target: target || null } : m),
  })
  const add = () => {
    const next = unmapped[0]
    if (!next) return
    onDraft({ ...draft, mapping: [...draft.mapping, { axisKey: next.key, axisLabel: next.label, target: null, order: draft.mapping.length }] })
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
      <OrderedList
        keyboardGrip
        compact
        disabled={coordinate.channel === 'EBAY' && !page.order?.writableHere}
        label={`The order buyers pick ${axisNounPlural(vocabulary)} in`}
        items={order}
        itemLabel={key => byKey.get(key)?.axisLabel ?? key}
        onChange={reorder}
        renderItem={key => {
          const row = byKey.get(key)
          if (!row) return null
          const isLocked = !!locked?.lockedAxisKeys.includes(key)
          return (
            <span className="nds-vp-dock-specific">
              <span className="nds-vp-dock-axis" title={row.axisLabel}>{row.axisLabel}</span>
              <span className="nds-vp-dock-arrow" aria-hidden>→</span>
              {/* §4.4.4 — a locked axis keeps its row and loses its listbox, "disabled with the same
                  reason". The reason is the SERVER's sentence, carried on the element the operator
                  hovers: a disabled control whose reason lives only in a banner further up is the
                  silent-disable shape `scripts/check-silent-disabled.mjs` exists to catch. */}
              <span
                className="nds-vp-dock-target"
                title={isLocked ? locked?.reason : undefined}
              >
                <Listbox
                  size="sm"
                  options={targetOptions.map(o => ({ value: o.code, label: o.label }))}
                  value={row.target ?? ''}
                  emptyLabel={`Choose a ${vocabulary.axisNoun}`}
                  emptyIsPlaceholder
                  disabled={isLocked}
                  ariaLabel={isLocked
                    ? `${row.axisLabel} is the ${channelLabel} ${vocabulary.axisNoun} ${row.target ?? ''}, locked: ${locked?.reason ?? ''}`
                    : `The ${channelLabel} ${vocabulary.axisNoun} for ${row.axisLabel}`}
                  onChange={value => retarget(key, value)}
                  width="100%"
                />
              </span>
            </span>
          )
        }}
      />
      {/* Held rather than hidden: the reason an operator cannot add one is the useful half. */}
      <Button
        size="sm"
        variant="ghost"
        disabled={unmapped.length === 0 || atLimit}
        title={
          atLimit ? `${channelLabel} allows up to ${limits.axes} ${axisNounPlural(vocabulary)} per listing.`
            : unmapped.length === 0 ? `Every shared axis is already a ${vocabulary.axisNoun}. Add an axis on the shared product first.`
              : `Show ${unmapped[0].label} as a ${vocabulary.axisNoun} on ${channelLabel}`
        }
        onClick={add}
      >+ Add a {vocabulary.axisNoun}</Button>
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
        title={page.order?.reason || 'Choose the order buyers see each value in.'} onClick={openOrder}>Order values</Button>}
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
  const heldReason = split.heldReason ?? 'Splitting into more than one listing is not available yet.'

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
