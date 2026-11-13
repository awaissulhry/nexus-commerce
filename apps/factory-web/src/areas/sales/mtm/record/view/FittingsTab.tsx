'use client'

import Link from 'next/link'
import { CalendarPlus, ClipboardPen, Scissors, PencilRuler } from 'lucide-react'
import { Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { ReadState, Section } from '../../../../quality/_shared/parts'
import type { FittingResult, ProfileRecord } from '../../api'
import { appointmentTone, fittingsHeld, nextOf, promiseMove, recordHref, repairHref, rightHeld, templatesHref, type Phrase } from '../../model'
import { useWords } from '../../parts'
import type { ProfileRecordActions, ProfileRecordModel } from '../view-model'
// B-W2b-371 (XF2:01): a fitting's photos on its card.
import { FittingPhotos, PhotoNotice } from '../../photos/view/OfficePhotos'
import { ExtrasMessages } from '../../photos/words'

/**
 * The rider profile's Fittings tab (design rider.fittings, SAL-054, SAL-297; B-W2b-360's API): the fittings and visits booked for
 * the rider's garment type (date, place, fitter, the invite sent, the state; each opens its panel: move, done or missed, cancel,
 * send the invite again), and what came out of them (fits / alteration needed / remade, the point changes, the alteration sent
 * back with the date moved by its time, the new revision, what comes next — in words of ours). Book a fitting · Record outcome,
 * held with why; while made-to-measure has not started for the template (GATE-MTM) the tab says so and where it is started.
 */
export function FittingsTab({ model, record, actions }: { model: ProfileRecordModel; record: ProfileRecord; actions?: ProfileRecordActions }) {
  const { t, say, when, day } = useWords()
  const offline = model.live === 'offline'
  const tab = model.fittings.items
  const bookHeld = fittingsHeld(tab, 'book', model.can, offline, record.template?.code ?? null)
  const recordHeld = fittingsHeld(tab, 'record', model.can, offline, record.template?.code ?? null)
  const head = (
    <div className="fw-mtm-head">
      <p className="fw-mtm-hint">{t('fit.intro')}</p>
      <div className="fw-mtm-actions">
        <Button size="sm" variant="secondary" heldReason={say(recordHeld)} onClick={() => actions?.onOpenOutcome?.()}>
          <ClipboardPen size={14} aria-hidden /> {t('fit.record')}
        </Button>
        <Button size="sm" variant="primary" heldReason={say(bookHeld)} onClick={() => actions?.onOpenFitting?.()}>
          <CalendarPlus size={14} aria-hidden /> {t('fit.book')}
        </Button>
      </div>
    </div>
  )
  if (model.fittings.problem || !tab)
    return (
      <div className="fw-mtm-stack">
        {head}
        <ReadState problem={model.fittings.problem} loading={!tab && !model.fittings.problem} onRetry={() => actions?.onRetry?.()} failedTitle={t('fit.failed')} />
      </div>
    )
  const results = model.lastResult && !tab.results.some((result) => result.id === model.lastResult?.id) ? [model.lastResult, ...tab.results] : tab.results.map((result) => (model.lastResult?.id === result.id ? model.lastResult : result))
  return (
    <div className="fw-mtm-stack">
      {head}
      {!tab.started && (
        <p className="fw-mtm-hint">
          {t('off.template', { template: record.template?.code ?? tab.garmentType })} {t('fit.offBody')}{' '}
          <Link className="fw-mtm-link" href={templatesHref(model.prefix)}>
            {t('off.where')}
          </Link>
        </p>
      )}
      <Section id="fit-appointments" title={t('fit.appointments')} sub={tab.nextFittingAt ? t('fit.nextAt', { when: when(tab.nextFittingAt) }) : t('fit.noNext')}>
        {tab.appointments.length === 0 ? (
          <EmptyState title={t('fit.none')} description={t('fit.noneBody')} />
        ) : (
          <SummaryTable
            label={t('fit.appointments')}
            density="roomy"
            stackOnPhone
            columns={[t('fit.col.when'), t('fit.col.kind'), t('fit.col.place'), t('fit.col.fitter'), t('fit.col.invite'), t('fit.col.status'), t('fit.col.open')]}
            widths={['22%', '12%', '18%', '16%', '12%', '10%', undefined]}
            rows={tab.appointments.map((appointment) => ({
              id: appointment.id,
              cells: [
                <span key="w" className="fw-mtm-cell">
                  <span>{when(appointment.startsAt)}</span>
                  <span className="fw-mtm-hint">{appointment.profile ? t('fit.forRevision', { revision: appointment.profile.revision }) : t('fit.noRevision')}</span>
                </span>,
                t(`apptKind.${appointment.kind}`),
                appointment.place,
                appointment.with.name ?? '—',
                appointment.inviteSentAt ? t('fit.invited', { date: day(appointment.inviteSentAt) }) : t('fit.notInvited'),
                <Pill key="s" tone={appointmentTone(appointment.status)}>
                  {t(`apptStatus.${appointment.status}`)}
                </Pill>,
                <Button key="o" size="sm" variant="quiet" onClick={() => actions?.onOpenAppointment?.(appointment.id)} aria-label={t('fit.openAria', { when: when(appointment.startsAt) })}>
                  {t('fit.open')}
                </Button>,
              ],
            }))}
          />
        )}
      </Section>
      {model.photos && (
        <ExtrasMessages>
          <PhotoNotice model={model.photos} actions={actions?.photos} />
        </ExtrasMessages>
      )}
      <Section id="fit-results" title={t('fit.results')}>
        {results.length === 0 ? (
          <EmptyState title={t('fit.noResults')} description={t('fit.noResultsBody')} />
        ) : (
          <div className="fw-mtm-stack">
            {results.map((result) => (
              <ResultCard key={result.id} result={result} model={model} record={record} actions={actions} />
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

function ResultCard({ result, model, record, actions }: { result: FittingResult; model: ProfileRecordModel; record: ProfileRecord; actions?: ProfileRecordActions }) {
  const { t, say, when } = useWords()
  const offline = model.live === 'offline'
  const move = promiseMove(result)
  const next = nextOf(result)
  const alterHeld: Phrase | null = !model.can.fittings ? rightHeld('fittings') : offline ? { key: 'held.offline' } : result.may.alteration ? null : result.alteration ? { key: 'fit.held.altered' } : !result.orderLine ? { key: 'fit.held.noLine' } : { key: 'fit.held.notNow' }
  const newer = record.revisions[0] && record.revisions[0].id !== result.profile.id && record.revisions[0].revision > result.profile.revision ? record.revisions[0] : null
  const nameHeld: Phrase | null = !model.can.fittings ? rightHeld('fittings') : offline ? { key: 'held.offline' } : !newer ? { key: 'fit.held.noNewer' } : result.may.revision ? null : { key: 'fit.held.notNow' }
  return (
    <Card padded>
      <div className="fw-mtm-stack">
        <div className="fw-mtm-head">
          <span className="fw-mtm-row">
            <Tag tone={result.verdict === 'OK' ? 'success' : result.verdict === 'ALTER' ? 'warning' : 'danger'}>{t(`verdict.${result.verdict}`)}</Tag>
            <span>{t('fit.fittedAt', { when: when(result.fittedAt), revision: result.profile.revision })}</span>
            {result.orderLine && (
              <span className="fw-mtm-hint">
                {t('fit.line', { order: result.orderLine.orderNumber, seq: result.orderLine.seq, style: result.orderLine.style, colourway: result.orderLine.colourway })}
              </span>
            )}
          </span>
          {result.verdict !== 'OK' && (
            <span className="fw-mtm-actions">
              {result.verdict === 'ALTER' && !result.alteration && (
                <Button size="sm" variant="primary" heldReason={say(alterHeld)} onClick={() => actions?.onAlteration?.(result)}>
                  <Scissors size={14} aria-hidden /> {t('fit.sendAlteration')}
                </Button>
              )}
              {!result.newProfile && (
                <Button size="sm" variant="secondary" heldReason={say(nameHeld)} onClick={() => actions?.onNameRevision?.(result)}>
                  <PencilRuler size={14} aria-hidden /> {newer ? t('fit.nameRevision', { revision: newer.revision }) : t('fit.newMeasures')}
                </Button>
              )}
            </span>
          )}
        </div>
        {result.pointChanges.length > 0 && (
          <SummaryTable
            label={t('fit.changes')}
            columns={[t('fit.col.point'), t('fit.col.change'), t('fit.col.note')]}
            widths={['30%', '20%', undefined]}
            stackOnPhone
            rows={result.pointChanges.map((change) => ({ id: change.code, cells: [change.name, `${change.change} ${change.unit}`, change.note ?? '—'] }))}
          />
        )}
        {result.notes && <p className="fw-mtm-text">{result.notes}</p>}
        <p className="fw-mtm-row fw-mtm-hint">
          {result.alteration && (
            <span>
              {t('fit.alteration')}{' '}
              <Link className="fw-mtm-link" href={repairHref(model.prefix, result.alteration.id)}>
                {result.alteration.number}
              </Link>
            </span>
          )}
          {move && <span>{say({ key: 'fit.moved', params: { from: move.from, to: move.to } })}</span>}
          {result.alterationDays !== null && !move && <span>{t('fit.days', { count: result.alterationDays })}</span>}
          {result.newProfile && (
            <span>
              <Link className="fw-mtm-link" href={recordHref(model.prefix, result.newProfile.id)}>
                {t('fit.newRevision', { revision: result.newProfile.revision })}
              </Link>
            </span>
          )}
        </p>
        {next && <p className="fw-mtm-hint">{say(next)}</p>}
        {model.photos && (
          <ExtrasMessages>
            <FittingPhotos model={model.photos} actions={actions?.photos} resultId={result.id} />
          </ExtrasMessages>
        )}
      </div>
    </Card>
  )
}
