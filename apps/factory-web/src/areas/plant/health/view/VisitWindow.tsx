'use client'

import Link from 'next/link'
import { CalendarCheck, CalendarX, Check, MoveRight, Stethoscope, Undo2 } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { DueCell } from '@nexus/ui/components/DueCell/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { HEALTH_LIMITS, VISIT_CANCEL_REASONS, type VisitCancelReason } from '@nexus/factory-domain/safety/health/rules'
import { DateField, Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { addressTerms, dueDayOf, EMPTY_ADDRESS, HEALTH_PATH, moveHeld, newMoveDraft, type VisitMoveKind } from '../model'
import type { HealthPageActions, HealthPageModel, VisitWindowState } from '../view-model'
import { personText, ProtectedLaw, say, SectionFailed, SectionLoading, useWhen, useWords, VisitStateTag, WhoLooked } from './parts'

/**
 * A visit of the due list (Enter on a row, `?visit=<id>`): its own RECORDED read (one OPEN view: said in the window) — the person,
 * the role and its risks, the type, the due day, the booking (day, place, who), a return visit's absence LENGTH only, the
 * cancel, the judgement recorded from it; Who looked for HR and the DPO. Moves for HR and the doctor: book or rebook, unbook,
 * move the due day, mark done, cancel (a reason from the list: no free text on a health record), Record a judgement.
 */
export function VisitWindow({ model, state, actions }: { model: HealthPageModel; state: VisitWindowState; actions?: HealthPageActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const when = useWhen()
  const visit = state.read.status === 'ready' ? state.read.value.visit : null
  const frame = model.frame.status === 'ready' ? model.frame.value : null
  const manage = frame?.can.manage ?? model.can.manage
  const views = frame?.can.views ?? model.can.views
  const move = state.move
  const closed = visit ? visit.status === 'DONE' || visit.status === 'CANCELLED' : true
  const startHeld = (kind: VisitMoveKind): string | null => {
    if (!manage) return t('held.manage')
    if (!visit) return t('common.reading')
    if (closed) return t('refusal.VISIT_CLOSED')
    return kind === 'unbook' && visit.status !== 'BOOKED' ? t('refusal.VISIT_NOT_BOOKED') : null
  }
  const held = visit && move ? say(t, moveHeld(visit, move, model.today)) : null
  const judgementHref = visit?.judgementId ? `${model.prefix}${HEALTH_PATH}${addressTerms({ ...EMPTY_ADDRESS, judgement: visit.judgementId })}` : null

  const footer = !visit ? (
    <Button onClick={() => actions?.onVisitClose?.()}>{t('common.close')}</Button>
  ) : move ? (
    <>
      <Button onClick={() => actions?.onVisitMove?.(null)}>{t('common.back')}</Button>
      <span className="grow" />
      <Button variant="primary" heldReason={state.busy ? t('held.saving') : held} onClick={() => actions?.onVisitSave?.()}>
        {state.busy ? <Spinner size={12} /> : null} {t(`move.${move.kind}.do`)}
      </Button>
    </>
  ) : (
    <>
      <Button onClick={() => actions?.onVisitClose?.()}>{t('common.close')}</Button>
      <span className="grow" />
      {visit.status === 'BOOKED' && (
        <Button heldReason={startHeld('unbook')} onClick={() => actions?.onVisitMove?.(newMoveDraft('unbook', model.today, visit))}>
          <Undo2 size={14} aria-hidden /> {t('move.unbook.title')}
        </Button>
      )}
      <Button heldReason={startHeld('cancel')} onClick={() => actions?.onVisitMove?.(newMoveDraft('cancel', model.today, visit))}>
        <CalendarX size={14} aria-hidden /> {t('move.cancel.title')}
      </Button>
      <Button heldReason={startHeld('move')} onClick={() => actions?.onVisitMove?.(newMoveDraft('move', model.today, visit))}>
        <MoveRight size={14} aria-hidden /> {t('move.move.title')}
      </Button>
      <Button heldReason={startHeld('book')} onClick={() => actions?.onVisitMove?.(newMoveDraft('book', model.today, visit))}>
        <CalendarCheck size={14} aria-hidden /> {t(visit.status === 'BOOKED' ? 'move.book.again' : 'move.book.title')}
      </Button>
      <Button heldReason={startHeld('done')} onClick={() => actions?.onVisitMove?.(newMoveDraft('done', model.today, visit))}>
        <Check size={14} aria-hidden /> {t('move.done.title')}
      </Button>
      <Button variant="primary" heldReason={!manage ? t('held.manage') : visit.judgementId ? t('refusal.VISIT_JUDGED') : visit.status === 'CANCELLED' ? t('refusal.VISIT_CANCELLED') : null} onClick={() => actions?.onAddress?.({ visit: null, judge: visit.id })}>
        <Stethoscope size={14} aria-hidden /> {t('band.judge')}
      </Button>
    </>
  )

  return (
    <Modal open onClose={() => actions?.onVisitClose?.()} title={visit ? t('visit.title', { type: t(`visitType.${visit.type}`) }) : t('visit.reading')} subtitle={visit ? personText(visit.employee) : undefined} size="lg" footer={footer}>
      <div className="fw-hv-form">
        {state.read.status === 'loading' ? (
          <SectionLoading rows={5} />
        ) : state.read.status === 'error' ? (
          <SectionFailed title={t('visit.failed')} problem={state.read.problem} onRetry={actions?.onVisitRetry} />
        ) : visit ? (
          <>
            <PrivacyNote
              level="protected"
              variant="panel"
              recorded
              text={t('visit.recorded', { time: when.at(state.read.value.at) })}
              law={<ProtectedLaw />}
              action={views ? <WhoLooked of={{ recordType: 'HEALTH_VISIT', recordId: visit.id }} state={model.whoLooked} onOpen={actions?.onWhoLooked} label={t('who.visit', { name: visit.employee.name })} /> : undefined}
              labels={ds.privacyNote}
            />
            {state.problem && <Banner tone="danger" title={t('visit.refused')}>{t(state.problem.key)}</Banner>}
            {move ? (
              <MoveForm model={model} state={state} actions={actions} />
            ) : (
              <KeyValue
                items={[
                  { label: t('visit.person'), value: `${personText(visit.employee)} · ${visit.employee.site.name}` },
                  { label: t('visit.role'), value: visit.role ? `${visit.role.code} · ${visit.role.name}` : t('visit.noRole') },
                  { label: t('visit.type'), value: t(`visitType.${visit.type}`) },
                  { label: t('visit.status'), value: <VisitStateTag state={visit.state} /> },
                  {
                    label: t('visit.due'),
                    value:
                      visit.status === 'CANCELLED' ? when.day(visit.dueOn) : <DueCell value={visit.status === 'DONE' ? { state: 'done', doneOn: visit.doneOn } : { due: dueDayOf(visit) }} today={model.today} formatDate={(iso) => when.day(iso)} labels={{ ...ds.dueCell, validUntil: (text) => t('due.dueOn', { date: text }) }} />,
                  },
                  ...(visit.absenceDays !== null ? [{ label: t('visit.absence'), value: t('visit.absenceDays', { count: visit.absenceDays }) }] : []),
                  ...(visit.booked ? [{ label: t('visit.booked'), value: t('visit.bookedBy', { day: when.day(visit.booked.on), place: visit.booked.place ?? t('visit.noPlace'), by: visit.booked.by?.name ?? t('who.someone'), at: when.at(visit.booked.at) }) }] : []),
                  ...(visit.doneOn ? [{ label: t('visit.done'), value: when.day(visit.doneOn) }] : []),
                  ...(visit.cancelled ? [{ label: t('visit.cancelled'), value: t('visit.cancelledBy', { reason: t(`cancelReason.${visit.cancelled.reason}`), by: visit.cancelled.by?.name ?? t('who.someone'), at: when.at(visit.cancelled.at) }) }] : []),
                  { label: t('visit.risks'), value: visit.risks.length > 0 ? visit.risks.join(', ') : '—' },
                  {
                    label: t('visit.judgement'),
                    value: judgementHref ? <Link href={judgementHref}>{t('visit.openJudgement')}</Link> : closed ? t('visit.noJudgement') : t('visit.judgementLater'),
                  },
                ]}
              />
            )}
          </>
        ) : null}
      </div>
    </Modal>
  )
}

/** One move of the visit: its fields (a day, a place, a reason from the list) and what it does, in words. */
function MoveForm({ model, state, actions }: { model: HealthPageModel; state: VisitWindowState; actions?: HealthPageActions | undefined }) {
  const t = useWords()
  const move = state.move!
  const set = (change: Partial<typeof move>) => actions?.onVisitMove?.({ ...move, ...change })
  const at = (field: string) => (state.problem?.field === field ? t(state.problem.key) : undefined)
  return (
    <div className="fw-hv-form">
      <p className="fw-hv-muted">{t(`move.${move.kind}.body`)}</p>
      {(move.kind === 'move' || move.kind === 'done' || move.kind === 'book') && (
        <div className="fw-hv-form-row">
          <Field label={t(`move.${move.kind}.day`)} required error={at(move.kind === 'move' ? 'dueOn' : move.kind === 'done' ? 'doneOn' : 'bookedOn')}>
            <DateField value={move.day} {...(move.kind === 'done' ? { max: model.today } : move.kind === 'book' ? { min: model.today } : {})} onChange={(value) => set({ day: value })} ariaLabel={t(`move.${move.kind}.day`)} />
          </Field>
          {move.kind === 'book' && (
            <Field label={t('book.place')} hint={t('book.placeHint', { most: HEALTH_LIMITS.bookedPlace })} error={at('bookedPlace')}>
              <Input value={move.place} maxLength={HEALTH_LIMITS.bookedPlace} onChange={(event) => set({ place: event.target.value })} />
            </Field>
          )}
        </div>
      )}
      {move.kind === 'cancel' && (
        <Field label={t('move.cancel.reason')} required error={at('reason')}>
          <Select value={move.reason ?? ''} onChange={(event) => set({ reason: (event.target.value || null) as VisitCancelReason | null })}>
            <option value="">{t('move.cancel.choose')}</option>
            {VISIT_CANCEL_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {t(`cancelReason.${reason}`)}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </div>
  )
}
