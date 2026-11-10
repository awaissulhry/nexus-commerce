'use client'

import { useMemo, useRef, type MouseEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { Archive, ArchiveRestore, CornerDownRight, MoreHorizontal, Plus, Shapes } from 'lucide-react'
import { Card, EmptyState, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, SegmentedControl } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { ProductType } from '../api'
import { auditHref, mayKeepTypeOf, movable, queryOf, typesShown, typeTree, type TypeFilter, type TypeNode } from '../model'
import type { ProductSettingsActions, ProductSettingsModel } from '../view-model'
import { CardDescription } from './parts'

/** Whether the person may keep this type: a company's type with the company's right, every company's with a right over every company. */
export function mayKeepType(model: ProductSettingsModel, companyId: string | null): boolean {
  return mayKeepTypeOf(model.address.scope, model.settings.value, model.tenant.value, model.live === 'offline', companyId)
}

/** Why a new type is held now, or null. */
export function newTypeHeld(model: ProductSettingsModel): string | null {
  if (!model.settings.value || !model.types.value) return 'held.reading'
  if (model.live === 'offline') return 'held.offline'
  return mayKeepType(model, model.address.scope === 'all' ? null : model.companyId) || mayKeepType(model, null) ? null : model.address.scope === 'all' ? 'held.noRightAll' : 'held.noRight'
}

/**
 * psettings.types — Product types (PRD-008): the types as a tree in the ONE list frame (each parent before its children,
 * indented; a child inherits its parent's required attributes and defaults), with what a new style of each takes after
 * inheritance (required attributes, size scale, PPE), whose it is, how many styles use it. Active / Archived / All. Selected:
 * Archive N · Restore N. New product type; a row opens its dialog (`?type=<id>`). A reader opens the same dialog as text.
 */
export function TypesCard({ model, actions }: { model: ProductSettingsModel; actions?: ProductSettingsActions }) {
  const t = useT('products-settings')
  const types = model.types.value
  const shown = useMemo(() => (types ? typeTree(typesShown(types, model.address.scope, model.address.status)) : null), [types, model.address.scope, model.address.status])
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const codeOf = useMemo(() => new Map((types ?? []).map((type) => [type.id, type.code])), [types])

  const columns = useMemo<ColDef<TypeNode>[]>(() => {
    const open = (event: MouseEvent, id: string) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
      event.preventDefault()
      latest.current.actions?.onTypeOpen?.(id)
    }
    const TypeCell = ({ data }: ICellRendererParams<TypeNode>) => {
      if (!data) return null
      const { type, depth } = data
      return (
        <span className="fw-pst-tree" style={{ ['--fw-pst-depth' as string]: depth }}>
          {depth > 0 && <CornerDownRight size={13} aria-hidden className="fw-pst-branch" />}
          <span className="fw-pst-cell">
            <Link className="fw-pst-rowlink" href={queryOf({ ...latest.current.model.address, type: type.id })} onClick={(event) => open(event, type.id)}>
              <strong>{type.code}</strong> · {type.name}
            </Link>
            <span className="fw-pst-sub">
              {type.parent ? t('types.childOf', { parent: type.parent.code }) : t('types.top')}
              {type.status === 'ARCHIVED' && <> · {t('types.archived')}</>}
            </span>
          </span>
        </span>
      )
    }
    const RequiredCell = ({ data }: ICellRendererParams<TypeNode>) => {
      if (!data) return null
      const required = data.type.effective.requiredAttributes
      const inherited = required.filter((entry) => entry.fromTypeId !== data.type.id).length
      if (required.length === 0) return <span className="fw-pst-sub">{t('types.noneRequired')}</span>
      return (
        <span className="fw-pst-cell">
          <span>{required.map((entry) => t(`attr.${entry.name}`)).join(', ')}</span>
          {inherited > 0 && <span className="fw-pst-sub">{t('types.inherited', { count: inherited })}</span>}
        </span>
      )
    }
    const ScaleCell = ({ data }: ICellRendererParams<TypeNode>) => {
      if (!data) return null
      const scale = data.type.refs.sizeScale
      const from = data.type.effective.defaults.defaultSizeScaleId.fromTypeId
      if (!scale) return <span className="fw-pst-sub">—</span>
      return (
        <span className="fw-pst-cell">
          <span>
            {scale.code} · {scale.name}
          </span>
          {from && from !== data.type.id && <span className="fw-pst-sub">{t('types.from', { code: codeOf.get(from) ?? '…' })}</span>}
        </span>
      )
    }
    const PpeCell = ({ data }: ICellRendererParams<TypeNode>) => {
      if (!data) return null
      const defaults = data.type.effective.defaults
      const category = defaults.defaultPpeCategory.value
      if (!category) return <span className="fw-pst-sub">—</span>
      const standard = [defaults.defaultPpeStandard.value, defaults.defaultPpeClass.value].filter(Boolean).join(' · ')
      return (
        <span className="fw-pst-cell">
          <span>{t(`ppe.${category}`)}</span>
          {standard && <span className="fw-pst-sub">{standard}</span>}
        </span>
      )
    }
    const ActionsCell = ({ data }: ICellRendererParams<TypeNode>) => {
      if (!data) return null
      const { type } = data
      const may = mayKeepType(latest.current.model, type.companyId)
      const held = may ? null : t(latest.current.model.live === 'offline' ? 'held.offline' : type.companyId === null ? 'held.noRightAll' : 'held.noRight')
      const items: MenuItemDef[] = [
        { id: 'open', label: t(may && type.status === 'ACTIVE' ? 'row.edit' : 'row.view'), onSelect: () => latest.current.actions?.onTypeOpen?.(type.id) },
        { id: 'sep', separator: true },
        type.status === 'ACTIVE'
          ? { id: 'archive', label: t('row.archive'), disabled: !may, description: held ?? t('row.archiveHint'), onSelect: () => latest.current.actions?.onTypeMove?.(type, 'archive') }
          : { id: 'restore', label: t('row.restore'), disabled: !may, description: held ?? undefined, onSelect: () => latest.current.actions?.onTypeMove?.(type, 'restore') },
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { code: type.code }) }} items={items} />
    }
    return [
      { colId: 'type', headerName: t('types.col.type'), minWidth: 260, flex: 2.2, valueGetter: (params) => (params.data ? `${params.data.type.code} ${params.data.type.name}` : ''), cellRenderer: TypeCell, autoHeight: true, wrapText: true },
      { colId: 'kind', headerName: t('types.col.kind'), minWidth: 120, flex: 0.8, valueGetter: (params) => (params.data ? t(`garment.${params.data.type.productType}`) : '') },
      { colId: 'whose', headerName: t('types.col.whose'), minWidth: 140, flex: 0.9, valueGetter: (params) => (params.data ? (params.data.type.companyId === null ? t('types.everyCompany') : t('types.thisCompany')) : '') },
      { colId: 'required', headerName: t('types.col.required'), minWidth: 220, flex: 2, cellRenderer: RequiredCell, autoHeight: true, wrapText: true, sortable: false },
      { colId: 'scale', headerName: t('types.col.scale'), minWidth: 160, flex: 1.2, cellRenderer: ScaleCell, autoHeight: true, sortable: false },
      { colId: 'ppe', headerName: t('types.col.ppe'), minWidth: 170, flex: 1.2, cellRenderer: PpeCell, autoHeight: true, sortable: false },
      { colId: 'styles', headerName: t('types.col.styles'), minWidth: 120, flex: 0.6, type: 'rightAligned', valueGetter: (params) => params.data?.type.styles ?? null },
      { colId: 'actions', headerName: t('types.col.actions'), width: 72, minWidth: 72, cellRenderer: ActionsCell, suppressHeaderMenuButton: true, sortable: false },
    ]
  }, [t, codeOf])

  /** The ticked types Archive N / Restore N moves: in the right state, and the person keeps them. */
  const moving = (to: 'archive' | 'restore') => movable(types ?? [], model.selected, to).filter((type) => mayKeepType(model, type.companyId))
  const bulkHeld = (to: 'archive' | 'restore'): string | null => {
    if (model.busy !== null) return t('held.busy')
    if (model.live === 'offline') return t('held.offline')
    const inState = movable(types ?? [], model.selected, to)
    if (inState.length === 0) return t(to === 'archive' ? 'held.noneActive' : 'held.noneArchived')
    if (moving(to).length === 0) return t(inState.some((type) => type.companyId === null) ? 'held.noRightAll' : 'held.noRight')
    return null
  }
  const bulk = (
    <>
      <Button size="sm" heldReason={bulkHeld('archive')} onClick={() => actions?.onBulkMove?.('archive')} aria-label={t('bulk.archive', { count: moving('archive').length })}>
        <Archive size={13} aria-hidden /> <SelectionLabel>{t('bulk.archive', { count: moving('archive').length })}</SelectionLabel>
      </Button>
      <Button size="sm" heldReason={bulkHeld('restore')} onClick={() => actions?.onBulkMove?.('restore')} aria-label={t('bulk.restore', { count: moving('restore').length })}>
        <ArchiveRestore size={13} aria-hidden /> <SelectionLabel>{t('bulk.restore', { count: moving('restore').length })}</SelectionLabel>
      </Button>
    </>
  )
  const held = newTypeHeld(model)
  const state: ReactNode = model.types.problem ? (
    <EmptyState
      title={t('types.failed')}
      description={t(model.types.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetryTypes?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : shown && shown.length === 0 ? (
    <EmptyState
      icon={<Shapes size={22} aria-hidden />}
      title={t(model.address.status === 'ARCHIVED' ? 'types.emptyArchived.title' : 'types.empty.title')}
      description={t(model.address.status === 'ARCHIVED' ? 'types.emptyArchived.body' : 'types.empty.body')}
      action={
        model.address.status === 'ARCHIVED' ? undefined : (
          <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onTypeOpen?.('new')}>
            <Plus size={14} aria-hidden /> {t('types.add')}
          </Button>
        )
      }
    />
  ) : undefined
  const keys: ListKey[] = [{ keys: ['c'], does: t('keys.newType') }]
  const total = shown?.length ?? 0
  return (
    <Card
      header={t('types.title')}
      description={<CardDescription text={t('types.description')} changed={model.changed.types} href={model.can.audit && (types?.length ?? 0) > 0 ? auditHref(model.prefix, 'ProductTypeProfile') : null} />}
      headerAction={
        <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onTypeOpen?.('new')}>
          <Plus size={14} aria-hidden /> {t('types.add')}
        </Button>
      }
      headingLevel={2}
      className="fw-pst-card"
    >
      <div className="fw-pst-stack">
        {held && held !== 'held.reading' && <p className="fw-pst-held">{t(held)}</p>}
        <ListFrame<TypeNode>
          label={t('types.table')}
          title={t('types.title')}
          rows={model.types.problem ? [] : shown}
          rowId={(node) => node.type.id}
          columns={columns}
          count={!shown ? t('common.loading') : t('types.count', { count: total })}
          tools={
            <SegmentedControl
              size="sm"
              ariaLabel={t('types.status.label')}
              value={model.address.status}
              onChange={(value) => actions?.onStatus?.(value as TypeFilter)}
              options={[
                { value: 'ACTIVE', label: t('types.status.ACTIVE') },
                { value: 'ARCHIVED', label: t('types.status.ARCHIVED') },
                { value: 'ALL', label: t('types.status.ALL') },
              ]}
            />
          }
          selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
          keys={keys}
          onHelp={() => actions?.onKeys?.()}
          onOpen={(node) => actions?.onTypeOpen?.(node.type.id)}
          state={state}
        />
        <p className="fw-pst-hint">{t('types.how')}</p>
      </div>
    </Card>
  )
}

export type { ProductType }
