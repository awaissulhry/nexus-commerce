'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { CheckCircle2 } from 'lucide-react'
import { Banner, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Pill, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { ConfirmPhraseField, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { money, unitPrice } from '../../../quotes/model'
import type { ImpactItem, Order } from '../../api'
import {
  cancelConfirmHeld,
  changeLabel,
  closableLines,
  closeChoiceProblem,
  closedLines,
  compareRows,
  IMPACT_LINKED,
  impactWords,
  inWorkOrdersOf,
  moneyChange,
  namesOf,
  type CompareRow,
} from '../../daily-model'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { DialogProblem, Frame } from './Dialogs'

/**
 * The order studio's daily dialogs (B-W2a-50; the DS ReviewChangesModal, ActionConfirm and ConfirmPhraseField spoke
 * English only, so these are composed from the DS Modal, SummaryTable, KeyValue and Banner, named here; F-OP-106: the amendment's
 * review is no dialog any more — its parts are the Lines tab's "What changes" strip, ONE Apply):
 *  - Close remaining lines / Reopen lines (ActionConfirm, composed): the lines and sizes that will not be made or
 *    shipped, the reason, the reversal.
 *  - Cancel order (ActionConfirm, composed): the impact check — what stops it, what it changes, what it leaves behind —
 *    the reason, no reversal (copy it as a new quote), the order's number typed in the DS ConfirmPhraseField (B-W2b-18).
 *  - Copy as new quote, and the Changes tab's before → after (VersionCompare, composed).
 */

const close = (actions?: OrderRecordActions) => () => actions?.onDialog?.(null)

// ---- Close remaining lines / Reopen lines ------------------------------------------------------------------------------

export function CloseLinesDialog({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const open = closableLines(order)
  const [chosen, setChosen] = useState<string[]>(model.draft?.lineIds ?? open.map((entry) => entry.line.id))
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  // B-W2b-16: why, as a code of the CANCEL list (the words stay beside it).
  const [reasonCode, setReasonCode] = useState(model.draft?.reasonCode ?? '')
  const locale = useLocale()
  const answer = model.closedLines
  const problem = closeChoiceProblem(order, chosen, reason, reasonCode, model.cancelReasons ?? null)
  const held = model.busy ? t('held.busy') : problem ? t(problem.key) : null
  const stillMade = inWorkOrdersOf(order, chosen)
  const pieces = open.filter((entry) => chosen.includes(entry.line.id)).reduce((sum, entry) => sum + entry.left, 0)
  const done = answer ? (
    <div className="fw-so-done" role="status">
      <CheckCircle2 size={20} className="fw-so-ico is-ok" aria-hidden />
      <span className="fw-so-stack-tight">
        <span>{t('closeLines.done', { count: answer.closed.length, pieces: answer.closed.reduce((sum, entry) => sum + entry.closedShortQuantity, 0) })}</span>
        {answer.stillInWorkOrders.length > 0 && <span>{t('closeLines.stillMade', { count: answer.stillInWorkOrders.reduce((sum, entry) => sum + entry.pieces, 0) })}</span>}
        <span className="fw-so-hint">{t('closeLines.reversal')}</span>
      </span>
    </div>
  ) : undefined
  return (
    <Frame title={t('closeLines.title', { number: order.number })} held={held} go={() => actions?.onCloseLines?.(chosen.length === open.length ? [] : chosen, reason.trim(), reasonCode)} goLabel={model.busy ? t('common.working') : t('closeLines.go', { count: chosen.length })} onClose={close(actions)} problem={<DialogProblem model={model} />} done={done}>
      <p className="fw-so-hint">{t('closeLines.body')}</p>
      <fieldset className="fw-so-choices">
        <legend className="fw-so-legend">{t('closeLines.lines')}</legend>
        {open.map((entry) => {
          const names = namesOf({ lineId: entry.line.id, styleId: entry.line.styleId, colourwayId: entry.line.colourwayId }, order, null)
          return (
            <Checkbox
              key={entry.line.id}
              checked={chosen.includes(entry.line.id)}
              onChange={(event) => setChosen((current) => (event.target.checked ? [...current, entry.line.id] : current.filter((id) => id !== entry.line.id)))}
              label={
                <span className="fw-so-stack-tight">
                  <span>{t('closeLines.line', { line: entry.line.seq, style: names.style, colour: names.colour, count: entry.left })}</span>
                  <span className="fw-so-hint">{entry.sizes.map((size) => `${size.size}: ${size.left}`).join(' · ')}</span>
                </span>
              }
            />
          )
        })}
      </fieldset>
      {chosen.length > 0 && <p className="fw-so-hint">{t('closeLines.pieces', { count: pieces })}</p>}
      {stillMade > 0 && <Banner tone="warning" title={t('closeLines.inWorkOrders', { count: stillMade })} />}
      <Field label={t('closeLines.reasonCode')} hint={model.cancelReasons === null || model.cancelReasons === undefined ? t('closeLines.reasonCodeNone') : undefined} required>
        <Select value={reasonCode} disabled={!model.cancelReasons || model.cancelReasons.length === 0} onChange={(event) => setReasonCode(event.target.value)} aria-label={t('closeLines.reasonCode')}>
          <option value="">{t('closeLines.pickReasonCode')}</option>
          {(model.cancelReasons ?? []).map((entry) => (
            <option key={entry.code} value={entry.code}>
              {locale === 'it' ? entry.labelIt : entry.labelEn}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('closeLines.reason')} hint={t('closeLines.reasonHint')}>
        <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={1000} />
      </Field>
      <p className="fw-so-hint">{t('closeLines.reversal')}</p>
    </Frame>
  )
}

export function ReopenLinesDialog({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const closedOnes = closedLines(order)
  const [chosen, setChosen] = useState<string[]>(model.draft?.lineIds ?? closedOnes.map((line) => line.id))
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  const held = model.busy ? t('held.busy') : chosen.length === 0 ? t('reopen.held.none') : reason.trim() === '' ? t('reopen.held.reason') : null
  return (
    <Frame title={t('reopen.title', { number: order.number })} held={held} go={() => actions?.onReopenLines?.(chosen.length === closedOnes.length ? [] : chosen, reason.trim())} goLabel={model.busy ? t('common.working') : t('reopen.go', { count: chosen.length })} onClose={close(actions)} problem={<DialogProblem model={model} />}>
      <p className="fw-so-hint">{t('reopen.body')}</p>
      <fieldset className="fw-so-choices">
        <legend className="fw-so-legend">{t('reopen.lines')}</legend>
        {closedOnes.map((line) => {
          const names = namesOf({ lineId: line.id, styleId: line.styleId, colourwayId: line.colourwayId }, order, null)
          return (
            <Checkbox
              key={line.id}
              checked={chosen.includes(line.id)}
              onChange={(event) => setChosen((current) => (event.target.checked ? [...current, line.id] : current.filter((id) => id !== line.id)))}
              label={
                <span className="fw-so-stack-tight">
                  <span>{t('reopen.line', { line: line.seq, style: names.style, colour: names.colour, count: line.closedShort?.quantity ?? 0 })}</span>
                  <span className="fw-so-hint">
                    {line.closedShort?.at ? t('reopen.closedOn', { date: formatDate(line.closedShort.at, { locale }) }) : ''} {line.closedShort?.reason ?? ''}
                  </span>
                </span>
              }
            />
          )
        })}
      </fieldset>
      <Field label={t('reopen.reason')}>
        <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={1000} />
      </Field>
    </Frame>
  )
}

// ---- Cancel order -----------------------------------------------------------------------------------------------------

function ImpactList({ title, items, order, model, tone }: { title: string; items: ImpactItem[]; order: Order; model: OrderRecordModel; tone: 'danger' | 'info' | 'neutral' }) {
  const t = useT('orders')
  const locale = useLocale()
  if (items.length === 0) return null
  const check = model.cancelCheck?.value ?? null
  return (
    <section className="fw-so-impact" aria-label={title}>
      <h3 className="fw-so-h3">{title}</h3>
      <ul className="fw-so-list">
        {items.map((item, index) => {
          const words = impactWords(item, check)
          const links = item.refs.filter((ref) => IMPACT_LINKED.has(ref.type) && ref.number)
          return (
            <li key={`${item.code}-${index}`}>
              <span className="fw-so-inline">
                {tone === 'danger' && <Pill tone="danger">{t('cancel.blocks')}</Pill>}
                <span>{t(words.key, words.params)}</span>
                {model.can.price && item.amount !== null && item.amount !== undefined && <strong>{money(item.amount, order.currency, locale)}</strong>}
              </span>
              {links.length > 0 && (
                <span className="fw-so-inline">
                  <span className="fw-so-hint">{t('cancel.open')}</span>
                  {links.map((ref) => (
                    <Link key={ref.id} className="fw-so-link" href={`${model.prefix}${recordAddress({ type: ref.type, id: ref.id, label: ref.number ?? '', companyId: order.companyId }, OFFICE_PAGES)}`}>
                      {ref.number}
                    </Link>
                  ))}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function CancelDialog({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  const [typed, setTyped] = useState(model.draft?.typed ?? '')
  const part = model.cancelCheck
  const check = part?.value ?? null
  const confirmHeld = cancelConfirmHeld({ check, reason, typed, number: order.number })
  const held = model.busy ? t('held.busy') : confirmHeld ? t(confirmHeld.key, confirmHeld.params) : null
  let body: ReactNode
  if (!part || (!check && !part.problem)) {
    body = (
      <p className="fw-so-hint" role="status">
        <Spinner size={14} /> {t('cancel.reading')}
      </p>
    )
  } else if (!check) {
    body = (
      <Banner
        tone="danger"
        title={t('cancel.failed', { problem: t(part.problem ?? 'problem.read.internal') })}
        action={
          <Button size="sm" onClick={() => actions?.onRetryPart?.('cancelCheck')}>
            {t('common.retry')}
          </Button>
        }
      />
    )
  } else {
    const nothing = check.impact.touches.length === 0 && check.impact.leavesBehind.length === 0 && check.impact.blocks.length === 0
    body = (
      <>
        {!check.impact.cancellable && <Banner tone="danger" title={t('cancel.blocked')} />}
        <ImpactList title={t('cancel.stopsTitle')} items={check.impact.blocks} order={order} model={model} tone="danger" />
        <ImpactList title={t('cancel.changesTitle')} items={check.impact.touches} order={order} model={model} tone="info" />
        <ImpactList title={t('cancel.leavesTitle')} items={check.impact.leavesBehind} order={order} model={model} tone="neutral" />
        {nothing && <p className="fw-so-hint">{t('cancel.nothing')}</p>}
        {check.impact.cancellable && (
          <>
            <Field label={t('cancel.reason')} hint={t('cancel.reasonHint')}>
              <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={1000} />
            </Field>
            {/* The DS ConfirmPhraseField (B-W2b-18): the number as written, its state in the person's language. */}
            <ConfirmPhraseField phrase={order.number} value={typed} onChange={setTyped} />
          </>
        )}
        <p className="fw-so-hint">{t('cancel.reversal')}</p>
      </>
    )
  }
  return (
    <Frame title={t('cancel.title', { number: order.number })} held={held} go={() => actions?.onCancelOrder?.(reason.trim(), typed.trim())} goLabel={model.busy ? t('common.working') : t('cancel.go')} onClose={close(actions)} problem={<DialogProblem model={model} />} tone="danger" size="lg" closeLabel={t('cancel.keep')}>
      {body}
    </Frame>
  )
}

// ---- Copy as new quote -----------------------------------------------------------------------------------------------------

export function CopyQuoteDialog({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const copied = model.copied
  const done = copied ? (
    <div className="fw-so-done" role="status">
      <CheckCircle2 size={20} className="fw-so-ico is-ok" aria-hidden />
      <span className="fw-so-stack-tight">
        <span>{t('copy.done', { number: copied.quote.number ?? '—' })}</span>
        {copied.dropped.length > 0 && <span>{t('copy.dropped', { count: copied.dropped.length })}</span>}
        {model.can.viewQuotes && (
          <Link className="fw-so-link" href={`${model.prefix}/sales/quotes/${copied.quote.id}`}>
            {t('copy.open', { number: copied.quote.number ?? '—' })}
          </Link>
        )}
      </span>
    </div>
  ) : undefined
  return (
    <Frame title={t('copy.title', { number: order.number })} held={model.busy ? t('held.busy') : null} go={() => actions?.onCopyAsQuote?.()} goLabel={model.busy ? t('common.working') : t('copy.go')} onClose={close(actions)} problem={<DialogProblem model={model} />} done={done}>
      <p className="fw-so-hint">{t('copy.body', { customer: order.party?.legalName ?? '—' })}</p>
      <ul className="fw-so-list">
        <li>{t('copy.prices')}</li>
        <li>{t('copy.left')}</li>
        <li>{t('copy.orderStays')}</li>
      </ul>
    </Frame>
  )
}

// ---- The Changes tab: before → after (VersionCompare, composed) ----------------------------------------------------------

export function CompareDialog({ order, amendmentId, model, actions }: { order: Order; amendmentId: string; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const amendment = model.amendments?.value?.amendments.find((entry) => entry.id === amendmentId) ?? null
  if (!amendment) return null
  const rows: CompareRow[] =
    amendment.before && amendment.after
      ? compareRows(amendment.before, amendment.after)
      : amendment.diff.lines.map((line) => ({ lineId: line.lineId, seq: line.seq, styleId: line.styleId, colourwayId: line.colourwayId, change: line.change, sizes: line.sizes, piecesBefore: line.piecesBefore, piecesAfter: line.piecesAfter, priceBefore: null, priceAfter: null, netBefore: null, netAfter: null }))
  const withMoney = model.can.price && !!amendment.before
  const columns = [t('changes.col.line'), t('changes.col.change'), t('changes.col.before'), t('changes.col.after'), ...(withMoney ? [t('changes.col.price'), t('changes.col.net')] : [])]
  const table = rows.map((row) => {
    const name = changeLabel(row, order, model.changeStyles)
    const before = row.sizes.filter((size) => size.before > 0).map((size) => `${size.size}: ${size.before}`).join(' · ')
    const after = row.sizes.filter((size) => size.after > 0).map((size) => `${size.size}: ${size.after}`).join(' · ')
    return {
      id: row.lineId,
      cells: [
        name.what ? t('changes.lineWhat', { line: name.line, what: name.what }) : t('changes.line', { line: name.line }),
        row.change ? (
          <Tag key="c" tone={row.change === 'REMOVED' ? 'danger' : row.change === 'ADDED' ? 'info' : 'warning'}>
            {t(`changes.kind.${row.change}`)}
          </Tag>
        ) : (
          <span key="c" className="fw-so-hint">
            {t('changes.kind.same')}
          </span>
        ),
        before || '—',
        after || '—',
        ...(withMoney
          ? [
              row.priceBefore === row.priceAfter ? unitPrice(row.priceAfter, order.currency, locale) : `${unitPrice(row.priceBefore, order.currency, locale)} → ${unitPrice(row.priceAfter, order.currency, locale)}`,
              `${money(row.netBefore, order.currency, locale)} → ${money(row.netAfter, order.currency, locale)}`,
            ]
          : []),
      ],
    }
  })
  const change = moneyChange(amendment.diff)
  return (
    <Frame
      title={t('compare.title', { revision: amendment.revision, number: order.number })}
      held={null}
      go={close(actions)}
      goLabel={t('common.done')}
      onClose={close(actions)}
      problem={null}
      size="xl"
      done={
        <div className="fw-so-stack">
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('changes.madeBy'), value: t('changes.byAt', { name: amendment.createdBy ?? t('changes.someone'), date: formatDate(amendment.createdAt, { locale }) }) },
              { label: t('changes.reason'), value: amendment.reason },
              ...(change ? [{ label: t('changes.money'), value: `${money(change.before, order.currency, locale)} → ${money(change.after, order.currency, locale)}` }] : []),
              { label: t('changes.reacceptance'), value: t(`changes.reaccept.${amendment.reacceptance}`) },
            ]}
          />
          <SummaryTable label={t('compare.tableLabel')} columns={columns} rows={table} density="roomy" stackOnPhone />
          {!withMoney && model.can.price && <p className="fw-so-hint">{t('compare.noSnapshot')}</p>}
        </div>
      }
    >
      {null}
    </Frame>
  )
}
