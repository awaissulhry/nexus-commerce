'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ListRestart, Plus, Search } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { ItemEntry, ItemParameters, PlanningSite } from '../../api'
import { manageHeld, type SettingsCan } from '../../model'
import { ReadFailed } from '../../view/parts'
import { markKey, methodPatch, PARAMS_NAMESPACES, planPatch, qtyText, REORDER_METHODS, REORDER_QTY_FIELDS, reorderCellOpen, ruleTarget, type Mark, type Notice, type QtyField, type ReorderMethod, type Words } from '../model'
import { cellKeys, ElsewhereBanner, KeysDialog, NoticeBanner, SaveMark, useSay } from './cells'
import '../params.css'

export interface RuleDraft {
  query: string
  itemId: string | null
  colourId: string | null
  method: ReorderMethod
  first: string
  second: string
}
export const EMPTY_RULE: RuleDraft = { query: '', itemId: null, colourId: null, method: 'REORDER_POINT', first: '', second: '' }

export type ReorderDialog = { kind: 'method'; id: string; method?: ReorderMethod } | { kind: 'new'; draft: RuleDraft } | { kind: 'orders' } | { kind: 'keys' }

export interface RuleSearch {
  status: 'idle' | 'loading' | 'ready' | 'error'
  items: readonly ItemEntry[]
}

/** The ONE view model of Reorder rules. It fetches nothing. */
export interface ReorderModel {
  site: PlanningSite
  can: SettingsCan
  load: { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready' }
  rules: readonly ItemParameters[] | null
  marks: Readonly<Record<string, Mark>>
  notice: Notice | null
  changedElsewhere: boolean
  busy: boolean
  search: RuleSearch
  selected?: readonly string[]
  dialog?: ReorderDialog | null
  focusRow?: number
}

export interface ReorderActions {
  onRetry?: () => void
  onReload?: () => void
  onCell?: (rule: ItemParameters, field: QtyField, raw: unknown) => void
  onMethod?: (rule: ItemParameters, patch: Record<string, unknown>) => void
  onSearch?: (query: string) => void
  /** A new rule (or an item's row changed to one): resolves true when saved. */
  onRule?: (entry: ItemEntry, colourId: string | null, patch: Record<string, unknown>) => Promise<boolean>
  /** "Plan N from orders": each rule's method back to ORDERS (its reorder values are cleared). */
  onOrders?: (rules: readonly ItemParameters[]) => Promise<boolean>
  onDismissNotice?: () => void
}

export function ReorderView({ model, actions }: { model: ReorderModel; actions?: ReorderActions }) {
  return (
    <WithMessages namespaces={PARAMS_NAMESPACES}>
      <Reorder model={model} actions={actions} />
    </WithMessages>
  )
}

const nameOf = (rule: Pick<ItemParameters, 'item' | 'colour'>) => (rule.colour ? `${rule.item.code} · ${rule.colour.name}` : rule.item.code)

function Reorder({ model, actions }: { model: ReorderModel; actions?: ReorderActions }) {
  const t = useT('planning-params')
  const ts = useT('planning-settings')
  const locale = useLocale()
  const held = manageHeld('reorder', model.can)
  const heldText = held ? ts(held) : null
  const can = model.can.manageItems
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const [dialog, setDialog] = useState<ReorderDialog | null>(model.dialog ?? null)
  useEffect(() => setDialog(model.dialog ?? null), [model.dialog])
  const latest = useRef({ model, actions, setDialog })
  latest.current = { model, actions, setDialog }
  const marksKey = JSON.stringify(model.marks)
  const picked = (model.rules ?? []).filter((rule) => selected.includes(rule.id))

  const columns = useMemo<ColDef<ItemParameters>[]>(() => {
    const mark = (id: string, field: string) => latest.current.model.marks[markKey(id, field)]
    const ItemCell = ({ data }: ICellRendererParams<ItemParameters>) =>
      data ? (
        <span className="fw-pp-two">
          <span className="fw-pp-code">{data.item.code}</span>
          <span className="fw-pp-sub">{data.item.name}</span>
        </span>
      ) : null
    const MethodCell = ({ data }: ICellRendererParams<ItemParameters>) => {
      if (!data) return null
      const text = t(`pp.method.${data.method}`)
      return (
        <span className="fw-pp-cell">
          <Button size="sm" variant="quiet" heldReason={can ? null : heldText} aria-label={t('pp.cell.change', { field: t('pp.field.method'), item: nameOf(data), value: text })} onClick={() => latest.current.setDialog({ kind: 'method', id: data.id })}>
            {text}
          </Button>
          <SaveMark mark={mark(data.id, 'method')} />
        </span>
      )
    }
    const NumberCell = (field: QtyField) =>
      function NumberValue({ data }: ICellRendererParams<ItemParameters>) {
        if (!data) return null
        if (!reorderCellOpen(data, field)) return <span className="fw-pp-sub" title={t('pp.reorder.notThisMethod')}>—</span>
        const value = data[field]
        return (
          <span className="fw-pp-cell num">
            <span className={value === null ? 'fw-pp-sub' : undefined}>{value === null ? '—' : `${qtyText(value, locale)} ${t(`pp.uom.${data.item.baseUom}`)}`}</span>
            <SaveMark mark={mark(data.id, field)} />
          </span>
        )
      }
    const number = (field: QtyField): ColDef<ItemParameters> => ({
      colId: field,
      headerName: t(`pp.col.${field}`),
      minWidth: 130,
      flex: 1,
      ...(can ? { editable: (params: { data?: ItemParameters }) => !!params.data && reorderCellOpen(params.data, field), cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: 20 } } : {}),
      valueGetter: (params) => params.data?.[field] ?? '',
      valueSetter: (params) => {
        if (params.data) latest.current.actions?.onCell?.(params.data, field, params.newValue)
        return false
      },
      cellRenderer: NumberCell(field),
      suppressKeyboardEvent: cellKeys(),
    })
    return [
      { colId: 'item', headerName: t('pp.col.item'), minWidth: 200, flex: 1.6, cellRenderer: ItemCell, suppressKeyboardEvent: cellKeys() },
      { colId: 'colour', headerName: t('pp.col.colour'), minWidth: 130, flex: 0.9, valueGetter: (params) => (params.data?.colour ? params.data.colour.name : t('pp.colour.every')), suppressKeyboardEvent: cellKeys() },
      { colId: 'warehouse', headerName: t('pp.col.warehouse'), minWidth: 140, flex: 0.9, valueGetter: () => latest.current.model.site.name, suppressKeyboardEvent: cellKeys() },
      {
        colId: 'method',
        headerName: t('pp.col.method'),
        minWidth: 150,
        flex: 1,
        cellRenderer: MethodCell,
        suppressKeyboardEvent: (params: { event: KeyboardEvent; editing: boolean; data?: ItemParameters }) => cellKeys(can && params.data ? () => latest.current.setDialog({ kind: 'method', id: params.data!.id }) : undefined)(params),
      },
      ...REORDER_QTY_FIELDS.map(number),
    ]
  }, [t, locale, can, heldText, marksKey])

  const ownKeys: ListKey[] = can
    ? [
        { keys: ['c'], does: t('pp.keys.newRule') },
        { keys: ['↵'], does: t('pp.keys.edit') },
        { keys: ['Esc'], does: t('pp.keys.cancel') },
      ]
    : []
  const ready = model.load.status === 'ready' && model.rules !== null
  const newRule = () => setDialog({ kind: 'new', draft: EMPTY_RULE })

  // c: a new rule (as every list's "c").
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest?.('input, textarea, select, [role="dialog"], [role="menu"], .ag-cell-inline-editing') || target?.isContentEditable) return
      if (!latest.current.model.can.manageItems || latest.current.model.load.status !== 'ready') return
      event.preventDefault()
      latest.current.setDialog({ kind: 'new', draft: EMPTY_RULE })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  let state: ReactNode = undefined
  if (model.load.status === 'error') state = <ReadFailed title={t('pp.reorder.failed')} problem={model.load.problem} onRetry={actions?.onRetry} />
  else if (ready && model.rules!.length === 0)
    state = (
      <EmptyState
        title={t('pp.reorder.empty.title')}
        description={t('pp.reorder.empty.body')}
        action={
          <Button size="sm" variant="primary" heldReason={heldText} onClick={newRule}>
            <Plus size={14} aria-hidden /> {t('pp.reorder.new')}
          </Button>
        }
      />
    )
  const methodRule = dialog?.kind === 'method' ? (model.rules ?? []).find((rule) => rule.id === dialog.id) ?? null : null
  const close = () => setDialog(null)

  return (
    <section className="fw-pp" aria-label={t('pp.reorder.title')}>
      <p className="fw-ps-hint">{t('pp.reorder.hint', { site: model.site.name })}</p>
      {model.changedElsewhere && <ElsewhereBanner onReload={actions?.onReload} />}
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {ready && !can && <Banner tone="neutral" title={t('pp.readOnly.title')}>{heldText}</Banner>}
      <ListFrame<ItemParameters>
        label={t('pp.reorder.table')}
        listKey="planning.settings.reorder"
        rows={state ? [] : model.rules}
        rowId={(rule) => rule.id}
        columns={columns}
        rowKind="two-line"
        count={model.rules ? t('pp.reorder.count', { count: model.rules.length }) : '—'}
        right={
          <Button size="sm" variant="primary" heldReason={!ready ? t('pp.held.loading') : heldText} onClick={newRule} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> <SelectionLabel>{t('pp.reorder.new')}</SelectionLabel>
          </Button>
        }
        selection={
          ready
            ? {
                selected,
                onChange: setSelected,
                actions: (
                  <Button size="sm" variant="danger-outline" aria-label={t('pp.reorder.toOrders', { count: picked.length })} heldReason={heldText ?? (model.busy ? ts('ps.held.busy') : null)} onClick={() => setDialog({ kind: 'orders' })}>
                    <ListRestart size={13} aria-hidden /> <SelectionLabel>{t('pp.reorder.toOrders', { count: picked.length })}</SelectionLabel>
                  </Button>
                ),
              }
            : undefined
        }
        keys={ownKeys}
        onHelp={() => setDialog({ kind: 'keys' })}
        state={state}
        focusRow={model.focusRow}
      />
      {dialog?.kind === 'method' && methodRule && <RuleMethodDialog rule={methodRule} initial={dialog.method} actions={actions} onClose={close} />}
      {dialog?.kind === 'new' && <NewRuleDialog draft={dialog.draft} model={model} onDraft={(draft) => setDialog({ kind: 'new', draft })} actions={actions} onClose={close} />}
      {dialog?.kind === 'orders' && <OrdersDialog rules={picked} busy={model.busy} actions={actions} onClose={close} onDone={() => setSelected([])} />}
      {dialog?.kind === 'keys' && <KeysDialog keys={ownKeys} selection onClose={close} />}
    </section>
  )
}

/** The pair a method needs, as typed (its two values). */
function PairFields({ method, first, second, unit, onFirst, onSecond, error }: { method: ReorderMethod; first: string; second: string; unit: string; onFirst: (value: string) => void; onSecond: (value: string) => void; error?: { field: string; text: string } | null }) {
  const t = useT('planning-params')
  const [a, b] = method === 'REORDER_POINT' ? (['reorderPoint', 'lotSize'] as const) : (['minStock', 'maxStock'] as const)
  return (
    <div className="fw-pp-pair">
      <Field label={t(`pp.field.${a}`)} hint={t('pp.inUnit', { unit })} required error={error?.field === a ? error.text : undefined}>
        <Input inputMode="decimal" value={first} onChange={(event) => onFirst(event.target.value)} />
      </Field>
      <Field label={t(`pp.field.${b}`)} hint={t('pp.inUnit', { unit })} required error={error?.field === b ? error.text : undefined}>
        <Input inputMode="decimal" value={second} onChange={(event) => onSecond(event.target.value)} />
      </Field>
    </div>
  )
}

/** A rule's method switched (reorder point ⇄ min/max), with the two values the new one needs. */
function RuleMethodDialog({ rule, initial, actions, onClose }: { rule: ItemParameters; initial?: ReorderMethod; actions?: ReorderActions; onClose: () => void }) {
  const t = useT('planning-params')
  const say = useSay()
  const start: ReorderMethod = initial ?? (rule.method === 'MIN_MAX' ? 'MIN_MAX' : 'REORDER_POINT')
  const pair = (method: ReorderMethod): [string, string] => (method === 'REORDER_POINT' ? [rule.reorderPoint ?? '', rule.lotSize ?? ''] : [rule.minStock ?? '', rule.maxStock ?? ''])
  const [method, setMethod] = useState<ReorderMethod>(start)
  const [first, setFirst] = useState(pair(start)[0])
  const [second, setSecond] = useState(pair(start)[1])
  const typed = methodPatch(method, first, second)
  const plan = 'patch' in typed ? planPatch(rule, typed.patch) : null
  const problem: { field: string; words: Words } | null = 'words' in typed ? typed : plan?.kind === 'refused' ? plan : null
  return (
    <Modal
      open
      onClose={onClose}
      title={t('pp.methodDialog.title', { item: nameOf(rule) })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('pp.cancel')}</Button>
          <Button
            variant="primary"
            heldReason={problem ? say(problem.words) : plan?.kind === 'none' ? t('pp.held.same') : null}
            onClick={() => {
              if (plan?.kind !== 'write' || !('patch' in typed)) return
              actions?.onMethod?.(rule, typed.patch as Record<string, unknown>)
              onClose()
            }}
          >
            {t('pp.methodDialog.apply')}
          </Button>
        </>
      }
    >
      <div className="fw-pp-dialog">
        <SegmentedControl
          ariaLabel={t('pp.field.method')}
          value={method}
          options={REORDER_METHODS.map((value) => ({ value, label: t(`pp.method.${value}`) }))}
          onChange={(value) => {
            const next = value as ReorderMethod
            setMethod(next)
            setFirst(pair(next)[0])
            setSecond(pair(next)[1])
          }}
        />
        <p className="fw-ps-hint">{t(`pp.methodHint.${method}`)}</p>
        <PairFields method={method} first={first} second={second} unit={t(`pp.uom.${rule.item.baseUom}`)} onFirst={setFirst} onSecond={setSecond} error={problem ? { field: problem.field, text: say(problem.words) } : null} />
        {plan?.kind === 'write' && plan.cleared.length > 0 && <Banner tone="info">{t('pp.methodDialog.clears', { fields: plan.cleared.map((field) => t(`pp.field.${field}`)).join(', ') })}</Banner>}
      </div>
    </Modal>
  )
}

/** New rule: the item (search), its colour or every colour, the method and its two values. An item with a row is changed. */
function NewRuleDialog({ draft, model, onDraft, actions, onClose }: { draft: RuleDraft; model: ReorderModel; onDraft: (draft: RuleDraft) => void; actions?: ReorderActions; onClose: () => void }) {
  const t = useT('planning-params')
  const say = useSay()
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<RuleDraft>) => onDraft({ ...draft, ...patch })
  useEffect(() => {
    if (!actions?.onSearch || draft.query.trim().length < 1) return
    const timer = setTimeout(() => actions.onSearch?.(draft.query.trim()), 300)
    return () => clearTimeout(timer)
  }, [draft.query, actions])
  const items = actions?.onSearch
    ? model.search.items
    : model.search.items.filter((entry) => !draft.query.trim() || `${entry.item.code} ${entry.item.name}`.toLowerCase().includes(draft.query.trim().toLowerCase()))
  const entry = items.find((candidate) => candidate.item.id === draft.itemId) ?? model.search.items.find((candidate) => candidate.item.id === draft.itemId) ?? null
  const target = entry ? ruleTarget(entry, draft.colourId) : null
  const typed = methodPatch(draft.method, draft.first, draft.second)
  const plan = entry && 'patch' in typed ? planPatch(target, typed.patch) : null
  const problem: { field: string; words: Words } | null = 'words' in typed && (draft.first || draft.second) ? typed : plan?.kind === 'refused' && (draft.first || draft.second) ? plan : null
  const heldReason = !entry ? t('pp.rule.pickItem') : saving ? t('pp.held.busy') : 'words' in typed ? say(typed.words) : plan?.kind === 'refused' ? say(plan.words) : plan?.kind === 'none' ? t('pp.held.same') : null
  return (
    <Modal
      open
      onClose={onClose}
      title={t('pp.rule.title')}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>{t('pp.cancel')}</Button>
          <Button
            variant="primary"
            heldReason={heldReason}
            onClick={async () => {
              if (!entry || !('patch' in typed) || plan?.kind !== 'write') return
              setSaving(true)
              const ok = await (actions?.onRule?.(entry, draft.colourId, typed.patch as Record<string, unknown>) ?? Promise.resolve(true))
              setSaving(false)
              if (ok) onClose()
            }}
          >
            {saving ? <Spinner size={12} /> : null} {target ? t('pp.rule.change') : t('pp.rule.add')}
          </Button>
        </>
      }
    >
      <div className="fw-pp-dialog">
        <Field label={t('pp.rule.item')} hint={model.search.status === 'error' ? t('pp.rule.searchFailed') : t('pp.rule.itemHint')}>
          <Input type="search" leadingIcon={<Search size={13} aria-hidden />} value={draft.query} onChange={(event) => set({ query: event.target.value })} />
        </Field>
        {model.search.status === 'loading' && (
          <p className="fw-ps-hint" role="status">
            <Spinner size={12} /> {t('pp.rule.searching')}
          </p>
        )}
        {items.length > 0 && (
          <div className="fw-pp-picks" role="radiogroup" aria-label={t('pp.rule.item')}>
            {items.slice(0, 8).map((candidate) => (
              <Button key={candidate.item.id} size="sm" variant={candidate.item.id === draft.itemId ? 'tonal' : 'quiet'} role="radio" aria-checked={candidate.item.id === draft.itemId} onClick={() => set({ itemId: candidate.item.id, colourId: null })}>
                <span className="fw-pp-code">{candidate.item.code}</span> {candidate.item.name}
              </Button>
            ))}
          </div>
        )}
        {entry && (
          <>
            <Field label={t('pp.col.colour')}>
              <Select value={draft.colourId ?? ''} onChange={(event) => set({ colourId: event.target.value || null })}>
                <option value="">{t('pp.colour.every')}</option>
                {entry.item.colours.map((colour) => (
                  <option key={colour.id} value={colour.id}>
                    {colour.name}
                  </option>
                ))}
              </Select>
            </Field>
            {target && <Banner tone="info">{t('pp.rule.hasRow', { method: t(`pp.method.${target.method}`) })}</Banner>}
            <SegmentedControl ariaLabel={t('pp.field.method')} value={draft.method} options={REORDER_METHODS.map((value) => ({ value, label: t(`pp.method.${value}`) }))} onChange={(value) => set({ method: value as ReorderMethod, first: '', second: '' })} />
            <p className="fw-ps-hint">{t(`pp.methodHint.${draft.method}`)}</p>
            <PairFields method={draft.method} first={draft.first} second={draft.second} unit={t(`pp.uom.${entry.item.baseUom}`)} onFirst={(first) => set({ first })} onSecond={(second) => set({ second })} error={problem ? { field: problem.field, text: say(problem.words) } : null} />
          </>
        )}
      </div>
    </Modal>
  )
}

/** "Plan N from orders": the rules end; the items are planned from the orders again (their reorder values cleared). */
function OrdersDialog({ rules, busy, actions, onClose, onDone }: { rules: readonly ItemParameters[]; busy: boolean; actions?: ReorderActions; onClose: () => void; onDone: () => void }) {
  const t = useT('planning-params')
  return (
    <Modal
      open
      onClose={onClose}
      title={t('pp.reorder.toOrdersTitle', { count: rules.length })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('pp.cancel')}</Button>
          <Button
            variant="danger"
            heldReason={busy ? t('pp.held.busy') : null}
            onClick={async () => {
              const ok = await (actions?.onOrders?.(rules) ?? Promise.resolve(true))
              if (ok) {
                onDone()
                onClose()
              }
            }}
          >
            {t('pp.reorder.toOrders', { count: rules.length })}
          </Button>
        </>
      }
    >
      <div className="fw-pp-dialog">
        <p>{t('pp.reorder.toOrdersBody')}</p>
        <ul className="fw-pp-names">
          {rules.map((rule) => (
            <li key={rule.id}>{nameOf(rule)}</li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}
