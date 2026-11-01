'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Plus, RotateCcw, Search, XCircle } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Kbd, Pill, SegmentedControl, Select, Toggle } from '@nexus/ui/primitives'
import { OFF_STANDARD_KINDS, PAY_RULES, type OffStandardKind, type PayRule } from '@nexus/factory-domain/production/offstandard/rules'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { FLOOR_RULES_NAMESPACES } from '../model'
import type { OffCode } from '../w2b-api'
import { markKey, offDraftHeld, typedCode, type Mark, type OffDraft } from '../w2b-model'
import { cellKeys, languageName, SaveMark } from './cells'

export type OffDialog = { kind: 'new'; draft: OffDraft; problem: string | null } | { kind: 'keys' }

/** The ONE view model of Off-standard codes (fetches nothing). */
export interface OffStandardModel {
  load: { status: 'loading' } | { status: 'ready' } | { status: 'error'; problem: string }
  codes: readonly OffCode[] | null
  /** The floor languages besides Italian and English (their word columns). */
  languages: readonly string[]
  canManage: boolean
  marks: Readonly<Record<string, Mark>>
  notice: { tone: 'success' | 'danger' | 'info'; key: string; params?: Record<string, string | number> } | null
  busy: boolean
  dialog: OffDialog | null
  changedElsewhere: boolean
  /** Design cases. */
  selected?: readonly string[]
  focusRow?: number
}

export interface OffStandardActions {
  onRetry?: () => void
  onReload?: () => void
  onCell?: (row: OffCode, field: 'labelIt' | 'labelEn' | `lang:${string}`, value: unknown) => void
  onPayRule?: (row: OffCode, rule: PayRule) => void
  onSwitch?: (row: OffCode, field: 'needsApproval' | 'active', next: boolean) => void
  onActiveMany?: (ids: readonly string[], active: boolean) => void
  onDialog?: (dialog: OffDialog | null) => void
  onCreate?: () => void
  onDismissNotice?: () => void
}

const PAY_TONE: Readonly<Record<PayRule, 'success' | 'info' | 'neutral'>> = { AVERAGE: 'success', BASE: 'info', UNPAID: 'neutral' }

/**
 * Floor rules & codes › Off-standard codes (design production.settings fr-offstd, MES-155): ONE list frame of the
 * company's codes for time not on standard work — code (with its kind: off-standard or indirect), words in Italian,
 * English and each other floor language, the pay rule (average earnings, base hourly, unpaid; the CCNL reading is NOT
 * verified: said on the page), whether the team leader approves the time, active, how many blocks use it and the help-call
 * types whose waiting books to it — saved per cell with the DS save mark. New code (`c`); Set N inactive / active with rows
 * selected. A code in use is set inactive, never deleted; a code's kind never changes. Keys only in the footer's icon.
 */
export function OffStandardView({ model, actions }: { model: OffStandardModel; actions?: OffStandardActions }) {
  return (
    <WithMessages namespaces={FLOOR_RULES_NAMESPACES}>
      <Editor model={model} actions={actions} />
    </WithMessages>
  )
}

const NEW_DIALOG = (): OffDialog => ({ kind: 'new', draft: { code: '', kind: 'OFF_STANDARD', payRule: 'AVERAGE', needsApproval: true, labelIt: '', labelEn: '' }, problem: null })

function Editor({ model, actions }: { model: OffStandardModel; actions?: OffStandardActions }) {
  const t = useT('floor-rules')
  const locale = useLocale()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const all = model.codes
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!all || !needle) return all
    return all.filter((row) => [row.code, row.labelIt, row.labelEn, ...Object.values(row.labelI18n)].some((text) => text.toLowerCase().includes(needle)))
  }, [all, query])
  const picked = (all ?? []).filter((row) => selected.includes(row.id))
  const latest = useRef({ model, actions })
  latest.current = { model, actions }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || latest.current.model.dialog) return
      if (target?.closest?.('input, textarea, select, [role="dialog"], [role="menu"], .ag-cell-inline-editing')) return
      if (event.key === 'c' && latest.current.model.canManage && latest.current.model.load.status === 'ready') {
        event.preventDefault()
        latest.current.actions?.onDialog?.(NEW_DIALOG())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const marksKey = JSON.stringify(model.marks)
  const columns = useMemo<ColDef<OffCode>[]>(() => {
    const can = model.canManage
    const mark = (id: string, field: string) => latest.current.model.marks[markKey(id, field)]
    const editable = () => (can ? { editable: true, cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: 80 } } : {})
    const CodeCell = ({ data }: ICellRendererParams<OffCode>) =>
      data ? (
        <span className="fw-fr-cell-col">
          <span className={data.active ? 'fw-fr-code' : 'fw-fr-code off'}>{data.code}</span>
          <span className="fw-fr-sub">{t(`fr.off.kind.${data.kind}`)}</span>
        </span>
      ) : null
    const Words = (field: 'labelIt' | 'labelEn' | `lang:${string}`) =>
      function WordsCell({ data, value }: ICellRendererParams<OffCode>) {
        if (!data) return null
        const text = typeof value === 'string' ? value : ''
        return (
          <span className="fw-fr-cell">
            {text ? <span className="fw-fr-ellipsis">{text}</span> : <span className="fw-fr-sub">{t('fr.cells.fallback')}</span>}
            <SaveMark mark={mark(data.id, field)} />
          </span>
        )
      }
    const words = (field: 'labelIt' | 'labelEn', headerName: string): ColDef<OffCode> => ({
      colId: field,
      headerName,
      field,
      minWidth: 150,
      flex: 1.3,
      ...editable(),
      cellRenderer: Words(field),
      suppressKeyboardEvent: cellKeys(),
      valueSetter: (params) => {
        if (params.data) latest.current.actions?.onCell?.(params.data, field, params.newValue)
        return false
      },
    })
    const PayCell = ({ data }: ICellRendererParams<OffCode>) =>
      data ? (
        <span className="fw-fr-cell">
          {can ? (
            <Select size="sm" aria-label={t('fr.off.payFor', { code: data.code })} value={data.payRule} onChange={(event) => latest.current.actions?.onPayRule?.(data, event.target.value as PayRule)}>
              {PAY_RULES.map((rule) => (
                <option key={rule} value={rule}>
                  {t(`fr.off.pay.${rule}`)}
                </option>
              ))}
            </Select>
          ) : (
            <Pill tone={PAY_TONE[data.payRule]}>{t(`fr.off.pay.${data.payRule}`)}</Pill>
          )}
          <SaveMark mark={mark(data.id, 'payRule')} />
        </span>
      ) : null
    const Switch = (field: 'needsApproval' | 'active') =>
      function SwitchCell({ data }: ICellRendererParams<OffCode>) {
        if (!data) return null
        const on = data[field]
        const word = t(`fr.off.${field}.${on ? 'on' : 'off'}`)
        return (
          <span className="fw-fr-cell">
            {can ? <Toggle size="xs" checked={on} aria-label={t(`fr.off.${field}.label`, { code: data.code })} onChange={(next) => latest.current.actions?.onSwitch?.(data, field, next)} /> : null}
            {field === 'active' && !on ? <Pill tone="neutral">{word}</Pill> : <span className={on ? undefined : 'fw-fr-sub'}>{word}</span>}
            <SaveMark mark={mark(data.id, field)} />
          </span>
        )
      }
    const switchColumn = (field: 'needsApproval' | 'active'): ColDef<OffCode> => ({
      colId: field,
      headerName: t(`fr.off.col.${field}`),
      field,
      minWidth: 130,
      flex: 0.8,
      cellRenderer: Switch(field),
      suppressKeyboardEvent: can ? (params) => cellKeys(() => params.data && latest.current.actions?.onSwitch?.(params.data, field, !params.data[field]))(params) : cellKeys(),
    })
    const UsedCell = ({ data }: ICellRendererParams<OffCode>) =>
      data ? (
        <span className="fw-fr-cell-col">
          <span className="fw-fr-num">{t('fr.off.used', { count: data.usedCount })}</span>
          {data.callTypes.length > 0 && <span className="fw-fr-sub fw-fr-ellipsis">{t('fr.off.calls', { types: data.callTypes.join(', ') })}</span>}
        </span>
      ) : null
    const languageColumns: ColDef<OffCode>[] = latest.current.model.languages.map((language) => ({
      colId: `lang:${language}`,
      headerName: languageName(language, locale),
      minWidth: 140,
      flex: 1.1,
      valueGetter: (params) => params.data?.labelI18n[language] ?? '',
      ...editable(),
      cellRenderer: Words(`lang:${language}`),
      suppressKeyboardEvent: cellKeys(),
      valueSetter: (params) => {
        if (params.data) latest.current.actions?.onCell?.(params.data, `lang:${language}`, params.newValue)
        return false
      },
    }))
    return [
      { colId: 'code', headerName: t('fr.off.col.code'), field: 'code', minWidth: 150, flex: 1, cellRenderer: CodeCell, suppressKeyboardEvent: cellKeys() },
      words('labelIt', t('fr.cells.it')),
      words('labelEn', t('fr.cells.en')),
      ...languageColumns,
      { colId: 'payRule', headerName: t('fr.off.col.payRule'), field: 'payRule', minWidth: 170, flex: 1, cellRenderer: PayCell, suppressKeyboardEvent: cellKeys() },
      switchColumn('needsApproval'),
      switchColumn('active'),
      { colId: 'used', headerName: t('fr.off.col.used'), field: 'usedCount', minWidth: 130, flex: 0.8, cellRenderer: UsedCell, suppressKeyboardEvent: cellKeys() },
    ]
  }, [t, locale, model.canManage, model.languages.join(','), marksKey])

  const ready = model.load.status === 'ready' && all !== null
  const ownKeys: ListKey[] = model.canManage
    ? [
        { keys: ['c'], does: t('fr.cells.keyNew') },
        { keys: ['↵'], does: t('fr.cells.keyEdit') },
        { keys: ['Esc'], does: t('fr.cells.keyCancel') },
      ]
    : []
  let state: ReactNode = undefined
  if (model.load.status === 'error')
    state = <EmptyState icon={<XCircle size={20} aria-hidden />} title={t('fr.cells.failed')} description={t(model.load.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('fr.retry')}</Button>} />
  else if (ready && all.length === 0)
    state = (
      <EmptyState
        title={t('fr.off.empty.title')}
        description={t(model.canManage ? 'fr.off.empty.body' : 'fr.off.empty.bodyView')}
        action={
          model.canManage ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onDialog?.(NEW_DIALOG())}>
              <Plus size={14} aria-hidden /> {t('fr.off.new.first')}
            </Button>
          ) : undefined
        }
      />
    )
  else if (ready && rows && rows.length === 0) state = <EmptyState title={t('fr.cells.noMatch')} action={<Button size="sm" onClick={() => setQuery('')}>{t('fr.cells.clearSearch')}</Button>} />

  const offHeld = picked.length === 0 ? 'fr.cells.pickRows' : picked.every((row) => !row.active) ? 'fr.cells.allOff' : model.busy ? 'fr.busy' : null
  const onHeld = picked.length === 0 ? 'fr.cells.pickRows' : picked.every((row) => row.active) ? 'fr.cells.allOn' : model.busy ? 'fr.busy' : null

  return (
    <section className="fw-fr-stack" aria-label={t('fr.off.title')}>
      <div className="fw-fr-section">
        <h2 className="fw-fr-title">{t('fr.off.title')}</h2>
        <p className="fw-fr-sub">{t('fr.off.intro')}</p>
      </div>
      <Banner tone="warning" title={t('fr.off.ccnl.title')}>
        {t('fr.off.ccnl.body')}
      </Banner>
      {model.changedElsewhere && (
        <Banner tone="info" title={t('fr.elsewhere.title')} action={<Button size="sm" onClick={() => actions?.onReload?.()}>{t('fr.elsewhere.reload')}</Button>}>
          {t('fr.cells.elsewhere')}
        </Banner>
      )}
      {model.notice && (
        <Banner tone={model.notice.tone} onDismiss={actions?.onDismissNotice}>
          {t(model.notice.key, model.notice.params)}
        </Banner>
      )}
      {ready && !model.canManage && (
        <Banner tone="neutral" title={t('fr.off.readOnly.title')}>
          {t('fr.off.readOnly.body')}
        </Banner>
      )}
      <ListFrame<OffCode>
        label={t('fr.off.table')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        rowKind="text"
        count={all ? t('fr.cells.count', { active: all.filter((row) => row.active).length, inactive: all.filter((row) => !row.active).length }) : '—'}
        search={<Input size="sm" type="search" leadingIcon={<Search size={13} aria-hidden />} aria-label={t('fr.cells.search')} placeholder={t('fr.cells.search')} value={query} onChange={(event) => setQuery(event.target.value)} />}
        right={
          <Button size="sm" variant="primary" heldReason={!ready ? t('fr.cells.loading') : model.canManage ? null : t('fr.off.held.manage')} onClick={() => actions?.onDialog?.(NEW_DIALOG())} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('fr.off.new.button')}
          </Button>
        }
        selection={
          model.canManage && ready
            ? {
                selected,
                onChange: setSelected,
                actions: (
                  <>
                    <Button size="sm" variant="danger-outline" aria-label={t('fr.cells.bulkOff', { count: picked.length })} heldReason={offHeld ? t(offHeld) : null} onClick={() => actions?.onActiveMany?.(selected, false)}>
                      <XCircle size={13} aria-hidden /> <SelectionLabel>{t('fr.cells.bulkOff', { count: picked.length })}</SelectionLabel>
                    </Button>
                    <Button size="sm" aria-label={t('fr.cells.bulkOn', { count: picked.length })} heldReason={onHeld ? t(onHeld) : null} onClick={() => actions?.onActiveMany?.(selected, true)}>
                      <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('fr.cells.bulkOn', { count: picked.length })}</SelectionLabel>
                    </Button>
                  </>
                ),
              }
            : undefined
        }
        keys={ownKeys}
        onHelp={() => actions?.onDialog?.({ kind: 'keys' })}
        state={state}
        focusRow={model.focusRow}
        listKey={null}
      />
      {model.dialog?.kind === 'new' && <NewCodeDialog dialog={model.dialog} codes={(all ?? []).map((row) => row.code)} busy={model.busy} actions={actions} />}
      {model.dialog?.kind === 'keys' && <KeysDialog own={ownKeys} withSelection={model.canManage} onClose={() => actions?.onDialog?.(null)} />}
    </section>
  )
}

function NewCodeDialog({ dialog, codes, busy, actions }: { dialog: { draft: OffDraft; problem: string | null }; codes: readonly string[]; busy: boolean; actions?: OffStandardActions }) {
  const t = useT('floor-rules')
  const draft = dialog.draft
  const set = (patch: Partial<OffDraft>) => actions?.onDialog?.({ kind: 'new', draft: { ...draft, ...patch }, problem: null })
  const held = offDraftHeld(draft, codes, busy)
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('fr.off.new.title')}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('fr.cells.back')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onCreate?.()}>
            {t('fr.off.new.add')}
          </Button>
        </>
      }
    >
      <div className="fw-fr-section">
        <p className="fw-fr-sub">{t('fr.off.new.intro')}</p>
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        <div className="fw-fr-form-grid">
          <Field label={t('fr.off.col.code')} required hint={t('fr.off.new.codeHint')} error={draft.code && codes.includes(draft.code) ? t('fr.off.new.codeTaken') : undefined}>
            <Input value={draft.code} maxLength={40} spellCheck={false} onChange={(event) => set({ code: typedCode(event.target.value) })} />
          </Field>
          <Field label={t('fr.off.new.kind')} hint={t(`fr.off.kindHint.${draft.kind}`)}>
            <SegmentedControl size="sm" ariaLabel={t('fr.off.new.kind')} value={draft.kind} onChange={(value) => set({ kind: value as OffStandardKind })} options={OFF_STANDARD_KINDS.map((kind) => ({ value: kind, label: t(`fr.off.kind.${kind}`) }))} />
          </Field>
          <Field label={t('fr.cells.it')} required>
            <Input value={draft.labelIt} maxLength={80} lang="it" onChange={(event) => set({ labelIt: event.target.value })} />
          </Field>
          <Field label={t('fr.cells.en')} required>
            <Input value={draft.labelEn} maxLength={80} lang="en" onChange={(event) => set({ labelEn: event.target.value })} />
          </Field>
          <Field label={t('fr.off.col.payRule')} hint={t(`fr.off.payHint.${draft.payRule}`)}>
            <Select value={draft.payRule} onChange={(event) => set({ payRule: event.target.value as PayRule })}>
              {PAY_RULES.map((rule) => (
                <option key={rule} value={rule}>
                  {t(`fr.off.pay.${rule}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('fr.off.col.needsApproval')} hint={t('fr.off.new.approvalHint')}>
            <span className="fw-fr-row">
              <Toggle checked={draft.needsApproval} aria-label={t('fr.off.col.needsApproval')} onChange={(needsApproval) => set({ needsApproval })} />
              <span>{t(`fr.off.needsApproval.${draft.needsApproval ? 'on' : 'off'}`)}</span>
            </span>
          </Field>
        </div>
      </div>
    </Modal>
  )
}

export function KeysDialog({ own, withSelection, onClose }: { own: readonly ListKey[]; withSelection: boolean; onClose: () => void }) {
  const t = useT('floor-rules')
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('fr.cells.keysTitle')} size="sm">
      <dl className="fw-fr-keys">
        {listKeys(own, withSelection).map((entry) => (
          <div key={entry.keys.join('+')}>
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd>{entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
