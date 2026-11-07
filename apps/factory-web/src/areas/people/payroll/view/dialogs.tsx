'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Trash2 } from 'lucide-react'
import { Banner, ChangeReview, EmptyState, Field, KeyValue, Menu, OrderedList } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Input, Select, Tag } from '@nexus/ui/primitives'
import { ActionConfirm, DateField, JobProgress, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { DATE_FORMATS, DECIMAL_SEPARATORS, DELIMITERS, ENCODINGS, LAYOUT_LIMITS } from '@nexus/factory-domain/people/payroll/layouts'
import { PAYROLL_LIMITS, PAYROLL_LINK_TERMS } from '@nexus/factory-domain/people/payroll/rules'
import { TIME_ZONE } from '../../_shared/model'
import type { ColumnKey, ShowAnswer } from '../api'
import { changeSides, checkWords, COLUMN_KEYS, columnsHeld, confirmHeld, correctHeld, delimiterKey, formatChoices, formatWords, meaningOf, monthWords, placeOf, recordHref, sendHeld, withKey, type ColumnDraft, type PayrollCan } from '../model'
import type { CancelDialog, ColumnsDialog, ConfirmDialog, CorrectDialog, ExportDialogActions, ExportDialogs, PayrollActions, PayrollModel, SendDialog, ShowDialog } from '../view-model'
import { dayWords, LayoutWarning, SectionLoading, ToConfirm, usePayrollWords, useSaid, type PayrollWords } from './parts'

// ---- "Show me" -------------------------------------------------------------------------------------------------------------------

type ShownPerson = ShowAnswer['people'][number]
type ShownCode = ShowAnswer['codes'][number]

/**
 * Show me (design sec:step-checks): the people or codes behind one check, opened by the person and recorded when it names people.
 * The names live in this dialog's state alone. A list with no selection: nothing here is done to many rows.
 */
export function ShowModal({ model, dialog, actions }: { model: PayrollModel; dialog: ShowDialog; actions?: PayrollActions | undefined }) {
  const t = usePayrollWords()
  const said = useSaid()
  const locale = useLocale()
  const month = model.month.status === 'ready' ? model.month.value.month : ''
  const words = checkWords(dialog.check, month, locale)
  const place = placeOf(dialog.check.place, model.prefix, month, model.pages)
  const answer = dialog.answer
  const peopleColumns = useMemo<ColDef<ShownPerson>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<ShownPerson>) =>
      !data ? null : model.can.people ? (
        <Link className="fw-pp-link fw-pp-ellipsis" href={`${model.prefix}/people/employees/${encodeURIComponent(data.employeeId)}`} target="_blank" rel="noopener noreferrer">
          {data.name}
        </Link>
      ) : (
        <span className="fw-pp-ellipsis">{data.name}</span>
      )
    return [
      { colId: 'name', headerName: t('col.person'), minWidth: 200, flex: 1.4, cellRenderer: NameCell },
      { colId: 'code', headerName: t('col.employeeCode'), minWidth: 130, flex: 0.8, valueGetter: (params) => params.data?.employeeCode ?? t('preview.noCode') },
      { colId: 'last', headerName: t('col.lastDay'), minWidth: 130, flex: 0.8, valueGetter: (params) => (params.data?.lastDay ? dayWords(params.data.lastDay, locale) : '—') },
    ]
  }, [t, locale, model.prefix, model.can.people])
  const codeColumns = useMemo<ColDef<ShownCode>[]>(
    () => [
      { colId: 'kind', headerName: t('col.kind'), minWidth: 110, flex: 0.7, valueGetter: (params) => (params.data ? t(`kind.${params.data.kind}`) : '') },
      { colId: 'our', headerName: t('col.ourCode'), minWidth: 120, flex: 0.8, valueGetter: (params) => params.data?.ourCode ?? '' },
      { colId: 'meaning', headerName: t('col.meaning'), minWidth: 200, flex: 1.5, valueGetter: (params) => (params.data ? meaningOf(params.data.kind, params.data.ourCode, params.data.meaning, locale) : '') },
    ],
    [t, locale],
  )
  return (
    <Modal
      open
      onClose={() => actions?.onCloseShow?.()}
      title={t(words.name)}
      size="lg"
      footer={
        <>
          {place.kind === 'page' && (
            <Button asChild size="sm">
              <Link href={place.href} target="_blank" rel="noopener noreferrer">
                {t(place.words)}
              </Link>
            </Button>
          )}
          {place.kind === 'step' && (
            <Button
              size="sm"
              onClick={() => {
                actions?.onCloseShow?.()
                actions?.onStep?.(place.step)
              }}
            >
              {t(place.words)}
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => actions?.onCloseShow?.()}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className="fw-pp-stack">
        <p className="fw-pp-hint">{said(words.detail)}</p>
        {dialog.problem && <Banner tone="danger" title={said(dialog.problem)} />}
        {!answer && !dialog.problem && <SectionLoading words={t('show.reading')} rows={3} />}
        {answer && answer.people.length > 0 && (
          <>
            <ListFrame<ShownPerson> label={t(words.name)} rows={answer.people} rowId={(row) => row.employeeId} columns={peopleColumns} count={t('show.people', { count: answer.people.length })} listKey={null} rowKind="text" />
            <p className="fw-pp-hint">{t('show.recorded')}</p>
          </>
        )}
        {answer && answer.codes.length > 0 && <ListFrame<ShownCode> label={t(words.name)} rows={answer.codes} rowId={(row) => `${row.kind}|${row.ourCode}`} columns={codeColumns} count={t('show.codes', { count: answer.codes.length })} listKey={null} rowKind="text" />}
        {answer && answer.people.length === 0 && answer.codes.length === 0 && <EmptyState title={t('show.nothing')} />}
      </div>
    </Modal>
  )
}

// ---- CSV columns -----------------------------------------------------------------------------------------------------------------

function formatText(t: PayrollWords, format: string): string {
  const words = formatWords(format)
  return typeof words === 'string' ? words : t(words.key, words.params)
}

function ColumnRow({ column, position, dialog, actions }: { column: ColumnDraft; position: number; dialog: ColumnsDialog; actions?: PayrollActions | undefined }) {
  const t = usePayrollWords()
  const fixed = dialog.draft.format === 'FIXED_WIDTH'
  const replace = (next: ColumnDraft | null) => actions?.onColumnsDraft?.({ columns: dialog.draft.columns.flatMap((row) => (row.id === column.id ? (next ? [next] : []) : [row])) })
  const number = position + 1
  return (
    <span className={fixed ? 'fw-pay-column is-fixed' : 'fw-pay-column'}>
      <Select size="sm" aria-label={t('columns.key', { number })} value={column.key} onChange={(event) => replace(withKey(column, event.target.value as ColumnKey))}>
        {COLUMN_KEYS.map((key) => (
          <option key={key} value={key}>
            {t(`column.${key}`)}
          </option>
        ))}
      </Select>
      {column.key === 'constant' ? (
        <Input size="sm" aria-label={t('columns.value', { number })} placeholder={t('columns.valueHint')} maxLength={LAYOUT_LIMITS.value} value={column.value} onChange={(event) => replace({ ...column, value: event.target.value })} />
      ) : (
        <Input size="sm" aria-label={t('columns.header', { number })} placeholder={t('columns.headerHint')} maxLength={LAYOUT_LIMITS.header} value={column.header} onChange={(event) => replace({ ...column, header: event.target.value })} />
      )}
      {fixed && <Input size="sm" aria-label={t('columns.width', { number })} placeholder={t('columns.widthHint')} inputMode="numeric" value={column.width} onChange={(event) => replace({ ...column, width: event.target.value })} />}
      {formatChoices(column.key).length > 1 ? (
        <Select size="sm" aria-label={t('columns.format', { number })} value={column.format} onChange={(event) => replace({ ...column, format: event.target.value })}>
          {formatChoices(column.key).map((format) => (
            <option key={format} value={format}>
              {formatText(t, format)}
            </option>
          ))}
        </Select>
      ) : (
        <span />
      )}
      <Button size="sm" variant="quiet" aria-label={t('columns.remove', { number })} onClick={() => replace(null)}>
        <Trash2 size={13} aria-hidden />
      </Button>
    </span>
  )
}

/** CSV columns (design pop:csv-map): order, headers, number and date formats, saved per consultant as the company's layout. */
export function ColumnsModal({ model, dialog, actions }: { model: PayrollModel; dialog: ColumnsDialog; actions?: PayrollActions | undefined }) {
  const t = usePayrollWords()
  const said = useSaid()
  const { draft, layout } = dialog
  const held = columnsHeld(draft, model.can, dialog.busy)
  const set = (patch: Partial<typeof draft>) => actions?.onColumnsDraft?.(patch)
  const byId = new Map(draft.columns.map((column, index) => [column.id, { column, index }]))
  const fixed = draft.format === 'FIXED_WIDTH'
  const spreadsheet = draft.format === 'SPREADSHEET'
  return (
    <Modal
      open
      onClose={() => actions?.onCloseColumns?.()}
      title={t(fixed ? 'format.columnsFixed' : 'format.columns')}
      size="xl"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={() => actions?.onCloseColumns?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? said(held) : null} onClick={() => actions?.onSaveColumns?.()}>
            {t('columns.save')}
          </Button>
        </>
      }
    >
      <div className="fw-pp-stack">
        <div className="fw-pp-form">
          <Field label={t('columns.name')}>
            <Input value={draft.name} maxLength={LAYOUT_LIMITS.name} onChange={(event) => set({ name: event.target.value })} />
          </Field>
        </div>
        <p className="fw-pp-hint">{t('columns.companyCodeMoved')}</p>
        <LayoutWarning layout={layout} />
        {layout.confirmed && layout.provider && <Banner tone="info" title={t('columns.dropsConfirmation')} />}
        <div className="fw-pay-section-head">
          <h4 className="fw-pp-h3">{t('columns.list')}</h4>
          <Menu align="right" label={t('columns.add')} triggerProps={{ 'aria-label': t('columns.add') }} items={COLUMN_KEYS.map((key) => ({ id: key, label: t(`column.${key}`), onSelect: () => actions?.onColumnAdd?.(key) }))} />
        </div>
        <OrderedList
          label={t('columns.list')}
          compact
          keyboardGrip
          items={draft.columns.map((column) => column.id)}
          itemLabel={(id) => t(`column.${byId.get(id)?.column.key ?? 'constant'}`)}
          onChange={(ids) => set({ columns: ids.flatMap((id) => { const entry = byId.get(id); return entry ? [entry.column] : [] }) })}
          renderItem={(id) => {
            const entry = byId.get(id)
            return entry ? <ColumnRow column={entry.column} position={entry.index} dialog={dialog} actions={actions} /> : null
          }}
        />
        <div className="fw-pp-form">
          {!fixed && !spreadsheet && (
            <Field label={t('columns.delimiterLabel')}>
              <Select value={draft.delimiter} onChange={(event) => set({ delimiter: event.target.value })}>
                {DELIMITERS.map((delimiter) => (
                  <option key={delimiter} value={delimiter}>
                    {t(delimiterKey(delimiter))}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {!spreadsheet && (
            <Field label={t('columns.decimal')}>
              <Select value={draft.decimalSeparator} onChange={(event) => set({ decimalSeparator: event.target.value })}>
                {DECIMAL_SEPARATORS.map((separator) => (
                  <option key={separator} value={separator}>
                    {t(separator === ',' ? 'columns.comma' : 'columns.dot')}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('columns.date')}>
            <Select value={draft.dateFormat} onChange={(event) => set({ dateFormat: event.target.value })}>
              {DATE_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {format}
                </option>
              ))}
            </Select>
          </Field>
          {!spreadsheet && (
            <Field label={t('columns.encoding')}>
              <Select value={draft.encoding} onChange={(event) => set({ encoding: event.target.value })}>
                {ENCODINGS.map((encoding) => (
                  <option key={encoding} value={encoding}>
                    {encoding}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {!fixed && <Checkbox checked={draft.headerRow} onChange={(event) => set({ headerRow: event.target.checked })} label={t('columns.headerRow')} />}
        {dialog.problem && <Banner tone="danger" title={said(dialog.problem)} />}
      </div>
    </Modal>
  )
}

// ---- the consultant's confirmation ------------------------------------------------------------------------------------------------

/** Who confirmed a provider layout against the consultant's sample, and when; or take it back. Nothing is checked by Nexus. */
export function ConfirmModal({ model, dialog, actions }: { model: PayrollModel; dialog: ConfirmDialog; actions?: PayrollActions | undefined }) {
  const t = usePayrollWords()
  const said = useSaid()
  const held = confirmHeld(dialog.draft, model.can, dialog.busy)
  const confirmed = dialog.layout.confirmation
  return (
    <Modal
      open
      onClose={() => actions?.onCloseConfirm?.()}
      title={t('confirm.title', { name: dialog.layout.name })}
      size="md"
      footer={
        <>
          {confirmed && (
            <Button size="sm" variant="quiet" onClick={() => actions?.onTakeBackConfirm?.()}>
              {t('confirm.takeBack')}
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => actions?.onCloseConfirm?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? said(held) : null} onClick={() => actions?.onSaveConfirm?.()}>
            {t('confirm.save')}
          </Button>
        </>
      }
    >
      <div className="fw-pp-stack">
        <p className="fw-pp-hint">{t('confirm.lead')}</p>
        <LayoutWarning layout={dialog.layout} />
        <div className="fw-pp-form">
          <Field label={t('confirm.by')} hint={t('confirm.byHint')}>
            <Input value={dialog.draft.by} maxLength={LAYOUT_LIMITS.confirmedBy} onChange={(event) => actions?.onConfirmDraft?.({ by: event.target.value })} />
          </Field>
          <Field label={t('confirm.on')}>
            <DateField value={dialog.draft.on} onChange={(on) => actions?.onConfirmDraft?.({ on: on ?? '' })} />
          </Field>
        </div>
        <ToConfirm />
        {dialog.problem && <Banner tone="danger" title={said(dialog.problem)} />}
      </div>
    </Modal>
  )
}

// ---- the pop-ups of a file -----------------------------------------------------------------------------------------------------------

/** Send, the correction and a draft's cancel: mounted by every page that shows a file. */
export function ExportModals({ prefix, can, dialogs, actions }: { prefix: string; can: PayrollCan; dialogs: ExportDialogs; actions?: ExportDialogActions | undefined }) {
  return (
    <>
      {dialogs.send && <SendModal can={can} dialog={dialogs.send} actions={actions} />}
      {dialogs.correct && <CorrectModal prefix={prefix} can={can} dialog={dialogs.correct} actions={actions} />}
      {dialogs.cancel && <CancelModal dialog={dialogs.cancel} actions={actions} />}
    </>
  )
}

/**
 * Send to the labour consultant (design pop:send, the Publish dialog pattern): recipient, expiry, uses, message, then the result in
 * the same dialog; the link can be withdrawn. The mail carries a link, never the file. The consultant's download page comes with a
 * later wave: the dialog says so before Send, because a person must know a real consultant cannot fetch the file in a browser yet.
 */
function SendModal({ can, dialog, actions }: { can: PayrollCan; dialog: SendDialog; actions?: ExportDialogActions | undefined }) {
  const t = usePayrollWords()
  const said = useSaid()
  const locale = useLocale()
  const { draft, target, done } = dialog
  const held = sendHeld(draft, can, dialog.busy)
  const place = { locale, timeZone: TIME_ZONE }
  const label = monthWords(target.month, locale)
  return (
    <Modal
      open
      onClose={() => actions?.onCloseSend?.()}
      title={t('sendDialog.title')}
      size="lg"
      footer={
        done ? (
          <>
            <Button size="sm" onClick={() => actions?.onWithdrawSent?.()} heldReason={dialog.withdrawn ? t('sendDialog.withdrawnHeld') : dialog.withdrawing ? t('held.busy') : null}>
              {t('sendDialog.withdraw')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => actions?.onCloseSend?.()}>
              {t('wizard.done')}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="secondary" onClick={() => actions?.onCloseSend?.()}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" heldReason={held ? said(held) : null} onClick={() => actions?.onSend?.()}>
              {t('sendDialog.send')}
            </Button>
          </>
        )
      }
    >
      <div className="fw-pp-stack">
        <p className="fw-pp-hint">{t('sendDialog.what', { month: label, version: target.revision, number: target.number ?? '—' })}</p>
        <Banner tone="warning" title={t('sendDialog.noPage')}>
          {t('sendDialog.noPageBody')}
        </Banner>
        <LayoutWarning layout={target.layout} />
        {done ? (
          <>
            <Banner tone={done.delivery === 'FAILED' ? 'danger' : 'success'} title={t(`sendDialog.delivery.${done.delivery === 'SENT' || done.delivery === 'FAILED' ? done.delivery : 'QUEUED'}`, { email: done.link.email })} />
            <KeyValue
              dense
              items={[
                { label: t('sendDialog.to'), value: done.link.email },
                { label: t('sendDialog.expiresAt'), value: formatDateTime(done.link.expiresAt, place) },
                { label: t('sendDialog.uses'), value: String(done.link.maxUses) },
                { label: t('sendDialog.state'), value: <Tag tone={dialog.withdrawn ? 'neutral' : 'success'}>{t(dialog.withdrawn ? 'link.REVOKED' : 'link.LIVE')}</Tag> },
              ]}
            />
            {done.withdrawn.length > 0 && <p className="fw-pp-hint">{t('sendDialog.earlier', { count: done.withdrawn.length })}</p>}
            <p className="fw-pp-hint">{t('sendDialog.log')}</p>
          </>
        ) : (
          <>
            <div className="fw-pp-form">
              <Field label={t('sendDialog.to')} hint={t('sendDialog.toHint')}>
                <Input type="email" autoComplete="off" value={draft.email} maxLength={254} onChange={(event) => actions?.onSendDraft?.({ email: event.target.value })} />
              </Field>
              <Field label={t('sendDialog.days')} hint={t('sendDialog.daysHint', { max: PAYROLL_LINK_TERMS.expiryDays.max })}>
                <Input inputMode="numeric" value={draft.days} onChange={(event) => actions?.onSendDraft?.({ days: event.target.value })} />
              </Field>
              <Field label={t('sendDialog.uses')} hint={t('sendDialog.usesHint', { max: PAYROLL_LINK_TERMS.uses.max })}>
                <Input inputMode="numeric" value={draft.uses} onChange={(event) => actions?.onSendDraft?.({ uses: event.target.value })} />
              </Field>
              <Field label={t('sendDialog.language')}>
                <Select value={draft.language} onChange={(event) => actions?.onSendDraft?.({ language: event.target.value === 'en' ? 'en' : 'it' })}>
                  <option value="it">{t('sendDialog.it')}</option>
                  <option value="en">{t('sendDialog.en')}</option>
                </Select>
              </Field>
            </div>
            <Field label={t('sendDialog.message')} hint={t('sendDialog.messageHint')}>
              <Textarea value={draft.message} limit={PAYROLL_LIMITS.message} rows={3} onChange={(event) => actions?.onSendDraft?.({ message: event.target.value })} />
            </Field>
            <p className="fw-pp-hint">{t('sendDialog.terms')}</p>
          </>
        )}
        {dialog.problem && <Banner tone="danger" title={said(dialog.problem)} />}
      </div>
    </Modal>
  )
}

/**
 * Make correction export (design pop:reexport, ActionConfirm + ChangeReview): vN+1 replaces vN for the consultant, vN is kept, what
 * changed in counts. From → to per employee code opens on the click and is recorded; the dialog holds it alone.
 */
function CorrectModal({ prefix, can, dialog, actions }: { prefix: string; can: PayrollCan; dialog: CorrectDialog; actions?: ExportDialogActions | undefined }) {
  const t = usePayrollWords()
  const said = useSaid()
  const locale = useLocale()
  const { target, month, done } = dialog
  const label = monthWords(target.month, locale)
  const version = target.revision + 1
  const held = correctHeld({ month, can, busy: dialog.busy })
  const rows = dialog.changes.value?.changes?.rows ?? []
  if (done) {
    return (
      <Modal
        open
        onClose={() => actions?.onCloseCorrect?.()}
        title={t('correct.madeTitle', { version: done.revision })}
        size="md"
        footer={
          <>
            <Button asChild size="sm">
              <Link href={recordHref(prefix, done.id)}>{t('send.openRecord')}</Link>
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                actions?.onCloseCorrect?.()
                actions?.onOpenSend?.(done)
              }}
            >
              {t('send.send')}
            </Button>
          </>
        }
      >
        <Banner tone="success" title={t('correct.made', { number: done.number ?? '—', month: label, version: done.revision })}>
          {t('correct.madeBody', { version: target.revision })}
        </Banner>
      </Modal>
    )
  }
  return (
    <Modal open onClose={() => actions?.onCloseCorrect?.()} title={t('correct.title')} size="lg">
      <div className="fw-pp-stack">
        {dialog.readProblem && <Banner tone="danger" title={said(dialog.readProblem)} />}
        {!month && !dialog.readProblem && <SectionLoading words={t('correct.reading')} rows={2} />}
        <LayoutWarning layout={target.layout} />
        {dialog.busy && <JobProgress label={t('send.making', { month: label })} {...(dialog.startedAt ? { startedAt: dialog.startedAt } : {})} detail={t('send.makingDetail')} />}
        <ActionConfirm
          mode="inline"
          impact={{
            level: 'confirm',
            title: t('correct.question', { version, month: label }),
            confirmLabel: t('correct.make', { version }),
            consequences: [t('correct.replaces', { version, previous: target.revision }), ...(month?.correction ? [t('correct.changed', { people: month.correction.people, values: month.correction.values })] : []), ...(month?.correction?.corrections ? [t('correct.corrections', { count: month.correction.corrections })] : [])],
            sideEffects: [t('correct.links', { version: target.revision })],
            ...(held || dialog.problem ? { refusal: { reason: dialog.problem ? said(dialog.problem) : said(held) } } : {}),
          }}
          onConfirm={() => actions?.onCorrect?.()}
          onCancel={() => actions?.onCloseCorrect?.()}
        />
        {dialog.changes.status === 'idle' && (
          <div className="fw-pay-open">
            <Button size="sm" heldReason={can.records ? null : t('held.noRecords')} onClick={() => actions?.onReadChanges?.()}>
              {t('correct.show')}
            </Button>
            <span className="fw-pp-hint">{t('preview.recorded')}</span>
          </div>
        )}
        {dialog.changes.status === 'reading' && <SectionLoading words={t('correct.readingChanges')} rows={2} />}
        {dialog.changes.status === 'error' && <Banner tone="danger" title={said(dialog.changes.problem)} />}
        {dialog.changes.status === 'ready' && (
          <ChangeReview
            label={t('correct.review')}
            tick={false}
            selectedIds={[]}
            onSelectionChange={() => undefined}
            items={rows.map((row) => {
              const sides = changeSides(row, locale)
              return {
                id: `${row.employeeCode}|${row.kind}|${row.code}`,
                label: row.employeeCode,
                status: <Tag tone="warning">{t(`change.${row.change}`)}</Tag>,
                note: meaningOf(row.kind, row.code, row.meaning, locale),
                selectable: false,
                values: [
                  { label: t('correct.from'), value: sides.from ?? '—' },
                  { label: t('correct.to'), value: sides.to ?? '—' },
                ],
              }
            })}
          />
        )}
      </div>
    </Modal>
  )
}

/** Cancel a draft (a failure after the first step of a file leaves one): a reason, recorded. */
function CancelModal({ dialog, actions }: { dialog: CancelDialog; actions?: ExportDialogActions | undefined }) {
  const t = usePayrollWords()
  const said = useSaid()
  const locale = useLocale()
  const held = dialog.reason.trim().length < PAYROLL_LIMITS.reasonMin ? t('cancel.heldReason') : dialog.busy ? t('held.busy') : null
  return (
    <Modal
      open
      onClose={() => actions?.onCloseCancel?.()}
      title={t('cancel.title', { month: monthWords(dialog.target.month, locale) })}
      size="sm"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={() => actions?.onCloseCancel?.()}>
            {t('common.close')}
          </Button>
          <Button size="sm" variant="danger" heldReason={held} onClick={() => actions?.onCancelDraft?.()}>
            {t('cancel.submit')}
          </Button>
        </>
      }
    >
      <div className="fw-pp-stack">
        <Field label={t('cancel.reason')}>
          <Textarea value={dialog.reason} limit={PAYROLL_LIMITS.reasonMax} rows={3} onChange={(event) => actions?.onCancelReason?.(event.target.value)} />
        </Field>
        {dialog.problem && <Banner tone="danger" title={said(dialog.problem)} />}
      </div>
    </Modal>
  )
}
