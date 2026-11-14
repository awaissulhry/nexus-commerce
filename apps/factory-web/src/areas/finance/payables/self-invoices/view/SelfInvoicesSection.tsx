'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { FilePlus2, MoreHorizontal, ShieldOff } from 'lucide-react'
import { Banner, EmptyState, Field, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { hasRecordPage, recordAddress } from '../../../../../lib/records/record-links'
import { WithMessages } from '../../../../../record-panels/i18n'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { dayInstant, type Phrase } from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import { DEPTH, DEPTH_NAMESPACES, type DepthProblem } from '../../../invoices/test-mode/depth'
import { SELF_INVOICE_KINDS, VAT_RATES, type SelfInvoice, type SelfInvoiceCandidate, type SelfInvoiceKind, type SelfInvoices, type VatRate } from '../api'
import { cancelHeld, createDialogHeld, createHeld, deadlineWords, DEADLINE_TONE, draftHeld, reasonProblem, SELF_ROWS, stageOf, STATUS_TONE, type SelfInvoiceAbilities, type SelfRows } from '../model'
import '../../../_shared/finance.css'

export type SelfDialog = { kind: 'create' } | { kind: 'cancel'; row: SelfInvoice }

export interface SelfInvoicesModel {
  prefix: string
  can: SelfInvoiceAbilities
  rows: SelfRows
  list: { value: SelfInvoices | null; problem: string | null }
  dialog: SelfDialog | null
  /** The create dialog's supplier invoices from abroad (null value while they load). */
  candidates: { value: SelfInvoiceCandidate[] | null; problem: string | null }
  draft: { supplierInvoiceId: string; kind: SelfInvoiceKind | null; rate: VatRate }
  reason: string
  busy: boolean
  problem: DepthProblem | null
  notice: { tone: 'success' | 'warning' | 'danger'; words: Phrase } | null
  /** Design cases: the starting selection. */
  selected?: string[]
}

export interface SelfInvoicesActions {
  onRows?: (rows: SelfRows) => void
  onRetry?: () => void
  onDialog?: (dialog: SelfDialog | null) => void
  onDraft?: (patch: Partial<SelfInvoicesModel['draft']>) => void
  onReason?: (reason: string) => void
  onCreate?: () => void
  onCancel?: () => void
  onMakeDrafts?: (rows: SelfInvoice[]) => void
  onRetryCandidates?: () => void
  /** Enter on a row: its invoice (with the cost grain), else the supplier invoice. */
  onOpen?: (row: SelfInvoice) => void
  onDismissNotice?: () => void
}

/**
 * Finance › Payables › Self-invoices (design finance.payables sec:selfinv and page.h ⋯ "Self-invoices TD17/18/19"; FIN-095):
 * the self-invoices the company must send to SDI for purchases from abroad, on the shared list frame (select-all, shift
 * range, x; "Make drafts N" while rows are selected; keys only in the footer's info icon) — the purchase (supplier and its
 * invoice), the kind (TD17 services from abroad · TD18 goods from the EU · TD19 goods already in Italy), the deadline (the
 * 15th of the month after receipt, counted down), where it stands (to draft, draft waiting, issued, cancelled). Create from
 * the supplier invoice (the kind suggested, the Italian rate), Cancel a pending one with the reason. No money: the
 * self-invoice's draft carries the amounts (cost grain). While the accountant's switch is off the issue waits (said).
 */
export function SelfInvoicesSection({ model, actions, banner }: { model: SelfInvoicesModel; actions?: SelfInvoicesActions; /** The test-mode banner (self-invoices go to SDI). */ banner?: ReactNode }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <Section model={model} actions={actions} banner={banner} />
    </WithMessages>
  )
}

function Section({ model, actions, banner }: { model: SelfInvoicesModel; actions?: SelfInvoicesActions; banner?: ReactNode }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const lists = useT('lists')
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(false)
  const items = model.list.value?.selfInvoices ?? null
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const create = createHeld(model.can)

  const columns = useMemo<ColDef<SelfInvoice>[]>(() => {
    const PurchaseCell = ({ data }: ICellRendererParams<SelfInvoice>) =>
      data ? (
        <span className="fw-fin-cell">
          <span className="fw-fin-ellipsis">
            {hasRecordPage('Party', OFFICE_PAGES) ? (
              <Link className="fw-fin-link" href={`${latest.current.model.prefix}${recordAddress({ type: 'Party', id: data.partyId }, OFFICE_PAGES)}`}>
                {data.supplier.legalName}
              </Link>
            ) : (
              data.supplier.legalName
            )}
          </span>
          <span className="fw-fin-cell-sub">
            <Link className="fw-fin-link" href={`${latest.current.model.prefix}/finance/payables/${encodeURIComponent(data.supplierInvoice.id)}`}>
              {w('self.supplierInvoice', { number: data.supplierInvoice.number })}
            </Link>{' '}
            · {w('self.received', { date: day(data.supplierInvoice.receivedOn) })}
          </span>
        </span>
      ) : null
    const KindCell = ({ data }: ICellRendererParams<SelfInvoice>) =>
      data ? (
        <span className="fw-fin-cell">
          <span>{data.kind}</span>
          <span className="fw-fin-cell-sub">{w(`self.kind.${data.kind}`)}</span>
        </span>
      ) : null
    const DeadlineCell = ({ data }: ICellRendererParams<SelfInvoice>) => {
      if (!data) return null
      const words = deadlineWords(data.deadlineState)
      return (
        <span className="fw-fin-cell">
          <span>{day(data.deadline)}</span>
          <Pill tone={DEADLINE_TONE[data.deadlineState.state]}>{w(words.key, words.params)}</Pill>
        </span>
      )
    }
    const StatusCell = ({ data }: ICellRendererParams<SelfInvoice>) => {
      if (!data) return null
      const stage = stageOf(data)
      return (
        <span className="fw-fin-cell">
          <Pill tone={STATUS_TONE[data.status]}>{w(`self.status.${data.status}`)}</Pill>
          <span className="fw-fin-cell-sub">
            {data.invoice && latest.current.model.can.cost ? (
              <Link className="fw-fin-link" href={`${latest.current.model.prefix}/finance/invoices/${encodeURIComponent(data.invoice.id)}`}>
                {w(stage.key, stage.params)}
              </Link>
            ) : (
              w(stage.key, stage.params)
            )}
          </span>
        </span>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<SelfInvoice>) => {
      if (!data) return null
      const now = latest.current
      const draft = draftHeld(data, now.model.can, now.model.busy)
      const cancel = cancelHeld(data, now.model.can, now.model.busy)
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': w('self.rowMenu', { number: data.supplierInvoice.number }) }}
          items={[
            ...(data.invoice && now.model.can.cost ? [{ id: 'open', label: w('self.openInvoice'), href: `${now.model.prefix}/finance/invoices/${encodeURIComponent(data.invoice.id)}` }] : []),
            ...(data.status === 'PENDING' && !data.invoice ? [{ id: 'draft', label: w('self.makeDraft'), disabled: !!draft, description: draft ? w(draft.key) : undefined, onSelect: () => now.actions?.onMakeDrafts?.([data]) }] : []),
            ...(data.status === 'PENDING' ? [{ id: 'cancel', label: w('self.cancel'), tone: 'danger' as const, disabled: !!cancel, description: cancel ? w(cancel.key) : undefined, onSelect: () => now.actions?.onDialog?.({ kind: 'cancel', row: data }) }] : []),
            { id: 'supplier', label: w('self.openSupplierInvoice'), href: `${now.model.prefix}/finance/payables/${encodeURIComponent(data.supplierInvoice.id)}` },
          ]}
        />
      )
    }
    return [
      { colId: 'purchase', headerName: w('self.col.purchase'), minWidth: 230, flex: 1.6, cellRenderer: PurchaseCell },
      { colId: 'kind', headerName: w('self.col.kind'), minWidth: 190, flex: 1.2, cellRenderer: KindCell },
      { colId: 'deadline', headerName: w('self.col.deadline'), minWidth: 160, flex: 0.9, cellRenderer: DeadlineCell },
      { colId: 'status', headerName: w('self.col.status'), minWidth: 170, flex: 1, cellRenderer: StatusCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, w, locale])

  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const drafts = picked.filter((row) => draftHeld(row, model.can) === null)
  const ownKeys: ListKey[] = [{ keys: ['n'], does: w('self.keyCreate') }]

  // n: Create from the supplier invoice — never while typing or inside a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || help || model.dialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === 'n' && !create) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'create' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!model.can.view)
    return (
      <section className="fw-fin-section" id="fw-selfinv" aria-labelledby="fw-selfinv-title">
        <h2 className="fw-fin-h2" id="fw-selfinv-title">
          {w('self.title')}
        </h2>
        <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={w('self.noRight.title')} description={w('self.noRight.body')} />
      </section>
    )

  const state = model.list.problem ? (
    <EmptyState title={w('self.failed')} description={t(model.list.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    <EmptyState title={w(model.rows === 'open' || model.rows === 'all' ? 'self.empty.title' : 'self.emptyRows.title')} description={w('self.empty.body')} />
  ) : undefined

  return (
    <section className="fw-fin-section" id="fw-selfinv" aria-labelledby="fw-selfinv-title">
      <div className="fw-fin-section-head">
        <h2 className="fw-fin-h2" id="fw-selfinv-title">
          {w('self.title')}
        </h2>
        <Button size="sm" heldReason={create ? w(create.key) : null} onClick={() => actions?.onDialog?.({ kind: 'create' })} aria-keyshortcuts="n">
          <FilePlus2 size={14} aria-hidden /> {w('self.createVerb')}
        </Button>
      </div>
      <p className="fw-fin-hint">{w('self.explain')}</p>
      {banner}
      {model.list.value && !model.list.value.selfInvoicesOn && <Banner tone="info" title={w('self.waits')} />}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={w(model.notice.words.key, model.notice.words.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      <ListFrame<SelfInvoice>
        label={w('self.title')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? w('self.count', { count: items.length }) : '—'}
        tools={
          <Select size="sm" aria-label={w('self.rowsLabel')} value={model.rows} onChange={(event) => actions?.onRows?.(event.target.value as SelfRows)}>
            {SELF_ROWS.map((view) => (
              <option key={view} value={view}>
                {w(`self.rows.${view}`)}
              </option>
            ))}
          </Select>
        }
        listKey="finance.payables.self-invoices"
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" variant="primary" heldReason={drafts.length === 0 ? w('self.held.noneToDraft') : model.busy ? w('held.busy') : null} aria-label={w('self.bulkDraft', { count: drafts.length })} onClick={() => actions?.onMakeDrafts?.(drafts)}>
              <FilePlus2 size={13} aria-hidden /> <SelectionLabel>{w('self.bulkDraft', { count: drafts.length })}</SelectionLabel>
            </Button>
          ),
        }}
        isRowSelectable={(row) => {
          const held = draftHeld(row, model.can)
          return held ? w(held.key) : null
        }}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
      />
      {model.dialog?.kind === 'create' && <CreateDialog model={model} actions={actions} />}
      {model.dialog?.kind === 'cancel' && <CancelDialog model={model} row={model.dialog.row} actions={actions} />}
      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('list.keysTitle')} size="sm">
          <ul className="fw-fin-list">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={entry.does}>
                <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </section>
  )
}

/** Create from the supplier invoice: the purchase from abroad, the kind (suggested), the Italian VAT rate; its draft follows. */
function CreateDialog({ model, actions }: { model: SelfInvoicesModel; actions?: SelfInvoicesActions }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const locale = useLocale()
  const candidates = model.candidates.value
  const candidate = candidates?.find((entry) => entry.supplierInvoiceId === model.draft.supplierInvoiceId) ?? null
  const held = createDialogHeld({ candidate, kind: model.draft.kind, busy: model.busy })
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  return (
    <DialogFrame
      title={w('self.create.title')}
      held={held ? w(held.key) : null}
      go={() => actions?.onCreate?.()}
      goLabel={model.busy ? t('common.working') : w('self.create.go')}
      onClose={() => actions?.onDialog?.(null)}
      problem={model.problem ? { key: model.problem.key, ...(model.problem.params ? { params: model.problem.params } : {}) } : null}
      size="lg"
    >
      <p className="fw-fin-hint">{w('self.create.explain')}</p>
      {model.candidates.problem ? (
        <EmptyState title={w('self.create.failed')} description={t(model.candidates.problem)} action={<Button size="sm" onClick={() => actions?.onRetryCandidates?.()}>{t('common.retry')}</Button>} />
      ) : !candidates ? (
        <p className="fw-fin-hint" role="status">
          <Spinner size={12} /> {w('self.create.reading')}
        </p>
      ) : candidates.length === 0 ? (
        <EmptyState title={w('self.create.none.title')} description={w('self.create.none.body')} />
      ) : (
        <>
          <Field label={w('self.create.purchase')}>
            <Select value={model.draft.supplierInvoiceId} onChange={(event) => actions?.onDraft?.({ supplierInvoiceId: event.target.value, kind: candidates.find((entry) => entry.supplierInvoiceId === event.target.value)?.suggestion.kind ?? null })}>
              <option value="">{w('self.create.pick')}</option>
              {candidates.map((entry) => (
                <option key={entry.supplierInvoiceId} value={entry.supplierInvoiceId}>
                  {entry.supplier.legalName} ({entry.supplier.country}) · {entry.number} · {day(entry.issueDate)}
                </option>
              ))}
            </Select>
          </Field>
          {candidate && (
            <>
              <p className="fw-fin-hint">
                {w('self.create.deadline', { date: day(candidate.deadline) })} · {w(deadlineWords(candidate.deadlineState).key, deadlineWords(candidate.deadlineState).params)}
                {candidate.currency !== 'EUR' ? ` · ${w('self.create.currency', { currency: candidate.currency })}` : ''}
              </p>
              <fieldset className="fw-fin-choices">
                <legend className="fw-fin-legend">{w('self.create.kind')}</legend>
                {SELF_INVOICE_KINDS.map((kind) => (
                  <RadioCard
                    key={kind}
                    name="fw-selfinv-kind"
                    value={kind}
                    checked={model.draft.kind === kind}
                    selected={model.draft.kind === kind}
                    onChange={() => actions?.onDraft?.({ kind })}
                    title={`${kind} · ${w(`self.kind.${kind}`)}`}
                    description={candidate.suggestion.kind === kind ? w('self.create.suggested') : w(`self.kindWhen.${kind}`)}
                  />
                ))}
                {candidate.suggestion.kind === null && <p className="fw-fin-hint">{w('self.create.mixed')}</p>}
              </fieldset>
              <Field label={w('self.create.rate')} hint={w('self.create.rateHint')}>
                <Select value={model.draft.rate} onChange={(event) => actions?.onDraft?.({ rate: event.target.value as VatRate })}>
                  {VAT_RATES.map((rate) => (
                    <option key={rate} value={rate}>
                      {rate} %
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          <p className="fw-fin-hint">{w('self.create.after')}</p>
        </>
      )}
    </DialogFrame>
  )
}

/** Cancel a pending self-invoice: the reason (kept on the audit row); its draft goes with it. */
function CancelDialog({ model, row, actions }: { model: SelfInvoicesModel; row: SelfInvoice; actions?: SelfInvoicesActions }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const problem = reasonProblem(model.reason)
  const held = model.busy ? w('held.busy') : problem ? w(problem.key) : null
  return (
    <DialogFrame
      title={w('self.cancelTitle', { number: row.supplierInvoice.number })}
      held={held}
      go={() => actions?.onCancel?.()}
      goLabel={model.busy ? t('common.working') : w('self.cancelGo')}
      onClose={() => actions?.onDialog?.(null)}
      problem={model.problem ? { key: model.problem.key, ...(model.problem.params ? { params: model.problem.params } : {}) } : null}
      tone="danger"
    >
      <p className="fw-fin-hint">{w(row.invoice ? 'self.cancelExplainDraft' : 'self.cancelExplain', { supplier: row.supplier.legalName })}</p>
      <Field label={w('self.cancelReason')}>
        <Textarea value={model.reason} rows={3} maxLength={500} onChange={(event) => actions?.onReason?.(event.target.value)} />
      </Field>
    </DialogFrame>
  )
}
