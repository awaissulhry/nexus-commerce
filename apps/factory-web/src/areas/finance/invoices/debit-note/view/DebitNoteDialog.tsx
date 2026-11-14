'use client'

import { Plus, Trash2 } from 'lucide-react'
import { Banner, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { TYPED_CHARGE_KINDS, type InvoiceRow } from '../../../_shared/api'
import { dayInstant, money, STATUS_TONE, type FinanceAbilities } from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import { DEPTH, DEPTH_NAMESPACES, type DepthProblem } from '../../test-mode/depth'
import type { DebitNotes } from '../api'
import { DEBIT_LINE_KINDS, debitableWords, debitHeld, debitProblems, emptyDebitLine, pickLabel, type DebitLineDraft, type NewKind } from '../model'
import '../../../_shared/finance.css'
import '../debit.css'

export interface DebitNoteModel {
  can: FinanceAbilities
  /** A debit note (lines here), or a credit note (the invoice picked here, its own dialog next). */
  kind: NewKind
  /** The invoice the record hands over; null: picked here from the issued ones. */
  fixed: { id: string; number: string | null; partyName: string } | null
  /** The issued invoices to pick from (null value while they load). */
  rows: { value: InvoiceRow[] | null; problem: string | null }
  invoiceId: string | null
  /** The picked invoice's debit notes and whether it takes one (a debit note only). */
  info: { value: DebitNotes | null; problem: string | null } | null
  lines: DebitLineDraft[]
  causale: string
  busy: boolean
  problem: DepthProblem | null
}

export interface DebitNoteActions {
  onPick?: (invoiceId: string | null) => void
  onLines?: (lines: DebitLineDraft[]) => void
  onCausale?: (causale: string) => void
  onCreate?: () => void
  onOpenCredit?: () => void
  onRetry?: () => void
  onClose?: () => void
}

/**
 * New ▾ › Debit note (design finance.invoices page.h "New ▾ (credit note · debit note W2b · deposit invoice)"; FIN-071): the
 * issued invoice it adds to (TD01 or TD24; handed over by the invoice record, else picked here), whether it takes one and
 * its debit notes so far, the lines added — a service, goods or a charge, with quantity and unit price; the VAT follows
 * the rules of the invoice debited — and the text. Create opens the TD05 draft; its issue waits for the accountant while
 * the company's switch is off (said here). New ▾ › Credit note picks the invoice the same way, then opens its own credit
 * note dialog.
 */
export function DebitNoteDialog({ model, actions }: { model: DebitNoteModel; actions?: DebitNoteActions }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <Dialog model={model} actions={actions} />
    </WithMessages>
  )
}

function Dialog({ model, actions }: { model: DebitNoteModel; actions?: DebitNoteActions }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const locale = useLocale()
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const debit = model.kind === 'debit'
  const problems = debitProblems(model.invoiceId, model.lines)
  const debitable = debit ? debitableWords(model.info?.value ?? null) : null
  const held = debit
    ? debitHeld({ can: model.can, busy: model.busy, problems, debitable, reading: !!model.invoiceId && !model.info?.value })
    : !model.can.manageInvoices
      ? { key: 'held.noManage' }
      : !model.invoiceId
        ? { key: 'debit.problem.invoice' }
        : null
  const setLine = (index: number, patch: Partial<DebitLineDraft>) => actions?.onLines?.(model.lines.map((line, at) => (at === index ? { ...line, ...patch } : line)))
  const info = model.info?.value ?? null
  return (
    <DialogFrame
      title={w(debit ? 'debit.title' : 'debit.creditTitle')}
      held={held ? w(held.key, 'params' in held ? held.params : undefined) : null}
      go={() => (debit ? actions?.onCreate?.() : actions?.onOpenCredit?.())}
      goLabel={model.busy ? t('common.working') : w(debit ? 'debit.go' : 'debit.creditGo')}
      onClose={() => actions?.onClose?.()}
      problem={model.problem ? { key: model.problem.key, ...(model.problem.params ? { params: model.problem.params } : {}) } : null}
      size="lg"
    >
      <p className="fw-fin-hint">{w(debit ? 'debit.explain' : 'debit.creditExplain')}</p>
      {model.fixed ? (
        <p className="fw-fin-hint">
          <b>{w('debit.of', { number: model.fixed.number ?? '—', customer: model.fixed.partyName })}</b>
        </p>
      ) : model.rows.problem ? (
        <EmptyState
          title={w('debit.pickFailed')}
          description={t(model.rows.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : !model.rows.value ? (
        <p className="fw-fin-hint" role="status">
          <Spinner size={12} /> {w('debit.pickReading')}
        </p>
      ) : model.rows.value.length === 0 ? (
        <EmptyState title={w(debit ? 'debit.pickNone' : 'debit.creditPickNone')} description={w('debit.pickNoneBody')} />
      ) : (
        <Field label={w('debit.invoice')} hint={w(debit ? 'debit.invoiceHint' : 'debit.creditInvoiceHint')}>
          <Select value={model.invoiceId ?? ''} onChange={(event) => actions?.onPick?.(event.target.value || null)}>
            <option value="">{w('debit.pickInvoice')}</option>
            {model.rows.value.map((row) => (
              <option key={row.id} value={row.id}>
                {pickLabel(row)} · {day(row.issueDate)}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {debit && model.invoiceId && (
        <>
          {model.info?.problem ? (
            <Banner tone="danger" title={w('debit.infoFailed', { why: t(model.info.problem) })} />
          ) : !info ? (
            <p className="fw-fin-hint" role="status">
              <Spinner size={12} /> {w('debit.infoReading')}
            </p>
          ) : (
            <>
              {debitable && <Banner tone="warning" title={w(debitable.key)} />}
              {info.waits !== null && <Banner tone="info" title={w('debit.waits')} />}
              {info.debitNotes.length > 0 && (
                <SummaryTable
                  label={w('debit.earlier')}
                  columns={[w('debit.col.number'), w('debit.col.status'), ...(model.can.price ? [w('debit.col.total')] : [])]}
                  rows={info.debitNotes.map((note) => ({
                    id: note.id,
                    cells: [note.number ?? t('list.draft'), <Pill key="s" tone={STATUS_TONE[note.status as keyof typeof STATUS_TONE] ?? 'neutral'}>{t(`invoiceStatus.${note.status}`)}</Pill>, ...(model.can.price ? [money(note.grossTotal, note.currency, locale)] : [])],
                  }))}
                  stackOnPhone
                />
              )}
            </>
          )}
          <fieldset className="fw-fin-choices">
            <legend className="fw-fin-legend">{w('debit.lines')}</legend>
            <ol className="fw-fin-rows" aria-label={w('debit.lines')}>
              {model.lines.map((line, index) => {
                const lineProblems = problems.lines[index] ?? {}
                return (
                  <li key={index} className="fw-fin-row is-debit">
                    <Field label={w('debit.kind', { n: index + 1 })}>
                      <Select value={line.kind} onChange={(event) => setLine(index, { kind: event.target.value as DebitLineDraft['kind'] })}>
                        {DEBIT_LINE_KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {w(`debit.lineKind.${kind}`)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={w('debit.description')} error={line.description !== '' && lineProblems.description ? w(lineProblems.description) : undefined}>
                      <Input value={line.description} maxLength={1000} onChange={(event) => setLine(index, { description: event.target.value })} autoComplete="off" />
                    </Field>
                    <Field label={w('debit.quantity')} error={lineProblems.quantity ? w(lineProblems.quantity) : undefined}>
                      <Input inputMode="decimal" value={line.quantity} onChange={(event) => setLine(index, { quantity: event.target.value })} autoComplete="off" />
                    </Field>
                    <Field label={w('debit.unitPrice')} error={line.unitPrice !== '' && lineProblems.unitPrice ? w(lineProblems.unitPrice) : undefined}>
                      <Input inputMode="decimal" value={line.unitPrice} onChange={(event) => setLine(index, { unitPrice: event.target.value })} autoComplete="off" />
                    </Field>
                    <span className="fw-fin-row-end">
                      {line.kind === 'CHARGE' && (
                        <Select size="sm" aria-label={w('debit.chargeKind')} value={line.chargeKind} onChange={(event) => setLine(index, { chargeKind: event.target.value as DebitLineDraft['chargeKind'] })}>
                          {TYPED_CHARGE_KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                              {w(`debit.chargeKinds.${kind}`)}
                            </option>
                          ))}
                        </Select>
                      )}
                      {model.lines.length > 1 && (
                        <Button size="sm" variant="link" onClick={() => actions?.onLines?.(model.lines.filter((_, at) => at !== index))} aria-label={w('debit.removeLine', { n: index + 1 })}>
                          <Trash2 size={13} aria-hidden /> {w('debit.remove')}
                        </Button>
                      )}
                    </span>
                  </li>
                )
              })}
            </ol>
            {model.lines.length < 50 && (
              <span className="fw-fin-inline">
                <Button size="sm" variant="quiet" onClick={() => actions?.onLines?.([...model.lines, emptyDebitLine()])}>
                  <Plus size={13} aria-hidden /> {w('debit.addLine')}
                </Button>
              </span>
            )}
          </fieldset>
          <Field label={w('debit.causale')} hint={w('debit.causaleHint')}>
            <Textarea value={model.causale} maxLength={500} rows={2} onChange={(event) => actions?.onCausale?.(event.target.value)} />
          </Field>
          <p className="fw-fin-hint">{w('debit.vat')}</p>
        </>
      )}
      {!debit && model.invoiceId && <p className="fw-fin-hint">{w('debit.creditNext')}</p>}
    </DialogFrame>
  )
}
