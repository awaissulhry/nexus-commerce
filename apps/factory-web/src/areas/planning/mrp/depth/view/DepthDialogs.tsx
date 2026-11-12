'use client'

import type { ReactNode } from 'react'
import { CalendarClock, Check, CircleSlash, RotateCcw } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import type { ReviewState } from '@nexus/ui/patterns'
import { Button, Input, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, ReviewChangesModal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayAt } from '../../../../_shared/buying/model'
import { PROTECTABLE, type ConvertResult, type PlannedOrder } from '../api'
import { DEPTH_NAMESPACE, heldOf, protection, sizesText, type ConvertDialog, type DepthActions, type DepthModel, type ShiftDialog } from '../model'
import { useDepthSay } from './words'

/**
 * The W2b parts' dialogs: "Create n work orders" / "Create n subcontract orders" (the DS ReviewChangesModal over the API's
 * preview: what each becomes, the rows that cannot be made real said apart, then each made real and the result row by
 * row), "Move n by days" (the review of every date that moves, all or none), the dates of one planned order (each changed
 * date is protected from the next run; a protected date offers Reset to plan with the plan's value), and Done / Ignore
 * with a note for action messages.
 */
export function DepthDialogs({ model, actions, today, timeZone }: { model: DepthModel; actions?: DepthActions; today: string; timeZone?: string }) {
  const dialog = model.dialog
  if (!dialog) return null
  if (dialog.kind === 'convert') return <ConvertReview convert={dialog.convert} actions={actions} timeZone={timeZone} />
  if (dialog.kind === 'shift') return <ShiftReview shift={dialog.shift} actions={actions} timeZone={timeZone} />
  if (dialog.kind === 'dates') return <DatesDialog model={model} actions={actions} today={today} timeZone={timeZone} />
  return <DecideDialog model={model} actions={actions} />
}

const rowLabel = (row: Pick<PlannedOrder, 'style' | 'colourway' | 'sizeGroup'>): string => [`${row.style.code} ${row.colourway.code}`, row.sizeGroup].filter(Boolean).join(' · ')

function reviewState(phase: ConvertDialog['phase'], problem: string | null, results: Record<string, { ok: boolean; words: string }> | null, t: (key: string) => string): ReviewState {
  if (phase === 'reading') return { phase: 'reading' }
  if (phase === 'failed') return { phase: 'failed', error: t(problem ?? 'problem.read') }
  if (phase === 'saving') return { phase: 'saving' }
  if (phase === 'done' && results) return { phase: 'done', results }
  return { phase: 'ready' }
}

function ConvertReview({ convert, actions, timeZone }: { convert: ConvertDialog; actions?: DepthActions; timeZone?: string }) {
  const t = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  const place = { locale, timeZone }
  const day = (value: string) => formatDate(dayAt(value), place)
  const resultOf = (id: string): ConvertResult | null => convert.preview?.results.find((result) => result.id === id) ?? null
  const ready = convert.rows.filter((row) => resultOf(row.id)?.ok)
  const held = convert.preview ? convert.rows.filter((row) => !resultOf(row.id)?.ok) : []
  const becomes = (result: ConvertResult | null): string => {
    if (!result) return '—'
    if (convert.kind === 'SUBCONTRACT' && result.subcontractOrder) {
      const sub = result.subcontractOrder
      return t('convert.next.SUBCONTRACT', { workshop: sub.workshop ? sub.workshop.code : '—', steps: sub.operations.map((step) => step.code).join(', ') || '—', kit: sub.kitDueAt ? formatDateTime(sub.kitDueAt, place) : '—' })
    }
    if (result.workOrder) return t('convert.next.MAKE', { revision: result.workOrder.revision ?? '—', pieces: result.workOrder.pieces, due: day(result.workOrder.dueDate) })
    return t('convert.next.unknown')
  }
  const heldWords = (row: PlannedOrder): string => {
    const own = heldOf(row)
    if (own) return t(own)
    const count = resultOf(row.id)?.problems ?? 0
    return count > 0 ? t('convert.heldChecks', { count }) : t('held.other')
  }
  const done = convert.done
  const results = done
    ? Object.fromEntries(
        convert.rows.map((row) => {
          const result = done.results.find((entry) => entry.id === row.id)
          if (!result) return [row.id, { ok: false, words: t('convert.done.notSent') }]
          if (result.ok) {
            const words =
              convert.kind === 'SUBCONTRACT'
                ? t('convert.done.SUBCONTRACT', { workOrder: result.workOrder?.number ?? '—', order: result.subcontractOrder?.number ?? '—' })
                : t('convert.done.MAKE', { workOrder: result.workOrder?.number ?? '—' })
            return [row.id, { ok: true, words, verb: t('convert.done.verb') }]
          }
          return [row.id, { ok: false, words: t(`convert.error.${['conflict', 'invalid_state', 'validation_failed', 'forbidden'].includes(result.error ?? '') ? result.error : 'other'}`), verb: t('convert.done.verb') }]
        }),
      )
    : null
  const lead: ReactNode =
    convert.phase === 'done' ? undefined : (
      <div className="fw-mrd-dialog">
        {held.length > 0 && (
          <Banner tone="warning" title={t('convert.heldTitle', { count: held.length })}>
            <ul className="fw-mrd-list">
              {held.map((row) => (
                <li key={row.id}>
                  <b>{rowLabel(row)}</b> — {heldWords(row)}
                </li>
              ))}
            </ul>
          </Banner>
        )}
        {convert.problem && convert.phase === 'ready' && <Banner tone="danger" title={t(convert.problem)} />}
      </div>
    )
  return (
    <ReviewChangesModal
      open
      onClose={() => actions?.onCloseDialog?.()}
      changes={(convert.preview ? ready : convert.rows).map((row) => ({
        id: row.id,
        where: rowLabel(row),
        what: t(`convert.what.${convert.kind}`),
        now: t('convert.now', { sizes: sizesText(row), start: day(row.startDate), due: day(row.dueDate) }),
        next: convert.preview ? becomes(resultOf(row.id)) : '…',
      }))}
      state={reviewState(convert.phase, convert.problem, results, t)}
      title={t(`convert.title.${convert.kind}`, { count: convert.rows.length })}
      summary={t(`convert.summary.${convert.kind}`)}
      {...(convert.preview ? { metrics: [{ label: t('convert.metric.ready'), value: String(ready.length) }, { label: t('convert.metric.held'), value: String(held.length) }] } : {})}
      problems={convert.preview && ready.length === 0 ? [t('convert.noneReady')] : []}
      saveLabel={t(`convert.save.${convert.kind}`, { count: ready.length })}
      onSave={() => actions?.onConvertSave?.()}
      onRetry={() => actions?.onConvert?.(convert.kind, convert.rows.map((row) => row.id))}
      onDone={() => actions?.onCloseDialog?.()}
      lead={lead}
      size="lg"
    />
  )
}

function ShiftReview({ shift, actions, timeZone }: { shift: ShiftDialog; actions?: DepthActions; timeZone?: string }) {
  const t = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  const place = { locale, timeZone }
  const value = (field: string, raw: unknown): string => {
    if (raw === null || raw === undefined) return t('shift.none')
    if (typeof raw !== 'string') return String(raw)
    return field === 'kitDueAt' ? formatDateTime(raw, place) : /^\d{4}-\d{2}-\d{2}$/.test(raw) ? formatDate(dayAt(raw), place) : raw
  }
  const fieldWord = (name: string | undefined) => (name && (PROTECTABLE as readonly string[]).includes(name) ? t(`field.${name}`) : t('field.other'))
  const answer = shift.done ?? shift.preview
  const labelOf = (id: string) => {
    const row = shift.rows.find((entry) => entry.id === id)
    return row ? rowLabel(row) : id
  }
  const changes = (answer?.rows ?? []).flatMap((row) => row.changes.map((change) => ({ id: `${row.id}:${change.field}`, where: labelOf(row.id), what: t(`field.${change.field}`), now: value(change.field, change.from), next: value(change.field, change.to) })))
  const problems = (shift.preview?.rows ?? []).filter((row) => row.problems.length > 0).map((row) => t('shift.problem', { label: labelOf(row.id), fields: [...new Set(row.problems.map((field) => field.split('/').pop()))].map(fieldWord).join(', ') }))
  const results = shift.done ? Object.fromEntries(changes.map((change) => [change.id, { ok: true, words: t('shift.moved'), verb: t('shift.verb') }])) : null
  const daysProblem = shift.problem === 'shift.days' ? t('shift.days') : null
  const lead: ReactNode =
    shift.phase === 'done' ? undefined : (
      <div className="fw-mrd-dialog">
        <Field label={t('shift.by')} hint={t('shift.hint')} error={daysProblem ?? undefined}>
          <Input inputMode="numeric" type="number" value={Number.isFinite(shift.days) ? String(shift.days) : ''} onChange={(event) => actions?.onShiftDays?.(Math.trunc(Number(event.target.value)))} />
        </Field>
        {shift.problem && shift.problem !== 'shift.days' && shift.phase === 'ready' && <Banner tone="danger" title={t(shift.problem)} />}
      </div>
    )
  return (
    <ReviewChangesModal
      open
      onClose={() => actions?.onCloseDialog?.()}
      changes={changes}
      state={shift.phase === 'failed' && shift.problem === 'shift.days' ? { phase: 'ready' } : reviewState(shift.phase, shift.problem, results, t)}
      title={t('shift.title', { count: shift.rows.length })}
      summary={t('shift.summary')}
      problems={problems}
      saveLabel={t('shift.save', { count: shift.rows.length, days: shift.days })}
      onSave={() => actions?.onShiftSave?.()}
      onRetry={() => actions?.onShiftDays?.(shift.days)}
      onDone={() => actions?.onCloseDialog?.()}
      lead={lead}
      leadHeld={daysProblem}
      size="lg"
    />
  )
}

function DatesDialog({ model, actions, today, timeZone }: { model: DepthModel; actions?: DepthActions; today: string; timeZone?: string }) {
  const t = useT(DEPTH_NAMESPACE)
  const say = useDepthSay(timeZone)
  const locale = useLocale()
  const place = { locale, timeZone }
  const dates = model.dialog?.kind === 'dates' ? model.dialog.dates : null
  const row = model.planned?.status === 'ready' && dates ? (model.planned.value.plannedOrders.find((entry) => entry.id === dates.rowId) ?? null) : null
  if (!dates) return null
  const changed = !!row && (dates.startDate !== row.startDate || dates.dueDate !== row.dueDate)
  const problem = !/^\d{4}-\d{2}-\d{2}$/.test(dates.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(dates.dueDate) ? 'dates.pick' : dates.startDate < today || dates.dueDate < today ? 'dates.past' : dates.startDate > dates.dueDate ? 'dates.order' : null
  const held = !row ? t('problem.gone') : !model.can.edit ? t('held.noEdit') : dates.busy ? t('held.busy') : problem ? t(problem) : !changed ? t('dates.same') : null
  const busy = row ? model.busy.includes(row.id) : false
  const field = (name: 'startDate' | 'dueDate') => {
    const info = row ? protection(row, name) : { protectedNow: false, plan: null }
    return (
      <Field label={t(`field.${name}`)} hint={info.protectedNow ? (info.plan ? t('protected.hint', { plan: formatDate(dayAt(info.plan), place) }) : t('protected.hintNoPlan')) : t('dates.planHint')}>
        <span className="fw-mrd-inline">
          <DateField value={dates[name]} min={today} onChange={(value) => actions?.onDatesChange?.(name, value)} locale={INTL_LOCALE[locale]} ariaLabel={t(`field.${name}`)} />
          {info.protectedNow && row && (
            <Button size="sm" variant="quiet" heldReason={!model.can.edit ? t('held.noEdit') : busy ? t('held.busy') : null} onClick={() => actions?.onReset?.(row.id, name)}>
              <RotateCcw size={13} aria-hidden /> {t('protected.reset')}
            </Button>
          )}
        </span>
      </Field>
    )
  }
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={t('dates.title')}
      subtitle={row ? `${rowLabel(row)} · ${sizesText(row)}` : undefined}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onCloseDialog?.()}>
            {t('cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onDatesSave?.()}>
            {dates.busy ? <Spinner size={12} /> : <CalendarClock size={13} aria-hidden />} {t('dates.save')}
          </Button>
        </>
      }
    >
      <div className="fw-mrd-dialog">
        <p className="fw-mrd-hint">{t('dates.body')}</p>
        <div className="fw-mrd-pair">
          {field('startDate')}
          {field('dueDate')}
        </div>
        {row?.late && <Banner tone="warning" title={say({ key: 'late.planned', params: { need: row.late.needDate, count: row.late.daysLate } })} />}
        {dates.problem && <Banner tone="danger" title={t(dates.problem)} />}
      </div>
    </Modal>
  )
}

function DecideDialog({ model, actions }: { model: DepthModel; actions?: DepthActions }) {
  const t = useT(DEPTH_NAMESPACE)
  const decide = model.dialog?.kind === 'decide' ? model.dialog.decide : null
  if (!decide) return null
  const done = decide.status === 'DONE'
  const held = !model.can.actions ? t('held.noActions') : decide.busy ? t('held.busy') : decide.note.length > 2000 ? t('decide.tooLong') : null
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={t(done ? 'decide.titleDone' : 'decide.titleIgnore', { count: decide.ids.length })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onCloseDialog?.()}>
            {t('cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onDecideSave?.()}>
            {decide.busy ? <Spinner size={12} /> : done ? <Check size={13} aria-hidden /> : <CircleSlash size={13} aria-hidden />} {t(done ? 'decide.saveDone' : 'decide.saveIgnore', { count: decide.ids.length })}
          </Button>
        </>
      }
    >
      <div className="fw-mrd-dialog">
        <p className="fw-mrd-hint">{t(done ? 'decide.bodyDone' : 'decide.bodyIgnore')}</p>
        <Field label={t('decide.note')} hint={t(done ? 'decide.noteHintDone' : 'decide.noteHintIgnore')}>
          <Textarea value={decide.note} rows={3} maxLength={2000} onChange={(event) => actions?.onDecideNote?.(event.target.value)} />
        </Field>
        {decide.problem && <Banner tone="danger" title={t(decide.problem)} />}
      </div>
    </Modal>
  )
}
