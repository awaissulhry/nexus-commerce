'use client'

/**
 * VersionCompare — two versions of a structured record side by side (B-W2b-207, design part VersionCompare): a style's
 * revisions and a change order's redline, a work order's spec against today's, a quote's or an order's versions, a price
 * list's. Lines added, removed and changed (each with its word and mark, never colour alone), the changed fields before
 * and after in two columns, the quantities per size that moved (from → to and the difference), the totals before → after,
 * and "Use as change note", which hands the same facts in plain words to the page.
 *
 *   <VersionCompare before={{ label: 'Rev 3', note: 'Released' }} after={{ label: 'Rev 4', note: 'Draft' }}
 *                   lines={lines} fields={[{ id: 'qty', label: t('qty') }]} sizes={range} totals={totals}
 *                   locale="it-IT" onUseAsNote={(note) => setDescription(note)} labels={ds.versionCompare} />
 *
 * - Lines are matched by the app (`id`); fields come written ("1.20 m²"); a quantity per size is a decimal, compared
 *   exactly and written in the page's language.
 * - Unchanged lines are counted and hidden; "Show 4 unchanged lines" brings them back (aria-pressed).
 * - Phone: each line is a card; its two version columns stay side by side (short values), the size moves wrap.
 * Data in, events out: it reads no API and saves nothing.
 */
import { useId, useMemo, useState } from 'react'
import { ArrowRight, Equal, FileText, Minus, Pencil, Plus } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { Button } from '../../primitives/Button'
import { VERSION_COMPARE_LABELS, type VersionCompareLabels } from './VersionCompareLabels'
import {
  versionChangeNote,
  versionHasChanges,
  versionLineViews,
  versionSummary,
  type VersionField,
  type VersionHead,
  type VersionLine,
  type VersionLineKind,
  type VersionLineView,
  type VersionTotal,
} from './versionCompareModel'
import './versionCompare.css'

export interface VersionCompareProps {
  /** The first version (the one before). */
  before: VersionHead
  /** The second version (the one after). */
  after: VersionHead
  /** The lines of both versions, matched by id, in the order to show. */
  lines: readonly VersionLine[]
  /** The fields compared on each line, in order, with their words. */
  fields: readonly VersionField[]
  /** The sizes in scale order (the per-size moves follow it). */
  sizes?: readonly string[]
  /** Totals before → after (written). */
  totals?: readonly VersionTotal[]
  /** The page's language for quantities (default en-GB). */
  locale?: string
  /** How a quantity is written (overrides `locale`). */
  formatQuantity?: (value: string) => string
  /** Hands the plain change note to the page. Absent: no button. */
  onUseAsNote?: (note: string) => void
  /** Why the note cannot be used now (the change is decided). */
  noteHeldReason?: string | null
  /** Start with the unchanged lines shown. Default false. */
  defaultShowUnchanged?: boolean
  className?: string
  labels?: Partial<VersionCompareLabels>
}

const KIND_ICON: Record<VersionLineKind, typeof Plus> = { added: Plus, removed: Minus, changed: Pencil, unchanged: Equal }

export function VersionCompare({
  before,
  after,
  lines,
  fields,
  sizes = [],
  totals = [],
  locale = 'en-GB',
  formatQuantity,
  onUseAsNote,
  noteHeldReason,
  defaultShowUnchanged = false,
  className,
  labels,
}: VersionCompareProps) {
  const lw = mergeLabels(VERSION_COMPARE_LABELS, labels)
  const id = useId()
  const [showUnchanged, setShowUnchanged] = useState(defaultShowUnchanged)
  const views = useMemo(() => versionLineViews(lines, fields, sizes), [lines, fields, sizes])
  const summary = versionSummary(views, totals)
  const changed = versionHasChanges(summary)
  const quantity = useMemo(() => {
    if (formatQuantity) return formatQuantity
    const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 })
    return (value: string) => format.format(Number(value))
  }, [formatQuantity, locale])
  const signed = (delta: string) => (delta.startsWith('-') ? `−${quantity(delta.slice(1))}` : `+${quantity(delta)}`)
  const shown = views.filter((view) => showUnchanged || view.kind !== 'unchanged')
  const noteHeld = noteHeldReason ?? (changed ? null : lw.nothingToNote)

  return (
    <section className={['nds-vc', className].filter(Boolean).join(' ')} aria-labelledby={`${id}-head`}>
      <div className="nds-vc-head">
        <p id={`${id}-head`} className="nds-vc-versions">
          <span className="nds-vc-sr">{lw.title(before.label, after.label)}</span>
          <Version head={before} side="before" />
          <ArrowRight size={14} aria-hidden className="nds-vc-arrow" />
          <Version head={after} side="after" />
        </p>
        <p className="nds-vc-summary">{changed ? lw.summary(summary.added, summary.removed, summary.changed) : lw.same}</p>
        {summary.unchanged > 0 || onUseAsNote ? (
          <div className="nds-vc-tools">
            {summary.unchanged > 0 ? (
              <Button size="sm" variant="quiet" aria-pressed={showUnchanged} onClick={() => setShowUnchanged((now) => !now)}>
                {showUnchanged ? lw.hideUnchanged : lw.showUnchanged(summary.unchanged)}
              </Button>
            ) : null}
            {onUseAsNote ? (
              <Button
                size="sm"
                heldReason={noteHeld}
                onClick={() => onUseAsNote(versionChangeNote(before, after, views, totals, lw, { formatQuantity: quantity }))}
              >
                <FileText size={13} aria-hidden /> {lw.useAsNote}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {shown.length > 0 ? (
        <ol className="nds-vc-lines">
          {shown.map((view) => (
            <Line key={view.line.id} view={view} before={before} after={after} lw={lw} quantity={quantity} signed={signed} />
          ))}
        </ol>
      ) : null}
      {totals.length > 0 ? (
        <table className="nds-vc-totals">
          <caption>{lw.totals}</caption>
          <thead>
            <tr>
              <th scope="col">{lw.field}</th>
              <th scope="col">{before.label}</th>
              <th scope="col">{after.label}</th>
            </tr>
          </thead>
          <tbody>
            {totals.map((total) => {
              const moved = total.before !== total.after
              return (
                <tr key={total.id} data-changed={moved ? 'true' : undefined}>
                  <th scope="row">{total.label}</th>
                  <td className="nds-vc-from">{total.before ?? lw.none}</td>
                  <td className="nds-vc-to">{total.after ?? lw.none}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : null}
    </section>
  )
}

function Version({ head, side }: { head: VersionHead; side: 'before' | 'after' }) {
  return (
    <span className="nds-vc-version" data-side={side} aria-hidden="true">
      <b>{head.label}</b>
      {head.note ? <span className="nds-vc-sub">{head.note}</span> : null}
    </span>
  )
}

function Line({
  view,
  before,
  after,
  lw,
  quantity,
  signed,
}: {
  view: VersionLineView
  before: VersionHead
  after: VersionHead
  lw: VersionCompareLabels
  quantity: (value: string) => string
  signed: (delta: string) => string
}) {
  const Icon = KIND_ICON[view.kind]
  const empty = (side: 'before' | 'after') =>
    side === 'before' && view.kind === 'added' ? lw.notIn(before.label) : side === 'after' && view.kind === 'removed' ? lw.notIn(after.label) : lw.none
  const q = (value: string | null) => (value === null ? lw.none : quantity(value))
  return (
    <li className="nds-vc-line" data-kind={view.kind}>
      <div className="nds-vc-line-head">
        <span className="nds-vc-kind" data-kind={view.kind}>
          <Icon size={12} aria-hidden /> {lw.kinds[view.kind]}
        </span>
        <span className="nds-vc-line-name">
          <b>{view.line.label}</b>
          {view.line.detail ? <span className="nds-vc-sub">{view.line.detail}</span> : null}
        </span>
      </div>
      {view.fields.length > 0 ? (
        <table className="nds-vc-fields">
          <thead>
            <tr>
              <th scope="col">{lw.field}</th>
              <th scope="col">{before.label}</th>
              <th scope="col">{after.label}</th>
            </tr>
          </thead>
          <tbody>
            {view.fields.map((change) => (
              <tr key={change.id}>
                <th scope="row">{change.label}</th>
                <td className="nds-vc-from" data-empty={change.from === null ? 'true' : undefined}>
                  {change.from ?? empty('before')}
                </td>
                <td className="nds-vc-to" data-empty={change.to === null ? 'true' : undefined}>
                  {change.to ?? empty('after')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {view.sizes.length > 0 ? (
        <div className="nds-vc-sizes">
          <span className="nds-vc-sub">{lw.sizes}</span>
          <ul className="nds-vc-size-list">
            {view.sizes.map((change) => (
              <li key={change.size} className="nds-vc-size">
                <span className="nds-vc-sr">{lw.sizeChange(change.size, q(change.from), q(change.to), change.delta === null ? null : signed(change.delta))}</span>
                <b aria-hidden="true">{change.size}</b>
                <span className="nds-vc-from" aria-hidden="true">
                  {q(change.from)}
                </span>
                <ArrowRight size={11} aria-hidden />
                <span className="nds-vc-to" aria-hidden="true">
                  {q(change.to)}
                </span>
                {change.delta !== null ? (
                  <span className="nds-vc-delta" data-sign={change.delta.startsWith('-') ? 'down' : 'up'} aria-hidden="true">
                    {signed(change.delta)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  )
}
