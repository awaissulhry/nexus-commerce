'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Banner, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Invoice } from '../../../_shared/api'
import { dayInstant, DEADLINE_TONE, deadlineWords, money, STATUS_TONE, type FinanceAbilities, type Phrase } from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import type { DeferredGroup, ReturnCredit } from '../api'
import { CHARGE_KINDS, chargeProblems, ddtsOf, monthWords, returnCreditHeld, skipKey, type ChargeDraft, type ChargeKind } from '../model'

/**
 * The invoice screens' every-day dialogs (B-W2a-80), composed from the DS (packages/ui is frozen): Add a charge line
 * (design invoice tab "lines": charge lines — freight, packaging, samples, a fee), the month's deferred invoice of a
 * customer ("Create deferred invoice for N DDTs of <customer>"), the credit notes of a customer return (design pop-up
 * credit-note, opened from the return's inspection), and "carry the credit" of an over-paid invoice. Each fetches nothing:
 * its host passes what it shows and does what it asks. A refusal is said inside the dialog; what was typed stays.
 */

const kindWords = (t: (key: string) => string, kind: ChargeKind) => t(`charge.kind.${kind}`)

/** Add a charge line to a draft: its kind, its words (prefilled by the kind), quantity, unit price, the DDT it belongs to. */
export function ChargeDialog({
  invoice,
  ddtNumbers,
  busy,
  problem,
  can,
  start,
  onSave,
  onClose,
}: {
  invoice: Invoice
  /** The DDT numbers by id (the record's related read). */
  ddtNumbers: Readonly<Record<string, string>>
  busy: boolean
  problem: Phrase | null
  can: Pick<FinanceAbilities, 'manageInvoices' | 'price'>
  start?: Partial<ChargeDraft>
  onSave: (draft: ChargeDraft) => void
  onClose: () => void
}) {
  const t = useT('finance')
  const d = useT('finance-daily')
  const ddts = ddtsOf(invoice)
  const [draft, setDraft] = useState<ChargeDraft>({ kind: start?.kind ?? '', description: start?.description ?? '', quantity: start?.quantity ?? '1', unitPrice: start?.unitPrice ?? '', ddtId: start?.ddtId ?? (ddts.length === 1 ? ddts[0]! : '') })
  const [typedWords, setTypedWords] = useState(!!start?.description)
  const problems = chargeProblems(draft, ddts.length)
  const first = problems.kind ?? problems.description ?? problems.quantity ?? problems.unitPrice ?? problems.ddt ?? null
  const held = busy ? t('held.busy') : !can.manageInvoices ? d('charge.held.noManage') : !can.price ? d('charge.held.noPrice') : first ? d(first) : null
  const set = (field: keyof ChargeDraft, value: string) => setDraft((current) => ({ ...current, [field]: value }))
  return (
    <DialogFrame title={d('charge.title')} held={held} go={() => onSave(draft)} goLabel={busy ? t('common.working') : d('charge.go')} onClose={onClose} problem={problem}>
      <p className="fw-fin-hint">{d('charge.body')}</p>
      <div className="fw-fin-two">
        <Field label={d('charge.kindLabel')} error={draft.kind === '' ? undefined : problems.kind ? d(problems.kind) : undefined}>
          <Select
            value={draft.kind}
            onChange={(event) => {
              const kind = event.target.value as ChargeKind | ''
              setDraft((current) => ({ ...current, kind, description: typedWords || kind === '' ? current.description : d(`charge.words.${kind}`) }))
            }}
          >
            <option value="">{d('charge.pickKind')}</option>
            {CHARGE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kindWords(d, kind)}
              </option>
            ))}
          </Select>
        </Field>
        {ddts.length > 1 && (
          <Field label={d('charge.ddt')} hint={d('charge.ddtHint')} error={problems.ddt && draft.kind !== '' ? d(problems.ddt) : undefined}>
            <Select value={draft.ddtId} onChange={(event) => set('ddtId', event.target.value)}>
              <option value="">{d('charge.pickDdt')}</option>
              {ddts.map((id) => (
                <option key={id} value={id}>
                  {t('shipped.ddt', { number: ddtNumbers[id] ?? '—' })}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      <Field label={d('charge.description')} hint={d('charge.descriptionHint')} error={draft.description && problems.description ? d(problems.description) : undefined}>
        <Input
          value={draft.description}
          maxLength={1000}
          onChange={(event) => {
            setTypedWords(true)
            set('description', event.target.value)
          }}
          autoComplete="off"
        />
      </Field>
      <div className="fw-fin-two">
        <Field label={d('charge.quantity')} error={problems.quantity ? d(problems.quantity) : undefined}>
          <Input inputMode="decimal" value={draft.quantity} onChange={(event) => set('quantity', event.target.value)} autoComplete="off" />
        </Field>
        <Field label={d('charge.unitPrice', { currency: invoice.currency })} error={draft.unitPrice && problems.unitPrice ? d(problems.unitPrice) : undefined}>
          <Input inputMode="decimal" value={draft.unitPrice} onChange={(event) => set('unitPrice', event.target.value)} autoComplete="off" />
        </Field>
      </div>
      <p className="fw-fin-hint">{d('charge.vat')}</p>
      {busy && (
        <p className="fw-fin-hint" role="status">
          <Spinner size={12} /> {d('charge.saving')}
        </p>
      )}
    </DialogFrame>
  )
}

/** The month's deferred invoice of a customer (one TD24 of every DDT of that month still to invoice), then its draft opens. */
export function DeferredDialog({ group, busy, problem, can, held: outerHeld, onCreate, onClose }: { group: DeferredGroup; busy: boolean; problem: Phrase | null; can: Pick<FinanceAbilities, 'price'>; held: Phrase | null; onCreate: () => void; onClose: () => void }) {
  const t = useT('finance')
  const d = useT('finance-daily')
  const locale = useLocale()
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const deadline = group.deadline ? deadlineWords(group.deadline) : null
  const held = busy ? t('held.busy') : outerHeld ? d(outerHeld.key, outerHeld.params) : null
  return (
    <DialogFrame
      title={d('deferred.dialogTitle', { month: monthWords(group.month, locale), customer: group.legalName })}
      held={held}
      go={onCreate}
      goLabel={busy ? t('common.working') : d('deferred.go', { count: group.ddts.length, customer: group.legalName })}
      onClose={onClose}
      problem={problem}
    >
      <p className="fw-fin-hint">{d('deferred.dialogBody')}</p>
      <KeyValue
        dense
        labelCase="sentence"
        columns={2}
        items={[
          { label: d('deferred.customer'), value: `${group.legalName} · ${group.code}` },
          { label: d('deferred.month'), value: monthWords(group.month, locale) },
          { label: d('deferred.ddts'), value: group.ddts.map((ddt) => `${ddt.number} (${day(ddt.date)})`).join(', ') },
          ...(can.price ? [{ label: d('deferred.value'), value: money(group.valueAmount, 'EUR', locale) }] : []),
          ...(can.price ? [{ label: d('deferred.freightLabel'), value: (group.freightAmount ?? 0) > 0 ? money(group.freightAmount, 'EUR', locale) : d('deferred.noFreight') }] : []),
          { label: d('deferred.deadline'), value: group.deadline ? <Pill tone={DEADLINE_TONE[group.deadline.state]}>{t(deadline!.key, deadline!.params)}</Pill> : '—', hint: group.deadline ? t('shipped.dueBy', { date: day(group.deadline.dueBy) }) : undefined },
        ]}
      />
      {group.drafts.length > 0 && <Banner tone="info" title={d('deferred.someInDraft', { count: group.drafts.length })} />}
      <p className="fw-fin-hint">{d('deferred.after')}</p>
    </DialogFrame>
  )
}

/**
 * The credit notes of a customer return (design pop-up credit-note opened from the return's inspection; B-W2a-61): what
 * the return's decision credits, one draft credit note per invoice that billed its lines (the lines, the pieces, the net),
 * the lines left out and why, and the credit notes it has already. Create makes every draft at once; the first opens.
 */
export function ReturnCreditDialog({
  answer,
  readProblem,
  busy,
  problem,
  can,
  prefix,
  onRetry,
  onCreate,
  onClose,
}: {
  answer: ReturnCredit | null
  readProblem: string | null
  busy: boolean
  problem: Phrase | null
  can: Pick<FinanceAbilities, 'manageInvoices' | 'price'>
  prefix: string
  onRetry: () => void
  onCreate: (lineIds: string[] | null) => void
  onClose: () => void
}) {
  const t = useT('finance')
  const d = useT('finance-daily')
  const locale = useLocale()
  const allLines = answer?.toCredit.flatMap((note) => note.lines.map((line) => line.returnLineId)) ?? []
  const [picked, setPicked] = useState<string[] | null>(null)
  const chosen = picked ?? allLines
  const wait = returnCreditHeld(answer, can)
  const held = busy ? t('held.busy') : wait ? d(wait.key, wait.params) : chosen.length === 0 ? d('returnCredit.held.noLine') : null
  const title = answer ? d('returnCredit.title', { number: answer.return.number }) : d('returnCredit.titleLoading')
  return (
    <DialogFrame title={title} held={held} go={() => onCreate(picked === null || picked.length === allLines.length ? null : chosen)} goLabel={busy ? t('common.working') : d('returnCredit.go', { count: answer?.toCredit.length ?? 0 })} onClose={onClose} problem={problem} size="lg">
      {readProblem ? (
        <Banner
          tone="danger"
          title={d('returnCredit.failed')}
          action={
            <Button size="sm" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(readProblem)}
        </Banner>
      ) : !answer ? (
        <p className="fw-fin-hint" role="status">
          <Spinner size={12} /> {d('returnCredit.loading')}
        </p>
      ) : (
        <>
          <p className="fw-fin-hint">{d('returnCredit.body')}</p>
          {can.price && (
            <KeyValue
              dense
              labelCase="sentence"
              columns={2}
              items={[
                { label: d('returnCredit.decided'), value: money(answer.creditDecidedAmount, 'EUR', locale) },
                { label: d('returnCredit.noted'), value: money(answer.creditNotedAmount, 'EUR', locale) },
              ]}
            />
          )}
          {answer.toCredit.length === 0 ? (
            <Banner tone="info" title={d('returnCredit.nothing')} />
          ) : (
            answer.toCredit.map((note) => (
              <fieldset key={note.creditOfId} className="fw-fin-choices">
                <legend className="fw-fin-legend">{d('returnCredit.ofInvoice', { number: note.invoiceNumber })}</legend>
                {note.lines.map((line) => (
                  <Checkbox
                    key={line.returnLineId}
                    checked={chosen.includes(line.returnLineId)}
                    onChange={(event) => setPicked((event.target.checked ? [...chosen, line.returnLineId] : chosen.filter((id) => id !== line.returnLineId)))}
                    label={`${d('returnCredit.line', { seq: line.seq, pieces: line.pieces })} · ${line.description}${can.price ? ` · ${money(line.netAmount, note.currency, locale)}` : ''}`}
                  />
                ))}
                {can.price && <p className="fw-fin-hint">{d('returnCredit.noteTotal', { amount: money(note.netTotal, note.currency, locale) })}</p>}
              </fieldset>
            ))
          )}
          {answer.notCredited.length > 0 && (
            <>
              <h3 className="fw-fin-h3">{d('returnCredit.leftOut')}</h3>
              <ul className="fw-fin-list">
                {answer.notCredited.map((entry) => (
                  <li key={entry.lineId}>{d('returnCredit.skipLine', { seq: entry.seq, why: d(skipKey(entry.code)) })}</li>
                ))}
              </ul>
            </>
          )}
          {answer.creditNotes.length > 0 && (
            <>
              <h3 className="fw-fin-h3">{d('returnCredit.existing')}</h3>
              <SummaryTable
                label={d('returnCredit.existing')}
                columns={[d('returnCredit.col.note'), d('returnCredit.col.of'), d('returnCredit.col.status'), ...(can.price ? [d('returnCredit.col.amount')] : [])]}
                rows={answer.creditNotes.map((note) => ({
                  id: note.id,
                  cells: [
                    <Link key="n" className="fw-fin-link" href={`${prefix}/finance/invoices/${note.id}`}>
                      {note.number ?? t('list.draft')}
                    </Link>,
                    note.creditOfNumber ?? '—',
                    <Pill key="s" tone={STATUS_TONE[note.status]}>{t(`invoiceStatus.${note.status}`)}</Pill>,
                    ...(can.price ? [money(note.grossTotal, note.currency, locale)] : []),
                  ],
                }))}
                stackOnPhone
              />
            </>
          )}
          <p className="fw-fin-hint">{d('returnCredit.after')}</p>
        </>
      )}
    </DialogFrame>
  )
}

/** "Carry to the credit balance": the over-paid part of an invoice goes back to its payments (a note says why). */
export function CarryDialog({ invoice, busy, problem, onCarry, onClose, start }: { invoice: Invoice; busy: boolean; problem: Phrase | null; onCarry: (note: string) => void; onClose: () => void; start?: string }) {
  const t = useT('finance')
  const d = useT('finance-daily')
  const locale = useLocale()
  const [note, setNote] = useState(start ?? '')
  const tooShort = note.trim().length < 3
  const held = busy ? t('held.busy') : tooShort ? d('carry.problem.note') : null
  return (
    <DialogFrame title={d('carry.title', { number: invoice.number ?? '—' })} held={held} go={() => onCarry(note.trim())} goLabel={busy ? t('common.working') : d('carry.go', { amount: money(invoice.refundDueAmount, invoice.currency, locale) })} onClose={onClose} problem={problem}>
      <p className="fw-fin-hint">{d('carry.body', { amount: money(invoice.refundDueAmount, invoice.currency, locale) })}</p>
      <Field label={d('carry.note')} hint={d('carry.noteHint')}>
        <Textarea value={note} rows={2} maxLength={500} onChange={(event) => setNote(event.target.value)} />
      </Field>
      <p className="fw-fin-hint">{d('carry.orRefund')}</p>
    </DialogFrame>
  )
}
