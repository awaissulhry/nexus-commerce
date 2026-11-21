'use client'

import Link from 'next/link'
import { Lock, Reply, ShieldCheck } from 'lucide-react'
import { Tag, ToolbarButton } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../../lib/records/record-links'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { OFFICE_PAGES } from '../../../../../../shell/nav/office-nav'
import { newNcrAddress } from '../../../../../quality/_shared/model'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame'
import type { Order } from '../../../api'
import { dayInstant, readOnlyOnPage } from '../../../model'
import { orderWaitingOf, readOf, say } from '../../overview/model'
import { stripDoorsOf, whereStripsOf, type StripDoorsInput } from '../../overview/where'
import { finalChecksOf, ncrsOf, qualityVerdictOf, waitingAnswersOf } from '../../production/problems'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { DiscussDoor, ShowInThreadDoor } from '../Discuss'
import { CREDIT_NS, StripRow } from '../overview/StripRow'
import { PartFailed, PartReading, Quiet, Section } from './Kit'

const NCR_NS = 'ncr'

/**
 * F-PT-301 / F-PT-302 (order PRODUCTION tab, 10-design §6; plan D2 / L9) — "Problems & holds" (#holds): one line of answer ("1 thing
 * stops this order · 2 questions wait for an answer · Final check passed"), then
 *   What stops it    the SAME strips and doors as Overview's "Where it is now" (StripRow, whereStripsOf, stripDoorsOf — a hold door the
 *                    reader may not use is not drawn, on both tabs); the office's hold notes under them (office only)
 *   Needs an answer  the order's open issues from the ONE issues list (orders.view — B31): what kind, who asked, the excerpt, the due
 *                    day and "late", how far it escalated, who answers; Reply in the thread (a customer's report) / Open the note
 *   Quality          the final checks, the verdict first, each its own inspection (B28) with its defects; the NCRs with severity,
 *                    stage and title — withheld in one line of words without the quality rights
 * A failed read says so with its own Try again (B27); the rest of the tab still draws.
 */
export function ProblemsSection(props: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <WithMessages namespaces={[...CREDIT_NS, NCR_NS]}>
      <Problems {...props} />
    </WithMessages>
  )
}

function Problems({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const n = useT(NCR_NS)
  const locale = useLocale()
  const frame = useRecordFrame()
  const state = model.production ?? null
  const read = readOf(state)
  const approval = model.depth?.approval?.value ?? null
  const waiting = orderWaitingOf(order, model, locale)
  const { strips, holds } = whereStripsOf(order, read, approval, waiting)
  const readOnly = readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold })
  const input: StripDoorsInput = { prefix: model.prefix, order, can: model.can, readOnly, busy: model.busy, approval, depthCan: model.depth?.can ?? null, work: read?.work?.workOrders ?? [], acts: model.workOrderActs?.can ?? null, credit: model.credit ?? null }
  const doors = strips.map((strip) => ({ strip, doors: stripDoorsOf(strip, input) }))
  const notes = read?.headline?.holdNotes ?? null
  const asks = model.asks ?? null
  const answers = asks?.value ? waitingAnswersOf(asks.value.issues, model.today) : null
  const withheld = new Set(read?.withheld ?? [])
  const finals = finalChecksOf(read?.quality?.final)
  const verdict = qualityVerdictOf(finals)
  const ncrs = ncrsOf(read?.quality?.ncrs)
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const now = Date.now()
  // F-PT-302: Raise a nonconformance… — Quality's own New NCR, from the newest final check (its right; hidden without it, L9).
  const raiseFrom = !readOnly && model.can.raiseNcr ? (finals ?? []).find((check) => check.inspectionId)?.inspectionId ?? null : null
  // fx5 (L7): Discuss only for who may write in the order's thread (threads.post) — Read-only gets no door that leads nowhere.
  const mayDiscuss = model.people?.mayNote !== false
  const ncrHref = (id: string, number: string) => `${model.prefix}${recordAddress({ type: 'Nonconformance', id, label: number, companyId: order.companyId }, OFFICE_PAGES)}`

  const answer = [
    strips.length > 0 ? t('productionTab.problems.stops', { count: strips.length }) : t('productionTab.problems.stopsNothing'),
    answers ? (answers.length > 0 ? t('productionTab.now.questions', { count: answers.length }) : t('productionTab.problems.noQuestions')) : null,
    verdict ? t(`productionTab.problems.final.${verdict}`) : finals ? t('productionTab.problems.final.none') : null,
  ]
    .filter(Boolean)
    .join(' · ')

  let body
  if (!state || state.status === 'loading') body = <PartReading rows={2} height={34} />
  else if (state.status === 'failed') body = <PartFailed part={t('productionTab.problems.title')} problem={state.problem} onRetry={() => actions?.onRetryProduction?.()} />
  else
    body = (
      <div className="fw-pt-ph">
        <div className="fw-pt-now-blk">
          <h3 className="fw-pt-h3">{t('productionTab.problems.stopsTitle')}</h3>
          {strips.length === 0 && holds === 'read' ? <Quiet>{t('productionTab.problems.stopsNothing')}</Quiet> : null}
          {strips.length > 0 || holds !== 'read' ? (
            <ul className="fw-so-strips" aria-label={t('productionTab.problems.stopsTitle')}>
              {doors.map(({ strip, doors: shown }) => (
                <StripRow key={strip.key} strip={strip} doors={shown} order={order} model={model} actions={actions} now={now} />
              ))}
            </ul>
          ) : null}
          {holds === 'reading' ? <PartReading rows={1} height={22} /> : null}
          {holds === 'failed' ? <PartFailed part={t('productionTab.problems.stopsTitle')} problem="problem.read.unavailable" onRetry={() => actions?.onRetryProduction?.()} /> : null}
          {notes && notes.length > 0 ? (
            <ul className="fw-pt-units" aria-label={t('production.quality.notes')}>
              {notes.map((note) => (
                <li key={`${note.workOrderId}-${note.since}`} className="fw-pt-mark" id={`about-ProductionHold-${note.workOrderId}`}>
                  <span className="fw-pt-inline">
                    <Lock size={12} aria-hidden /> <b>{note.number}</b> {note.note}
                    {/* F-SA-266: a hold is discussed in an office note only. */}
                    {mayDiscuss ? <DiscussDoor order={order} part={t('discuss.hold', { number: note.number })} target={{ kind: 'WorkOrder', id: note.workOrderId }} officeOnly align="end" /> : null}
                  </span>
                  <span className="fw-pt-sub">{t('production.quality.officeOnly', { date: formatDate(note.since, { locale }) })}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {asks ? <h3 className="fw-pt-h3">{t('productionTab.problems.answersTitle')}</h3> : null}
          {asks && !asks.value && !asks.problem ? <PartReading rows={1} height={22} /> : null}
          {asks?.problem ? <PartFailed part={t('productionTab.partAsks')} problem={asks.problem} onRetry={() => actions?.onRetryAsks?.()} /> : null}
          {answers && answers.length === 0 ? <Quiet>{t('productionTab.problems.noQuestions')}</Quiet> : null}
          {answers && answers.length > 0 ? (
            <ul className="fw-pt-moves">
              {answers.map((entry) => (
                <li key={entry.id} className="fw-pt-move" id={`about-ProductionIssue-${entry.id}`} tabIndex={-1}>
                  <span className="fw-pt-inline">
                    <b>{say(entry.kindWords, locale)}</b>
                    {entry.workOrder ? <span className="fw-pt-sub">{t('productionTab.now.about', { number: entry.workOrder })}</span> : null}
                  </span>
                  <span className="fw-pt-sub">{[entry.by ? t('productionTab.now.askedBy', { by: entry.by, at: formatDateTime(entry.at, { locale }) }) : t('productionTab.now.asked', { at: formatDateTime(entry.at, { locale }) }), t('productionTab.now.answerBy', { due: day(entry.due) })].join(' · ')}</span>
                  {entry.late || entry.escalated ? (
                    <span className="fw-pt-inline">
                      {entry.late ? <Tag tone="danger">{t('productionTab.problems.late')}</Tag> : null}
                      {entry.escalated ? <span className="fw-pt-sub">{say(entry.escalated, locale)}</span> : null}
                    </span>
                  ) : null}
                  {entry.excerpt ? (
                    <span className="fw-pt-sub">
                      <q>{entry.excerpt}</q>
                    </span>
                  ) : null}
                  {entry.answers ? <span className="fw-pt-sub">{t(`productionTab.problems.answers.${entry.answers}`)}</span> : null}
                  <span className="fw-pt-move-doors">
                    {/* A customer's report is answered in the thread (a reply); an office ask is opened at its note (office only). */}
                    {entry.source === 'BRAND' && model.people?.mayNote && frame?.compose ? <ToolbarButton icon={<Reply size={14} aria-hidden />} label={t('productionTab.problems.reply')} onClick={() => frame.compose?.({ messageId: entry.messageId, mode: 'reply' })} /> : null}
                    {entry.messageId ? <ShowInThreadDoor order={order} at={entry.at} align="end" /> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="fw-pt-now-blk fw-pt-ph-q">
          <h3 className="fw-pt-h3">
            <ShieldCheck size={14} aria-hidden /> {t('productionTab.problems.qualityTitle')}
          </h3>
          {finals === null && ncrs === null && (withheld.has('quality.final') || withheld.has('quality.ncrs')) ? <Quiet>{t('productionTab.problems.qualityWithheld')}</Quiet> : null}
          {finals && finals.length === 0 && (!ncrs || ncrs.length === 0) ? <Quiet>{t('productionTab.problems.noFinal')}</Quiet> : null}
          {finals && finals.length > 0 ? (
            <ul className="fw-pt-units">
              {finals.map((check) => (
                // fx5 #14: one row shape — the check's words at the left, its Discuss door always at the row's end (never wrapped under).
                <li key={check.key} className="fw-pt-qrow">
                  <span className="fw-pt-qrow-b">
                    <span className="fw-pt-inline">
                      <Tag tone={check.status === 'PASSED' ? 'success' : check.status === 'FAILED' ? 'danger' : 'neutral'}>{t(`production.quality.finalState.${check.status}`, { date: check.on ? day(check.on) : '—' })}</Tag>
                      <span>{t('production.quality.finalRow', { number: check.number ?? '—', checked: check.checked })}</span>
                    </span>
                    {check.inspected !== null && check.lot !== null ? <span className="fw-pt-sub">{t('productionTab.problems.inspected', { inspected: check.inspected, lot: check.lot })}</span> : null}
                    {check.defects ? <span className="fw-pt-sub">{t('productionTab.problems.defects', check.defects)}</span> : null}
                    {check.shared ? <span className="fw-pt-sub">{t('productionTab.problems.sharedCheck')}</span> : null}
                  </span>
                  {/* F-SA-266: quality is discussed in an office note only. */}
                  {mayDiscuss ? <DiscussDoor order={order} part={t('discuss.quality', { number: check.number ?? '—' })} target={{ kind: 'WorkOrder', id: check.workOrderId }} officeOnly align="end" /> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {ncrs === null && finals !== null && withheld.has('quality.ncrs') ? <Quiet>{t('productionTab.problems.qualityWithheld')}</Quiet> : null}
          {ncrs && ncrs.length > 0 ? (
            <ul className="fw-pt-units">
              {ncrs.map((ncr) => (
                <li key={ncr.id}>
                  <span className="fw-pt-inline">
                    <Link className="fw-pt-link" href={ncrHref(ncr.id, ncr.number)}>
                      {ncr.number}
                    </Link>
                    <Tag tone={ncr.severity === 'CRITICAL' ? 'danger' : ncr.severity === 'MAJOR' ? 'warning' : 'neutral'}>{n(`severity.${ncr.severity}`)}</Tag>
                    <span className="fw-pt-sub">{n(`stage.${ncr.stage}`)}</span>
                  </span>
                  {ncr.title ? <span className="fw-pt-sub">{ncr.title}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {raiseFrom ? (
            <Link className="fw-pt-link" href={newNcrAddress(model.prefix, 'Inspection', raiseFrom)}>
              {t('productionTab.problems.raiseNcr')}
            </Link>
          ) : null}
        </div>
      </div>
    )
  return (
    <Section id="holds" title={t('productionTab.problems.title')} answer={answer} info={<p>{t('productionTab.problems.infoBody')}</p>}>
      {body}
    </Section>
  )
}
