'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { Check, CheckCheck, Footprints, Wrench, X } from 'lucide-react'
import { Banner, KeyValue, Timeline, type TimelineStep } from '@nexus/ui/components'
import { DetailModal } from '@nexus/ui/patterns'
import { Button, Kbd } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useDsLabels } from '../../../../lib/i18n/ds-labels'
import { useLocale } from '../../../../lib/i18n/provider'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import type { CallRecord } from '../api'
import { ackHeld, callTitleParts, closeHeld, comeHeld, jobHeld, offersJob, personPhrase, RESOLUTIONS, type StepState } from '../model'
import type { CallsActions, CallsModel } from './CallsView'
import { Duration, say, StatusPill, TypeCell, useCallsT, WaitingTag } from './parts'

const STEP_TONE = { SENT: 'neutral', SEEN: 'info', ON_THE_WAY: 'info', SOLVED: 'success', CANCELLED: 'neutral' } as const

/**
 * The call's detail (design production.calls/pop:cl-item "Machine call · Line 2 · Station 4", a centred DetailModal opened
 * by a row or `?open=<call>`): the timeline of the call (sent, seen, on the way, solved or cancelled — when, and who where
 * the API names them), where it came from, the team called and who is coming, the station's words, the times (response,
 * on the way, resolve: the call's), how it was solved, what it led to (a maintenance job, an NCR, a task: its link), and
 * the waiting booked to off-standard time (MES-148). Keys: A acknowledge, D done (solved, with a resolution code), J / K
 * the previous and next call of the list. A machine call opens a maintenance job (plant.jobs) linked as its outcome. Each
 * step held with its reason. The caller is named only here, and only where the site's floor records name workers.
 */
export function CallDetail({ model, actions, ids }: { model: CallsModel; actions?: CallsActions; ids: readonly string[] }) {
  const t = useCallsT()
  const ds = useDsLabels()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const detail = model.detail!
  const loaded = detail.loaded
  const record = loaded.status === 'ready' ? loaded.value : null
  const call = record?.call ?? null
  const state: StepState = { canAnswer: model.can.answer && (record?.canAnswer ?? true), busy: model.busy }
  const ack = call ? ackHeld(call, state) : 'held.loading'
  const come = call ? comeHeld(call, state) : 'held.loading'
  const close = call ? closeHeld(call, state) : 'held.loading'
  const job = record && call ? jobHeld(call, record.canNameOutcome, model.can, model.busy) : 'held.loading'
  const navIds = ids.includes(detail.id) ? ids : [detail.id]

  const latest = useRef({ actions, ack, close, call })
  latest.current = { actions, ack, close, call }
  const quiet = model.dialog !== null
  useEffect(() => {
    if (quiet) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="menu"]') || target.isContentEditable)) return
      const now = latest.current
      const key = event.key.toLowerCase()
      if (key === 'a' && !now.ack && now.call) {
        event.preventDefault()
        now.actions?.onAcknowledge?.([now.call.id])
      } else if (key === 'd' && !now.close && now.call) {
        event.preventDefault()
        now.actions?.onSolveOpen?.([now.call.id])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [quiet])

  const parts = call ? callTitleParts(call, locale) : null
  const title = parts ? (parts.line ? t('detail.title', parts as { type: string; line: string; station: string }) : t('detail.titleNoLine', { type: parts.type, station: parts.station })) : t('detail.titleLoading')

  return (
    <DetailModal
      open
      onClose={() => actions?.onAddress?.({ open: null })}
      title={title}
      subtitle={call ? `${call.station.name}${call.line ? ` · ${call.line.name}` : ''}` : undefined}
      meta={
        call ? (
          <>
            <StatusPill status={call.status} />
            {call.waitingBooked && <WaitingTag />}
          </>
        ) : undefined
      }
      nav={{ ids: navIds, current: detail.id, onGo: (id) => actions?.onAddress?.({ open: id }), noun: t('detail.noun') }}
      loading={loaded.status === 'loading'}
      error={loaded.status === 'error' ? t(loaded.problem) : loaded.status === 'notFound' ? t('detail.notFound') : undefined}
      onRetry={() => actions?.onRetryDetail?.()}
      labels={ds.detail}
      actions={
        call ? (
          <>
            {offersJob(call) && (
              <Button size="sm" heldReason={job ? t(job) : null} onClick={() => actions?.onJobOpen?.(call.id)}>
                <Wrench size={14} aria-hidden /> {t('detail.job')}
              </Button>
            )}
            <Button size="sm" variant="danger-outline" heldReason={close ? t(close) : null} onClick={() => actions?.onDialog?.({ kind: 'cancel', id: call.id, reason: '', problem: null })}>
              <X size={14} aria-hidden /> {t('detail.cancel')}
            </Button>
            <Button size="sm" heldReason={come ? t(come) : null} onClick={() => actions?.onComing?.(call.id)}>
              <Footprints size={14} aria-hidden /> {t('detail.coming')}
            </Button>
            <Button size="sm" heldReason={ack ? t(ack) : null} onClick={() => actions?.onAcknowledge?.([call.id])} aria-keyshortcuts="a">
              <Check size={14} aria-hidden /> {t('detail.ack')} <Kbd>A</Kbd>
            </Button>
            <Button size="sm" variant="primary" heldReason={close ? t(close) : null} onClick={() => actions?.onSolveOpen?.([call.id])} aria-keyshortcuts="d">
              <CheckCheck size={14} aria-hidden /> {t('detail.done')} <Kbd>D</Kbd>
            </Button>
          </>
        ) : undefined
      }
    >
      {record && call && <CallDetailBody model={model} call={call} place={place} />}
    </DetailModal>
  )
}

export function CallDetailBody({ model, call, place }: { model: CallsModel; call: CallRecord; place: { locale: ReturnType<typeof useLocale>; timeZone: string } }) {
  const t = useCallsT()
  const ds = useDsLabels()
  const who = (person: CallRecord['caller']) => say(t, personPhrase(person, true))
  const steps: TimelineStep[] = call.timeline.map((entry, index) => ({
    key: `${entry.step}:${index}`,
    label: t(`step.${entry.step}`),
    tone: STEP_TONE[entry.step],
    at: entry.at,
    detail:
      entry.step === 'SENT'
        ? call.caller
          ? t('step.sentBy', { who: who(call.caller), station: call.station.code })
          : t('step.sentFrom', { station: call.station.code })
        : entry.by
          ? who(entry.by)
          : undefined,
  }))
  if (call.open) {
    const done = new Set(call.timeline.map((entry) => entry.step))
    if (!done.has('SEEN')) steps.push({ key: 'SEEN:next', label: t('step.SEEN'), tone: 'neutral', at: null })
    if (!done.has('ON_THE_WAY')) steps.push({ key: 'ON_THE_WAY:next', label: t('step.ON_THE_WAY'), tone: 'neutral', at: null })
    steps.push({ key: 'SOLVED:next', label: t('step.SOLVED'), tone: 'neutral', at: null })
  }
  const resolution = call.resolutionCode ? ((RESOLUTIONS as readonly string[]).includes(call.resolutionCode) ? t(`resolution.${call.resolutionCode}`) : call.resolutionCode) : null
  const outcomeHref = call.outcome ? `${model.prefix}${recordAddress({ type: call.outcome.recordType, id: call.outcome.recordId }, OFFICE_PAGES)}` : null

  return (
    <div className="fw-cl-detail">
      {call.waitingBooked && (
        <Banner tone="info" title={t('waiting.tag')}>
          {call.waiting ? t('waiting.banner', { code: call.waiting.code, status: t(`waiting.status.${call.waiting.status}`) }) : t('waiting.hint')}
        </Banner>
      )}
      <div className="fw-cl-detail-grid">
        <section className="fw-cl-section" aria-label={t('detail.timeline')}>
          <h3 className="fw-cl-h3">{t('detail.timeline')}</h3>
          <Timeline steps={steps} label={t('detail.timeline')} labels={ds.timeline} now={model.now} />
        </section>
        <section className="fw-cl-section" aria-label={t('detail.facts')}>
          <h3 className="fw-cl-h3">{t('detail.facts')}</h3>
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: t('detail.type'), value: <TypeCell type={call.type} /> },
              { label: t('detail.where'), value: call.line ? t('detail.whereValue', { station: call.station.code, line: call.line.code }) : call.station.code, hint: call.station.name },
              {
                label: t('detail.work'),
                value: call.workOrder ? (
                  model.can.workOrders ? (
                    <Link className="fw-cl-link" href={`${model.prefix}/production/work-orders/${call.workOrder.id}`}>
                      {call.workOrder.number}
                    </Link>
                  ) : (
                    call.workOrder.number
                  )
                ) : (
                  '—'
                ),
                hint: call.bundle ? t('detail.bundle', { code: call.bundle.code }) : undefined,
              },
              { label: t('detail.team'), value: call.responderTeam ? call.responderTeam.name : t('routing.leaders') },
              ...(call.coming ? [{ label: t('detail.comingLabel'), value: t(`coming.${call.coming.step}`, { who: who(call.coming.by), team: call.coming.team?.name ?? t('routing.leaders') }) }] : []),
              ...(call.caller ? [{ label: t('detail.caller'), value: who(call.caller), hint: t('detail.callerHint') }] : []),
              { label: t('detail.sent'), value: formatDateTime(call.sentAt, place) },
              { label: t('detail.response'), value: <Duration seconds={call.times.responseSeconds} empty={call.open ? t('list.notYet') : '—'} /> },
              { label: t('detail.onTheWay'), value: <Duration seconds={call.times.onTheWaySeconds} empty={call.open ? t('list.notYet') : '—'} /> },
              { label: t('detail.resolve'), value: <Duration seconds={call.times.resolveSeconds} empty={call.open ? t('list.notYet') : '—'} /> },
              ...(call.note ? [{ label: t('detail.note'), value: call.note }] : []),
              ...(resolution || call.resolutionNote ? [{ label: t('detail.resolution'), value: resolution ?? '—', hint: call.resolutionNote ?? undefined }] : []),
              {
                label: t('detail.outcome'),
                value: call.outcome && outcomeHref ? (
                  <Link className="fw-cl-link" href={outcomeHref}>
                    {t(`outcome.${call.outcome.recordType}`)}
                  </Link>
                ) : (
                  t('detail.noOutcome')
                ),
              },
            ]}
          />
        </section>
      </div>
      <p className="fw-cl-hint">{t('detail.legal')}</p>
    </div>
  )
}
