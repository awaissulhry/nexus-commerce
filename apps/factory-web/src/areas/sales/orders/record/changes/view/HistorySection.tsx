'use client'

import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { GitCompare, Undo2 } from 'lucide-react'
import { Button, SegmentedControl, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { useProductionWords } from '../../../../../../lib/production/words'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { tabHref, writeSearch } from '../../../../../_shared/record-frame/address'
import { said } from '../../../../../home/approvals/requests/model'
import type { WorkOrderChange } from '../../../../../home/approvals/work-order-changes/api'
import { money } from '../../../../quotes/model'
import type { Order } from '../../../api'
import type { Change } from '../../../depth/api'
import { NAMESPACE as DEPTH } from '../../../depth/model'
import type { DiscussPart } from '../../dock/discuss'
import { autoReasonOf } from '../../lines-draft' // F-OL-03: the automatic reasons in words
import { readOf } from '../../overview/model'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { revisionToAskOf } from '../../revised-order-ask'
import { toldParts, type ToldChange } from '../../told'
import { PartFailed, PartReading, Section } from '../../view/production/Kit' // F-OC-101 (L6): the Production kit, in place
import { dayTimeOf } from '../layout'
import { askWordsOf } from '../model'
import { changeRowsOf, chipCountsOf, HISTORY_CHIPS, HISTORY_OPEN, historyChipOf, restoreOf, rowsForChip, type ChangeRow, type HistoryChip, type RevisionFacts } from '../history'
import { RowMenu } from './RowMenu'
import './changes.css'

/**
 * F-OC-301 … 304 (order CHANGES tab, 10-design §5; 13-backend B-OC-009 … 014; 18-lead-settles L5, L12) — section 3, What changed
 * (#history): every change since confirmation, ONE row per change (history.ts), newest first — what changed in words, why, the
 * customer's answer with its day, what it did on the floor (its work-order changes, the Told line), money only with the price grain,
 * who and when — with at most three doors: [Before → after] [Restore as before… | Ask {customer}…] [⋯]. Chips are filters with
 * counts, kept in the address (`?history=`); a row may be in two. The newest five open, the rest behind "Show N earlier changes". A
 * part that could not be read says so and the rest is shown — never "No changes". Each row's address is `#change-<id>`.
 */
export function HistorySection(props: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <WithMessages namespaces={[DEPTH]}>
      <History {...props} />
    </WithMessages>
  )
}

function History({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const params = useSearchParams()
  const search = params?.toString() ?? ''
  const [all, setAll] = useState(false)
  const chip = historyChipOf(params?.get('history'))
  const title = t('changesTab.history.title')
  const changes = model.depth?.changes ?? null
  const amendments = model.amendments ?? null
  // The ONE changes read when the page has it; a design case or an older page draws the amendments read.
  const source = changes ?? amendments
  const reading = !!source && source.value === null && source.problem === null
  const failed = !!source && source.value === null && source.problem !== null
  const rows = changeRowsOf({
    requests: model.requests?.value ?? [],
    changes: changes ? (changes.value?.changes ?? []) : null,
    amendments: changes ? null : (amendments?.value?.amendments ?? null),
    confirmation: model.depth?.confirmation?.value ?? null,
    workOrderChanges: model.orderChanges?.list?.value ?? null,
    told: model.told?.value?.changes ?? [],
  })
  const counts = chipCountsOf(rows)
  const shown = rowsForChip(rows, chip)
  const open = all ? shown : shown.slice(0, HISTORY_OPEN)
  // The chip is kept in the address (`?history=`): a link to a filtered list, the same list after a reload.
  const choose = (next: HistoryChip) => {
    const query = new URLSearchParams(search)
    if (next === 'all') query.delete('history')
    else query.set('history', next)
    const text = query.toString()
    // F-OC fx4: THE history writer of the record pages (a replace; the App Router's search follows it) — never the router's hook: a
    // page drawn outside the App Router (a design case, a test) has none, and it threw there.
    writeSearch(`${window.location.pathname}${text ? `?${text}` : ''}#history`)
  }
  // The promise's own history lives in Production › Dates & plan — one pointer, only when the date moved (F-PT-204).
  const moves = readOf(model.production)?.headline?.promise.moves ?? 0
  const pointer =
    moves > 0 ? (
      <p className="fw-pt-quiet fw-oc-foot">
        <span>{t('changesTab.history.dates', { count: moves })}</span>
        <span aria-hidden>·</span>
        <TabLink className="fw-pt-link" href={`${tabHref(`${model.prefix}/sales/orders/${order.id}`, 'production', search)}#promise-moves`}>
          {t('productionTab.history.pointer')}
        </TabLink>
      </p>
    ) : null
  const info = (
    <>
      <p>{t('changesTab.history.info')}</p>
    </>
  )
  const answer = reading ? t('changesTab.history.reading') : rows.length > 0 ? t('changesTab.history.count', { count: rows.length }) : failed ? null : t(order.status === 'CANCELLED' || order.status === 'CLOSED' ? 'changesTab.history.emptyFinal' : 'changesTab.history.empty')
  return (
    <Section id="history" title={title} answer={answer} info={info}>
      {failed && <PartFailed part={t('changesTab.history.revisionsPart')} problem={source!.problem!} onRetry={() => (changes ? actions?.depth?.onRetry?.('changes') : actions?.onRetryPart?.('amendments'))} />}
      {reading && rows.length === 0 ? <PartReading rows={3} height={44} /> : null}
      {rows.length > 0 && (
        <>
          {/* fx6 (walk 11): compact chips at the left, never a full-width bar. */}
          <div className="fw-oc-chips">
          <SegmentedControl size="sm" ariaLabel={t('changesTab.history.chipsLabel')} value={chip} onChange={(value) => choose(value as HistoryChip)} options={HISTORY_CHIPS.map((value) => ({ value, label: `${t(`changesTab.history.chips.${value}`)} ${counts[value]}` }))} wrap />
          </div>
          {shown.length === 0 ? (
            <p className="fw-pt-quiet">{t(`changesTab.history.emptyChip.${chip}`)}</p>
          ) : (
            <ol className="fw-oc-hl">
              {open.map((row) => (
                <ChangeRowView key={`${row.kind}:${row.id}`} row={row} order={order} model={model} actions={actions} />
              ))}
            </ol>
          )}
          {!all && shown.length > HISTORY_OPEN && (
            <Button size="sm" variant="quiet" onClick={() => setAll(true)}>
              {t('changesTab.history.earlier', { count: shown.length - HISTORY_OPEN })}
            </Button>
          )}
        </>
      )}
      {pointer}
    </Section>
  )
}

// ---- F-OC-302: one row per change -------------------------------------------------------------------------------------------------
function ChangeRowView({ row, order, model, actions }: { row: ChangeRow; order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const w = useProductionWords()
  const locale = useLocale()
  const asOf = readOf(model.production)?.asOf ?? null
  const when = (at: string) => {
    const day = dayTimeOf(at, asOf, locale)
    return day.today ? t('changesTab.today', { time: day.time }) : t('changesTab.dayTime', { date: day.date, time: day.time })
  }
  const customer = order.party?.legalName ?? ''
  const tags: { key: string; tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; words: string }[] = []
  const lines: { key: string; text: ReactNode; quote?: boolean }[] = []
  const meta: string[] = []
  let headline = ''
  let discuss: DiscussPart | null = null
  let told: ToldChange | null = null
  let revision: RevisionFacts | null = null
  let workOrderChanges: readonly WorkOrderChange[] = []
  switch (row.kind) {
    case 'request': {
      const request = row.request
      headline = t('changesTab.history.request', { what: askWordsOf(request, { kind: w.t(`parts.request.kind.${request.kind}`), say: t, day: w.day }) })
      tags.push({ key: 'status', tone: request.status === 'ACCEPTED' ? 'success' : request.status === 'REFUSED' ? 'danger' : request.status === 'COUNTERED' ? 'info' : 'neutral', words: w.t(`parts.request.office.${request.status}`) })
      if (request.note) lines.push({ key: 'note', text: `“${request.note}”`, quote: true })
      if (row.revision) lines.push({ key: 'doneAs', text: t('changesTab.history.doneAs', { revision: row.revision.revision }) })
      if (request.answer) lines.push({ key: 'answer', text: t('changesTab.history.ourAnswer', { answer: request.answer }) })
      // fx6 (walk 10): who is who — "Asked by …" and "Answered by …", never two bare names.
      meta.push(request.askedBy ? t('changesTab.row.askedBy', { name: request.askedBy, when: when(request.askedAt) }) : when(request.askedAt))
      if (request.answeredAt) meta.push(request.answeredBy ? t('changesTab.history.answeredBy', { name: request.answeredBy, when: when(request.answeredAt) }) : when(request.answeredAt))
      discuss = { part: t('discuss.request', { kind: w.t(`parts.request.kind.${request.kind}`) }), target: { kind: 'OrderChangeRequest', id: request.id } }
      told = row.told
      revision = row.revision
      workOrderChanges = row.workOrderChanges
      break
    }
    case 'revision': {
      revision = row.revision
      headline = revision.change?.restores ? t('changesTab.history.restoreRow', { restores: revision.change.restores, revision: revision.revision }) : t('changesTab.history.revision', { revision: revision.revision })
      meta.push([revision.by, when(revision.at)].filter(Boolean).join(' · '))
      discuss = { part: t('discuss.revision', { revision: revision.revision }), target: null }
      told = row.told
      workOrderChanges = row.workOrderChanges
      break
    }
    case 'workOrderChange': {
      const change = row.change
      const number = change.workOrder?.number ?? change.madeWorkOrder?.number ?? t('wocs.newDraft')
      headline = `${number} · ${change.words.cells}`
      tags.push({ key: 'status', tone: change.status === 'APPLIED' ? 'success' : 'neutral', words: said(change.words.status, locale) })
      lines.push(...workOrderLinesOf(change, t))
      meta.push([change.decidedBy?.name ?? null, when(change.decidedAt ?? change.proposedAt)].filter(Boolean).join(' · '))
      // A work order is discussed in an office note only (its number never reaches a customer).
      discuss = change.workOrder ? { part: change.workOrder.number, target: { kind: 'WorkOrder', id: change.workOrder.id }, officeOnly: true } : null
      told = row.told
      break
    }
    case 'confirmationMade':
      headline = t('changesTab.history.made', { version: row.version })
      meta.push([row.by, when(row.at)].filter(Boolean).join(' · '))
      break
    case 'confirmationSent':
      headline = t('changesTab.history.sent', { version: row.version })
      tags.push({ key: 'sent', tone: 'success', words: t('changesTab.history.tag.sent') })
      if (row.to.length > 0) lines.push({ key: 'to', text: t('changesTab.history.sentTo', { to: row.to.join(', ') }) })
      meta.push([row.by, when(row.at)].filter(Boolean).join(' · '))
      break
    default: {
      // The kinds the told read's speaker names: never a person; a work order this reader does not reach is "a work order".
      const speaker = row.told.speaker
      const what = speaker?.hold?.workOrder?.number ?? t('changesTab.history.aWorkOrder')
      headline = row.kind === 'styleReleased' ? (speaker?.changeOrder?.number ? t('changesTab.history.styleReleased', { number: speaker.changeOrder.number }) : t('changesTab.history.styleReleasedAny')) : row.kind === 'paused' || row.kind === 'pauseLifted' ? t(`changesTab.history.${row.kind}`, { what }) : t(`changesTab.history.${row.kind}`)
      tags.push({ key: 'kind', tone: row.kind === 'styleReleased' ? 'info' : 'neutral', words: t(`changesTab.history.tag.${row.kind}`) })
      meta.push(when(row.at))
      told = row.told
    }
  }
  // A revision's story: what changed, why, our approval, the customer's answer, restored by, money (the price grain only).
  if (revision) {
    const change = revision.change
    if (row.kind === 'revision') {
      // fx6 (walk 6, 10-design §5): WHAT changed, in words — each line with its style, colour and sizes, the PO, the requested date.
      const amendment = (model.amendments?.value?.amendments ?? []).find((entry) => entry.id === revision!.id) ?? null
      const what = whatOf(revision.lines, revision.header.length > 0 ? revision.header : (amendment?.diff.header ?? []), order, t, (value) => (value === null ? t('changesTab.compare.none') : /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(`${value}T12:00:00Z`, { locale }) : value))
      what.forEach((text, index) => lines.push({ key: `what-${index}`, text }))
      if (what.length === 0) lines.push({ key: 'what', text: t('changes.headerOnly') })
      lines.push({ key: 'why', text: whyOf(revision, t) })
    }
    if (change) {
      tags.push(...outcomeTagsOf(change, model.can.price, t))
      const answered = change.customer.answeredAt
      if (answered && (change.customer.decision === 'ACCEPTED' || change.customer.decision === 'REFUSED')) {
        lines.push({ key: 'customer', text: [t(change.customer.decision === 'ACCEPTED' ? 'changesTab.history.saidYes' : 'changesTab.history.saidNo', { when: when(answered) }), change.customer.by ?? null, change.customer.via ? t(`changesTab.history.via.${change.customer.via}`) : null].filter(Boolean).join(' · ') })
        if (change.customer.answer) lines.push({ key: 'words', text: `“${change.customer.answer}”`, quote: true })
      }
      if (change.yes.state === 'TURNED_DOWN' && change.yes.reason) lines.push({ key: 'yesWhy', text: d('changeYes.because', { reason: change.yes.reason }) })
      if (change.restoredBy) lines.push({ key: 'restoredBy', text: t('changesTab.history.restoredBy', { revision: change.restoredBy }) })
      if (model.can.price) {
        const parts = [change.changeAmount !== undefined && change.changeAmount !== 0 ? `${change.changeAmount > 0 ? '+' : '−'}${money(Math.abs(change.changeAmount), order.currency, locale)}` : null, change.feeAmount ? d('pricedList.fee', { amount: money(change.feeAmount, order.currency, locale) }) : null, change.deposit && change.deposit.amount !== undefined ? d('pricedList.deposit', { amount: money(change.deposit.amount, order.currency, locale), kind: d(`depositKind.${change.deposit.kind}`), status: d(`depositStatus.${change.deposit.status}`) }) : null].filter(Boolean)
        if (parts.length > 0) lines.push({ key: 'money', text: t('changesTab.history.money', { words: parts.join(' · ') }) })
      }
    }
  }
  // What it did on the floor: its work-order changes (office only), each in one line.
  for (const change of workOrderChanges) lines.push({ key: `woc-${change.id}`, text: `${change.workOrder?.number ?? change.madeWorkOrder?.number ?? t('wocs.newDraft')} · ${said(change.words.status, locale)} — ${change.words.cells}` })
  // The Told line — who was TOLD (the conversation, the bell, the floor, the workshop), never who read it; it opens Who was told.
  const toldLineOf = (change: ToldChange) => (
    <span className="fw-so-told">
      <Button size="xs" variant="link" inline wrap onClick={() => actions?.onWhoWasTold?.(change.messageId)} title={t('told.open')}>
        {toldParts(change)
          .map((one) => t(one.key, one.params))
          .join(' · ')}
      </Button>
    </span>
  )
  const toldLine = told ? toldLineOf(told) : null
  // A work-order change applied on a draft work order: the floor is told once it is released — said, never a Told line.
  const draftUntold = row.kind === 'workOrderChange' && !told && row.change.status === 'APPLIED' && row.change.workOrder?.status === 'DRAFT' ? t('changesTab.history.woDraft', { number: row.change.workOrder.number }) : null
  // The doors (≤ 3): Before → after · Restore as before… (or Ask {customer}…, L5) · ⋯.
  const revised = revision?.change ?? null
  const latestToAsk = model.can.manage && model.can.askCustomer ? revisionToAskOf(model.depth?.changes?.value) : null
  const ask = revision && latestToAsk && latestToAsk.amendmentId === revision.id ? latestToAsk : null
  const restore = !ask && model.can.manage ? restoreOf(revised, locale) : null
  return (
    <li className="fw-oc-hrow" id={`change-${row.id}`} tabIndex={-1}>
      <div className="fw-oc-hrow-a">
        <span className="fw-pt-inline">
          <b>{headline}</b>
          {tags.map((tag) => (
            <Tag key={tag.key} tone={tag.tone}>
              {tag.words}
            </Tag>
          ))}
        </span>
        {lines.map((line) => (
          <span key={line.key} className={line.quote ? 'fw-pt-sub fw-oc-q' : 'fw-pt-sub'}>
            {line.text}
          </span>
        ))}
      </div>
      <div className="fw-oc-hrow-b">
        {meta.filter(Boolean).map((text, index) => (
          <span key={index} className="fw-pt-sub">
            {text}
          </span>
        ))}
        {toldLine}
        {draftUntold && <span className="fw-pt-sub">{draftUntold}</span>}
      </div>
      {/* fx6 (walk 11): the doors under the meta (2 columns), their own column from 1400 (3 columns) — never stranded far right. */}
      <div className="fw-oc-hrow-doors">
          {revision && (
            <Button size="sm" variant="quiet" aria-label={t('changesTab.history.compareOf', { revision: revision.revision })} onClick={() => actions?.onDialog?.({ kind: 'compare', amendmentId: revision!.id })}>
              <GitCompare size={13} aria-hidden /> {t('changesTab.history.compare')}
            </Button>
          )}
          {ask && (
            <Button size="sm" heldReason={model.depth?.busy ? t('held.busy') : null} onClick={() => actions?.depth?.onDialog?.({ kind: 'askRevision', amendmentId: ask.amendmentId, revision: ask.revision })}>
              {t('changesTab.agreement.ask', { customer })}
            </Button>
          )}
          {restore && revised && (
            <Button size="sm" heldReason={!restore.may ? (restore.why ?? d('held.putBackNot')) : model.busy || model.depth?.busy ? t('held.busy') : null} aria-label={t('changesTab.history.restoreOf', { revision: revised.revision })} onClick={() => actions?.depth?.onDialog?.({ kind: 'putBack', changeId: revised.id, reason: '' })}>
              <Undo2 size={13} aria-hidden /> {t('changesTab.history.restore')}
            </Button>
          )}
          <RowMenu order={order} prefix={model.prefix} label={t('changesTab.menu.label')} anchor={`change-${row.id}`} discuss={model.people?.mayNote !== false ? discuss : null /* fx6 (walk 1): Discuss only with threads.post */} at={row.at} toldMessageId={told?.messageId ?? null} onWhoWasTold={actions?.onWhoWasTold} />
      </div>
    </li>
  )
}

type Translate = (key: string, params?: Record<string, string | number>) => string

/** fx6 (walk 6): a revision's changes in words — at most three lines, then "+N more lines"; the order's own fields after them. */
type DiffLine = { readonly change: string; readonly lineId: string; readonly seq: number; readonly sizes: readonly { readonly size: string; readonly before: number; readonly after: number }[]; readonly piecesBefore: number; readonly piecesAfter: number }
type HeaderMove = { readonly field: 'customerRef' | 'requestedDate'; readonly before: string | null; readonly after: string | null }
export function whatOf(lines: readonly DiffLine[], header: readonly HeaderMove[], order: Pick<Order, 'lines'>, t: Translate, day: (value: string | null) => string): string[] {
  const out = lines.slice(0, 3).map((line) => {
    const own = order.lines.find((entry) => entry.id === line.lineId)
    const head = line.change === 'ADDED' ? t('changesTab.history.lineAdded', { line: line.seq }) : line.change === 'REMOVED' ? t('changesTab.history.lineRemoved', { line: line.seq }) : t('changesTab.history.lineOf', { line: line.seq })
    const sizes = line.sizes.map((size) => t('changesTab.request.size', { size: size.size, from: size.before, to: size.after }))
    const pieces = sizes.length === 0 && line.piecesBefore !== line.piecesAfter ? [t('changes.piecesMoved', { before: line.piecesBefore, after: line.piecesAfter })] : []
    return [head, ...(own?.style?.code ? [own.style.code] : []), ...(own?.colourway?.name ? [own.colourway.name] : []), ...sizes, ...pieces].join(' · ')
  })
  if (lines.length > 3) out.push(t('changesTab.history.moreLines', { count: lines.length - 3 }))
  for (const entry of header) out.push(t('changesTab.history.headerMove', { field: t(`amend.field.${entry.field}`), from: entry.field === 'requestedDate' ? day(entry.before) : (entry.before ?? t('changesTab.compare.none')), to: entry.field === 'requestedDate' ? day(entry.after) : (entry.after ?? t('changesTab.compare.none')) }))
  return out
}

/** Why a revision was made, in words: the server's own words said in the reader's ("Done for the customer's request"), else as typed. */
function whyOf(revision: RevisionFacts, t: Translate): string {
  if (revision.reasonCode === 'REQUEST') return t('changesTab.history.whyRequest')
  if (revision.reasonCode === 'PUT_BACK') return revision.change?.restores ? t('changesTab.history.whyPutBack', { revision: revision.change.restores }) : t('changesTab.history.whyPutBackAny')
  const automatic = autoReasonOf(revision.reason)
  if (automatic) return t(automatic.key)
  return revision.reason.trim() ? t('changesTab.history.why', { reason: revision.reason.trim() }) : t('changesTab.history.noWhy')
}

/** A revision's outcome in tags: our approval of an old change, the customer's answer, a priced change for a reader without prices. */
function outcomeTagsOf(change: Change, price: boolean, t: Translate): { key: string; tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; words: string }[] {
  const tags: { key: string; tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; words: string }[] = []
  if (change.yes.state === 'WAITING') tags.push({ key: 'yes', tone: 'warning', words: t('changesTab.history.tag.yesWaiting') })
  if (change.yes.state === 'TURNED_DOWN') tags.push({ key: 'yes', tone: 'danger', words: t('changesTab.history.tag.yesRefused') })
  const decision = change.customer.decision
  const tone = decision === 'ACCEPTED' ? 'success' : decision === 'REFUSED' || decision === 'EXPIRED' ? 'danger' : decision === 'NOT_NEEDED' || decision === 'WITHDRAWN' ? 'neutral' : 'warning'
  tags.push({ key: 'customer', tone, words: t(`changesTab.history.tag.${decision}`) })
  if (change.priced && !price) tags.push({ key: 'priced', tone: 'info', words: t('changesTab.history.tag.priced') })
  return tags
}

/** A decided work-order change's own lines: why it was left as is, the new work order it made. */
function workOrderLinesOf(change: WorkOrderChange, t: Translate): { key: string; text: ReactNode; quote?: boolean }[] {
  return [
    ...(change.status === 'DECLINED' && change.decisionNote ? [{ key: 'note', text: `“${change.decisionNote}”`, quote: true }] : []),
    ...(change.madeWorkOrder ? [{ key: 'made', text: t('changesTab.history.woMade', { number: change.madeWorkOrder.number }) }] : []),
  ]
}
