'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, Plus } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { SizeGridEditor, type SizeGridIssue } from '@nexus/ui/grid/size-grid/index'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { DateField, Textarea } from '../../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { sizeGridWords } from '../../../quotes/record/view/grid-copy'
import type { Order, ShipToAddress } from '../../api'
import { SPLIT_LIMITS, splitLinesOf, splitOver, splitPartOf, splitPieces, splitProblem, splitStays, type SplitLine, type SplitPartDraft, type SplitRefusal } from '../../model'
import type { OrderRecordActions, OrderRecordModel, SplitState } from '../record-model'
import { DialogProblem, Frame } from './Dialogs'

/**
 * F-OP-111 (10-order-page §4.6) — "Split into new orders…" (⋯ Edit): each part a size grid of the lines that may move (each size
 * capped at what is not on a work order yet, less what the other parts take; a line of which every piece moves goes whole, and a line
 * with a delivery schedule or options moves only whole), where it ships (the customer's delivery addresses), its customer PO and its
 * requested and promise dates (the order's own by default); "Another part" (at most the API's 20); an optional reason. The new orders
 * keep the prices, terms and season; the deposit stays here. A refusal is said at its place: under its part, or above for the split
 * as a whole. Done: the new orders, each a link; the page stays. The view draws its model and fetches nothing.
 */
export function SplitOrderDialog({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const sales = useT('sales')
  const lines = useMemo(() => splitLinesOf(order), [order])
  // F-OL-04: a line's ⋯ "Move to a new order…" opens with that line's pieces that may move in the first part (each capped).
  const [parts, setParts] = useState<SplitPartDraft[]>(() => {
    const asked = model.dialog?.kind === 'split' ? model.dialog.lineId : undefined
    const line = asked ? lines.find((entry) => entry.lineId === asked) : undefined
    const first = splitPartOf(order)
    return [line ? { ...first, grid: { [line.lineId]: Object.fromEntries(line.sizes.filter((size) => size.open > 0).map((size) => [size.size, size.open])) } } : first]
  })
  const [reason, setReason] = useState('')
  const split = model.split ?? null
  const made = split?.made ?? null
  const refusals = split?.refusals ?? []
  const problem = splitProblem({ order, parts, reason, today: model.today })
  const held = model.busy ? t('held.busy') : problem ? t(problem.key, problem.params) : null
  const atLimit = parts.length >= SPLIT_LIMITS.parts
  const stays = splitStays(order)
  const copy = useMemo(() => sizeGridWords(sales), [sales])
  const change = (index: number, next: Partial<SplitPartDraft>) => setParts((list) => list.map((part, at) => (at === index ? { ...part, ...next } : part)))
  const whole = refusals.filter((refusal) => refusal.part === null)

  const done = made ? (
    <div className="fw-so-done" role="status">
      <CheckCircle2 size={20} className="fw-so-ico is-ok" aria-hidden />
      <span className="fw-so-stack-tight">
        <span>{t('split.done', { count: made.length, numbers: made.map((entry) => entry.number).join(', ') })}</span>
        {made.map((entry) => (
          <Link key={entry.id} className="fw-so-link" href={`${model.prefix}/sales/orders/${entry.id}`}>
            {t('split.open', { number: entry.number })}
          </Link>
        ))}
      </span>
    </div>
  ) : undefined

  return (
    <Frame
      title={t('split.title', { number: order.number })}
      held={held}
      go={() => actions?.onSplit?.({ parts, reason: reason.trim() })}
      goLabel={model.busy ? t('common.working') : t('split.go', { count: parts.length })}
      onClose={() => actions?.onDialog?.(null)}
      problem={
        <>
          <DialogProblem model={model} />
          <Refusals refusals={whole} />
        </>
      }
      size="lg"
      done={done}
    >
      <p className="fw-so-hint">{t('split.body')}</p>
      {stays > 0 && <p className="fw-so-hint">{t('split.stays', { count: stays })}</p>}
      {parts.map((_, index) => (
        <SplitPart
          key={index}
          order={order}
          lines={lines}
          parts={parts}
          index={index}
          addresses={split?.addresses ?? null}
          refusals={refusals.filter((refusal) => refusal.part === index)}
          today={model.today}
          copy={copy}
          onChange={(next) => change(index, next)}
          onRemove={parts.length > 1 ? () => setParts((list) => list.filter((_, at) => at !== index)) : null}
        />
      ))}
      <div>
        <Button size="sm" heldReason={atLimit ? t('split.held.parts', { count: SPLIT_LIMITS.parts }) : null} onClick={() => setParts((list) => (list.length >= SPLIT_LIMITS.parts ? list : [...list, splitPartOf(order)]))}>
          <Plus size={14} aria-hidden /> {t('split.addPart')}
        </Button>
      </div>
      <Field label={t('split.reason')} hint={t('split.reasonHint')}>
        <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={SPLIT_LIMITS.reason} />
      </Field>
      <p className="fw-so-hint">{t('split.keeps')}</p>
    </Frame>
  )
}

/** The refusals of one place: the first as the banner's line, the rest under it (each in this app's words). */
function Refusals({ refusals }: { refusals: readonly SplitRefusal[] }) {
  const t = useT('orders')
  const [first, ...rest] = refusals
  if (!first) return null
  return (
    <Banner tone="danger" title={t(first.words.key, first.words.params)}>
      {rest.length > 0 && (
        <ul className="fw-so-list">
          {rest.map((refusal, index) => (
            <li key={index}>{t(refusal.words.key, refusal.words.params)}</li>
          ))}
        </ul>
      )}
    </Banner>
  )
}

/** The words of an address in the Ship to choice (its name, street, postcode and city). */
const addressWords = (address: ShipToAddress): string => [address.name, address.line1, `${address.postalCode} ${address.city}`].filter((part): part is string => !!part && part.trim() !== '').join(' · ')

function SplitPart(props: {
  order: Order
  lines: readonly SplitLine[]
  parts: readonly SplitPartDraft[]
  index: number
  addresses: SplitState['addresses']
  refusals: readonly SplitRefusal[]
  today: string
  copy: ReturnType<typeof sizeGridWords>
  onChange: (next: Partial<SplitPartDraft>) => void
  onRemove: (() => void) | null
}) {
  const { order, lines, parts, index, addresses, refusals, today, copy, onChange, onRemove } = props
  const t = useT('orders')
  const locale = useLocale()
  const part = parts[index]!
  const n = index + 1
  const sizes = useMemo(() => {
    const seen: string[] = []
    for (const line of lines) for (const size of line.sizes) if (size.open > 0 && !seen.includes(size.size)) seen.push(size.size)
    return seen.map((size) => ({ key: size, label: size }))
  }, [lines])
  const issues: SizeGridIssue[] = splitOver(lines, parts, index).map((cell) => ({ colour: cell.lineId, size: cell.size, message: t('split.room', { room: cell.room }), tone: 'error' }))
  const shipToHint = addresses === null ? t('split.shipToHeld') : addresses.problem ? t('split.shipToFailed') : addresses.value === null ? t('split.shipToReading') : undefined
  return (
    <fieldset className="fw-so-choices">
      <legend className="fw-so-legend">{t('split.part', { n })}</legend>
      <div className="fw-so-card-head">
        <span className="fw-so-hint">{t('split.pieces', { count: splitPieces(part) })}</span>
        {onRemove && (
          <Button size="sm" variant="quiet" onClick={onRemove}>
            {t('split.removePart', { n })}
          </Button>
        )}
      </div>
      <Refusals refusals={refusals} />
      <div className="fw-so-gridbox">
        <SizeGridEditor
          colours={lines.map((line) => ({ key: line.lineId, label: t('split.line', { seq: line.seq, style: line.style, colour: line.colour }), offered: line.sizes.filter((size) => size.open > 0).map((size) => size.size) }))}
          sizes={sizes}
          value={part.grid as Record<string, Record<string, number>>}
          onChange={(next) => onChange({ grid: next })}
          issues={issues}
          caption={t('split.sizes', { n })}
          locale={INTL_LOCALE[locale]}
          copy={copy}
        />
      </div>
      <div className="fw-so-two">
        <Field label={t('split.shipTo')} hint={shipToHint}>
          <Select value={part.shipToAddressId ?? ''} onChange={(event) => onChange({ shipToAddressId: event.target.value || null })} aria-label={t('split.shipTo')}>
            <option value="">{t('split.shipToSame')}</option>
            {(addresses?.value ?? []).map((address) => (
              <option key={address.id} value={address.id}>
                {addressWords(address)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('amend.field.customerRef')}>
          <Input value={part.customerRef} onChange={(event) => onChange({ customerRef: event.target.value })} maxLength={100} autoComplete="off" />
        </Field>
      </div>
      <div className="fw-so-two">
        <Field label={t('amend.field.requestedDate')}>
          <DateField value={part.requestedDate} onChange={(value) => onChange({ requestedDate: value })} min={order.requestedDate && order.requestedDate < today ? undefined : today} locale={INTL_LOCALE[locale]} ariaLabel={t('amend.field.requestedDate')} />
        </Field>
        <Field label={t('newOrder.promise')}>
          <DateField value={part.promiseDate} onChange={(value) => onChange({ promiseDate: value })} min={order.promiseDate && order.promiseDate < today ? undefined : today} locale={INTL_LOCALE[locale]} ariaLabel={t('newOrder.promise')} />
        </Field>
      </div>
    </fieldset>
  )
}
