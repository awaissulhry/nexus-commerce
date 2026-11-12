'use client'

import { useMemo, useRef, type MouseEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { Archive, ArchiveRestore, MoreHorizontal, Plus, Ruler } from 'lucide-react'
import { Card, EmptyState, Field, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, NumberStepper, Pill, RadioCard, SegmentedControl, Skeleton } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { Tolerance } from '../api'
import {
  auditHref,
  defaultChanges,
  defaultProblems,
  exceptionsOf,
  followedDefaultOf,
  keepHeld,
  mayKeepTolerances,
  movable,
  ownDefaultOf,
  percentWords,
  queryOf,
  TOLERANCE_ACTIONS,
  type DefaultDraft,
  type StatusFilter,
} from '../model'
import type { PurchasingSettingsActions, PurchasingSettingsModel } from '../view-model'
import { CardDescription, CardFailed, NS, ViewOnly } from './parts'

/** "+5 % / −3 % · the extra refused" — a rule in words, from its figures (never the API's sentence). */
export function RuleWords({ row }: { row: Pick<Tolerance, 'overPct' | 'underPct' | 'whenBeyond'> }) {
  const t = useT(NS)
  const locale = useLocale()
  return (
    <span className="fw-pus-inforce">
      <Pill tone="info">{t('tolerance.figures', { over: percentWords(row.overPct, locale), under: percentWords(row.underPct, locale) })}</Pill>
      <span className="fw-pus-sub">{t(`tolerance.beyondShort.${row.whenBeyond}`)}</span>
    </span>
  )
}

/** The rule's supplier, material and company in words, from its references (never the API's English `scope`). */
export function useScopeWords() {
  const t = useT(NS)
  return {
    supplier: (row: Pick<Tolerance, 'supplier'>) => (row.supplier ? `${row.supplier.name}` : t('tolerance.everySupplier')),
    material: (row: Pick<Tolerance, 'item' | 'itemKind'>) => (row.item ? `${row.item.code} · ${row.item.name}` : row.itemKind ? t('tolerance.kindOf', { kind: t(`itemKind.${row.itemKind}`) }) : t('tolerance.everyMaterial')),
    whose: (row: Pick<Tolerance, 'company' | 'companyId'>) => (row.companyId === null ? t('common.everyCompany') : (row.company?.name ?? t('tolerance.thisCompany'))),
  }
}

/**
 * sec:tolerance — Delivery tolerances (SCM-061; design purchasing.settings "Over and under delivery per supplier or material
 * (e.g. ±5% footage)"; the API of B-W2b-296): the default of this company (or of every company) — every supplier, every
 * material — as a form with its EditModeBar (⌘S), fields empty with a hint each until one is kept; then the exceptions per
 * supplier or per material in the ONE list frame (Active · Archived · All; Archive N · Reactivate N; a row opens its dialog,
 * `?tolerance=<id>`; New exception, `c`). Beyond the tolerance the extra is refused, or needs a yes — and a yes for a receipt
 * is not built yet, so the extra is refused the same way: said where it is chosen. No money.
 */
export function ToleranceCard({ model, actions, shortcut }: { model: PurchasingSettingsModel; actions?: PurchasingSettingsActions; shortcut: boolean }) {
  const t = useT(NS)
  const rows = model.tolerances.value
  const isCompany = model.address.scope === 'company'
  const may = mayKeepTolerances(rows, model.address.scope, model.companyId, model.can.tolerances)
  const offline = model.live === 'offline'
  const held = keepHeld({ may, scope: model.address.scope, offline, busy: model.busy !== null })
  const newHeld = !rows ? t('held.reading') : held && held !== 'held.busy' ? t(held) : null

  const body = (): ReactNode => {
    if (model.tolerances.problem) return <CardFailed title={t('tolerance.failed')} problem={model.tolerances.problem} onRetry={actions?.onRetryTolerances} />
    if (!rows || !model.defaultDraft) return <Skeleton height={420} />
    return (
      <div className="fw-pus-stack">
        <DefaultForm model={model} actions={actions} rows={rows} draft={model.defaultDraft} may={may} held={held} shortcut={shortcut} />
        <Exceptions model={model} actions={actions} rows={rows} newHeld={newHeld} />
        <ul className="fw-pus-notes">
          <li>{t('tolerance.precedence')}</li>
          <li>{t('tolerance.leatherLine')}</li>
          <li>{t('tolerance.short')}</li>
        </ul>
      </div>
    )
  }

  return (
    <Card
      header={t('tolerance.title')}
      description={<CardDescription text={t('tolerance.description')} changed={rows ? model.changed.tolerance : undefined} href={model.can.audit && (rows?.length ?? 0) > 0 ? auditHref(model.prefix, 'DeliveryTolerance') : null} />}
      headerAction={
        rows && !may ? (
          <ViewOnly reason={t(isCompany ? 'held.noToleranceRight' : 'held.noToleranceRightAll')} />
        ) : (
          <Button size="sm" variant="primary" heldReason={newHeld} onClick={() => actions?.onToleranceOpen?.('new')}>
            <Plus size={14} aria-hidden /> {t('tolerance.add')}
          </Button>
        )
      }
      headingLevel={2}
      className="fw-pus-card"
    >
      {body()}
    </Card>
  )
}

/** The default: every supplier, every material — this company's or every company's; what applies once saved. */
function DefaultForm({ model, actions, rows, draft, may, held, shortcut }: { model: PurchasingSettingsModel; actions?: PurchasingSettingsActions; rows: readonly Tolerance[]; draft: DefaultDraft; may: boolean; held: string | null; shortcut: boolean }) {
  const t = useT(NS)
  const isCompany = model.address.scope === 'company'
  const own = ownDefaultOf(rows, model.address.scope, model.companyId)
  const followed = followedDefaultOf(rows, model.address.scope)
  const count = defaultChanges(own, draft)
  const problems = defaultProblems(draft)
  const typed = count > 0
  const disabled = model.busy !== null
  const set = (next: Partial<DefaultDraft>) => actions?.onDefault?.({ ...draft, ...next })
  const heading = isCompany ? t('tolerance.defaultFor', { company: model.companyName }) : t('tolerance.defaultAll')

  const applies = (): ReactNode => {
    if (own) return <RuleWords row={own} />
    if (followed) return <span className="fw-pus-inforce"><RuleWords row={followed} /><span className="fw-pus-sub">{t('tolerance.followsAll')}</span></span>
    return <span className="fw-pus-sub">{t('tolerance.none')}</span>
  }

  if (!may) {
    return (
      <section className="fw-pus-default" aria-label={heading}>
        <h3 className="fw-pus-question">{heading}</h3>
        <p className="fw-pus-held">{t(isCompany ? 'held.noToleranceRight' : 'held.noToleranceRightAll')}</p>
        <div className="fw-pus-inforce-row">
          <span className="fw-pus-sub">{t('tolerance.applies')}</span>
          {applies()}
        </div>
      </section>
    )
  }
  const firstProblem = typed ? (problems.over ?? problems.under) : null
  return (
    <section className="fw-pus-default" aria-label={heading}>
      <h3 className="fw-pus-question">{heading}</h3>
      <p className="fw-pus-hint">{t('tolerance.defaultHint')}</p>
      {model.live === 'offline' && <p className="fw-pus-held">{t('held.offline')}</p>}
      <div className="fw-pus-fields">
        <Field label={t('tolerance.over')} hint={t('tolerance.overHint')} required error={typed && problems.over ? t(problems.over) : undefined}>
          <span className="fw-pus-stepper">
            <NumberStepper value={draft.over} min={0} max={100} step={0.5} suffix="%" size="sm" disabled={disabled} decrementLabel={t('common.less')} incrementLabel={t('common.more')} placeholder={t('tolerance.overPlaceholder')} aria-label={t('tolerance.over')} onChange={(over) => set({ over })} />
          </span>
        </Field>
        <Field label={t('tolerance.under')} hint={t('tolerance.underHint')} required error={typed && problems.under ? t(problems.under) : undefined}>
          <span className="fw-pus-stepper">
            <NumberStepper value={draft.under} min={0} max={100} step={0.5} suffix="%" size="sm" disabled={disabled} decrementLabel={t('common.less')} incrementLabel={t('common.more')} placeholder={t('tolerance.underPlaceholder')} aria-label={t('tolerance.under')} onChange={(under) => set({ under })} />
          </span>
        </Field>
      </div>
      <fieldset className="fw-pus-choices" disabled={disabled}>
        <legend className="fw-pus-question">{t('tolerance.beyond')}</legend>
        {TOLERANCE_ACTIONS.map((action) => (
          <RadioCard key={action} name="pus-default-beyond" checked={draft.whenBeyond === action} selected={draft.whenBeyond === action} onChange={() => set({ whenBeyond: action })} title={t(`tolerance.beyondTitle.${action}`)} description={t(`tolerance.beyondHint.${action}`)} />
        ))}
      </fieldset>
      <div className="fw-pus-inforce-row">
        <span className="fw-pus-sub">{t(own || !followed ? 'tolerance.applies' : 'tolerance.appliesNow')}</span>
        {applies()}
        {own && (
          <Button size="sm" variant="quiet" heldReason={held ? t(held) : null} onClick={() => actions?.onRemoveDefault?.()}>
            {t('tolerance.removeDefault')}
          </Button>
        )}
      </div>
      {count > 0 && (
        <EditModeBar
          count={count}
          busy={model.busy === 'default'}
          applyHeldReason={firstProblem ? t(firstProblem) : held && held !== 'held.busy' ? t(held) : null}
          applyLabel={t('tolerance.applyDefault')}
          onDiscard={() => actions?.onDiscardDefault?.()}
          onApply={() => actions?.onApplyDefault?.()}
          saveShortcut={shortcut}
        />
      )}
    </section>
  )
}

/** The exceptions per supplier or per material in the ONE list frame. */
function Exceptions({ model, actions, rows, newHeld }: { model: PurchasingSettingsModel; actions?: PurchasingSettingsActions; rows: readonly Tolerance[]; newHeld: string | null }) {
  const t = useT(NS)
  const locale = useLocale()
  const words = useScopeWords()
  const shown = useMemo(() => exceptionsOf(rows, model.address.scope, model.companyId, model.address.status), [rows, model.address.scope, model.companyId, model.address.status])
  const latest = useRef({ model, actions, words })
  latest.current = { model, actions, words }

  const columns = useMemo<ColDef<Tolerance>[]>(() => {
    const open = (event: MouseEvent, id: string) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
      event.preventDefault()
      latest.current.actions?.onToleranceOpen?.(id)
    }
    const SupplierCell = ({ data }: ICellRendererParams<Tolerance>) => {
      if (!data) return null
      return (
        <span className="fw-pus-cell">
          <Link className="fw-pus-rowlink" href={queryOf({ ...latest.current.model.address, tolerance: data.id })} onClick={(event) => open(event, data.id)}>
            <strong>{latest.current.words.supplier(data)}</strong>
          </Link>
          {data.supplier && <span className="fw-pus-sub">{data.supplier.code}</span>}
        </span>
      )
    }
    const RuleCell = ({ data }: ICellRendererParams<Tolerance>) => (data ? <RuleWords row={data} /> : null)
    const StateCell = ({ data }: ICellRendererParams<Tolerance>) => {
      if (!data) return null
      return <Pill tone={data.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`tolerance.status.${data.status}`)}</Pill>
    }
    const ActionsCell = ({ data }: ICellRendererParams<Tolerance>) => {
      if (!data) return null
      const current = latest.current.model
      const heldReason = !data.mayChange ? t(data.companyId === null ? 'held.noToleranceRightAll' : 'held.noToleranceRight') : current.live === 'offline' ? t('held.offline') : null
      const items: MenuItemDef[] = [
        { id: 'open', label: t(data.mayChange && data.status === 'ACTIVE' ? 'row.edit' : 'row.view'), onSelect: () => latest.current.actions?.onToleranceOpen?.(data.id) },
        { id: 'sep', separator: true },
        data.status === 'ACTIVE'
          ? { id: 'archive', label: t('row.archive'), disabled: !!heldReason, description: heldReason ?? t('row.archiveHint'), onSelect: () => latest.current.actions?.onMove?.(data, 'archive') }
          : { id: 'reactivate', label: t('row.reactivate'), disabled: !!heldReason, description: heldReason ?? undefined, onSelect: () => latest.current.actions?.onMove?.(data, 'reactivate') },
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { rule: `${latest.current.words.supplier(data)} · ${latest.current.words.material(data)}` }) }} items={items} />
    }
    return [
      { colId: 'supplier', headerName: t('tolerance.col.supplier'), minWidth: 220, flex: 1.6, valueGetter: (params) => (params.data ? latest.current.words.supplier(params.data) : ''), cellRenderer: SupplierCell, autoHeight: true, wrapText: true },
      { colId: 'material', headerName: t('tolerance.col.material'), minWidth: 200, flex: 1.5, valueGetter: (params) => (params.data ? latest.current.words.material(params.data) : ''), autoHeight: true, wrapText: true },
      { colId: 'rule', headerName: t('tolerance.col.rule'), minWidth: 230, flex: 1.5, valueGetter: (params) => (params.data ? Number.parseFloat(params.data.overPct) : null), cellRenderer: RuleCell, autoHeight: true, wrapText: true },
      { colId: 'whose', headerName: t('tolerance.col.whose'), minWidth: 150, flex: 1, valueGetter: (params) => (params.data ? latest.current.words.whose(params.data) : '') },
      { colId: 'note', headerName: t('tolerance.col.note'), minWidth: 180, flex: 1.3, valueGetter: (params) => params.data?.note ?? '', wrapText: true, autoHeight: true },
      { colId: 'state', headerName: t('tolerance.col.state'), minWidth: 110, flex: 0.6, valueGetter: (params) => params.data?.status ?? '', cellRenderer: StateCell },
      { colId: 'changed', headerName: t('tolerance.col.changed'), minWidth: 140, flex: 0.8, valueGetter: (params) => (params.data ? formatDateTime(params.data.updatedAt, { locale }) : '') },
      { colId: 'actions', headerName: t('tolerance.col.actions'), width: 72, minWidth: 72, cellRenderer: ActionsCell, suppressHeaderMenuButton: true, sortable: false },
    ]
  }, [t, locale])

  const offline = model.live === 'offline'
  const bulkHeld = (to: 'archive' | 'reactivate'): string | null => {
    if (model.busy !== null) return t('held.busy')
    if (offline) return t('held.offline')
    if (movable(shown, model.selected, to).length === 0) return t(to === 'archive' ? 'held.noneActive' : 'held.noneArchived')
    return null
  }
  const bulk = (
    <>
      <Button size="sm" heldReason={bulkHeld('archive')} onClick={() => actions?.onBulkMove?.('archive')} aria-label={t('bulk.archive', { count: movable(shown, model.selected, 'archive').length })}>
        <Archive size={13} aria-hidden /> <SelectionLabel>{t('bulk.archive', { count: movable(shown, model.selected, 'archive').length })}</SelectionLabel>
      </Button>
      <Button size="sm" heldReason={bulkHeld('reactivate')} onClick={() => actions?.onBulkMove?.('reactivate')} aria-label={t('bulk.reactivate', { count: movable(shown, model.selected, 'reactivate').length })}>
        <ArchiveRestore size={13} aria-hidden /> <SelectionLabel>{t('bulk.reactivate', { count: movable(shown, model.selected, 'reactivate').length })}</SelectionLabel>
      </Button>
    </>
  )
  const keys: ListKey[] = [{ keys: ['c'], does: t('keys.newException') }]
  const archived = model.address.status === 'ARCHIVED'
  return (
    <section className="fw-pus-exceptions" aria-label={t('tolerance.exceptions')}>
      <h3 className="fw-pus-question">{t('tolerance.exceptions')}</h3>
      <ListFrame<Tolerance>
        label={t('tolerance.table')}
        title={t('tolerance.exceptions')}
        rows={shown}
        rowId={(row) => row.id}
        columns={columns}
        count={t('tolerance.count', { count: shown.length })}
        tools={
          <SegmentedControl
            size="sm"
            ariaLabel={t('tolerance.status.label')}
            value={model.address.status}
            onChange={(value) => actions?.onStatus?.(value as StatusFilter)}
            options={[
              { value: 'ACTIVE', label: t('tolerance.status.ACTIVE') },
              { value: 'ARCHIVED', label: t('tolerance.status.ARCHIVED') },
              { value: 'ALL', label: t('tolerance.status.ALL') },
            ]}
          />
        }
        selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
        isRowSelectable={(row) => (row.mayChange ? null : t(row.companyId === null ? 'held.noToleranceRightAll' : 'held.noToleranceRight'))}
        keys={keys}
        onHelp={() => actions?.onKeys?.()}
        onOpen={(row) => actions?.onToleranceOpen?.(row.id)}
        state={
          shown.length === 0 ? (
            <EmptyState
              icon={<Ruler size={22} aria-hidden />}
              title={t(archived ? 'tolerance.emptyArchived.title' : 'tolerance.empty.title')}
              description={t(archived ? 'tolerance.emptyArchived.body' : 'tolerance.empty.body')}
              action={
                archived ? undefined : (
                  <Button size="sm" variant="primary" heldReason={newHeld} onClick={() => actions?.onToleranceOpen?.('new')}>
                    <Plus size={14} aria-hidden /> {t('tolerance.add')}
                  </Button>
                )
              }
            />
          ) : undefined
        }
      />
    </section>
  )
}
