'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, MoreHorizontal, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Menu, Modal } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Input, Pill, Select } from '@nexus/ui/primitives'
import { PAYMENT_METHODS } from '@nexus/factory-domain/sales/terms/terms'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { decimal, type Phrase } from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import { INSTALMENT_EVENTS, type PaymentTerms } from '../api'
import '../terms.css'
import { archiveHeld, draftOf, emptyTerms, hasProblems, METHOD_CHOICES, previewOf, shareTotal, TERMS_ROWS, termsName, termsProblems, termsWords, type TermsAbilities, type TermsDraft, type TermsRows } from '../model'

/** The terms dialog: add, edit (names always; rules while unused), or copy as new terms. */
export type TermsDialogState = { mode: 'add'; draft?: TermsDraft } | { mode: 'edit'; terms: PaymentTerms; draft?: TermsDraft } | { mode: 'copy'; terms: PaymentTerms; draft?: TermsDraft }

export interface TermsSectionModel {
  can: TermsAbilities
  rows: TermsRows
  /** The library (null while it loads). */
  terms: PaymentTerms[] | null
  problem: string | null
  dialog: TermsDialogState | null
  busy: boolean
  dialogProblem: (Phrase & { inUse?: boolean }) | null
  notice: { tone: 'success' | 'danger' | 'info'; words: Phrase } | null
  /** Design cases: the starting selection, the keys panel. */
  selected?: string[]
}

export interface TermsSectionActions {
  onRows?: (rows: TermsRows) => void
  onRetry?: () => void
  onDialog?: (dialog: TermsDialogState | null) => void
  onSave?: (dialog: TermsDialogState, draft: TermsDraft) => void
  onMove?: (terms: PaymentTerms[], move: 'archive' | 'reactivate') => void
  onDismissNotice?: () => void
}

const methodName = (code: string, locale: 'it' | 'en') => (Object.hasOwn(PAYMENT_METHODS, code) ? PAYMENT_METHODS[code as keyof typeof PAYMENT_METHODS][locale] : code)

/**
 * Finance settings › Payment terms (design finance.settings sec:terms "Terms library": "30% deposit + balance before
 * shipping", "30/60 days end of month", "Ri.Ba. 60 days", instalments, early-payment discount; skip August W2b), on the
 * shared list frame (select-all, shift range, x; Archive N / Reactivate N while rows are selected; keys only in the
 * footer's info icon): each entry's code and printed name, the method, its instalments in the words its documents print,
 * the deposit it asks, the early-payment discount, how many customers have it as default, its state. Add · edit · copy.
 * Terms a quote or an order names keep their rules: "edit" of the rules is then new terms (the dialog offers it).
 */
export function TermsSection({ model, actions }: { model: TermsSectionModel; actions?: TermsSectionActions }) {
  const t = useT('finance')
  const d = useT('finance-daily')
  const lists = useT('lists')
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(false)
  const rowsKey = model.terms?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const latest = useRef({ can: model.can, actions })
  latest.current = { can: model.can, actions }
  const addHeld = model.can.manage ? (model.busy ? t('held.busy') : null) : d('terms.held.noManage')

  const columns = useMemo<ColDef<PaymentTerms>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<PaymentTerms>) =>
      data ? (
        <span className="fw-fin-cell">
          <Button size="sm" variant="link" onClick={() => latest.current.actions?.onDialog?.({ mode: 'edit', terms: data })}>
            {data.code}
          </Button>
          <span className="fw-fin-cell-sub">{termsName(data, locale)}</span>
        </span>
      ) : null
    const MethodCell = ({ data }: ICellRendererParams<PaymentTerms>) =>
      data ? (
        <span className="fw-fin-cell">
          <span>{methodName(data.method, locale)}</span>
          <span className="fw-fin-cell-sub fw-fin-code">{data.method}</span>
        </span>
      ) : null
    const WordsCell = ({ data }: ICellRendererParams<PaymentTerms>) => (data ? <span className="fw-fin-ellipsis" title={termsWords(data, locale)}>{termsWords(data, locale)}</span> : null)
    const DepositCell = ({ data }: ICellRendererParams<PaymentTerms>) => (data ? <span>{data.deposit ? d('terms.depositValue', { share: decimal(data.deposit.sharePct, locale), count: data.deposit.days }) : d('terms.noDeposit')}</span> : null)
    const DiscountCell = ({ data }: ICellRendererParams<PaymentTerms>) => (data ? <span>{data.earlyPaymentDiscountPct ? d('terms.discountValue', { share: decimal(data.earlyPaymentDiscountPct, locale), count: data.earlyPaymentDays ?? 0 }) : '—'}</span> : null)
    const CustomersCell = ({ data }: ICellRendererParams<PaymentTerms>) => (data ? <span className="fw-fin-num">{data.customers}</span> : null)
    const StateCell = ({ data }: ICellRendererParams<PaymentTerms>) => (data ? <Pill tone={data.status === 'ACTIVE' ? 'success' : 'neutral'}>{d(`terms.status.${data.status}`)}</Pill> : null)
    const MoreCell = ({ data }: ICellRendererParams<PaymentTerms>) => {
      if (!data) return null
      const now = latest.current
      const archiveWait = archiveHeld(data, now.can)
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': d('terms.rowMenu', { code: data.code }) }}
          items={[
            { id: 'edit', label: d(now.can.manage ? 'terms.edit' : 'terms.view'), onSelect: () => now.actions?.onDialog?.({ mode: 'edit', terms: data }) },
            { id: 'copy', label: d('terms.copy'), disabled: !now.can.manage, description: now.can.manage ? undefined : d('terms.held.noManage'), onSelect: () => now.actions?.onDialog?.({ mode: 'copy', terms: data }) },
            data.status === 'ACTIVE'
              ? { id: 'archive', label: d('terms.archive'), tone: 'danger' as const, disabled: !!archiveWait, description: archiveWait ? d(archiveWait.key, archiveWait.params) : undefined, onSelect: () => now.actions?.onMove?.([data], 'archive') }
              : { id: 'reactivate', label: d('terms.reactivate'), disabled: !now.can.manage, description: now.can.manage ? undefined : d('terms.held.noManage'), onSelect: () => now.actions?.onMove?.([data], 'reactivate') },
          ]}
        />
      )
    }
    return [
      { colId: 'code', headerName: d('terms.col.code'), minWidth: 170, flex: 1.1, cellRenderer: NameCell },
      { colId: 'method', headerName: d('terms.col.method'), minWidth: 150, flex: 0.9, cellRenderer: MethodCell },
      { colId: 'words', headerName: d('terms.col.words'), minWidth: 260, flex: 2, cellRenderer: WordsCell },
      { colId: 'deposit', headerName: d('terms.col.deposit'), minWidth: 150, flex: 0.9, cellRenderer: DepositCell },
      { colId: 'discount', headerName: d('terms.col.discount'), minWidth: 140, flex: 0.8, cellRenderer: DiscountCell },
      { colId: 'customers', headerName: d('terms.col.customers'), minWidth: 100, flex: 0.5, type: 'rightAligned', cellRenderer: CustomersCell },
      { colId: 'state', headerName: d('terms.col.state'), minWidth: 110, flex: 0.6, cellRenderer: StateCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, d, locale])

  const items = model.terms
  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const toArchive = picked.filter((row) => row.status === 'ACTIVE')
  const toReactivate = picked.filter((row) => row.status === 'ARCHIVED')
  const archiveWait = toArchive.map((row) => archiveHeld(row, model.can)).find((entry) => entry !== null) ?? null
  const ownKeys: ListKey[] = [{ keys: ['n'], does: d('terms.keyAdd') }]

  // n: Add terms — never while typing or inside a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || help || model.dialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === 'n' && !addHeld) {
        event.preventDefault()
        actions?.onDialog?.({ mode: 'add' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const state = model.problem ? (
    <EmptyState title={d('terms.failed')} description={t(model.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    <EmptyState title={d(model.rows === 'active' ? 'terms.empty.title' : 'terms.emptyRows.title')} description={d(model.rows === 'active' ? 'terms.empty.body' : 'terms.emptyRows.body')} action={model.rows === 'active' ? <Button size="sm" heldReason={addHeld} onClick={() => actions?.onDialog?.({ mode: 'add' })}>{d('terms.add')}</Button> : undefined} />
  ) : undefined

  return (
    <Card padded className="fw-fin-card fw-fin-card--wide">
      <div className="fw-fin-card-head">
        <h2 className="fw-fin-h2">{d('terms.title')}</h2>
        <Button size="sm" heldReason={addHeld} onClick={() => actions?.onDialog?.({ mode: 'add' })} aria-keyshortcuts="n">
          <Plus size={14} aria-hidden /> {d('terms.add')}
        </Button>
      </div>
      <p className="fw-fin-hint">{d('terms.explain')}</p>
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={d(model.notice.words.key, model.notice.words.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      <ListFrame<PaymentTerms>
        label={d('terms.title')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? d('terms.count', { count: items.length }) : '—'}
        tools={
          <Select size="sm" aria-label={d('terms.rowsLabel')} value={model.rows} onChange={(event) => actions?.onRows?.(event.target.value as TermsRows)}>
            {TERMS_ROWS.map((view) => (
              <option key={view} value={view}>
                {d(`terms.rows.${view}`)}
              </option>
            ))}
          </Select>
        }
        listKey="finance.settings.terms"
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              {toArchive.length > 0 && (
                <Button size="sm" variant="primary" heldReason={!model.can.manage ? d('terms.held.noManage') : archiveWait ? d(archiveWait.key, archiveWait.params) : model.busy ? t('held.busy') : null} aria-label={d('terms.bulkArchive', { count: toArchive.length })} onClick={() => actions?.onMove?.(toArchive, 'archive')}>
                  <Archive size={13} aria-hidden /> <SelectionLabel>{d('terms.bulkArchive', { count: toArchive.length })}</SelectionLabel>
                </Button>
              )}
              {toReactivate.length > 0 && (
                <Button size="sm" heldReason={!model.can.manage ? d('terms.held.noManage') : model.busy ? t('held.busy') : null} aria-label={d('terms.bulkReactivate', { count: toReactivate.length })} onClick={() => actions?.onMove?.(toReactivate, 'reactivate')}>
                  <RotateCcw size={13} aria-hidden /> <SelectionLabel>{d('terms.bulkReactivate', { count: toReactivate.length })}</SelectionLabel>
                </Button>
              )}
            </>
          ),
        }}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onDialog?.({ mode: 'edit', terms: row })}
        state={state}
      />
      {model.dialog && <TermsDialog key={`${model.dialog.mode}-${model.dialog.mode === 'add' ? '' : model.dialog.terms.id}`} model={model} dialog={model.dialog} actions={actions} />}
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
    </Card>
  )
}

/**
 * Add, edit or copy payment terms: the code (new terms only), the printed name in the company's language and in English,
 * the FatturaPA method, the instalments (share, from which event, days after it, end of month), the early-payment discount;
 * the words its documents would print, live. Editing terms in use: their rules are fixed — the refusal offers "Save as new
 * terms" with the same rules and a new code.
 */
function TermsDialog({ model, dialog, actions }: { model: TermsSectionModel; dialog: TermsDialogState; actions?: TermsSectionActions }) {
  const t = useT('finance')
  const d = useT('finance-daily')
  const locale = useLocale()
  const start = dialog.draft ?? (dialog.mode === 'add' ? emptyTerms() : draftOf(dialog.terms, locale, dialog.mode === 'copy'))
  const [draft, setDraft] = useState<TermsDraft>(start)
  const readOnly = !model.can.manage
  const problems = termsProblems(draft)
  const bad = hasProblems(problems)
  const total = shareTotal(draft)
  const preview = previewOf(draft, locale)
  const held = model.busy ? t('held.busy') : readOnly ? d('terms.held.noManage') : bad ? d('terms.problem.fix') : null
  const set = (patch: Partial<TermsDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const setLine = (index: number, patch: Partial<TermsDraft['instalments'][number]>) => setDraft((current) => ({ ...current, instalments: current.instalments.map((item, at) => (at === index ? { ...item, ...patch } : item)) }))
  const title = dialog.mode === 'add' ? d('terms.addTitle') : dialog.mode === 'copy' ? d('terms.copyTitle', { code: dialog.terms.code }) : d('terms.editTitle', { code: dialog.terms.code })
  const inUse = !!model.dialogProblem?.inUse
  return (
    <DialogFrame title={title} held={held} go={() => actions?.onSave?.(dialog, draft)} goLabel={model.busy ? t('common.working') : d(dialog.mode === 'edit' ? 'terms.save' : 'terms.create')} onClose={() => actions?.onDialog?.(null)} size="lg">
      {model.dialogProblem && !(inUse && dialog.mode === 'edit') && <Banner tone="danger" title={d(model.dialogProblem.key, model.dialogProblem.params)} />}
      {inUse && dialog.mode === 'edit' && (
        <Banner
          tone="info"
          title={d('terms.inUseTitle')}
          action={
            <Button size="sm" variant="primary" onClick={() => actions?.onDialog?.({ mode: 'copy', terms: dialog.terms, draft: { ...draft, code: '' } })}>
              {d('terms.saveAsNew')}
            </Button>
          }
        >
          {d('terms.inUseBody')}
        </Banner>
      )}
      {dialog.mode === 'edit' && dialog.terms.customers > 0 && <p className="fw-fin-hint">{d('terms.usedBy', { count: dialog.terms.customers })}</p>}
      <div className="fw-fin-two">
        <Field label={d('terms.code')} hint={dialog.mode === 'edit' ? d('terms.codeFixed') : d('terms.codeHint')} error={draft.code && problems.code ? d(problems.code) : undefined}>
          <Input value={draft.code} maxLength={20} readOnly={dialog.mode === 'edit' || readOnly} onChange={(event) => set({ code: event.target.value.toUpperCase() })} autoComplete="off" />
        </Field>
        <Field label={d('terms.method')} error={problems.method ? d(problems.method) : undefined}>
          <Select value={draft.method} disabled={readOnly} onChange={(event) => set({ method: event.target.value })}>
            {METHOD_CHOICES.map((code) => (
              <option key={code} value={code}>
                {code} · {methodName(code, locale)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="fw-fin-two">
        <Field label={d('terms.name')} hint={d('terms.nameHint')} error={draft.name && problems.name ? d(problems.name) : undefined}>
          <Input value={draft.name} maxLength={200} readOnly={readOnly} onChange={(event) => set({ name: event.target.value })} autoComplete="off" />
        </Field>
        <Field label={d('terms.nameEn')} hint={d('terms.nameEnHint')} error={problems.nameEn ? d(problems.nameEn) : undefined}>
          <Input value={draft.nameEn} maxLength={200} readOnly={readOnly} onChange={(event) => set({ nameEn: event.target.value })} autoComplete="off" />
        </Field>
      </div>
      <fieldset className="fw-fin-choices">
        <legend className="fw-fin-legend">{d('terms.instalments')}</legend>
        <ol className="fw-fin-rows" aria-label={d('terms.instalments')}>
          {draft.instalments.map((item, index) => (
            <li key={index} className="fw-fin-row is-instalment">
              <Field label={d('terms.share', { n: index + 1 })} error={problems.lines[index] === 'terms.problem.share' ? d('terms.problem.share') : undefined}>
                <Input inputMode="decimal" value={item.sharePct} readOnly={readOnly} onChange={(event) => setLine(index, { sharePct: event.target.value })} autoComplete="off" />
              </Field>
              <Field label={d('terms.from')}>
                <Select value={item.from} disabled={readOnly} onChange={(event) => setLine(index, { from: event.target.value as TermsDraft['instalments'][number]['from'] })}>
                  {INSTALMENT_EVENTS.map((event) => (
                    <option key={event} value={event}>
                      {d(`terms.event.${event}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={d('terms.days')} error={problems.lines[index] === 'terms.problem.days' ? d('terms.problem.days') : undefined}>
                <Input inputMode="numeric" value={item.days} readOnly={readOnly} onChange={(event) => setLine(index, { days: event.target.value })} autoComplete="off" />
              </Field>
              <span className="fw-fin-stack-tight">
                <Checkbox checked={item.endOfMonth} disabled={readOnly} onChange={(event) => setLine(index, { endOfMonth: event.target.checked })} label={d('terms.endOfMonth')} />
                {draft.instalments.length > 1 && !readOnly && (
                  <Button size="sm" variant="link" onClick={() => setDraft((current) => ({ ...current, instalments: current.instalments.filter((_, at) => at !== index) }))} aria-label={d('terms.removeLine', { n: index + 1 })}>
                    <Trash2 size={13} aria-hidden /> {d('terms.remove')}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ol>
        <span className="fw-fin-inline">
          {!readOnly && draft.instalments.length < 12 && (
            <Button size="sm" variant="quiet" onClick={() => setDraft((current) => ({ ...current, instalments: [...current.instalments, { sharePct: '', from: 'INVOICE', days: '60', endOfMonth: true }] }))}>
              <Plus size={13} aria-hidden /> {d('terms.addLine')}
            </Button>
          )}
          {problems.instalments ? <Pill tone="warning">{d(problems.instalments, { total: decimal(String(total), locale) })}</Pill> : <span className="fw-fin-hint">{d('terms.total', { total: decimal(String(total), locale) })}</span>}
        </span>
      </fieldset>
      <div className="fw-fin-two">
        <Field label={d('terms.discountPct')} hint={d('terms.discountHint')} error={problems.discount ? d(problems.discount) : undefined}>
          <Input inputMode="decimal" value={draft.discountPct} readOnly={readOnly} onChange={(event) => set({ discountPct: event.target.value })} autoComplete="off" />
        </Field>
        <Field label={d('terms.discountDays')}>
          <Input inputMode="numeric" value={draft.discountDays} readOnly={readOnly} onChange={(event) => set({ discountDays: event.target.value })} autoComplete="off" />
        </Field>
      </div>
      <p className="fw-fin-hint" role="status">
        {preview ? d('terms.preview', { words: preview }) : d('terms.previewNone')}
      </p>
      <p className="fw-fin-hint">{d('terms.skipAugust')}</p>
    </DialogFrame>
  )
}
