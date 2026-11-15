'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Banner, Card, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { money } from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import { PAY_DEPTH, PAY_DEPTH_NAMESPACES, type PayProblem, type Phrase } from '../../riba/depth'
import { MAX_WRITE_OFF_NOTE, WRITE_OFF_REASONS, type PaymentWriteOffs, type PossibleWriteOff, type WriteOff, type WriteOffReason } from '../api'
import { possibleHeld, reasonHeld, reverseHeld, reversible, takeBackHeld, type WriteOffCan } from '../model'

export type WriteOffDialog = { kind: 'writeOff'; possible: PossibleWriteOff } | { kind: 'takeBack'; writeOff: WriteOff }

export interface WriteOffModel {
  prefix: string
  can: WriteOffCan
  currency: string
  voided: boolean
  /** The payment's write-offs and what may be written off (null while read). */
  answer: PaymentWriteOffs | null
  problem: string | null
  /** The people the payment names (who wrote each one off). */
  people: ReadonlyArray<{ id: string; name: string | null }>
  dialog: WriteOffDialog | null
  busy: boolean
  writeProblem: PayProblem | null
  notice: Phrase | null
  /** Design cases: what the dialog holds typed. */
  draft?: { reason?: WriteOffReason; note?: string }
}

export interface WriteOffActions {
  onRetry?: () => void
  onDialog?: (dialog: WriteOffDialog | null) => void
  onWriteOff?: (possible: PossibleWriteOff, reason: WriteOffReason, note: string) => void
  onTakeBack?: (writeOff: WriteOff, note: string) => void
  onDismissNotice?: () => void
}

/**
 * The payment's small difference (design finance.payments rec:Payment allocation "small difference → write-off within
 * tolerance"; SCR-513): the company's write-off tolerance in force, each difference the payment leaves — a customer who
 * paid a few cents less on one invoice, or a little more — with "Write off…" when it is within the tolerance (the WHOLE
 * difference, with a reason: rounding, the bank's charges, or another one said in a note) and held with why otherwise;
 * then the write-offs made, each taken back with a note (the ledger never changes). Nothing drawn while the payment leaves
 * no difference and has none. Amounts only with the price grain.
 */
export function WriteOffCard({ model, actions }: { model: WriteOffModel; actions?: WriteOffActions }) {
  return (
    <WithMessages namespaces={PAY_DEPTH_NAMESPACES}>
      <CardBody model={model} actions={actions} />
    </WithMessages>
  )
}

function CardBody({ model, actions }: { model: WriteOffModel; actions?: WriteOffActions }) {
  const p = useT(PAY_DEPTH)
  const t = useT('finance')
  const s = useScopedT('finance')
  const locale = useLocale()
  const say = (phrase: Phrase | null) => (phrase ? s(phrase.key, phrase.params) : null)
  const m = (value: number | null | undefined) => money(value, model.currency, locale)
  if (model.problem) {
    return (
      <Card padded className="fw-fin-card">
        <h2 className="fw-fin-h2">{p('writeOff.title')}</h2>
        <p className="fw-fin-hint">{p('writeOff.failed', { reason: t(model.problem) })}</p>
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      </Card>
    )
  }
  const answer = model.answer
  if (!answer) {
    return (
      <p className="fw-fin-hint" role="status">
        <Spinner size={12} /> {p('writeOff.reading')}
      </p>
    )
  }
  if (answer.possible.length === 0 && answer.writeOffs.length === 0) return null
  const tolerance = answer.tolerance
  return (
    <Card padded className="fw-fin-card">
      <h2 className="fw-fin-h2">{p('writeOff.title')}</h2>
      {model.notice && (
        <Banner
          tone="success"
          title={say(model.notice) ?? ''}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      <p className="fw-fin-hint">
        {tolerance.source === null
          ? p('writeOff.tolerance.none')
          : model.can.price && tolerance.amount !== undefined && tolerance.amount !== null
            ? p(`writeOff.tolerance.${tolerance.source}`, { amount: m(tolerance.amount) })
            : p(`writeOff.tolerance.${tolerance.source}Plain`)}
      </p>
      {answer.possible.length > 0 && (
        <SummaryTable
          label={p('writeOff.possible')}
          columns={[p('writeOff.col.difference'), ...(model.can.price ? [p('writeOff.col.amount')] : []), p('writeOff.col.action')]}
          align={['left', ...(model.can.price ? (['right'] as const) : []), 'right']}
          stackOnPhone
          rows={answer.possible.map((possible, index) => {
            const held = possibleHeld(possible, answer, model.can, model.voided, model.busy)
            return {
              id: `${possible.kind}-${possible.allocationId ?? index}`,
              cells: [
                <span key="d" className="fw-fin-cell">
                  <span>{p(`writeOff.kind.${possible.kind}`)}</span>
                  <span className="fw-fin-cell-sub">
                    {possible.invoiceId ? (
                      <Link className="fw-fin-link" href={`${model.prefix}/finance/invoices/${possible.invoiceId}`}>
                        {p('writeOff.onInvoice', { number: possible.number ?? '—' })}
                      </Link>
                    ) : (
                      p('writeOff.onPayment')
                    )}
                    {' · '}
                    {possible.withinTolerance ? p('writeOff.within') : p('writeOff.over')}
                  </span>
                </span>,
                ...(model.can.price ? [m(possible.amount)] : []),
                <Button key="a" size="sm" heldReason={say(held)} onClick={() => actions?.onDialog?.({ kind: 'writeOff', possible })}>
                  {p('writeOff.go')}
                </Button>,
              ],
            }
          })}
        />
      )}
      {answer.writeOffs.length > 0 && (
        <SummaryTable
          label={p('writeOff.made')}
          columns={[p('writeOff.col.what'), p('writeOff.col.when'), ...(model.can.price ? [p('writeOff.col.amount')] : []), p('writeOff.col.action')]}
          align={['left', 'left', ...(model.can.price ? (['right'] as const) : []), 'right']}
          stackOnPhone
          rows={answer.writeOffs.map((row) => ({
            id: row.id,
            cells: [
              <span key="w" className="fw-fin-cell">
                <span>
                  {p(`writeOff.kind.${row.kind}`)} · {p(`writeOff.reason.${row.reason}`)}
                </span>
                <span className="fw-fin-cell-sub">{row.reversalOfId ? p('writeOff.reversal', { note: row.note ?? '—' }) : row.reversed ? p('writeOff.reversed') : (row.note ?? p('writeOff.noNote'))}</span>
              </span>,
              <span key="t" className="fw-fin-cell">
                <span>{formatDateTime(row.createdAt, { locale })}</span>
                <span className="fw-fin-cell-sub">{model.people.find((person) => person.id === row.writtenOffById)?.name ?? p('riba.someone')}</span>
              </span>,
              ...(model.can.price ? [m(row.amount)] : []),
              reversible(row) ? (
                <Button key="b" size="sm" variant="link" heldReason={say(reverseHeld(row, model.can, model.busy))} onClick={() => actions?.onDialog?.({ kind: 'takeBack', writeOff: row })}>
                  {p('writeOff.takeBack')}
                </Button>
              ) : (
                <Pill key="b" tone="neutral">
                  {row.reversalOfId ? p('writeOff.state.reversal') : p('writeOff.state.reversed')}
                </Pill>
              ),
            ],
          }))}
        />
      )}
      {model.dialog && <WriteOffDialogView key={model.dialog.kind === 'writeOff' ? `w-${model.dialog.possible.allocationId}` : `t-${model.dialog.writeOff.id}`} model={model} dialog={model.dialog} actions={actions} />}
    </Card>
  )
}

function WriteOffDialogView({ model, dialog, actions }: { model: WriteOffModel; dialog: WriteOffDialog; actions?: WriteOffActions }) {
  const p = useT(PAY_DEPTH)
  const s = useScopedT('finance')
  const locale = useLocale()
  const [reason, setReason] = useState<WriteOffReason>(model.draft?.reason ?? 'ROUNDING')
  const [note, setNote] = useState(model.draft?.note ?? '')
  const say = (phrase: Phrase | null) => (phrase ? s(phrase.key, phrase.params) : null)
  const close = () => actions?.onDialog?.(null)
  if (dialog.kind === 'writeOff') {
    const held = model.busy ? s('common.working') : say(reasonHeld(reason, note))
    const amount = model.can.price ? money(dialog.possible.amount, model.currency, locale) : null
    return (
      <DialogFrame title={p('writeOff.dialog.title')} held={held} go={() => actions?.onWriteOff?.(dialog.possible, reason, note.trim())} goLabel={amount ? p('writeOff.dialog.go', { amount }) : p('writeOff.dialog.goPlain')} onClose={close} problem={model.writeProblem}>
        <p className="fw-fin-hint">{p(`writeOff.dialog.body.${dialog.possible.kind}`, { number: dialog.possible.number ?? '—' })}</p>
        <Field label={p('writeOff.dialog.reason')}>
          <Select value={reason} onChange={(event) => setReason(event.target.value as WriteOffReason)}>
            {WRITE_OFF_REASONS.map((value) => (
              <option key={value} value={value}>
                {p(`writeOff.reason.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={p('writeOff.dialog.note')} hint={reason === 'OTHER' ? p('writeOff.dialog.noteNeeded') : p('writeOff.dialog.noteOptional')}>
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={MAX_WRITE_OFF_NOTE} rows={3} />
        </Field>
        <p className="fw-fin-hint">{p('writeOff.dialog.after')}</p>
      </DialogFrame>
    )
  }
  const held = model.busy ? s('common.working') : say(takeBackHeld(note))
  return (
    <DialogFrame title={p('writeOff.takeBackTitle')} held={held} go={() => actions?.onTakeBack?.(dialog.writeOff, note.trim())} goLabel={p('writeOff.takeBackGo')} tone="danger" onClose={close} problem={model.writeProblem}>
      <p className="fw-fin-hint">{p(`writeOff.takeBackBody.${dialog.writeOff.kind}`)}</p>
      <Field label={p('writeOff.dialog.note')} hint={p('writeOff.dialog.noteNeeded')}>
        <Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={MAX_WRITE_OFF_NOTE} rows={3} />
      </Field>
    </DialogFrame>
  )
}
