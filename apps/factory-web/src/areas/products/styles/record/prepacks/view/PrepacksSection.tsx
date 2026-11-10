'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, MoreHorizontal, Package, Plus, RotateCcw, WifiOff } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { sizeColumns } from '@nexus/ui/grid/size-columns/index'
import { Button, Checkbox, Input, Radio, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { PREPACK_LIMITS } from '@nexus/factory-domain/product/prepacks/rules'
import { CellSaveMark, Modal, useDsWords } from '../../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../../list-frame/model'
import type { StyleRecordViewModel } from '../../record-model'
import type { PrepackView, StylePrepacksView } from '../api'
import {
  ANY_COLOUR,
  bulkHeld,
  cellEditable,
  draftOf,
  draftProblems,
  draftRows,
  draftSizes,
  draftTotals,
  linesText,
  markKey,
  NO_PREPACKS,
  prepackCounts,
  prepackHeld,
  quantityOf,
  styleHeld,
  visibleRows,
  type PrepackDraft,
  type PrepackMark,
  type PrepacksActions,
  type PrepacksModel,
} from '../prepacks-model'
import '../prepacks.css'

type TooltipParams = Parameters<NonNullable<ColDef<PrepackView>['tooltipValueGetter']>>[0]

/**
 * SCR-287 — Style › Sizes & measurements › Prepacks (design products.styles rec:Style tab style.sizes, section
 * style.sizes.prepacks; PRD-055): the fixed size mixes dealers order as one unit — this style's and its size scale's — on
 * the shared list frame: the pieces per size (SizeColumns over the style's range; a size with none reads "—", never 0),
 * pieces per pack with the ratio ("2-3-2"), whether the style can sell the pack (a scale's pack with a size the style is
 * not made in cannot). A size cell of a pack without colourways saves by itself (CellSaveMark; waiting while offline); a
 * pack by colourway, its code and its name change in its dialog (Enter, ⋯ or a phone card); `p` adds one; with rows
 * selected: Archive N · Restore N. Prepacks are not part of a revision: a released revision does not freeze them. It
 * draws the view model and fetches nothing (use-prepacks.ts loads it).
 */
export function PrepacksSection({ model, actions }: { model: StyleRecordViewModel; actions?: PrepacksActions }) {
  const t = useT('products-prepacks')
  const tp = useT('products')
  const prepacks = model.prepacks ?? NO_PREPACKS
  const part = prepacks.part
  if (part.status === 'ready') return <Section view={part.value} prepacks={prepacks} canManage={prepacks.canManage} recordBusy={model.busy} actions={actions} />
  if (part.status === 'error') {
    return (
      <Banner
        tone="danger"
        title={t('prepacks.failed')}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {tp('common.retry')}
          </Button>
        }
      >
        {tp(part.problem)}
      </Banner>
    )
  }
  return (
    <Card header={t('prepacks.title')} headingLevel={2} aria-busy="true">
      <p className="fw-st-hint" role="status">
        <Spinner size={14} /> {t('prepacks.loading')}
      </p>
      <div className="fw-st-skeleton">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} height={22} />
        ))}
      </div>
    </Card>
  )
}

function Section({ view, prepacks, canManage, recordBusy, actions }: { view: StylePrepacksView; prepacks: PrepacksModel; canManage: boolean; recordBusy: boolean; actions?: PrepacksActions }) {
  const t = useT('products-prepacks')
  const tp = useT('products')
  const locale = useLocale()
  const ds = useDsWords()
  const busy = prepacks.busy || recordBusy
  const held = styleHeld(view, canManage)
  // A new pack of the scale is still possible while the style's own rule holds: the dialog offers it.
  const addHeld = !canManage ? t('prepacks.held.noManage') : view.style.status === 'ARCHIVED' ? t('prepacks.held.archivedStyle') : busy ? tp('held.busy') : null
  const keyFrom = useRef<{ control: boolean; at: number } | null>(null)
  const latest = useRef({ actions, marks: prepacks.marks, view })
  latest.current = { actions, marks: prepacks.marks, view }
  const marksKey = JSON.stringify(prepacks.marks)
  const rows = useMemo(() => visibleRows(view, prepacks.showArchived), [view, prepacks.showArchived])
  const counts = prepackCounts(view)
  const range = view.style.sizes

  // `p` adds a pack (never while typing or with a dialog open).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || event.key !== 'p' || prepacks.dialog) return
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return
      if (addHeld) return
      event.preventDefault()
      latest.current.actions?.onDialog?.({ kind: 'prepack', prepackId: null })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const columns = useMemo<ColDef<PrepackView>[]>(() => {
    const plain = { sortable: false, suppressHeaderMenuButton: true } as const
    const NameCell = ({ data }: ICellRendererParams<PrepackView>) =>
      data ? (
        <span className="fw-ppk-name">
          <strong>{data.code}</strong>
          <span className="fw-ppk-sub">{data.byColourway ? `${data.name} · ${t('prepacks.byColour')}` : data.name}</span>
        </span>
      ) : null
    const ForCell = ({ data }: ICellRendererParams<PrepackView>) =>
      data ? (
        <span className="fw-ppk-cell">
          <Tag tone={data.scope === 'STYLE' ? 'info' : 'neutral'}>{data.scope === 'STYLE' ? t('prepacks.for.style') : t('prepacks.for.scale', { scale: data.sizeScale.code })}</Tag>
        </span>
      ) : null
    const SizeCell = (params: ICellRendererParams<PrepackView>) => {
      if (!params.data) return null
      const size = (params.colDef?.colId ?? '').replace(/^size:/, '')
      const mark = latest.current.marks[markKey(params.data.id, size)]
      return (
        <span className="fw-ppk-cell fw-ppk-num">
          {mark && mark.state !== 'refused' && mark.value !== undefined ? (mark.value ?? ds.sizeColumns.notNeeded) : params.valueFormatted}
          <Mark mark={mark} />
        </span>
      )
    }
    const sizes = sizeColumns<PrepackView>({
      sizes: range,
      base: view.style.baseSize,
      unit: t('prepacks.unit'),
      value: (row, size) => quantityOf(row, size),
      editable: (row) => cellEditable(row, latest.current.view, canManage),
      required: false,
      scale: 0,
      onChange: (row, size, value) => latest.current.actions?.onCell?.(row, size, value),
      onRefused: (row, size, text) => latest.current.actions?.onCell?.(row, size, text),
      locale: INTL_LOCALE[locale],
      cellLabel: (row, size) => t('prepacks.cell', { code: row.code, size }),
      labels: ds.sizeColumns,
    }).map((column) => ({
      ...column,
      cellRenderer: SizeCell,
      // A pack by colourway says its lines in the cell's tooltip (its cells are their sums, changed in the dialog).
      tooltipValueGetter: (params: TooltipParams) => (params.data?.byColourway ? linesText(params.data) : typeof column.tooltipValueGetter === 'function' ? column.tooltipValueGetter(params) : undefined),
    }))
    const PiecesCell = ({ data }: ICellRendererParams<PrepackView>) =>
      data ? (
        <span className="fw-ppk-cell">
          <strong>{data.pieces}</strong>
          <span className="fw-ppk-sub">{t('prepacks.ratio', { ratio: data.ratio })}</span>
        </span>
      ) : null
    const FitCell = ({ data }: ICellRendererParams<PrepackView>) => {
      if (!data) return null
      if (data.status === 'ARCHIVED') return <Tag tone="neutral">{t('prepacks.fit.archived')}</Tag>
      if (data.outsideRange.length > 0) return <Tag tone="warning">{t('prepacks.fit.outside', { sizes: data.outsideRange.join(', ') })}</Tag>
      return <Tag tone="success">{t('prepacks.fit.usable')}</Tag>
    }
    const MoreCell = ({ data }: ICellRendererParams<PrepackView>) => {
      if (!data) return null
      const why = prepackHeld(data, latest.current.view, canManage)
      const statusWhy = !canManage ? t('prepacks.held.noManage') : data.scope === 'STYLE' && styleHeld(latest.current.view, canManage) ? t(styleHeld(latest.current.view, canManage)!) : undefined
      const items: MenuItemDef[] = [
        { id: 'open', label: t(why ? 'prepacks.row.open' : 'prepacks.row.edit'), onSelect: () => latest.current.actions?.onDialog?.({ kind: 'prepack', prepackId: data.id }) },
        data.status === 'ACTIVE'
          ? { id: 'archive', label: t('prepacks.row.archive'), disabled: !!statusWhy, description: statusWhy, onSelect: () => latest.current.actions?.onDialog?.({ kind: 'status', ids: [data.id], status: 'ARCHIVED' }) }
          : { id: 'restore', label: t('prepacks.row.restore'), disabled: !!statusWhy, description: statusWhy, onSelect: () => latest.current.actions?.onDialog?.({ kind: 'status', ids: [data.id], status: 'ACTIVE' }) },
      ]
      return <Menu label={<MoreHorizontal size={16} aria-label={t('prepacks.row.more', { code: data.code })} />} items={items} align="right" triggerProps={{ 'aria-label': t('prepacks.row.more', { code: data.code }) }} />
    }
    return [
      { colId: 'prepack', headerName: t('prepacks.col.prepack'), minWidth: 200, flex: 1.4, cellRenderer: NameCell, valueGetter: (params) => (params.data ? `${params.data.code} · ${params.data.name}` : ''), ...plain },
      { colId: 'for', headerName: t('prepacks.col.for'), minWidth: 170, flex: 1, cellRenderer: ForCell, valueGetter: (params) => (params.data ? (params.data.scope === 'STYLE' ? t('prepacks.for.style') : t('prepacks.for.scale', { scale: params.data.sizeScale.code })) : ''), ...plain },
      ...sizes,
      { colId: 'pieces', headerName: t('prepacks.col.pieces'), minWidth: 190, flex: 1, cellRenderer: PiecesCell, valueGetter: (params) => (params.data ? `${params.data.pieces} · ${params.data.ratio}` : ''), ...plain },
      { colId: 'fit', headerName: t('prepacks.col.fit'), minWidth: 170, flex: 1, cellRenderer: FitCell, valueGetter: (params) => (params.data ? (params.data.status === 'ARCHIVED' ? t('prepacks.fit.archived') : params.data.outsideRange.length > 0 ? t('prepacks.fit.outside', { sizes: params.data.outsideRange.join(', ') }) : t('prepacks.fit.usable')) : ''), ...plain },
      { colId: 'more', headerName: t('prepacks.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', suppressMovable: true, cellRenderer: MoreCell, ...plain },
    ]
    // The cells read the marks through `latest`; a change of them redraws the cells.
  }, [t, locale, canManage, ds.sizeColumns, range.join(','), view.style.baseSize, marksKey])

  const selected = prepacks.selected
  const archiveHeld = busy ? tp('held.busy') : bulkHeld(view, selected, 'ARCHIVED', canManage)
  const restoreHeld = busy ? tp('held.busy') : bulkHeld(view, selected, 'ACTIVE', canManage)
  const bulk = (
    <>
      <Button size="sm" aria-label={t('prepacks.bulk.archive', { count: selected.length })} heldReason={archiveHeld ? t(archiveHeld) : null} onClick={() => actions?.onDialog?.({ kind: 'status', ids: [...selected], status: 'ARCHIVED' })}>
        <Archive size={13} aria-hidden /> <SelectionLabel>{t('prepacks.bulk.archive', { count: selected.length })}</SelectionLabel>
      </Button>
      <Button size="sm" aria-label={t('prepacks.bulk.restore', { count: selected.length })} heldReason={restoreHeld ? t(restoreHeld) : null} onClick={() => actions?.onDialog?.({ kind: 'status', ids: [...selected], status: 'ACTIVE' })}>
        <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('prepacks.bulk.restore', { count: selected.length })}</SelectionLabel>
      </Button>
    </>
  )
  const addButton = (
    <Button size="sm" variant="primary" heldReason={addHeld} onClick={() => actions?.onDialog?.({ kind: 'prepack', prepackId: null })} aria-keyshortcuts="p">
      <Plus size={13} aria-hidden /> {t('prepacks.add')}
    </Button>
  )
  const keys: ListKey[] = [
    { keys: ['p'], does: t('prepacks.keys.add') },
    { keys: ['↵'], does: t('prepacks.keys.open') },
  ]
  const waiting = Object.values(prepacks.marks).filter((entry) => entry.state === 'waiting').length

  return (
    <section
      className="fw-st-stack"
      aria-label={t('prepacks.title')}
      onKeyDownCapture={(event) => {
        // Where the last key was typed, seen before the grid sees it (the list opens a row on Enter).
        keyFrom.current = { control: !!(event.target as HTMLElement | null)?.closest?.('input, select, textarea, button'), at: Date.now() }
      }}
    >
      <Card header={t('prepacks.title')} headingLevel={2} description={t('prepacks.intro', { scale: view.sizeScale.code })} headerAction={addButton}>
        <p className="fw-st-hint">{t('prepacks.rule')}</p>
      </Card>
      {held === 'prepacks.held.noManage' && <Banner tone="info" title={t('prepacks.readOnly.noManage')} />}
      {held === 'prepacks.held.rule' && <Banner tone="info" title={t('prepacks.readOnly.rule')} />}
      {held === 'prepacks.held.archivedStyle' && <Banner tone="info" title={t('prepacks.held.archivedStyle')} />}
      {prepacks.notice && (
        <Banner
          tone={prepacks.notice.tone}
          title={t(prepacks.notice.key, prepacks.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {tp('common.dismiss')}
            </Button>
          }
        />
      )}
      {(prepacks.offline || waiting > 0) && (
        <Banner
          tone="warning"
          title={
            <span className="fw-st-inline">
              <WifiOff size={14} aria-hidden /> {t('prepacks.offline', { count: waiting })}
            </span>
          }
        />
      )}
      <ListFrame<PrepackView>
        label={t('prepacks.table')}
        listKey={null}
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('prepacks.count', { count: counts.active, usable: counts.usable })}
        tools={
          counts.archived > 0 ? (
            <Checkbox label={t('prepacks.showArchived', { count: counts.archived })} checked={prepacks.showArchived} onChange={(event) => actions?.onShowArchived?.(event.target.checked)} />
          ) : undefined
        }
        selection={{ selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
        keys={keys}
        onOpen={(row) => {
          // Enter that ends a size cell's typing (its editor is a text field) saves the cell, never "open the pack".
          const key = keyFrom.current
          if (key && key.control && Date.now() - key.at < 1000) return
          actions?.onDialog?.({ kind: 'prepack', prepackId: row.id })
        }}
        focusRow={prepacks.focusRow}
        state={rows.length === 0 ? <EmptyState icon={<Package size={24} aria-hidden />} title={t('prepacks.empty.title')} description={t('prepacks.empty.body')} action={addHeld ? undefined : addButton} /> : undefined}
      />
      <PrepackDialogs view={view} prepacks={prepacks} canManage={canManage} busy={busy} actions={actions} />
    </section>
  )
}

/** A size cell's save mark: saving / waiting (the DS CellSaveMark), refused ("!" with our words); nothing once saved. */
function Mark({ mark }: { mark: PrepackMark | undefined }) {
  const t = useT('products-prepacks')
  if (!mark) return null
  if (mark.state === 'refused') {
    const reason = t(mark.problem ?? 'prepacks.problem.write')
    return (
      <span className="fw-ppk-refused" role="img" aria-label={reason} title={reason}>
        !
      </span>
    )
  }
  return <CellSaveMark state={mark.state} />
}

function PrepackDialogs({ view, prepacks, canManage, busy, actions }: { view: StylePrepacksView; prepacks: PrepacksModel; canManage: boolean; busy: boolean; actions?: PrepacksActions }) {
  const dialog = prepacks.dialog
  if (!dialog) return null
  if (dialog.kind === 'prepack') {
    const prepack = dialog.prepackId ? (view.prepacks.find((entry) => entry.id === dialog.prepackId) ?? null) : null
    return <PrepackDialog key={dialog.prepackId ?? 'new'} view={view} prepack={prepack} preset={prepacks.draft} canManage={canManage} busy={busy} actions={actions} />
  }
  return <StatusDialog view={view} ids={dialog.ids} status={dialog.status} busy={busy} actions={actions} />
}

/** A new pack, or every field of one (Enter on a row, ⋯, a phone card): the pieces per size, per colourway or not; explicit Save. */
function PrepackDialog({ view, prepack, preset, canManage, busy, actions }: { view: StylePrepacksView; prepack: PrepackView | null; preset?: PrepackDraft; canManage: boolean; busy: boolean; actions?: PrepacksActions }) {
  const t = useT('products-prepacks')
  const tp = useT('products')
  const [draft, setDraft] = useState<PrepackDraft>(() => preset ?? draftOf(prepack))
  const rowHeld = prepack ? prepackHeld(prepack, view, canManage) : !canManage ? 'prepacks.held.noManage' : draft.scope === 'STYLE' ? styleHeld(view, canManage) : null
  const editable = rowHeld === null
  const problems = draftProblems(draft, view, prepack?.id ?? null)
  const first = Object.values(problems)[0]
  const held = rowHeld ? t(rowHeld) : first ? t(first) : busy ? tp('held.busy') : null
  const sizes = draftSizes(draft, view)
  const rows = draftRows(draft, view)
  const totals = draftTotals(draft, view)
  const close = () => actions?.onDialog?.(null)
  const go = () => {
    if (held) return
    void actions?.onSave?.(prepack?.id ?? null, draft)
  }
  const setCell = (row: string, size: string, text: string) => setDraft((current) => ({ ...current, cells: { ...current.cells, [row]: { ...(current.cells[row] ?? {}), [size]: text } } }))
  const setByColour = (byColour: boolean) =>
    setDraft((current) => {
      // Switching keeps nothing typed in the other layout: the sums would mean something else.
      const cells = byColour ? Object.fromEntries(view.colourways.filter((colourway) => colourway.status === 'ACTIVE').map((colourway) => [colourway.id, {}])) : { [ANY_COLOUR]: {} }
      return { ...current, byColour, cells }
    })
  return (
    <Modal
      open
      onClose={close}
      size="lg"
      title={prepack ? t('prepacks.dialog.editTitle', { code: prepack.code }) : t('prepacks.dialog.addTitle')}
      footer={
        <>
          <Button onClick={close}>{tp('common.back')}</Button>
          {(editable || !prepack) && (
            <Button variant="primary" heldReason={held} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
              {prepack ? t('prepacks.dialog.save') : t('prepacks.dialog.add')}
            </Button>
          )}
        </>
      }
    >
      <div
        className="fw-st-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            go()
          }
        }}
      >
        {rowHeld && prepack && <Banner tone="info" title={t(rowHeld)} />}
        <div className="fw-st-form-grid">
          <Field label={t('prepacks.col.code')} required hint={t('prepacks.dialog.codeHint')} error={problems.code ? t(problems.code) : undefined}>
            <Input value={draft.code} maxLength={PREPACK_LIMITS.code} autoFocus disabled={!editable} onChange={(event) => setDraft((current) => ({ ...current, code: event.target.value }))} />
          </Field>
          <Field label={t('prepacks.col.name')} required error={problems.name ? t(problems.name) : undefined}>
            <Input value={draft.name} maxLength={PREPACK_LIMITS.name} disabled={!editable} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
          </Field>
        </div>
        <Field label={t('prepacks.col.for')} hint={prepack ? t('prepacks.dialog.forFixed') : t('prepacks.dialog.forHint')}>
          <div className="fw-ppk-choices" role="radiogroup" aria-label={t('prepacks.col.for')}>
            <Radio name="prepack-scope" label={t('prepacks.for.styleLong', { style: view.style.code })} checked={draft.scope === 'STYLE'} disabled={!!prepack || !canManage} onChange={() => setDraft((current) => ({ ...current, scope: 'STYLE' }))} />
            <Radio name="prepack-scope" label={t('prepacks.for.scaleLong', { scale: view.sizeScale.code })} checked={draft.scope === 'SCALE'} disabled={!!prepack || !canManage} onChange={() => setDraft((current) => ({ ...current, scope: 'SCALE', byColour: false, cells: { [ANY_COLOUR]: current.cells[ANY_COLOUR] ?? {} } }))} />
          </div>
        </Field>
        <Checkbox label={t('prepacks.dialog.byColour')} checked={draft.byColour} disabled={!editable || draft.scope === 'SCALE' || view.colourways.length === 0} onChange={(event) => setByColour(event.target.checked)} />
        <div className="fw-ppk-grid-box" role="region" aria-label={t('prepacks.dialog.grid')}>
          <table className="fw-ppk-grid">
            <thead>
              <tr>
                <th scope="col">{draft.byColour ? t('prepacks.dialog.colourway') : t('prepacks.dialog.pieces')}</th>
                {sizes.map((size) => (
                  <th key={size} scope="col">
                    {size}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id || 'any'}>
                  <th scope="row" title={row.code ? `${row.code} · ${row.name}` : undefined}>
                    {row.code ? `${row.code} · ${row.name}` : t('prepacks.dialog.anyColour')}
                  </th>
                  {sizes.map((size) => (
                    <td key={size}>
                      <Input
                        size="xs"
                        inputMode="numeric"
                        maxLength={5}
                        value={draft.cells[row.id]?.[size] ?? ''}
                        disabled={!editable}
                        aria-label={t('prepacks.dialog.cell', { row: row.code ?? t('prepacks.dialog.anyColour'), size })}
                        onChange={(event) => setCell(row.id, size, event.target.value)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fw-st-hint" role="status">
          {problems.cells ? t(problems.cells) : t('prepacks.dialog.totals', { pieces: totals.pieces, ratio: totals.ratio })}
        </p>
      </div>
    </Modal>
  )
}

/** Archive (the lines freeze; no new order takes it) or restore one pack or the selection. */
function StatusDialog({ view, ids, status, busy, actions }: { view: StylePrepacksView; ids: string[]; status: 'ACTIVE' | 'ARCHIVED'; busy: boolean; actions?: PrepacksActions }) {
  const t = useT('products-prepacks')
  const tp = useT('products')
  const moving = view.prepacks.filter((prepack) => ids.includes(prepack.id) && prepack.status !== status)
  const close = () => actions?.onDialog?.(null)
  const archive = status === 'ARCHIVED'
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={t(archive ? 'prepacks.status.archiveTitle' : 'prepacks.status.restoreTitle', { count: moving.length })}
      footer={
        <>
          <Button onClick={close}>{tp('common.back')}</Button>
          <Button variant={archive ? 'danger' : 'primary'} heldReason={moving.length === 0 ? t(archive ? 'prepacks.bulk.noneActive' : 'prepacks.bulk.noneArchived') : busy ? tp('held.busy') : null} onClick={() => void actions?.onStatus?.(ids, status)}>
            {t(archive ? 'prepacks.status.archive' : 'prepacks.status.restore', { count: moving.length })}
          </Button>
        </>
      }
    >
      <div className="fw-st-dialog">
        <p>{moving.map((prepack) => prepack.code).join(', ')}</p>
        <p className="fw-st-hint">{t(archive ? 'prepacks.status.archiveBody' : 'prepacks.status.restoreBody')}</p>
      </div>
    </Modal>
  )
}
