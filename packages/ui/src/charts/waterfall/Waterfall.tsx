'use client'

/**
 * Waterfall — signed steps from a start to a result, a bar per step (B-W2b-09; design "Waterfall" on styles, orders and
 * quotes): price (base → list → options → quantity break → manual → net) or cost (materials → labour → overhead → … →
 * cost → margin → price).
 *
 *   <Waterfall label="Price build-up" format={(n) => money(n, 'EUR', locale)} heldReason={can.price ? null : t('noGrain')}
 *     steps={[{ id: 'base', kind: 'start', label: 'Base price', amount: 52 }, { id: 'qty', kind: 'step', label: 'Quantity break',
 *       amount: -4.5, detail: <p>…</p> }, { id: 'net', kind: 'total', label: 'Net price', amount: 47.5 }]} />
 *
 * - **Every step a link or a popover**: `href` makes its name a real link (a cost step opens Standard vs actual);
 *   `detail` makes it a button that opens a `DetailPopover` with how it is made; otherwise plain words.
 * - **Grain-aware**: the app passes `heldReason` when the person lacks the grain ("Needs the cost grain") — the reason
 *   is shown in place of the chart, never a chart of zeros. Price amounts for price, cost for cost: the app decides.
 * - **Words, not only bars**: each row writes its signed amount ("− €4.50"); totals their value; a total that does not
 *   match the steps above it says so. The bars are drawn for the eye only (`aria-hidden`); each row's name says the
 *   label, the amount and the running total.
 * Its own entry point (`charts/waterfall`). Words: `labels`; amounts: `format`.
 */
import type { ComponentType, ReactNode } from 'react'
import NextLink from 'next/link'

import { DetailPopover } from '../../components/DetailPopover'
import { mergeLabels } from '../../lib/labels'
import { WATERFALL_LABELS, type WaterfallLabels } from './WaterfallLabels'
import { waterfallView, type WaterfallGood, type WaterfallKind } from './waterfallModel'
import './waterfall.css'

export interface WaterfallStep {
  id: string
  kind: WaterfallKind
  /** The step's name in words ("Quantity break"). Also its text name. */
  label: string
  /** start: the opening value; step: the signed change; total: the server's value (checked against the steps). */
  amount?: number | null
  /** A real link: the record or page that explains this step. */
  href?: string
  /** A popover: how this step is made. */
  detail?: ReactNode
  /** A short line under the name ("3 sizes at the 50+ break"). */
  note?: ReactNode
}

export type WaterfallLinkComponent = ComponentType<{ href: string; className?: string; children?: ReactNode }>

export interface WaterfallProps {
  steps: readonly WaterfallStep[]
  /** The chart's name: "Price build-up". */
  label: string
  /** Writes an amount (no sign): "€12.00". The app's money writer for the grain. */
  format: (value: number) => string
  /** Which way is good. Default `up` (price, margin); `down` for a cost build-up. */
  good?: WaterfallGood
  /** The person may not see these amounts: the reason, drawn in place of the chart. */
  heldReason?: string | null
  /** A total's mismatch in words ("The steps add up to €45.00; the order says €46.00"). Default: not said. */
  mismatchWords?: (total: string, given: string) => string
  linkAs?: WaterfallLinkComponent
  labels?: Partial<WaterfallLabels>
  className?: string
}

export function Waterfall({ steps, label, format, good = 'up', heldReason, mismatchWords, linkAs, labels, className }: WaterfallProps) {
  const words = mergeLabels(WATERFALL_LABELS, labels)
  const cls = ['nds-waterfall', className ?? ''].filter(Boolean).join(' ')
  if (heldReason) return <p className={`${cls} is-held`}>{heldReason}</p>
  if (steps.length === 0) return <p className={`${cls} is-empty`}>{words.empty}</p>
  const view = waterfallView(steps, good)
  const Link = linkAs ?? NextLink
  return (
    <ol className={cls} aria-label={label}>
      {view.bars.map((bar, index) => {
        const step = steps[index]!
        const total = bar.kind !== 'step'
        const amount = total ? format(bar.amount) : bar.amount < 0 ? words.down(format(-bar.amount)) : words.up(format(bar.amount))
        const name = total ? words.totalName(step.label, amount) : words.stepName(step.label, amount, format(bar.to))
        const title = step.href ? (
          <Link className="nds-waterfall-link" href={step.href}>
            {step.label}
          </Link>
        ) : step.detail != null ? (
          <DetailPopover trigger={step.label} triggerLabel={words.open(step.label)} triggerClassName="nds-waterfall-pop" label={step.label}>
            {step.detail}
          </DetailPopover>
        ) : (
          step.label
        )
        return (
          <li key={bar.id} className={`nds-waterfall-row is-${bar.kind} tone-${bar.tone}`}>
            <span className="nds-vh">{name}</span>
            <span className="nds-waterfall-label">
              <span className="nds-waterfall-name">{title}</span>
              {step.note != null && step.note !== '' && <span className="nds-waterfall-note">{step.note}</span>}
              {bar.mismatch !== null && mismatchWords && <span className="nds-waterfall-note is-mismatch">{mismatchWords(format(bar.to), format(bar.to + bar.mismatch))}</span>}
            </span>
            <span className="nds-waterfall-track" aria-hidden>
              <span className="nds-waterfall-zero" style={{ left: `${view.zero}%` }} />
              <span className="nds-waterfall-bar" style={{ left: `${bar.left}%`, width: `${bar.width}%` }} />
            </span>
            <span className="nds-waterfall-amount" aria-hidden>{amount}</span>
          </li>
        )
      })}
    </ol>
  )
}
