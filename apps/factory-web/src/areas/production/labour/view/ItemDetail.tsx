'use client'

import { useEffect, useRef } from 'react'
import { Check, Lock, LockOpen, UserRound, X } from 'lucide-react'
import { Banner, KeyValue, SummaryTable, type TimelineStep } from '@nexus/ui/components'
import { Button, Kbd, Pill, Tag } from '@nexus/ui/primitives'
import { DetailModal, Timeline } from '../../../../lib/i18n/ds-parts'
import { formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import type { AroundScan, BlockRecord, Change, CorrectionRequest, DayRecord, Dispute, LabourRecord } from '../api'
import { approveHeld, blockerPhrase, closeDayHeld, codedPhrase, codeWords, dayOpenHeld, dayTarget, minutesText, reopenDayHeld, rejectHeld, type ItemRecord, type OpenItem } from '../model'
import type { LabourActions, LabourModel } from './LabourView'
import { ChangeList, dayText, DayPill, KindPill, say, useLabourT, useValueWords, WhoNote, type Words } from './parts'

const STATUS_TONE: Readonly<Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'>> = { PENDING: 'warning', OPEN: 'warning', APPROVED: 'success', UPHELD: 'success', REJECTED: 'danger', REFUSED: 'danger', WITHDRAWN: 'neutral' }

/** The title of an item: its kind's name, the line and the day where they are known. */
function titleOf(t: Words, record: ItemRecord | null, open: OpenItem | null, day: (value: string | null) => string): string {
  if (!record) return open ? t(`detail.title.${open.kind}`) : t('detail.loading')
  if (record.kind === 'LINE_DAY') return t('detail.dayTitle', { line: record.day.line.code, day: day(record.day.workDate) })
  return t(`detail.title.${record.kind}`)
}

/**
 * One queue item (design pop:lb-item, a centred DetailModal opened by a row or `?open=<KIND>:<id>`): a correction request (the
 * original entry, unchanged; the proposed correcting entry; why; the scans around it for context: "Approve adds a CORRECTION
 * row; nothing is overwritten"), a dispute (the person's words, the record it is about, the answer), an off-standard block
 * (its code, times and why it is unusual) or a line day (what holds it, its history). A approve, R reject, J / K the previous
 * and next item; after a decision the next one opens. "Open this person's day" opens the Daily sheet where the record names
 * someone. Every step held with its reason. Names come only from this one record, where the API served them.
 */
export function ItemDetail({ model, actions, open, ids }: { model: LabourModel; actions?: LabourActions; open: OpenItem | null; ids: readonly string[] }) {
  const t = useLabourT()
  const locale = useLocale()
  const detail = model.detail!
  const loaded = detail.loaded
  const record = loaded.status === 'ready' ? loaded.value : null
  const state = { can: model.can, busy: model.busy }
  const approve = approveHeld(record, state)
  const reject = rejectHeld(record, state)
  const navIds = ids.includes(detail.key) ? ids : [detail.key]
  const dayWords = (value: string | null) => dayText(value, locale, model.timeZone)

  const latest = useRef({ actions, approve, reject })
  latest.current = { actions, approve, reject }
  const quiet = model.dialog !== null
  useEffect(() => {
    if (quiet) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="menu"]') || target.isContentEditable)) return
      const now = latest.current
      const key = event.key.toLowerCase()
      if (key === 'a' && !now.approve) {
        event.preventDefault()
        now.actions?.onApproveOpen?.()
      } else if (key === 'r' && !now.reject) {
        event.preventDefault()
        now.actions?.onRejectOpen?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [quiet])

  const person = record ? personOf(record) : null
  const dayHeld = person ? dayOpenHeld(person.facts, model.can) : null
  const isDay = record?.kind === 'LINE_DAY'

  return (
    <DetailModal
      open
      onClose={() => actions?.onAddress?.({ open: null })}
      title={titleOf(t, record, open, dayWords)}
      subtitle={record ? subtitleOf(t, record, dayWords) : undefined}
      meta={open ? <KindPill kind={open.kind} /> : undefined}
      nav={{ ids: navIds, current: detail.key, onGo: (id) => actions?.onAddress?.({ open: id }), noun: t('detail.noun') }}
      loading={loaded.status === 'loading'}
      error={loaded.status === 'error' ? t(loaded.problem) : loaded.status === 'notFound' ? t('detail.notFound') : undefined}
      onRetry={() => actions?.onRetryDetail?.()}
      actions={
        record ? (
          <>
            {person && (
              <Button size="sm" heldReason={dayHeld ? t(dayHeld) : null} onClick={() => person.employeeId && actions?.onOpenDay?.({ employeeId: person.employeeId, name: person.name }, person.workDate)}>
                <UserRound size={14} aria-hidden /> {t('detail.openDay')}
              </Button>
            )}
            {isDay ? (
              <DayActions day={record.day} model={model} actions={actions} />
            ) : (
              <>
                <Button size="sm" variant="danger-outline" heldReason={reject ? t(reject) : null} onClick={() => actions?.onRejectOpen?.()} aria-keyshortcuts="r">
                  <X size={14} aria-hidden /> {t('verb.reject')} <Kbd>R</Kbd>
                </Button>
                <Button size="sm" variant="primary" heldReason={approve ? t(approve) : null} onClick={() => actions?.onApproveOpen?.()} aria-keyshortcuts="a">
                  <Check size={14} aria-hidden /> {t(`verb.${record.kind}`)} <Kbd>A</Kbd>
                </Button>
              </>
            )}
          </>
        ) : undefined
      }
    >
      {model.notice?.tone === 'danger' && <Banner tone="danger" title={say(t, model.notice.words)} />}
      {record && <ItemDetailBody model={model} record={record} />}
    </DetailModal>
  )
}

function DayActions({ day, model, actions }: { day: DayRecord; model: LabourModel; actions?: LabourActions }) {
  const t = useLabourT()
  const closed = day.state === 'CLOSED'
  if (closed) {
    const held = reopenDayHeld(day, model.can, model.busy)
    return (
      <Button size="sm" heldReason={held ? say(t, held) : !day.canReopen ? t('held.noReopen') : null} onClick={() => actions?.onDialog?.({ kind: 'reopen', day: dayTarget(day), reason: '', problem: null })}>
        <LockOpen size={14} aria-hidden /> {t('days.reopen')}
      </Button>
    )
  }
  const held = closeDayHeld(day, model.can, model.busy)
  return (
    <Button size="sm" variant="primary" heldReason={held ? say(t, held) : null} onClick={() => actions?.onApproveOpen?.()} aria-keyshortcuts="a">
      <Lock size={14} aria-hidden /> {t('days.close')} <Kbd>A</Kbd>
    </Button>
  )
}

function subtitleOf(t: Words, record: ItemRecord, day: (value: string | null) => string): string | undefined {
  if (record.kind === 'CORRECTION' && record.record) return t('detail.recordOf', { bundle: record.record.bundle.code, operation: `${record.record.operation.seq} ${record.record.operation.name}` })
  if (record.kind === 'DISPUTE') return [record.dispute.line?.code, day(record.dispute.workDate)].filter(Boolean).join(' · ')
  if (record.kind === 'OFF_STANDARD' && record.block) return [record.block.line?.code, record.block.station?.code, day(record.block.workDate)].filter(Boolean).join(' · ')
  if (record.kind === 'LINE_DAY') return record.day.line.name
  return undefined
}

/** Whose day a record opens: only where the API named them (the legal gate is on). */
function personOf(record: ItemRecord): { employeeId: string | null; name: string | null; workDate: string; facts: { workerHidden: boolean; employeeId: string | null; worker: { name: string } | null } } | null {
  const source = record.kind === 'CORRECTION' ? record.record : record.kind === 'DISPUTE' ? record.dispute : null
  if (!source) return null
  return { employeeId: source.employeeId, name: source.worker?.name ?? null, workDate: source.workDate, facts: source }
}

export function ItemDetailBody({ model, record }: { model: LabourModel; record: ItemRecord }) {
  if (record.kind === 'CORRECTION') return <CorrectionBody model={model} request={record.request} record={record.record} around={record.around} />
  if (record.kind === 'DISPUTE') return <DisputeBody model={model} dispute={record.dispute} />
  if (record.kind === 'OFF_STANDARD') return <BlockBody model={model} block={record.block} />
  return <DayBody model={model} day={record.day} />
}

const countsOf = (counts: { good: number; scrap: number; rework: number }) => [
  { field: 'good', value: counts.good },
  { field: 'scrap', value: counts.scrap },
  { field: 'rework', value: counts.rework },
]

function CorrectionBody({ model, request, record, around }: { model: LabourModel; request: CorrectionRequest | null; record: LabourRecord | null; around: readonly AroundScan[] | null }) {
  const t = useLabourT()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const words = useValueWords(model.codes, model.timeZone)
  const original = request?.recorded ? { good: request.recorded.goodQuantity, scrap: request.recorded.scrapQuantity, rework: request.recorded.reworkQuantity } : (record?.counts ?? null)
  const changes: Change[] = request && original ? [{ field: 'good', from: original.good, to: request.goodQuantity }, { field: 'scrap', from: original.scrap, to: request.scrapQuantity }, { field: 'rework', from: original.rework, to: request.reworkQuantity }].filter((change) => change.from !== change.to) : []
  return (
    <div className="fw-lb-detail">
      {record && <WhoNote record={record} />}
      {record?.enteredByLead && <Tag tone="info">{t('detail.enteredByLead')}</Tag>}
      {!model.can.correct && <Banner tone="info" title={t('held.noCorrect')} />}
      <div className="fw-lb-detail-grid">
        <section className="fw-lb-section" aria-label={t('detail.original')}>
          <h3 className="fw-lb-h3">{t('detail.original')}</h3>
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              ...(original ? countsOf(original).map((entry) => ({ label: t(`field.${entry.field}`), value: entry.value })) : []),
              { label: t('detail.when'), value: record ? formatDateTime(record.at, place) : request?.recorded ? formatDateTime(request.recorded.serverTime, place) : '—' },
              { label: t('detail.where'), value: record?.station ? `${record.station.code}${record.line ? ` · ${record.line.code}` : ''}` : (record?.line?.code ?? '—') },
              ...(record ? [{ label: t('detail.earned'), value: minutesText(record.earnedMinutes, locale), hint: t('detail.earnedHint') }] : []),
            ]}
          />
        </section>
        <section className="fw-lb-section" aria-label={t('detail.proposed')}>
          <h3 className="fw-lb-h3">{t('detail.proposed')}</h3>
          {changes.length > 0 ? <ChangeList changes={changes} words={words} /> : <p className="fw-lb-hint">{t('detail.noChange')}</p>}
          {request && (
            <KeyValue
              labelCase="sentence"
              items={[
                { label: t('detail.reason'), value: request.reason },
                { label: t('detail.status'), value: <Pill tone={STATUS_TONE[request.status] ?? 'neutral'}>{t(`requestStatus.${request.status}`)}</Pill>, hint: request.decisionNote ?? undefined },
                ...(request.askedAt ? [{ label: t('detail.askedAt'), value: request.askedAt.code }] : []),
              ]}
            />
          )}
          <p className="fw-lb-hint">{t('detail.appendOnly')}</p>
        </section>
      </div>
      {record && record.steps.length > 0 && (
        <section className="fw-lb-section" aria-label={t('detail.steps')}>
          <h3 className="fw-lb-h3">{t('detail.steps')}</h3>
          <SummaryTable
            label={t('detail.steps')}
            columns={[t('detail.when'), t('detail.step'), t('field.good'), t('field.scrap'), t('field.rework'), t('detail.reason')]}
            stackOnPhone
            rows={record.steps.map((step) => ({ id: step.scanId, cells: [formatDateTime(step.at, place), t(`scanKind.${step.kind}`), String(step.counts.good), String(step.counts.scrap), String(step.counts.rework), step.reason ?? '—'] }))}
          />
        </section>
      )}
      <section className="fw-lb-section" aria-label={t('detail.around')}>
        <h3 className="fw-lb-h3">{t('detail.around')}</h3>
        {around === null ? (
          <p className="fw-lb-hint">{t('detail.aroundHeld')}</p>
        ) : (
          <SummaryTable
            label={t('detail.around')}
            columns={[t('detail.when'), t('detail.operation'), t('detail.step'), t('field.good'), t('field.scrap'), t('field.rework'), t('detail.station')]}
            stackOnPhone
            rows={around.map((scan) => ({
              id: scan.id,
              cells: [formatTime(scan.serverTime, place), `${scan.operation.seq} ${scan.operation.name}`, scan.voidedById ? t('detail.voided', { kind: scanKindWord(t, scan.kind) }) : scanKindWord(t, scan.kind), String(scan.goodQuantity), String(scan.scrapQuantity), String(scan.reworkQuantity), scan.station?.code ?? '—'],
            }))}
          />
        )}
      </section>
    </div>
  )
}

const SCAN_KINDS = ['REPORT', 'CORRECTION', 'UNDO']
const scanKindWord = (t: Words, kind: string): string => t(SCAN_KINDS.includes(kind) ? `scanKind.${kind}` : 'scanKind.other')

function DisputeBody({ model, dispute }: { model: LabourModel; dispute: Dispute }) {
  const t = useLabourT()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const words = useValueWords(model.codes, model.timeZone)
  const record = dispute.record
  const code = codeWords(record?.code ?? null, model.codes, locale)
  return (
    <div className="fw-lb-detail">
      <WhoNote record={dispute} />
      <div className="fw-lb-detail-grid">
        <section className="fw-lb-section" aria-label={t('detail.disputeAbout')}>
          <h3 className="fw-lb-h3">{t('detail.disputeAbout')}</h3>
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: t('detail.reason'), value: t(dispute.reason ? `dispute.reason.${dispute.reason}` : 'dispute.noReason') },
              { label: t('detail.raised'), value: formatDateTime(dispute.raisedAt, place), hint: t(`dispute.on.${dispute.raisedOn}`) },
              ...(dispute.words ? [{ label: t('detail.theirWords'), value: dispute.words }] : []),
              { label: t('detail.status'), value: <Pill tone={STATUS_TONE[dispute.status] ?? 'neutral'}>{t(`disputeStatus.${dispute.status}`)}</Pill> },
            ]}
          />
        </section>
        <section className="fw-lb-section" aria-label={t('detail.theRecord')}>
          <h3 className="fw-lb-h3">{t('detail.theRecord')}</h3>
          {record ? (
            <KeyValue
              columns={2}
              labelCase="sentence"
              items={[
                ...(dispute.recordType === 'OffStandardEntry'
                  ? [
                      { label: t('detail.code'), value: code ?? '—' },
                      { label: t('detail.minutes'), value: record.minutes ?? '—' },
                      { label: t('detail.from'), value: record.startedAt ? formatDateTime(record.startedAt, place) : '—' },
                      { label: t('detail.to'), value: record.endedAt ? formatDateTime(record.endedAt, place) : '—' },
                    ]
                  : [{ label: t('detail.entry'), value: record.label }, ...(record.counts ? countsOf(record.counts).map((entry) => ({ label: t(`field.${entry.field}`), value: entry.value })) : [])]),
              ]}
            />
          ) : (
            <p className="fw-lb-hint">{t('detail.recordGone')}</p>
          )}
        </section>
      </div>
      {dispute.answer && (
        <section className="fw-lb-section" aria-label={t('detail.answer')}>
          <h3 className="fw-lb-h3">{t('detail.answer')}</h3>
          <p className="fw-lb-text">{dispute.answer}</p>
          <p className="fw-lb-hint">{dispute.answeredBy && dispute.answeredAt ? t('detail.answeredBy', { name: dispute.answeredBy.name, when: formatDateTime(dispute.answeredAt, place) }) : ''}</p>
        </section>
      )}
      {dispute.edits.length > 0 && (
        <section className="fw-lb-section" aria-label={t('detail.corrected')}>
          <h3 className="fw-lb-h3">{t('detail.corrected')}</h3>
          {dispute.edits.map((edit) => (
            <ChangeList key={edit.id} changes={edit.changes} words={words} />
          ))}
        </section>
      )}
      <p className="fw-lb-hint">{t('detail.rights')}</p>
    </div>
  )
}

function BlockBody({ model, block }: { model: LabourModel; block: BlockRecord | null }) {
  const t = useLabourT()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  if (!block) return <Banner tone="info" title={t('detail.blockHeld')} />
  const code = codeWords(block.code.code, model.codes, locale) ?? block.code.code
  return (
    <div className="fw-lb-detail">
      <WhoNote record={block} />
      {block.unusual.length > 0 && (
        <Banner tone="warning" title={t('detail.unusual')}>
          {block.unusual.map((reason) => t(`unusual.${reason}`)).join(' · ')}
        </Banner>
      )}
      <KeyValue
        columns={2}
        labelCase="sentence"
        items={[
          { label: t('detail.code'), value: code, hint: block.code.code },
          { label: t('detail.minutes'), value: block.minutes },
          { label: t('detail.from'), value: formatDateTime(block.startedAt, place) },
          { label: t('detail.to'), value: block.endedAt ? formatDateTime(block.endedAt, place) : t('detail.running') },
          { label: t('detail.where'), value: [block.station?.code, block.line?.code].filter(Boolean).join(' · ') || '—' },
          { label: t('detail.source'), value: t(`source.${block.source}`) },
          { label: t('detail.status'), value: <Pill tone={STATUS_TONE[block.status] ?? 'neutral'}>{t(`blockStatus.${block.status}`)}</Pill>, hint: block.rejectReason ?? undefined },
          ...(block.note ? [{ label: t('detail.note'), value: block.note }] : []),
        ]}
      />
      {block.own && <p className="fw-lb-hint">{t('held.ownBlock')}</p>}
    </div>
  )
}

function DayBody({ model, day }: { model: LabourModel; day: DayRecord }) {
  const t = useLabourT()
  const steps: TimelineStep[] = day.history.map((entry) => ({
    key: entry.id,
    label: t(`dayChange.${entry.change}`),
    tone: entry.change === 'CLOSED' ? 'success' : 'warning',
    at: entry.at,
    detail: [entry.by?.name, entry.reason].filter(Boolean).join(' · ') || undefined,
  }))
  return (
    <div className="fw-lb-detail">
      <div className="fw-lb-detail-grid">
        <section className="fw-lb-section" aria-label={t('detail.dayFacts')}>
          <h3 className="fw-lb-h3">{t('detail.dayFacts')}</h3>
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: t('col.status'), value: <DayPill state={day.state} /> },
              { label: t('col.coded'), value: say(t, codedPhrase(day)) },
              { label: t('col.anomalies'), value: day.anomalies },
              { label: t('col.records'), value: day.records },
              ...(day.note ? [{ label: t('detail.note'), value: day.note }] : []),
              ...(day.reopenReason ? [{ label: t('detail.reopened'), value: day.reopenReason, hint: day.reopenedBy?.name }] : []),
            ]}
          />
        </section>
        <section className="fw-lb-section" aria-label={t('detail.holds')}>
          <h3 className="fw-lb-h3">{t('detail.holds')}</h3>
          {day.blockers.length === 0 ? (
            <p className="fw-lb-hint">{t(day.state === 'CLOSED' ? 'detail.dayClosed' : 'detail.nothingHolds')}</p>
          ) : (
            <ul className="fw-lb-list">
              {day.blockers.map((blocker) => (
                <li key={blocker.kind}>{say(t, blockerPhrase(blocker))}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {steps.length > 0 && (
        <section className="fw-lb-section" aria-label={t('detail.history')}>
          <h3 className="fw-lb-h3">{t('detail.history')}</h3>
          <Timeline steps={steps} label={t('detail.history')} now={model.now} />
        </section>
      )}
      <p className="fw-lb-hint">{t('close.body')}</p>
    </div>
  )
}

