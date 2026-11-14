'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, MoreHorizontal, Plus } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Phrase } from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import { DEPTH, DEPTH_NAMESPACES, type DepthProblem } from '../../../invoices/test-mode/depth'
import { CANCELLATION_DEPOSIT_KINDS, CANCELLATION_DOCUMENTS, CANCELLED_BY, REFUND_RULES, type DepositRule, type DepositRules } from '../api'
import { archiveHeld, manageHeld, ORDER_KINDS, orderKindOf, RULE_ROWS, ruleDraftProblems, ruleWords, type RuleAbilities, type RuleDraft, type RuleRows } from '../model'
import '../../../_shared/finance.css'

export type RuleDialog = { kind: 'add' } | { kind: 'edit'; rule: DepositRule } | { kind: 'archive'; rules: DepositRule[] }

export interface DepositRulesModel {
  can: RuleAbilities
  rows: RuleRows
  list: { value: DepositRules | null; problem: string | null }
  dialog: RuleDialog | null
  draft: RuleDraft
  busy: boolean
  problem: DepthProblem | null
  notice: { tone: 'success' | 'warning' | 'danger'; words: Phrase } | null
  selected?: string[]
}

export interface DepositRulesActions {
  onRows?: (rows: RuleRows) => void
  onRetry?: () => void
  onDialog?: (dialog: RuleDialog | null) => void
  onDraft?: (patch: Partial<RuleDraft>) => void
  onSave?: () => void
  onArchive?: () => void
  onDismissNotice?: () => void
}

/**
 * Finance settings › Deposits › Refund on cancellation (design finance.settings sec:deposits "refund on cancellation
 * (W2b)"; FIN-080; GATE-ACCOUNTANT): the company's rules on the shared list frame (select-all, shift range, x; Archive N
 * while rows are selected; keys only in the footer's info icon) — for an advance (acconto), a confirmatory or a penalty
 * caparra, who cancels (the customer, us) and which orders (made to measure, the others, any) → what is kept or paid back
 * (all back, a percent kept, twice back for a caparra we cancel) and the document that follows (a credit note, none). No
 * rule: everything is paid back. Add · change · archive; the rule waits for the accountant's word (said).
 */
export function DepositRulesCard({ model, actions }: { model: DepositRulesModel; actions?: DepositRulesActions }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <RulesCard model={model} actions={actions} />
    </WithMessages>
  )
}

function RulesCard({ model, actions }: { model: DepositRulesModel; actions?: DepositRulesActions }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const lists = useT('lists')
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(false)
  const items = model.list.value?.rules ?? null
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const add = manageHeld(model.can, model.busy)

  const columns = useMemo<ColDef<DepositRule>[]>(() => {
    const DepositCell = ({ data }: ICellRendererParams<DepositRule>) =>
      data ? (
        <span className="fw-fin-cell">
          <b>{w(`rule.kind.${data.depositKind}`)}</b>
          <span className="fw-fin-cell-sub">{w(`rule.orders.${orderKindOf(data.madeToMeasure)}`)}</span>
        </span>
      ) : null
    const ByCell = ({ data }: ICellRendererParams<DepositRule>) => (data ? <span>{w(`rule.by.${data.cancelledBy}`)}</span> : null)
    const WordsCell = ({ data }: ICellRendererParams<DepositRule>) => {
      if (!data) return null
      const words = ruleWords(data)
      return (
        <span className="fw-fin-cell">
          <span className="fw-fin-ellipsis">{w(words.key, words.params)}</span>
          {data.note && <span className="fw-fin-cell-sub fw-fin-ellipsis">{data.note}</span>}
        </span>
      )
    }
    const StateCell = ({ data }: ICellRendererParams<DepositRule>) => (data ? <Pill tone={data.status === 'ACTIVE' ? 'success' : 'neutral'}>{w(`rule.status.${data.status}`)}</Pill> : null)
    const MoreCell = ({ data }: ICellRendererParams<DepositRule>) => {
      if (!data) return null
      const now = latest.current
      const change = manageHeld(now.model.can) ?? (data.status === 'ARCHIVED' ? { key: 'rule.held.archived' } : null)
      const archive = archiveHeld(data, now.model.can)
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': w('rule.rowMenu', { kind: w(`rule.kind.${data.depositKind}`) }) }}
          items={[
            { id: 'edit', label: w('rule.edit'), disabled: !!change, description: change ? w(change.key) : undefined, onSelect: () => now.actions?.onDialog?.({ kind: 'edit', rule: data }) },
            { id: 'archive', label: w('rule.archive'), tone: 'danger' as const, disabled: !!archive, description: archive ? w(archive.key) : undefined, onSelect: () => now.actions?.onDialog?.({ kind: 'archive', rules: [data] }) },
          ]}
        />
      )
    }
    return [
      { colId: 'deposit', headerName: w('rule.col.deposit'), minWidth: 190, flex: 1.1, cellRenderer: DepositCell },
      { colId: 'by', headerName: w('rule.col.by'), minWidth: 150, flex: 0.8, cellRenderer: ByCell },
      { colId: 'words', headerName: w('rule.col.what'), minWidth: 260, flex: 2, cellRenderer: WordsCell },
      { colId: 'state', headerName: w('rule.col.state'), minWidth: 110, flex: 0.6, cellRenderer: StateCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, w])

  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const toArchive = picked.filter((row) => row.status === 'ACTIVE')
  const ownKeys: ListKey[] = [{ keys: ['n'], does: w('rule.keyAdd') }]

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || help || model.dialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === 'n' && !add) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'add' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const state = model.list.problem ? (
    <EmptyState title={w('rule.failed')} description={t(model.list.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    <EmptyState title={w(model.rows === 'archived' ? 'rule.emptyArchived' : 'rule.empty.title')} description={w('rule.empty.body')} action={model.rows !== 'archived' ? <Button size="sm" heldReason={add ? w(add.key) : null} onClick={() => actions?.onDialog?.({ kind: 'add' })}>{w('rule.add')}</Button> : undefined} />
  ) : undefined

  return (
    <Card padded className="fw-fin-card">
      <div className="fw-fin-card-head">
        <h2 className="fw-fin-h2">{w('rule.title')}</h2>
        <Button size="sm" heldReason={add ? w(add.key) : null} onClick={() => actions?.onDialog?.({ kind: 'add' })} aria-keyshortcuts="n">
          <Plus size={14} aria-hidden /> {w('rule.add')}
        </Button>
      </div>
      <p className="fw-fin-hint">{w('rule.explain')}</p>
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
      <ListFrame<DepositRule>
        label={w('rule.title')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? w('rule.count', { count: items.length }) : '—'}
        tools={
          <Select size="sm" aria-label={w('rule.rowsLabel')} value={model.rows} onChange={(event) => actions?.onRows?.(event.target.value as RuleRows)}>
            {RULE_ROWS.map((view) => (
              <option key={view} value={view}>
                {w(`rule.rows.${view}`)}
              </option>
            ))}
          </Select>
        }
        listKey="finance.settings.deposit-rules"
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" variant="primary" heldReason={!model.can.manage ? w('held.noRules') : toArchive.length === 0 ? w('rule.held.noneActive') : model.busy ? w('held.busy') : null} aria-label={w('rule.bulkArchive', { count: toArchive.length })} onClick={() => actions?.onDialog?.({ kind: 'archive', rules: toArchive })}>
              <Archive size={13} aria-hidden /> <SelectionLabel>{w('rule.bulkArchive', { count: toArchive.length })}</SelectionLabel>
            </Button>
          ),
        }}
        isRowSelectable={(row) => (row.status === 'ARCHIVED' ? w('rule.held.archived') : null)}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => {
          if (row.status === 'ACTIVE' && model.can.manage) actions?.onDialog?.({ kind: 'edit', rule: row })
        }}
        state={state}
      />
      <p className="fw-fin-hint">{w('rule.accountant')}</p>
      {(model.dialog?.kind === 'add' || model.dialog?.kind === 'edit') && <RuleFormDialog model={model} rule={model.dialog.kind === 'edit' ? model.dialog.rule : null} actions={actions} />}
      {model.dialog?.kind === 'archive' && (
        <DialogFrame
          title={w('rule.archiveTitle', { count: model.dialog.rules.length })}
          held={model.busy ? w('held.busy') : null}
          go={() => actions?.onArchive?.()}
          goLabel={model.busy ? t('common.working') : w('rule.archiveGo', { count: model.dialog.rules.length })}
          onClose={() => actions?.onDialog?.(null)}
          problem={model.problem ? { key: model.problem.key, ...(model.problem.params ? { params: model.problem.params } : {}) } : null}
          tone="danger"
        >
          <p className="fw-fin-hint">{w('rule.archiveExplain')}</p>
        </DialogFrame>
      )}
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

/** Add a rule, or change what an active one keeps and the document (its deposit, side and orders are fixed). */
function RuleFormDialog({ model, rule, actions }: { model: DepositRulesModel; rule: DepositRule | null; actions?: DepositRulesActions }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const draft = model.draft
  const problems = ruleDraftProblems(draft)
  const held = model.busy ? w('held.busy') : !model.can.manage ? w('held.noRules') : Object.keys(problems).length > 0 ? w('rule.held.fix') : null
  const fixed = rule !== null
  const words = ruleWords({ refundRule: draft.refundRule, keepPct: draft.keepPct.replace(',', '.') || '0', documentKind: draft.documentKind })
  return (
    <DialogFrame
      title={w(fixed ? 'rule.editTitle' : 'rule.addTitle')}
      held={held}
      go={() => actions?.onSave?.()}
      goLabel={model.busy ? t('common.working') : w(fixed ? 'rule.save' : 'rule.create')}
      onClose={() => actions?.onDialog?.(null)}
      problem={model.problem ? { key: model.problem.key, ...(model.problem.params ? { params: model.problem.params } : {}) } : null}
      size="lg"
    >
      <div className="fw-fin-two">
        <Field label={w('rule.field.kind')} hint={fixed ? w('rule.field.fixed') : undefined}>
          <Select value={draft.depositKind} disabled={fixed} onChange={(event) => actions?.onDraft?.({ depositKind: event.target.value as RuleDraft['depositKind'] })}>
            {CANCELLATION_DEPOSIT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {w(`rule.kind.${kind}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={w('rule.field.by')} hint={fixed ? w('rule.field.fixed') : undefined}>
          <Select value={draft.cancelledBy} disabled={fixed} onChange={(event) => actions?.onDraft?.({ cancelledBy: event.target.value as RuleDraft['cancelledBy'] })}>
            {CANCELLED_BY.map((side) => (
              <option key={side} value={side}>
                {w(`rule.by.${side}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={w('rule.field.orders')} hint={fixed ? w('rule.field.fixed') : undefined}>
          <Select value={draft.orderKind} disabled={fixed} onChange={(event) => actions?.onDraft?.({ orderKind: event.target.value as RuleDraft['orderKind'] })}>
            {ORDER_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {w(`rule.orders.${kind}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="fw-fin-two">
        <Field label={w('rule.field.refund')} error={problems.refundRule ? w(problems.refundRule) : undefined}>
          <Select value={draft.refundRule} onChange={(event) => actions?.onDraft?.({ refundRule: event.target.value as RuleDraft['refundRule'], ...(event.target.value === 'KEEP_PERCENT' ? {} : { keepPct: '0' }) })}>
            {REFUND_RULES.map((refund) => (
              <option key={refund} value={refund}>
                {w(`rule.refund.${refund}`)}
              </option>
            ))}
          </Select>
        </Field>
        {draft.refundRule === 'KEEP_PERCENT' && (
          <Field label={w('rule.field.keep')} error={problems.keepPct ? w(problems.keepPct) : undefined}>
            <Input inputMode="decimal" value={draft.keepPct} onChange={(event) => actions?.onDraft?.({ keepPct: event.target.value })} autoComplete="off" />
          </Field>
        )}
        <Field label={w('rule.field.document')} error={problems.documentKind ? w(problems.documentKind) : undefined}>
          <Select value={draft.documentKind} onChange={(event) => actions?.onDraft?.({ documentKind: event.target.value as RuleDraft['documentKind'] })}>
            {CANCELLATION_DOCUMENTS.map((kind) => (
              <option key={kind} value={kind}>
                {w(`rule.document.${kind}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={w('rule.field.note')} hint={w('rule.field.noteHint')} error={problems.note ? w(problems.note) : undefined}>
        <Textarea value={draft.note} rows={2} maxLength={500} onChange={(event) => actions?.onDraft?.({ note: event.target.value })} />
      </Field>
      <p className="fw-fin-hint" role="status">
        {w('rule.preview', { words: w(words.key, words.params) })}
      </p>
    </DialogFrame>
  )
}
