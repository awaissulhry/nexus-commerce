'use client'

import { useEffect, useState, type ReactNode } from 'react'
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
import { dialogLinesOf } from '../record-model' // F-OO-124: one line's row ⋯ opens with only that line ticked
import { DialogProblem, Frame } from './Dialogs'
import type { CommandDialogActions, CommandDialogModel } from './Dialogs' // F-CP-108: type only (the Cancel the Orders sheet's row mounts)
// ---- F-OP-107 (B2): Close remaining lines and Cancel say what happens to each work order, and pick the extra pieces' outcome ----
import type { ExtraOutcome } from '@nexus/factory-domain/order-apply/rules'
import type { ExtraPiecesView, WorkOrderPlan } from '../../api' // B-OP-013: the previews' `workOrders` (extra pieces + plan)
import { extraChoicesOf, followedNumbers, heldWordsOf, outcomeHeld, stripWorkOrderOf, workOrderWords } from '../../daily-model'
import { ExtraPieces } from '../../../../home/approvals/requests/view/ExtraPieces'

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

const close = (actions?: Pick<OrderRecordActions, 'onDialog'> /* F-CP-108: type only */) => () => actions?.onDialog?.(null)

// ---- F-OP-107 (B2; 10-order-page §4.2): the change's work orders and its extra pieces, before the click --------------------------

/**
 * "Applies at once — no approval", then what the preview says of each work order ("WO-0311 40 → 28 · follows now" / "… · waits for
 * production — decide on this page") and the extra pieces' picker. Not read (a design case, or the read failed): said so, and the
 * change still applies at once — its work orders follow by the same rules.
 */
function FollowPlan({ order, model, state, plan, extra, outcome, onOutcome, name }: { order: Order; model: Pick<OrderRecordModel, 'can'> /* F-CP-108: type only */; state: 'none' | 'reading' | 'failed' | 'ready'; plan: readonly WorkOrderPlan[]; extra: ExtraPiecesView | null; outcome: ExtraOutcome | null; onOutcome: (outcome: ExtraOutcome) => void; name: string }) {
  const t = useT('orders')
  const locale = useLocale()
  return (
    <section className="fw-so-stack-tight" aria-label={t('edit.workOrders')}>
      <p className="fw-so-hint">{t('edit.appliesAtOnce')}</p>
      {state === 'reading' && (
        <p className="fw-so-hint" role="status">
          <Spinner size={14} /> {t('edit.strip.reading')}
        </p>
      )}
      {state === 'failed' && <p className="fw-so-hint">{t('edit.planNotRead')}</p>}
      {state === 'ready' && plan.length > 0 && (
        <>
          <h3 className="fw-so-h3">{t('edit.workOrders')}</h3>
          <ul className="fw-so-list">
            {plan.map((entry, index) => {
              const wo = stripWorkOrderOf(entry, index)
              return <li key={wo.key}>{workOrderWords(wo, t, locale)}</li>
            })}
          </ul>
        </>
      )}
      {state === 'ready' && extra && extra.extra.length > 0 && <ExtraPieces name={name} {...extraChoicesOf(extra, order, model.can.price)} chosen={outcome} onChoose={onOutcome} />}
    </section>
  )
}

/** After the change: the work orders that followed in its command, and those that wait for production. */
function Followed({ followed }: { followed: { readonly applied: readonly { readonly number: string | null }[]; readonly waiting: readonly { readonly number: string | null }[] } }) {
  const t = useT('orders')
  return (
    <>
      {followed.applied.length > 0 && <span>{t('edit.followed.changed', { numbers: followedNumbers(followed.applied) })}</span>}
      {followed.waiting.length > 0 && <span>{t('edit.followed.waits', { numbers: followedNumbers(followed.waiting) })}</span>}
    </>
  )
}
// ---- end F-OP-107

// ---- Close remaining lines / Reopen lines ------------------------------------------------------------------------------

export function CloseLinesDialog({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const open = closableLines(order)
  const [chosen, setChosen] = useState<string[]>(() => dialogLinesOf(model.dialog, 'closeLines', open.map((entry) => entry.line.id), model.draft?.lineIds)) // F-OO-124
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  // B-W2b-16: why, as a code of the CANCEL list (the words stay beside it).
  const [reasonCode, setReasonCode] = useState(model.draft?.reasonCode ?? '')
  const locale = useLocale()
  const answer = model.closedLines
  const problem = closeChoiceProblem(order, chosen, reason, reasonCode, model.cancelReasons ?? null)
  // ---- F-OP-107: the preview of the lines chosen (asked as they change), the extra pieces' outcome ----
  const [outcome, setOutcome] = useState<ExtraOutcome | null>(null)
  const chosenKey = chosen.join(',')
  const askPreview = actions?.onClosePreview
  useEffect(() => {
    askPreview?.(chosenKey === '' ? [] : chosenKey.split(','))
    // Asked when the lines chosen change (the action's identity changes every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenKey])
  const part = model.closePreview
  const preview = part?.value ?? null
  const planState = !part ? 'none' : preview ? 'ready' : part.problem ? 'failed' : 'reading'
  const extraHeld = outcomeHeld(preview?.workOrders ?? null, outcome)
  // ---- end F-OP-107
  const held = model.busy ? t('held.busy') : problem ? t(problem.key) : extraHeld ? heldWordsOf(extraHeld, t, locale) : null
  const stillMade = inWorkOrdersOf(order, chosen)
  const pieces = open.filter((entry) => chosen.includes(entry.line.id)).reduce((sum, entry) => sum + entry.left, 0)
  const done = answer ? (
    <div className="fw-so-done" role="status">
      <CheckCircle2 size={20} className="fw-so-ico is-ok" aria-hidden />
      <span className="fw-so-stack-tight">
        <span>{t('closeLines.done', { count: answer.closed.length, pieces: answer.closed.reduce((sum, entry) => sum + entry.closedShortQuantity, 0) })}</span>
        {answer.stillInWorkOrders.length > 0 && <span>{t('closeLines.stillMade', { count: answer.stillInWorkOrders.reduce((sum, entry) => sum + entry.pieces, 0) })}</span>}
        <Followed followed={answer.workOrders} />
        <span className="fw-so-hint">{t('closeLines.reversal')}</span>
      </span>
    </div>
  ) : undefined
  return (
    <Frame title={t('closeLines.title', { number: order.number })} held={held} go={() => actions?.onCloseLines?.(chosen.length === open.length ? [] : chosen, reason.trim(), reasonCode, preview?.workOrders?.extra.length ? outcome : null)} goLabel={model.busy ? t('common.working') : t('closeLines.go', { count: chosen.length })} onClose={close(actions)} problem={<DialogProblem model={model} />} done={done}>
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
      {/* F-OP-107: what happens to each work order once the preview is read; until then (or when it is not), what work orders still make. */}
      {stillMade > 0 && planState !== 'ready' && <Banner tone="warning" title={t('closeLines.inWorkOrders', { count: stillMade })} />}
      {chosen.length > 0 && <FollowPlan order={order} model={model} state={planState} plan={preview?.workOrders?.plan ?? []} extra={preview?.workOrders ?? null} outcome={outcome} onOutcome={setOutcome} name={`fw-so-close-extra-${order.id}`} />}
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
  const [chosen, setChosen] = useState<string[]>(() => dialogLinesOf(model.dialog, 'reopenLines', closedOnes.map((line) => line.id), model.draft?.lineIds)) // F-OO-124
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

function ImpactList({ title, items, order, model, tone }: { title: string; items: ImpactItem[]; order: Order; model: Pick<OrderRecordModel, 'cancelCheck' | 'can' | 'prefix'> /* F-CP-108: type only */; tone: 'danger' | 'info' | 'neutral' }) {
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

export function CancelDialog({ order, model, actions }: { order: Order; model: CommandDialogModel; actions?: CommandDialogActions } /* F-CP-108: type only */) {
  const t = useT('orders')
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  const [typed, setTyped] = useState(model.draft?.typed ?? '')
  const part = model.cancelCheck
  const check = part?.value ?? null
  const locale = useLocale()
  const confirmHeld = cancelConfirmHeld({ check, reason, typed, number: order.number })
  // F-OP-107 (B2): the pieces already cut of it get an outcome before the cancel, when the check says it is needed.
  const [outcome, setOutcome] = useState<ExtraOutcome | null>(null)
  const extraHeld = check?.impact.cancellable ? outcomeHeld(check.workOrders, outcome) : null
  const held = model.busy ? t('held.busy') : confirmHeld ? t(confirmHeld.key, confirmHeld.params) : extraHeld ? heldWordsOf(extraHeld, t, locale) : null
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
            {/* F-OP-107: what the cancel does to each work order, the extra pieces' outcome. */}
            <FollowPlan order={order} model={model} state="ready" plan={check.workOrders?.plan ?? []} extra={check.workOrders} outcome={outcome} onOutcome={setOutcome} name={`fw-so-cancel-extra-${order.id}`} />
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
    <Frame title={t('cancel.title', { number: order.number })} held={held} go={() => actions?.onCancelOrder?.(reason.trim(), typed.trim(), check?.workOrders?.extra.length ? outcome : null)} goLabel={model.busy ? t('common.working') : t('cancel.go')} onClose={close(actions)} problem={<DialogProblem model={model} />} tone="danger" size="lg" closeLabel={t('cancel.keep')}>
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
