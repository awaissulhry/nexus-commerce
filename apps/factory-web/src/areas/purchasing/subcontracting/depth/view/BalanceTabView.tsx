'use client'

import { Scale } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { ActionConfirm, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { quantity } from '../../../../_shared/buying/model'
import { say, type Words } from '../../model'
import type { BalanceLine, ConsumptionRow, OrderBalance } from '../api'
import {
  adjustAfter,
  adjustDraftOf,
  adjustHeld,
  adjustHeldDraft,
  balanceRungs,
  declareHeld,
  declareDraftOf,
  declareHeldDraft,
  declareMoves,
  DEPTH,
  FLAG_TONE,
  flagWords,
  movesOf,
  plain,
  typedQuantity,
  type AdjustDraft,
  type BalanceActions,
  type BalanceModel,
  type DeclareDraft,
} from '../model'
import '../depth.css'

/**
 * Subcontract order › Material balance (design purchasing.subcontracting rec:balance; SCM-143, SCM-144; "NEW Bridge" +
 * ActionConfirm): our material stays ours while the workshop has it. Per material sent with the kit, the bridge "sent →
 * in the garments → returned unused → scrapped → still open" (the open rest red once every piece is back), what is wrong
 * with it in words (counted short on arrival, not declared, declared returned but not back, back but not declared, open
 * after every piece is back), what the workshop counted, announced and what came back into our places, the days out, and
 * every declaration and adjustment with who booked it and why. "Book the workshop's declaration" (prefilled from what the
 * goods back suggest, naming the receipt) and, per line, "Book over- or under-consumption" (signed changes with a reason)
 * each confirm what they move. No money in this tab.
 */
export function BalanceTabView({ model, actions }: { model: BalanceModel; actions?: BalanceActions }) {
  return (
    <WithMessages namespaces={[DEPTH]}>
      <Balance model={model} actions={actions} />
    </WithMessages>
  )
}

const useSay = () => {
  const t = useT(DEPTH)
  return (value: Words) => say(t, value)
}

function Balance({ model, actions }: { model: BalanceModel; actions?: BalanceActions }) {
  const t = useT(DEPTH)
  const sayWords = useSay()
  const loaded = model.balance
  if (loaded.status === 'loading') {
    return (
      <Card padded aria-busy="true">
        <div className="fw-by-stack">
          <p className="fw-by-hint" role="status">
            <Spinner size={14} /> {model.slow ? t('balance.slow') : t('balance.loading')}
          </p>
          <div className="fw-by-ladder">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} height={52} />
            ))}
          </div>
          <Skeleton height={18} width="40%" />
        </div>
      </Card>
    )
  }
  if (loaded.status !== 'ready') {
    return (
      <Card padded>
        <EmptyState
          title={t('balance.failed')}
          description={t(loaded.status === 'error' ? loaded.problem : loaded.status === 'forbidden' ? 'problem.forbidden' : 'problem.gone')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      </Card>
    )
  }
  const balance = loaded.value
  const held = declareHeld(balance, model.can)
  const declareReason = model.busy ? t('held.busy') : held ? sayWords(held) : null
  const openAfterBack = balance.lines.filter((line) => line.flags.some((flag) => flag.flag === 'OPEN_AFTER_BACK')).length
  return (
    <div className="fw-by-stack">
      <div className="fw-by-head">
        <span className="fw-by-hint">{t('balance.intro')}</span>
        <Button size="sm" variant="primary" heldReason={declareReason} onClick={() => actions?.onDialog?.({ kind: 'declare', draft: declareDraftOf(balance) })}>
          <Scale size={14} aria-hidden /> {t('balance.declare.open')}
        </Button>
      </div>
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={sayWords(model.notice.words)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {balance.balanceOpen && <Banner tone="danger" title={t('balance.openAfterBack', { count: openAfterBack })} />}
      {balance.lines.length === 0 ? (
        <Card padded>
          <EmptyState title={t('balance.empty.title')} description={t('balance.empty.body')} />
        </Card>
      ) : (
        <div className="fw-scd-lines">
          {balance.lines.map((line) => (
            <LineCard key={line.kitLineId} line={line} balance={balance} model={model} actions={actions} />
          ))}
        </div>
      )}
      {model.dialog?.kind === 'declare' && <DeclareDialog draft={model.dialog.draft} balance={balance} model={model} actions={actions} />}
      {model.dialog?.kind === 'adjust' && <AdjustDialog draft={model.dialog.draft} balance={balance} model={model} actions={actions} />}
    </div>
  )
}


/** A quantity with its unit in the person's language ("42,6 m"). */
function useAmount() {
  const t = useT(DEPTH)
  const locale = useLocale()
  return (text: string, uom: string) => `${quantity(text, locale, 4)} ${t(`uom.${uom}`)}`
}

/** "+0,1" / "−0,1" for an adjustment's change. */
function useSigned() {
  const locale = useLocale()
  return (text: string) => {
    const value = Number(text)
    if (value === 0) return '0'
    return `${value > 0 ? '+' : '−'}${quantity(Math.abs(value), locale, 4)}`
  }
}

function LineCard({ line, balance, model, actions }: { line: BalanceLine; balance: OrderBalance; model: BalanceModel; actions?: BalanceActions }) {
  const t = useT(DEPTH)
  const sayWords = useSay()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const amount = useAmount()
  const held = adjustHeld(balance, line, model.can)
  const rungs = balanceRungs(line, balance.order)
  const sub = [line.colour ? `${line.colour.code} ${line.colour.name}` : null, line.lot ? t('balance.lot', { code: line.lot.code }) : null, line.hide ? t('balance.hide', { code: line.hide.code }) : null, line.sentAt ? t('balance.sentOn', { date: formatDate(line.sentAt, place) }) : null].filter(Boolean)
  const facts = [
    { label: t('balance.fact.checked'), value: line.checkedByWorkshop ? amount(line.checkedByWorkshop.quantity, line.uom) : t('balance.fact.notChecked'), hint: line.checkedByWorkshop?.note ?? undefined },
    { label: t('balance.fact.announced'), value: amount(line.announcedBack, line.uom) },
    { label: t('balance.fact.back'), value: amount(line.backInOurPlaces, line.uom) },
    { label: t('balance.fact.daysOut'), value: line.daysOut === null ? t('balance.fact.nothingOut') : t('balance.days', { count: line.daysOut }) },
  ]
  return (
    <Card padded>
      <section className="fw-by-stack" aria-label={t('balance.lineLabel', { line: line.seq, code: line.item.code })}>
        <div className="fw-by-card-head">
          <h3 className="fw-by-h3">
            {t('balance.line', { line: line.seq })} <span className="fw-by-code">{line.item.code}</span> {line.item.name}
          </h3>
          <Button size="sm" variant="secondary" heldReason={model.busy ? t('held.busy') : held ? sayWords(held) : null} onClick={() => actions?.onDialog?.({ kind: 'adjust', draft: adjustDraftOf(line.kitLineId) })}>
            {t('balance.adjust.open')}
          </Button>
        </div>
        {sub.length > 0 && <p className="fw-by-hint">{sub.join(' · ')}</p>}
        <ol className="fw-by-ladder" aria-label={t('balance.bridge', { line: line.seq })}>
          {rungs.map((rung) => (
            <li key={rung.key} className={rung.key === 'open' ? `fw-by-rung is-result${rung.alarm ? ' fw-scd-alarm' : ''}` : 'fw-by-rung'}>
              <span className="fw-by-rung-label">{t(`balance.rung.${rung.key}`)}</span>
              <span className="fw-by-rung-value">
                {rung.key === 'sent' ? '' : rung.key === 'open' ? '= ' : '− '}
                {amount(rung.quantity, line.uom)}
              </span>
            </li>
          ))}
        </ol>
        {line.flags.length > 0 && (
          <ul className="fw-by-list" aria-label={t('balance.flagsLabel')}>
            {line.flags.map((flag) => (
              <li key={flag.flag} className="fw-by-check fw-by-check-wrap">
                <Tag tone={FLAG_TONE[flag.flag]}>{t(`balance.flagName.${flag.flag}`)}</Tag>
                <span className="fw-by-check-body">{sayWords(flagWords(flag.flag, line))}</span>
              </li>
            ))}
          </ul>
        )}
        <KeyValue dense columns={2} phoneColumns={2} labelCase="sentence" items={facts} />
        {line.rows.length === 0 ? <p className="fw-by-hint">{t('balance.rows.none')}</p> : <Rows line={line} model={model} />}
      </section>
    </Card>
  )
}

function Rows({ line, model }: { line: BalanceLine; model: BalanceModel }) {
  const t = useT(DEPTH)
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const signed = useSigned()
  const cell = (row: ConsumptionRow, text: string) => (row.kind === 'ADJUSTMENT' ? signed(text) : quantity(text, locale, 4))
  return (
    <SummaryTable
      label={t('balance.rows.label', { line: line.seq })}
      stackOnPhone
      columns={[t('balance.rows.what'), t('balance.rung.used'), t('balance.rung.returned'), t('balance.rung.scrapped'), t('balance.rows.with'), t('balance.rows.why'), t('balance.rows.booked')]}
      align={[undefined, 'right', 'right', 'right', undefined, undefined, undefined]}
      widths={['14%', '10%', '10%', '10%', '12%', '24%', '20%']}
      rows={line.rows.map((row) => ({
        id: row.id,
        cells: [
          <span key="what" className="fw-by-cell">
            <span>{t(`balance.kind.${row.kind}`)}</span>
            <span className="fw-by-cell-sub">{t('balance.rows.reported', { date: formatDate(row.reportedAt, place) })}</span>
          </span>,
          cell(row, row.used),
          cell(row, row.returned),
          cell(row, row.scrapped),
          row.receipt ? t('balance.rows.receipt', { seq: row.receipt.seq }) : '—',
          row.reason ?? '—',
          <span key="booked" className="fw-by-cell">
            <span>{row.bookedBy ?? t('balance.rows.system')}</span>
            <span className="fw-by-cell-sub">{formatDateTime(row.bookedAt, place)}</span>
          </span>,
        ],
      }))}
    />
  )
}

/** B-W2b-408 (follow-up GL1:01): why the booking goes into a soft-locked month (asked once the API said so; kept in the audit). */
function LockReasonField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useT(DEPTH)
  return (
    <Field label={t('balance.lock.label')} required hint={t('balance.lock.hint')}>
      <Textarea rows={2} maxLength={500} value={value} onChange={(event) => onChange(event.target.value)} />
    </Field>
  )
}

function DeclareDialog({ draft, balance, model, actions }: { draft: DeclareDraft; balance: OrderBalance; model: BalanceModel; actions?: BalanceActions }) {
  const t = useT(DEPTH)
  const sayWords = useSay()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const amount = useAmount()
  const set = (next: Partial<DeclareDraft>) => actions?.onDialog?.({ kind: 'declare', draft: { ...draft, ...next } })
  const setLine = (kitLineId: string, field: 'used' | 'returned' | 'scrapped', value: string) => set({ lines: draft.lines.map((entry) => (entry.kitLineId === kitLineId ? { ...entry, [field]: value } : entry)) })
  const held = declareHeldDraft(draft, balance)
  // A refusal from the server is said above (the confirm stays enabled, so the focus stays on it and a retry reads again);
  // only the draft's own holds disable it. A second press while busy is ignored by the container.
  const refusal = held ? sayWords(held) : null
  const moves = held ? [] : declareMoves(draft, balance, model.workOrder).map(sayWords)
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal open onClose={close} title={t('balance.declare.title', { number: balance.order.number })} size="lg">
      <div className="fw-by-dialog">
        <p className="fw-by-hint">{t('balance.declare.intro')}</p>
        <Field label={t('balance.declare.receipt')} hint={t('balance.declare.receiptHint')}>
          <Select size="sm" value={draft.receiptId} onChange={(event) => set({ receiptId: event.target.value })}>
            <option value="">{t('balance.declare.noReceipt')}</option>
            {balance.receipts.map((receipt) => (
              <option key={receipt.id} value={receipt.id}>
                {t('balance.declare.receiptOption', { seq: receipt.seq, date: formatDate(receipt.receivedAt, place) })}
              </option>
            ))}
          </Select>
        </Field>
        {draft.lines.map((entry) => {
          const line = balance.lines.find((candidate) => candidate.kitLineId === entry.kitLineId)
          if (!line) return null
          const unit = t(`uom.${line.uom}`)
          return (
            <fieldset key={entry.kitLineId} className="fw-scd-declare">
              <legend className="fw-by-h3">
                {t('balance.line', { line: line.seq })} <span className="fw-by-code">{line.item.code}</span> {line.item.name}
              </legend>
              <p className="fw-by-hint">{t('balance.declare.lineOpen', { open: amount(line.open, line.uom), sent: amount(line.sent, line.uom) })}</p>
              <div className="fw-by-fields">
                {(['used', 'returned', 'scrapped'] as const).map((field) => (
                  <Field key={field} label={t(`balance.rung.${field}`)} hint={field === 'returned' ? t('balance.declare.returnedHint', { back: amount(line.backInOurPlaces, line.uom) }) : undefined}>
                    <Input size="sm" inputMode="decimal" aria-label={t('balance.declare.fieldOf', { what: t(`balance.rung.${field}`), line: line.seq })} value={entry[field]} suffix={unit} onChange={(event) => setLine(entry.kitLineId, field, event.target.value)} />
                  </Field>
                ))}
              </div>
            </fieldset>
          )
        })}
        <Field label={t('balance.declare.note')} hint={t('balance.declare.noteHint')}>
          <Textarea rows={2} maxLength={2000} value={draft.note} onChange={(event) => set({ note: event.target.value })} />
        </Field>
        {draft.lockReason !== null && <LockReasonField value={draft.lockReason} onChange={(lockReason) => set({ lockReason })} />}
        {model.problem && <Banner tone="danger" title={sayWords(model.problem)} />}
        {model.busy && (
          <p className="fw-by-hint" role="status">
            {t('held.busy')}
          </p>
        )}
        <ActionConfirm
          mode="inline"
          impact={{
            level: 'confirm',
            title: t('balance.declare.question', { count: draft.lines.filter((entry) => [entry.used, entry.returned, entry.scrapped].some((text) => Number(typedQuantity(text.trim() || '0') ?? 0) > 0)).length }),
            confirmLabel: t('balance.declare.confirm'),
            consequences: moves.length > 0 ? moves : [t('balance.declare.nothingMoves')],
            sideEffects: [t('balance.declare.costFollows', { workOrder: model.workOrder })],
            ...(refusal ? { refusal: { reason: refusal } } : {}),
          }}
          onConfirm={() => actions?.onDeclare?.()}
          onCancel={close}
        />
      </div>
    </Modal>
  )
}

function AdjustDialog({ draft, balance, model, actions }: { draft: AdjustDraft; balance: OrderBalance; model: BalanceModel; actions?: BalanceActions }) {
  const t = useT(DEPTH)
  const sayWords = useSay()
  const amount = useAmount()
  const line = balance.lines.find((candidate) => candidate.kitLineId === draft.kitLineId)
  const close = () => actions?.onDialog?.(null)
  if (!line) return null
  const set = (next: Partial<AdjustDraft>) => actions?.onDialog?.({ kind: 'adjust', draft: { ...draft, ...next } })
  const held = adjustHeldDraft(draft, line)
  // A refusal from the server is said above (the confirm stays enabled, so the focus stays on it and a retry reads again);
  // only the draft's own holds disable it. A second press while busy is ignored by the container.
  const refusal = held ? sayWords(held) : null
  const after = adjustAfter(draft, line)
  const unit = t(`uom.${line.uom}`)
  const change = { used: typedQuantity(draft.used.trim() || '0', true) ?? '0', returned: typedQuantity(draft.returned.trim() || '0', true) ?? '0', scrapped: typedQuantity(draft.scrapped.trim() || '0', true) ?? '0' }
  const moves = held ? [] : movesOf(line, change, model.workOrder).map(sayWords)
  return (
    <Modal open onClose={close} title={t('balance.adjust.title', { line: line.seq, code: line.item.code })} size="md">
      <div className="fw-by-dialog">
        <p className="fw-by-hint">{t('balance.adjust.intro')}</p>
        <KeyValue
          dense
          columns={2}
          phoneColumns={2}
          labelCase="sentence"
          items={(['used', 'returned', 'scrapped', 'open'] as const).map((field) => ({ label: t(`balance.rung.${field}`), value: amount(line[field], line.uom) }))}
        />
        <div className="fw-by-fields">
          {(['used', 'returned', 'scrapped'] as const).map((field) => (
            <Field key={field} label={t(`balance.adjust.change.${field}`)} hint={t('balance.adjust.changeHint')}>
              <Input size="sm" inputMode="decimal" value={draft[field]} suffix={unit} onChange={(event) => set({ [field]: event.target.value })} />
            </Field>
          ))}
        </div>
        <Field label={t('balance.adjust.reason')} required hint={t('balance.adjust.reasonHint')}>
          <Textarea rows={2} maxLength={2000} value={draft.reason} onChange={(event) => set({ reason: event.target.value })} />
        </Field>
        {draft.lockReason !== null && <LockReasonField value={draft.lockReason} onChange={(lockReason) => set({ lockReason })} />}
        {model.problem && <Banner tone="danger" title={sayWords(model.problem)} />}
        {model.busy && (
          <p className="fw-by-hint" role="status">
            {t('held.busy')}
          </p>
        )}
        <ActionConfirm
          mode="inline"
          impact={{
            level: 'confirm',
            title: t('balance.adjust.question', { line: line.seq }),
            confirmLabel: t('balance.adjust.confirm'),
            ...(moves.length > 0 ? { consequences: moves } : {}),
            ...(after && !held
              ? {
                  review: {
                    title: t('balance.adjust.review'),
                    rows: (['used', 'returned', 'scrapped', 'open'] as const).map((field) => ({ label: t(`balance.rung.${field}`), before: amount(line[field], line.uom), after: amount(after[field], line.uom) })),
                  },
                }
              : {}),
            ...(refusal ? { refusal: { reason: refusal } } : {}),
          }}
          onConfirm={() => actions?.onAdjust?.()}
          onCancel={close}
        />
        {plain(line.open) !== '0' && <p className="fw-by-hint">{t('balance.adjust.lossHint')}</p>}
      </div>
    </Modal>
  )
}
