'use client'

import { useId } from 'react'
import { Check, Lock, LockOpen, Search, UserRound, X } from 'lucide-react'
import { Banner, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { Button, Input, Kbd, SegmentedControl, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { DISPUTE_OUTCOMES, LABOUR_LIMITS, type DisputeOutcome } from '@nexus/factory-domain/production/labour/rules'
import { DateField, DateTimeField, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { listKeys } from '../../../../list-frame/model'
import { answerHeld, closeHeld, codeWords, minutesText, OPEN_REASONS, reasonHeld, reasonLimits, reopenHeld, sheetHeld, type OpenReason } from '../model'
import type { LabourActions, LabourDialog, LabourModel } from './LabourView'
import { ChangeList, dayText, say, useLabourT, useValueWords } from './parts'

/**
 * The page's dialogs (design pop:lb-reject, pop:lb-close, pop:lb-sheet): Reject (the reason is required and reaches the
 * person), the answer to a dispute (upheld or rejected, in words; upheld, a block's right code and times in the same step),
 * Close the day ("closed days feed pay; reopening needs permission and a reason"), Reopen (a reason), the name search and the
 * Daily sheet. Each held with its reason; the server's refusal in words inside the dialog; Esc closes and the focus goes
 * back to the opener (the DS Modal).
 */
export function LabourDialogs({ model, actions }: { model: LabourModel; actions?: LabourActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  switch (dialog.kind) {
    case 'reject':
      return <RejectDialog model={model} dialog={dialog} actions={actions} />
    case 'answer':
      return <AnswerDialog model={model} dialog={dialog} actions={actions} />
    case 'close':
      return <CloseDialog model={model} dialog={dialog} actions={actions} />
    case 'reopen':
      return <ReopenDialog model={model} dialog={dialog} actions={actions} />
    case 'find':
      return <FindDialog model={model} dialog={dialog} actions={actions} />
    case 'sheet':
      return <SheetDialog model={model} dialog={dialog} actions={actions} />
    case 'keys':
      return <KeysDialog onClose={() => actions?.onDialog?.(null)} />
  }
}

function RejectDialog({ model, dialog, actions }: { model: LabourModel; dialog: Extract<LabourDialog, { kind: 'reject' }>; actions?: LabourActions }) {
  const t = useLabourT()
  const held = reasonHeld(dialog.target.kind, dialog.reason, model.busy)
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('reject.title')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={held ? t(held) : null} onClick={() => actions?.onRejectSend?.()}>
            {model.busy ? <Spinner size={13} /> : <X size={14} aria-hidden />} {t('reject.do')}
          </Button>
        </>
      }
    >
      <div className="fw-lb-form">
        <p className="fw-lb-text">{t(`reject.body.${dialog.target.kind}`)}</p>
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem)} />}
        <Field label={t('reject.reason')} required hint={t('reject.reasonHint')}>
          <Textarea rows={3} value={dialog.reason} limit={reasonLimits(dialog.target.kind).max} disabled={model.busy} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value, problem: null })} />
        </Field>
      </div>
    </Modal>
  )
}

function AnswerDialog({ model, dialog, actions }: { model: LabourModel; dialog: Extract<LabourDialog, { kind: 'answer' }>; actions?: LabourActions }) {
  const t = useLabourT()
  const locale = useLocale()
  const set = (draft: Partial<typeof dialog.draft>) => actions?.onDialog?.({ ...dialog, draft: { ...dialog.draft, ...draft }, problem: null })
  const fix = (next: Partial<typeof dialog.draft.fix>) => set({ fix: { ...dialog.draft.fix, ...next } })
  const loaded = model.detail?.key === dialog.open && model.detail.loaded.status === 'ready' ? model.detail.loaded.value : null
  const dispute = loaded?.kind === 'DISPUTE' ? loaded.dispute : null
  const held = !dispute ? 'held.loading' : answerHeld(dialog.draft, model.busy)
  const onBlock = dispute?.recordType === 'OffStandardEntry'
  const upheld = dialog.draft.outcome === 'UPHELD'
  const intl = INTL_LOCALE[locale]
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('answer.title')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant={upheld ? 'primary' : 'danger'} heldReason={held ? t(held) : null} onClick={() => actions?.onAnswerSend?.()}>
            {model.busy ? <Spinner size={13} /> : upheld ? <Check size={14} aria-hidden /> : <X size={14} aria-hidden />} {t(`answer.do.${dialog.draft.outcome}`)}
          </Button>
        </>
      }
    >
      <div className="fw-lb-form">
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem)} />}
        <Field label={t('answer.outcome')}>
          <SegmentedControl size="sm" ariaLabel={t('answer.outcome')} value={dialog.draft.outcome} onChange={(value) => set({ outcome: value as DisputeOutcome })} options={DISPUTE_OUTCOMES.map((outcome) => ({ value: outcome, label: t(`answer.outcomes.${outcome}`) }))} />
        </Field>
        <Field label={t('answer.words')} required hint={t('answer.wordsHint')}>
          <Textarea rows={3} value={dialog.draft.answer} limit={LABOUR_LIMITS.answer} disabled={model.busy} onChange={(event) => set({ answer: event.target.value })} />
        </Field>
        {upheld && dispute && !onBlock && <p className="fw-lb-hint">{t('answer.reportHint')}</p>}
        {upheld && onBlock && (
          <div className="fw-lb-form">
            <p className="fw-lb-hint">{t('answer.blockHint')}</p>
            <Field label={t('detail.code')}>
              <Select value={dialog.draft.fix.codeId} disabled={model.busy || !model.codes} onChange={(event) => fix({ codeId: event.target.value })}>
                <option value="">{t('answer.sameCode', { code: codeWords(dispute?.record?.code ?? null, model.codes, locale) ?? '—' })}</option>
                {(model.codes ?? [])
                  .filter((code) => code.active)
                  .map((code) => (
                    <option key={code.id} value={code.id}>
                      {codeWords(code.code, model.codes, locale)}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label={t('detail.from')}>
              <DateTimeField value={dialog.draft.fix.startedAt || (dispute?.record?.startedAt ?? '')} onChange={(value) => fix({ startedAt: value })} stepMinutes={5} locale={intl} ariaLabel={t('detail.from')} />
            </Field>
            <Field label={t('detail.to')}>
              <DateTimeField value={dialog.draft.fix.endedAt || (dispute?.record?.endedAt ?? '')} onChange={(value) => fix({ endedAt: value })} stepMinutes={5} locale={intl} ariaLabel={t('detail.to')} />
            </Field>
          </div>
        )}
      </div>
    </Modal>
  )
}

function CloseDialog({ model, dialog, actions }: { model: LabourModel; dialog: Extract<LabourDialog, { kind: 'close' }>; actions?: LabourActions }) {
  const t = useLabourT()
  const locale = useLocale()
  const held = closeHeld(dialog.note, model.busy)
  const one = dialog.days.length === 1 ? dialog.days[0]! : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={one ? t('close.title', { line: one.lineCode }) : t('close.titleN', { count: dialog.days.length })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onCloseSend?.()}>
            {model.busy ? <Spinner size={13} /> : <Lock size={14} aria-hidden />} {one ? t('close.do') : t('close.doN', { count: dialog.days.length })}
          </Button>
        </>
      }
    >
      <div className="fw-lb-form">
        {one ? (
          <p className="fw-lb-text">{t('close.day', { line: one.lineName || one.lineCode, day: dayText(one.workDate, locale, model.timeZone) })}</p>
        ) : (
          <ul className="fw-lb-list">
            {dialog.days.map((day) => (
              <li key={`${day.lineId}:${day.workDate}`}>{t('close.dayLine', { line: day.lineCode, day: dayText(day.workDate, locale, model.timeZone) })}</li>
            ))}
          </ul>
        )}
        <p className="fw-lb-text">{t('close.body')}</p>
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem)} />}
        <Field label={t('close.note')} hint={t('close.noteHint')}>
          <Textarea rows={2} value={dialog.note} limit={LABOUR_LIMITS.note} disabled={model.busy} onChange={(event) => actions?.onDialog?.({ ...dialog, note: event.target.value, problem: null })} />
        </Field>
      </div>
    </Modal>
  )
}

function ReopenDialog({ model, dialog, actions }: { model: LabourModel; dialog: Extract<LabourDialog, { kind: 'reopen' }>; actions?: LabourActions }) {
  const t = useLabourT()
  const locale = useLocale()
  const held = reopenHeld(dialog.reason, model.busy)
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('reopen.title', { line: dialog.day.lineCode })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onReopenSend?.()}>
            {model.busy ? <Spinner size={13} /> : <LockOpen size={14} aria-hidden />} {t('reopen.do')}
          </Button>
        </>
      }
    >
      <div className="fw-lb-form">
        <p className="fw-lb-text">{t('reopen.body', { day: dayText(dialog.day.workDate, locale, model.timeZone) })}</p>
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem)} />}
        <Field label={t('reopen.reason')} required hint={t('reopen.reasonHint')}>
          <Textarea rows={3} value={dialog.reason} limit={LABOUR_LIMITS.reason} disabled={model.busy} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value, problem: null })} />
        </Field>
      </div>
    </Modal>
  )
}

/** The design's "name search": one person, one day, the same read as the People register's search; nothing is listed here but the hits. */
function FindDialog({ model, dialog, actions }: { model: LabourModel; dialog: Extract<LabourDialog, { kind: 'find' }>; actions?: LabourActions }) {
  const t = useLabourT()
  const hits = dialog.hits
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('find.title')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={dialog.person ? null : t('held.pickPerson')} onClick={() => dialog.person && actions?.onOpenDay?.({ employeeId: dialog.person.id, name: dialog.person.displayName }, dialog.workDate)}>
            <UserRound size={14} aria-hidden /> {t('find.do')}
          </Button>
        </>
      }
    >
      <div className="fw-lb-form">
        <p className="fw-lb-text">{t('find.body')}</p>
        <Field label={t('find.name')}>
          <Input type="search" leadingIcon={<Search size={13} aria-hidden />} value={dialog.query} onChange={(event) => actions?.onFind?.(event.target.value)} />
        </Field>
        {hits?.status === 'loading' && <Skeleton height={64} />}
        {hits?.status === 'error' && <Banner tone="danger" title={t(hits.problem)} />}
        {hits?.status === 'ready' &&
          (hits.value.length === 0 ? (
            <p className="fw-lb-hint">{t('find.none')}</p>
          ) : (
            <ul className="fw-lb-hits">
              {hits.value.map((person) => (
                <li key={person.id}>
                  <Button size="sm" variant={dialog.person?.id === person.id ? 'tonal' : 'quiet'} aria-pressed={dialog.person?.id === person.id} onClick={() => actions?.onDialog?.({ ...dialog, person })}>
                    {person.displayName}
                    {person.employeeCode ? ` · ${person.employeeCode}` : ''}
                  </Button>
                </li>
              ))}
            </ul>
          ))}
        <Field label={t('find.day')}>
          <DateField value={dialog.workDate} max={model.today} onChange={(value) => actions?.onDialog?.({ ...dialog, workDate: value })} />
        </Field>
      </div>
    </Modal>
  )
}

/**
 * Daily sheet (design pop:lb-sheet): one person, one day: attendance minutes, production minutes (standard minutes earned),
 * off-standard minutes by code, pieces, exceptions; no percentage, no comparison, no colour judgement. "This view is logged."
 * Opening it is the API's command (who, whose, why); someone else's day takes a reason first. Its figures stay in this
 * dialog alone: nothing is kept, printed or exported.
 */
function SheetDialog({ model, dialog, actions }: { model: LabourModel; dialog: Extract<LabourDialog, { kind: 'sheet' }>; actions?: LabourActions }) {
  const t = useLabourT()
  const locale = useLocale()
  const ds = useDsWords()
  const place = { locale, timeZone: model.timeZone }
  const words = useValueWords(model.codes, model.timeZone)
  const reasonId = useId()
  const sheet = dialog.sheet
  const access = dialog.access.status === 'ready' ? dialog.access.value : null
  const held = sheetHeld(access, dialog.reason, model.busy)
  const day = dayText(dialog.workDate, locale, model.timeZone)
  const name = sheet?.person.name ?? dialog.person.name
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('sheet.title')}
      size="lg"
      footer={
        sheet ? (
          <Button variant="primary" onClick={() => actions?.onDialog?.(null)}>
            {t('sheet.close')}
          </Button>
        ) : (
          <>
            <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
            <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onSheetOpen?.()}>
              {model.busy ? <Spinner size={13} /> : <UserRound size={14} aria-hidden />} {t('sheet.open')}
            </Button>
          </>
        )
      }
    >
      <div className="fw-lb-form">
        <p className="fw-lb-text">{name ? t('sheet.who', { name, day }) : t('sheet.whoHidden', { day })}</p>
        <PrivacyNote level="individual" variant="panel" text={t('sheet.level')} whoMore={t('sheet.logged')} labels={ds.privacyNote} />
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem)} />}
        {dialog.access.status === 'loading' && <Skeleton height={64} />}
        {dialog.access.status === 'error' && <Banner tone="danger" title={t(dialog.access.problem)} />}
        {access && !access.allowed && <Banner tone="warning" title={t(access.refusal === 'GATE_CLOSED' ? 'held.sheetsOff' : 'held.noFigures')} />}
        {!sheet && access?.allowed && access.needsReason && (
          <>
            <Field label={t('sheet.reason')} required hint={t('sheet.reasonHint')} htmlFor={reasonId}>
              <Select id={reasonId} value={dialog.reason} disabled={model.busy} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value as OpenReason | '', problem: null })}>
                <option value="">{t('sheet.pickReason')}</option>
                {OPEN_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {t(`sheet.reasons.${reason}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('sheet.note')}>
              <Textarea rows={2} value={dialog.note} limit={500} disabled={model.busy} onChange={(event) => actions?.onDialog?.({ ...dialog, note: event.target.value })} />
            </Field>
          </>
        )}
        {sheet && (
          <>
            <KeyValue
              columns={2}
              labelCase="sentence"
              items={[
                {
                  label: t('sheet.attendance'),
                  value: sheet.sheet.attendance ? t('sheet.minutes', { count: sheet.sheet.attendance.presentMinutes }) : '—',
                  hint: sheet.attendanceShown ? (sheet.sheet.attendance ? undefined : t('sheet.noAttendanceDay')) : t('sheet.noAttendance'),
                },
                { label: t('sheet.production'), value: t('sheet.minutesText', { minutes: minutesText(sheet.sheet.productionMinutes, locale) }), hint: t('detail.earnedHint') },
                { label: t('sheet.pieces'), value: t('sheet.piecesValue', sheet.sheet.pieces) },
                { label: t('sheet.offStandard'), value: t('sheet.minutes', { count: sheet.sheet.offStandard.minutes }) },
              ]}
            />
            {sheet.sheet.offStandard.byCode.length > 0 && (
              <SummaryTable
                label={t('sheet.byCode')}
                columns={[t('detail.code'), t('detail.minutes'), t('sheet.blocks')]}
                align={[undefined, 'right', 'right']}
                stackOnPhone
                rows={sheet.sheet.offStandard.byCode.map((entry) => ({ id: entry.codeId, cells: [codeWords(entry.code, model.codes, locale) ?? entry.code, String(entry.minutes), String(entry.blocks)] }))}
              />
            )}
            {sheet.sheet.exceptions.length > 0 && (
              <section className="fw-lb-section" aria-label={t('sheet.exceptions')}>
                <h3 className="fw-lb-h3">{t('sheet.exceptions')}</h3>
                <ul className="fw-lb-list">
                  {sheet.sheet.exceptions.map((entry) => (
                    <li key={entry.kind}>{t(`exception.${entry.kind}`, { count: entry.count })}</li>
                  ))}
                </ul>
              </section>
            )}
            {sheet.records.length > 0 && (
              <SummaryTable
                label={t('sheet.records')}
                columns={[t('detail.when'), t('col.work'), t('detail.operation'), t('field.good'), t('field.scrap'), t('field.rework'), t('sheet.earned')]}
                stackOnPhone
                rows={sheet.records.map((record) => ({
                  id: record.scanId,
                  cells: [formatTime(record.at, place), `${record.workOrder.number} · ${record.bundle.code}`, `${record.operation.seq} ${record.operation.name}`, String(record.counts.good), String(record.counts.scrap), String(record.counts.rework), minutesText(record.earnedMinutes, locale)],
                }))}
              />
            )}
            {sheet.edits.length > 0 && (
              <section className="fw-lb-section" aria-label={t('sheet.edits')}>
                <h3 className="fw-lb-h3">{t('sheet.edits')}</h3>
                {sheet.edits.map((edit) => (
                  <div key={edit.id} className="fw-lb-edit">
                    <ChangeList changes={edit.changes} words={words} />
                    <span className="fw-lb-sub">
                      {formatDateTime(edit.at, place)} · {edit.reason}
                    </span>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

function KeysDialog({ onClose }: { onClose: () => void }) {
  const t = useLabourT()
  const lists = useT('lists')
  const own = [
    { keys: ['A'], does: t('keys.approve') },
    { keys: ['R'], does: t('keys.reject') },
    { keys: ['J', 'K'], does: t('keys.next') },
  ]
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <dl className="fw-lb-keys">
        {listKeys(own, true).map((entry) => (
          <div key={entry.keys.join('+')}>
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd>{entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
