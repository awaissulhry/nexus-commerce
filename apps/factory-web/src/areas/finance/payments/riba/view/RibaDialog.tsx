'use client'

import { useState, type ReactNode } from 'react'
import { Download, ExternalLink, Landmark } from 'lucide-react'
import { Banner, EmptyState, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant, money } from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import { MAX_RIBA_REASON, RIBA_SETTLEMENTS, type CollectionsSettings, type RibaBatch, type RibaBatchRow, type RibaCandidates } from '../api'
import {
  BATCH_TONE,
  bankAsks,
  banksOf,
  freeKeys,
  issueHeld,
  ITEM_TONE,
  maskIban,
  pickedTotal,
  pickKey,
  settlementOf,
  settleRowProblem,
  waitingItems,
  windowProblem,
  type BankTyped,
  type RibaProblem,
  type SettleRow,
} from '../model'
import { PAY_DEPTH, PAY_DEPTH_NAMESPACES, type Phrase } from '../depth'

/** What the dialog shows: the start (recent batches, the window and its instalments), one batch, or one of its moves. */
export type RibaStage =
  | { kind: 'start'; batches: RibaBatchRow[] | null; batchesProblem: string | null; candidates: RibaCandidates | null; candidatesProblem: string | null; reading: boolean; window: { dueFrom: string; dueTo: string }; picked: readonly string[] | null; repick: RibaBatch | null }
  | { kind: 'batch'; batch: RibaBatch | null; problem: string | null }
  | { kind: 'cancel'; batch: RibaBatch }
  /** The Owner's Ri.Ba. switch turned on (a tick, then a fresh code); `from`: where Cancel goes back to. */
  | { kind: 'switch'; from: RibaStage }

export interface RibaDialogModel {
  prefix: string
  today: string
  can: { view: boolean; manage: boolean; record: boolean; price: boolean; switchRiba: boolean }
  stage: RibaStage
  /** The company's Ri.Ba. switch (null while unread). */
  collections: CollectionsSettings | null
  busy: boolean
  problem: RibaProblem | null
  notice: Phrase | null
  /** The SIA code remembered on this device (no column keeps it). */
  sia: string
  /** Design cases: what is typed. */
  draft?: { banks?: Record<string, BankTyped>; settle?: Record<string, SettleRow>; reason?: string; tick?: boolean }
}

export interface RibaDialogActions {
  onClose?: () => void
  onWindow?: (window: { dueFrom: string; dueTo: string }) => void
  onPicked?: (keys: string[]) => void
  onCreate?: () => void
  onSavePicks?: () => void
  onOpenBatch?: (batchId: string) => void
  onBack?: () => void
  onRepick?: (batch: RibaBatch) => void
  onIssue?: (input: { sia: string; banks: { partyId: string; abi: string; cab: string }[] }) => void
  onDownload?: (fileId: string, name: string) => void
  onStage?: (stage: RibaStage) => void
  onCancelBatch?: (reason: string) => void
  onSettle?: (rows: Record<string, SettleRow>) => void
  onSwitchOn?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-510 — the Ri.Ba. batch (design finance.payments pop:riba, from the band's ⋯): the instalments paid by Ri.Ba. due in a
 * window (each once; one already in a batch or in another currency held with why), picked, with their total → a draft
 * batch; the SIA code the bank gave and, for a customer whose bank is not known, its ABI and CAB → "Create file
 * (download)": the CBI file is made and kept on the batch, downloaded here and opened in its own tab (the bank's site takes
 * it: nothing is sent from here). The file is made only while the Owner's Ri.Ba. switch is on. An issued batch takes the
 * bank's report: each receipt paid (a payment is recorded and placed) or came back unpaid with the bank's fee (the invoice
 * is open again). A draft is changed or cancelled with why. Amounts only with the price grain.
 */
export function RibaDialog({ model, actions }: { model: RibaDialogModel; actions?: RibaDialogActions }) {
  return (
    <WithMessages namespaces={PAY_DEPTH_NAMESPACES}>
      <Dialog model={model} actions={actions} />
    </WithMessages>
  )
}

function Dialog({ model, actions }: { model: RibaDialogModel; actions?: RibaDialogActions }) {
  const stage = model.stage
  if (stage.kind === 'start') return <StartStage model={model} stage={stage} actions={actions} />
  if (stage.kind === 'cancel') return <CancelStage model={model} batch={stage.batch} actions={actions} />
  if (stage.kind === 'switch') return <SwitchStage model={model} actions={actions} />
  return <BatchStage model={model} batch={stage.batch} problem={stage.problem} actions={actions} />
}

function useWords() {
  const p = useT(PAY_DEPTH)
  const s = useScopedT('finance')
  const say = (phrase: Phrase | null | undefined): string | null => (phrase ? s(phrase.key, phrase.params) : null)
  return { p, s, say }
}

function Notice({ model, actions }: { model: RibaDialogModel; actions?: RibaDialogActions }) {
  const { say } = useWords()
  const t = useT('finance')
  if (!model.notice) return null
  return (
    <Banner
      tone="success"
      title={say(model.notice) ?? ''}
      action={
        <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
          {t('common.dismiss')}
        </Button>
      }
    />
  )
}

/** The Owner's switch, said: off → the file waits; the Owner may switch it on from here (a tick, then a fresh code). */
function SwitchLine({ model, actions }: { model: RibaDialogModel; actions?: RibaDialogActions }) {
  const { p } = useWords()
  const collections = model.collections
  if (!collections) return null
  if (collections.ribaOn) return <p className="fw-fin-hint">{p('riba.switch.on')}</p>
  const held = !model.can.switchRiba ? p('riba.switch.held') : null
  return (
    <Banner
      tone="warning"
      title={p('riba.switch.off')}
      action={
        <Button size="sm" heldReason={held} onClick={() => actions?.onStage?.({ kind: 'switch', from: model.stage })}>
          {p('riba.switch.turnOn')}
        </Button>
      }
    >
      {p('riba.switch.offBody')}
    </Banner>
  )
}

function StartStage({ model, stage, actions }: { model: RibaDialogModel; stage: Extract<RibaStage, { kind: 'start' }>; actions?: RibaDialogActions }) {
  const { p, say } = useWords()
  const t = useT('finance')
  const locale = useLocale()
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const candidates = stage.candidates
  const free = candidates ? freeKeys(candidates.candidates) : []
  const picked = new Set(stage.picked ?? free)
  const pickedFree = free.filter((key) => picked.has(key))
  const total = candidates ? pickedTotal(candidates.candidates, picked) : null
  const windowHeld = windowProblem(stage.window.dueFrom, stage.window.dueTo)
  const repick = stage.repick
  const held = !model.can.manage
    ? p('riba.held.manage')
    : windowHeld
      ? say(windowHeld)
      : !candidates || stage.reading
        ? p('riba.held.reading')
        : pickedFree.length === 0
          ? p('riba.held.nonePicked')
          : model.busy
            ? t('common.working')
            : null
  const goLabel = repick ? p('riba.savePicks', { count: pickedFree.length }) : p('riba.create', { count: pickedFree.length })
  return (
    <DialogFrame title={repick ? p('riba.titleRepick') : p('riba.title')} held={held} go={() => (repick ? actions?.onSavePicks?.() : actions?.onCreate?.())} goLabel={goLabel} onClose={() => actions?.onClose?.()} problem={model.problem} size="lg">
      <Notice model={model} actions={actions} />
      <p className="fw-fin-hint">{p('riba.body')}</p>
      {!repick && <RecentBatches model={model} stage={stage} actions={actions} />}
      <SwitchLine model={model} actions={actions} />
      <div className="fw-fin-two">
        <Field label={p('riba.window.from')} error={windowHeld && stage.window.dueFrom ? say(windowHeld) ?? undefined : undefined}>
          <DateField value={stage.window.dueFrom} onChange={(value) => actions?.onWindow?.({ ...stage.window, dueFrom: value })} locale={INTL_LOCALE[locale]} ariaLabel={p('riba.window.from')} />
        </Field>
        <Field label={p('riba.window.to')}>
          <DateField value={stage.window.dueTo} onChange={(value) => actions?.onWindow?.({ ...stage.window, dueTo: value })} locale={INTL_LOCALE[locale]} ariaLabel={p('riba.window.to')} />
        </Field>
      </div>
      {stage.candidatesProblem ? (
        <EmptyState
          title={p('riba.candidates.failed')}
          description={t(stage.candidatesProblem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : !candidates || stage.reading ? (
        <p className="fw-fin-hint" role="status">
          <Spinner size={12} /> {p('riba.candidates.reading')}
        </p>
      ) : candidates.candidates.length === 0 ? (
        <EmptyState icon={<Landmark size={24} aria-hidden />} title={p('riba.candidates.none.title', { from: day(candidates.dueFrom), to: day(candidates.dueTo) })} description={p('riba.candidates.none.body')} />
      ) : (
        <fieldset className="fw-fin-choices">
          <legend className="fw-fin-legend">{p('riba.candidates.legend', { from: day(candidates.dueFrom), to: day(candidates.dueTo) })}</legend>
          <Checkbox
            checked={free.length > 0 && pickedFree.length === free.length}
            disabled={free.length === 0}
            onChange={(event) => actions?.onPicked?.(event.target.checked ? free : [])}
            label={p('riba.candidates.all', { count: free.length })}
          />
          {candidates.candidates.map((row) => {
            const key = pickKey(row)
            return (
              <div key={key} className="fw-fin-check">
                <Checkbox
                  checked={row.held === null && picked.has(key)}
                  disabled={row.held !== null}
                  onChange={(event) => actions?.onPicked?.(event.target.checked ? [...pickedFree, key] : pickedFree.filter((entry) => entry !== key))}
                  label={
                    <span className="fw-fin-cell">
                      <span>
                        {row.customer.name} <span className="fw-fin-title-sub">· {p('riba.candidates.invoice', { number: row.invoice.number, instalment: row.instalment })}</span>
                      </span>
                      <span className="fw-fin-cell-sub">
                        {p('riba.candidates.due', { date: day(row.dueDate) })}
                        {model.can.price && row.amount !== undefined ? ` · ${money(row.amount, row.currency, locale)}` : ''}
                        {' · '}
                        {row.debtorBank ? p('riba.bank.known', { abi: row.debtorBank.abi, cab: row.debtorBank.cab }) : p('riba.bank.unknown')}
                        {row.held ? ` · ${p(`refusal.riba.${row.held.code}`)}` : ''}
                      </span>
                    </span>
                  }
                />
              </div>
            )
          })}
        </fieldset>
      )}
      {candidates && candidates.candidates.length > 0 && (
        <p className="fw-fin-hint" role="status">
          {model.can.price && total !== null ? p('riba.total', { count: pickedFree.length, amount: money(total, 'EUR', locale) }) : p('riba.totalPlain', { count: pickedFree.length })}
        </p>
      )}
    </DialogFrame>
  )
}

function RecentBatches({ model, stage, actions }: { model: RibaDialogModel; stage: Extract<RibaStage, { kind: 'start' }>; actions?: RibaDialogActions }) {
  const { p } = useWords()
  const t = useT('finance')
  const locale = useLocale()
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  if (stage.batchesProblem) return <p className="fw-fin-hint">{p('riba.batches.failed', { reason: t(stage.batchesProblem) })}</p>
  if (!stage.batches) return null
  const open = stage.batches.filter((row) => row.status === 'DRAFT' || (row.status === 'ISSUED' && row.settled.waiting > 0))
  if (open.length === 0) return null
  return (
    <section aria-label={p('riba.batches.title')} className="fw-fin-stack-tight">
      <h3 className="fw-fin-h3">{p('riba.batches.title')}</h3>
      <SummaryTable
        label={p('riba.batches.title')}
        columns={[p('riba.col.window'), p('riba.col.state'), p('riba.col.receipts'), ...(model.can.price ? [p('riba.col.total')] : []), p('riba.col.open')]}
        align={['left', 'left', 'right', ...(model.can.price ? (['right'] as const) : []), 'right']}
        stackOnPhone
        rows={open.slice(0, 5).map((row) => ({
          id: row.id,
          cells: [
            p('riba.window.range', { from: day(row.dueFrom), to: day(row.dueTo) }),
            <Pill key="s" tone={BATCH_TONE[row.status]}>
              {row.status === 'ISSUED' ? p('riba.batchState.waiting', { count: row.settled.waiting }) : p(`riba.batchState.${row.status}`)}
            </Pill>,
            String(row.count),
            ...(model.can.price ? [money(row.total, 'EUR', locale)] : []),
            <Button key="o" size="sm" variant="link" onClick={() => actions?.onOpenBatch?.(row.id)}>
              {row.status === 'DRAFT' ? p('riba.batches.continue') : p('riba.batches.settle')}
            </Button>,
          ],
        }))}
      />
    </section>
  )
}

function BatchStage({ model, batch, problem, actions }: { model: RibaDialogModel; batch: RibaBatch | null; problem: string | null; actions?: RibaDialogActions }) {
  const { p, say } = useWords()
  const t = useT('finance')
  const locale = useLocale()
  const [sia, setSia] = useState(model.sia)
  const [banks, setBanks] = useState<Record<string, BankTyped>>(model.draft?.banks ?? {})
  const [rows, setRows] = useState<Record<string, SettleRow>>(model.draft?.settle ?? {})
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  if (!batch) {
    return (
      <DialogFrame title={p('riba.title')} held={problem ? p('riba.held.failed') : p('riba.held.reading')} go={() => undefined} goLabel={p('riba.issue')} onClose={() => actions?.onClose?.()} size="lg">
        {problem ? (
          <EmptyState
            title={p('riba.batch.failed')}
            description={t(problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : (
          <p className="fw-fin-hint" role="status">
            <Spinner size={12} /> {p('riba.batch.reading')}
          </p>
        )}
      </DialogFrame>
    )
  }
  const asks = bankAsks(batch.items)
  const asked = new Set(model.problem?.banksFor ?? [])
  const waiting = waitingItems(batch)
  const back = (
    <Button size="sm" variant="link" onClick={() => actions?.onBack?.()}>
      {p('riba.back')}
    </Button>
  )
  const facts = (
    <KeyValue
      dense
      labelCase="sentence"
      columns={2}
      items={[
        { label: p('riba.col.state'), value: <Pill tone={BATCH_TONE[batch.status]}>{p(`riba.batchState.${batch.status}`)}</Pill> },
        { label: p('riba.col.window'), value: p('riba.window.range', { from: day(batch.dueFrom), to: day(batch.dueTo) }) },
        { label: p('riba.account'), value: `${maskIban(batch.bankAccount.iban)}${batch.bankAccount.bankName ? ` · ${batch.bankAccount.bankName}` : ''}` },
        { label: p('riba.col.receipts'), value: String(batch.count) },
        ...(model.can.price ? [{ label: p('riba.col.total'), value: money(batch.total, batch.currency, locale) }] : []),
        ...(batch.issuedAt ? [{ label: p('riba.issuedAt'), value: p('riba.issuedBy', { date: formatDateTime(batch.issuedAt, { locale }), name: batch.issuedBy?.name ?? p('riba.someone') }) }] : []),
      ]}
    />
  )
  const itemsTable = (
    <SummaryTable
      label={p('riba.items')}
      columns={[p('riba.col.invoice'), p('riba.col.customer'), p('riba.col.due'), ...(model.can.price ? [p('riba.col.amount')] : []), p('riba.col.bank'), p('riba.col.state')]}
      align={['left', 'left', 'left', ...(model.can.price ? (['right'] as const) : []), 'left', 'left']}
      stackOnPhone
      rows={batch.items.map((item) => ({
        id: item.id,
        cells: [
          p('riba.candidates.invoice', { number: item.invoice.number ?? '—', instalment: item.instalment }),
          item.customer.name,
          day(item.dueDate),
          ...(model.can.price ? [money(item.amount, batch.currency, locale)] : []),
          item.debtorBank ? p(`riba.bank.source.${item.debtorBank.source}`, { abi: item.debtorBank.abi, cab: item.debtorBank.cab }) : p('riba.bank.unknown'),
          <span key="s" className="fw-fin-cell">
            <Pill tone={ITEM_TONE[item.status]}>{p(`riba.itemState.${item.status}`)}</Pill>
            {item.settledOn && <span className="fw-fin-cell-sub">{p('riba.settledOn', { date: day(item.settledOn) })}</span>}
            {item.status === 'UNPAID' && model.can.price && item.unpaidFee != null && <span className="fw-fin-cell-sub">{p('riba.fee', { amount: money(item.unpaidFee, batch.currency, locale) })}</span>}
          </span>,
        ],
      }))}
    />
  )

  if (batch.status === 'DRAFT') {
    const held = !model.can.manage ? p('riba.held.manage') : !batch.can.issue && !model.collections?.ribaOn ? p('riba.held.switchOff') : say(issueHeld({ sia, asks, typed: banks, busy: model.busy }))
    return (
      <DialogFrame title={p('riba.titleDraft')} held={held} go={() => actions?.onIssue?.({ sia, banks: banksOf(asks, banks) })} goLabel={model.busy ? t('common.working') : p('riba.issue')} onClose={() => actions?.onClose?.()} problem={model.problem} size="lg">
        <Notice model={model} actions={actions} />
        <span className="fw-fin-inline">
          {back}
          <Button size="sm" variant="link" heldReason={!batch.can.pick ? p('riba.held.manage') : null} onClick={() => actions?.onRepick?.(batch)}>
            {p('riba.repick')}
          </Button>
          <Button size="sm" variant="link" heldReason={!batch.can.cancel ? p('riba.held.manage') : null} onClick={() => actions?.onStage?.({ kind: 'cancel', batch })}>
            {p('riba.cancel')}
          </Button>
        </span>
        {facts}
        {itemsTable}
        <SwitchLine model={model} actions={actions} />
        <Field label={p('riba.sia.label')} hint={p('riba.sia.hint')}>
          <Input value={sia} onChange={(event) => setSia(event.target.value)} maxLength={5} autoComplete="off" spellCheck={false} />
        </Field>
        <fieldset className="fw-fin-choices">
          <legend className="fw-fin-legend">{p('riba.bank.legend')}</legend>
          {asks.map((ask) => {
            const typed = banks[ask.partyId] ?? { abi: '', cab: '' }
            const set = (field: 'abi' | 'cab', value: string) => setBanks((current) => ({ ...current, [ask.partyId]: { ...typed, [field]: value } }))
            return (
              <div key={ask.partyId} className="fw-fin-stack-tight">
                <span>
                  {ask.name} <span className="fw-fin-title-sub">· {ask.known && !asked.has(ask.partyId) ? p(`riba.bank.source.${ask.known.source}`, { abi: ask.known.abi, cab: ask.known.cab }) : p('riba.bank.give')}</span>
                </span>
                <div className="fw-fin-two">
                  <Field label={p('riba.bank.abi')}>
                    <Input inputMode="numeric" maxLength={5} value={typed.abi} onChange={(event) => set('abi', event.target.value)} placeholder={ask.known?.abi} autoComplete="off" />
                  </Field>
                  <Field label={p('riba.bank.cab')}>
                    <Input inputMode="numeric" maxLength={5} value={typed.cab} onChange={(event) => set('cab', event.target.value)} placeholder={ask.known?.cab} autoComplete="off" />
                  </Field>
                </div>
              </div>
            )
          })}
        </fieldset>
        <p className="fw-fin-hint">{p('riba.issueBody')}</p>
        <p className="fw-fin-hint">{p('riba.rule')}</p>
      </DialogFrame>
    )
  }

  if (batch.status === 'ISSUED') {
    const settlement = settlementOf(waiting, rows, model.today)
    const settleRight = !model.can.manage ? p('riba.held.manage') : Object.values(rows).some((row) => row.status === 'PAID') && !model.can.record ? p('riba.held.record') : null
    const held = waiting.length === 0 ? p('riba.held.allSettled') : (settleRight ?? say(settlement.problem) ?? (model.busy ? t('common.working') : null))
    return (
      <DialogFrame title={p('riba.titleIssued')} held={held} go={() => actions?.onSettle?.(rows)} goLabel={model.busy ? t('common.working') : p('riba.settle.go', { count: settlement.items.length })} onClose={() => actions?.onClose?.()} problem={model.problem} size="lg">
        <Notice model={model} actions={actions} />
        {back}
        {facts}
        {batch.file && (
          <div className="fw-fin-inline">
            <span className="fw-fin-code">{batch.file.name}</span>
            <Button size="sm" onClick={() => actions?.onDownload?.(batch.file!.id, batch.file!.name)}>
              <Download size={14} aria-hidden /> {p('riba.file.download')}
            </Button>
            <Button size="sm" variant="link" asChild>
              <a href={`${model.prefix}/finance/payments/riba/${batch.id}/file`} target="_blank" rel="noopener">
                <ExternalLink size={14} aria-hidden /> {p('riba.file.openTab')}
              </a>
            </Button>
          </div>
        )}
        {itemsTable}
        {waiting.length > 0 ? (
          <fieldset className="fw-fin-choices">
            <legend className="fw-fin-legend">{p('riba.settle.legend')}</legend>
            <p className="fw-fin-hint">{p('riba.settle.body')}</p>
            {waiting.map((item) => {
              const row = rows[item.id] ?? { status: 'WAIT', settledOn: model.today, fee: '' }
              const set = (patch: Partial<SettleRow>) => setRows((current) => ({ ...current, [item.id]: { ...row, ...patch } }))
              const rowProblem = settleRowProblem(item, row, model.today)
              return (
                <div key={item.id} className="fw-fin-stack-tight">
                  <span>
                    {item.customer.name} <span className="fw-fin-title-sub">· {p('riba.candidates.invoice', { number: item.invoice.number ?? '—', instalment: item.instalment })} · {p('riba.candidates.due', { date: day(item.dueDate) })}</span>
                  </span>
                  <div className="fw-fin-two">
                    <Field label={p('riba.settle.outcome')}>
                      <Select value={row.status} onChange={(event) => set({ status: event.target.value as SettleRow['status'] })}>
                        <option value="WAIT">{p('riba.settle.WAIT')}</option>
                        {RIBA_SETTLEMENTS.map((status) => (
                          <option key={status} value={status}>
                            {p(`riba.settle.${status}`)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    {row.status !== 'WAIT' && (
                      <Field label={row.status === 'PAID' ? p('riba.settle.paidOn') : p('riba.settle.backOn')} error={rowProblem && rowProblem.key.endsWith('FEE_NEEDED') ? undefined : (say(rowProblem) ?? undefined)}>
                        <DateField value={row.settledOn} onChange={(value) => set({ settledOn: value })} min={item.dueDate} max={model.today} locale={INTL_LOCALE[locale]} ariaLabel={row.status === 'PAID' ? p('riba.settle.paidOn') : p('riba.settle.backOn')} />
                      </Field>
                    )}
                    {row.status === 'UNPAID' && (
                      <Field label={p('riba.settle.fee')} hint={p('riba.settle.feeHint')} error={rowProblem && rowProblem.key.endsWith('FEE_NEEDED') ? (say(rowProblem) ?? undefined) : undefined}>
                        <Input inputMode="decimal" value={row.fee} onChange={(event) => set({ fee: event.target.value })} autoComplete="off" />
                      </Field>
                    )}
                  </div>
                </div>
              )
            })}
          </fieldset>
        ) : (
          <p className="fw-fin-hint">{p('riba.settle.done', { paid: batch.settled.paid, unpaid: batch.settled.unpaid })}</p>
        )}
      </DialogFrame>
    )
  }

  return (
    <DialogFrame title={p('riba.titleCancelled')} held={null} go={() => undefined} goLabel="" onClose={() => actions?.onClose?.()} done={<CancelledBody batch={batch} back={back} facts={facts} />}>
      <span />
    </DialogFrame>
  )
}

function CancelledBody({ batch, back, facts }: { batch: RibaBatch; back: ReactNode; facts: ReactNode }) {
  const { p } = useWords()
  const locale = useLocale()
  return (
    <div className="fw-fin-stack">
      {back}
      {facts}
      <Banner tone="info" title={p('riba.cancelled', { date: batch.cancelledAt ? formatDate(batch.cancelledAt, { locale }) : '—' })}>
        {batch.cancelReason ?? '—'}
      </Banner>
    </div>
  )
}

function CancelStage({ model, batch, actions }: { model: RibaDialogModel; batch: RibaBatch; actions?: RibaDialogActions }) {
  const { p } = useWords()
  const t = useT('finance')
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  const short = reason.trim().length < 3
  const held = model.busy ? t('common.working') : short ? p('riba.cancelReason.short') : null
  return (
    <DialogFrame title={p('riba.cancelTitle')} held={held} go={() => actions?.onCancelBatch?.(reason.trim())} goLabel={p('riba.cancelGo')} tone="danger" onClose={() => actions?.onStage?.({ kind: 'batch', batch, problem: null })} problem={model.problem}>
      <p className="fw-fin-hint">{p('riba.cancelBody', { count: batch.count })}</p>
      <Field label={p('riba.cancelReason.label')}>
        <Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={MAX_RIBA_REASON} rows={3} />
      </Field>
    </DialogFrame>
  )
}

function SwitchStage({ model, actions }: { model: RibaDialogModel; actions?: RibaDialogActions }) {
  const { p } = useWords()
  const t = useT('finance')
  const [tick, setTick] = useState(!!model.draft?.tick)
  const stage = model.stage as Extract<RibaStage, { kind: 'switch' }>
  const held = !model.can.switchRiba ? p('riba.switch.held') : !tick ? p('riba.switch.tickFirst') : model.busy ? t('common.working') : null
  return (
    <DialogFrame title={p('riba.switch.title')} held={held} go={() => actions?.onSwitchOn?.()} goLabel={p('riba.switch.go')} onClose={() => actions?.onStage?.(stage.from)} problem={model.problem}>
      <p className="fw-fin-hint">{p('riba.switch.body')}</p>
      <Checkbox checked={tick} onChange={(event) => setTick(event.target.checked)} label={p('riba.switch.tick')} />
      <p className="fw-fin-hint">{p('riba.switch.after')}</p>
    </DialogFrame>
  )
}
