'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, FileQuestion, X } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { SupplierDocuments, SupplierRow } from '../../depth/api'
import { requestHeld, type DepthCan, type Read } from '../../depth/model'
import { KindTags } from '../../depth/view/ProfileCard'
import { useSay } from '../../depth/view/parts'

export interface ExpiringRow {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly kinds: readonly string[]
  readonly docs: SupplierDocuments
}

export interface ExpiringModel {
  readonly summary: Read<readonly SupplierDocuments[]>
  readonly suppliers: Read<readonly SupplierRow[]>
  readonly can: DepthCan
  /** `/w/<company>`: the rows open the supplier's Documents & qualification. */
  readonly prefix: string
  /** Design cases: the rows picked at the start. */
  readonly selected?: readonly string[]
}

export interface ExpiringActions {
  onRequest?: (targets: ReadonlyArray<{ id: string; name: string }>) => void
  onExport?: (rows: readonly ExpiringRow[]) => void
  onClose?: () => void
  onRetry?: () => void
  onOpen?: (row: ExpiringRow) => void
  onHelp?: () => void
}

/** The suppliers with a document that expires in 30 days, joined to their names and kinds (by code when a name is not read yet). */
export function expiringRows(summary: readonly SupplierDocuments[], suppliers: readonly SupplierRow[] | null): ExpiringRow[] {
  const byId = new Map((suppliers ?? []).map((row) => [row.id, row]))
  return summary
    .filter((row) => row.expiring > 0)
    .map((docs) => {
      const supplier = byId.get(docs.partyId)
      return { id: docs.partyId, code: docs.code, name: supplier?.name ?? docs.code, kinds: supplier?.kinds ?? [], docs }
    })
    .sort((a, b) => b.docs.expiring - a.docs.expiring || a.name.localeCompare(b.name))
}

/**
 * The "Documents expiring in 30 days" view of Suppliers (the tile pressed; Rows ▾ Expiring documents): the shared list
 * frame over the suppliers whose documents run out within 30 days — what each holds valid, expiring, expired and missing
 * —, with select-all, shift range, x and the bulk actions Request documents N and Export N. A row opens the supplier's
 * Documents & qualification.
 */
export function ExpiringSection({ model, actions }: { model: ExpiringModel; actions?: ExpiringActions }) {
  const { t, say } = useSay()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const summary = model.summary.status === 'ready' ? model.summary.value : null
  const suppliers = model.suppliers.status === 'ready' ? model.suppliers.value : null
  const rows = useMemo(() => (summary ? expiringRows(summary, suppliers) : null), [summary, suppliers])
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const latest = useRef(actions)
  latest.current = actions

  const columns = useMemo<ColDef<ExpiringRow>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<ExpiringRow>) =>
      data ? (
        <span className="fw-spd-who">
          <Link href={`${model.prefix}/purchasing/suppliers/${encodeURIComponent(data.id)}?tab=documents`} tabIndex={-1}>
            {data.name}
          </Link>
          <span className="fw-spd-hint fw-spd-code">{data.code}</span>
        </span>
      ) : null
    const KindsCell = ({ data }: ICellRendererParams<ExpiringRow>) => (data ? data.kinds.length > 0 ? <KindTags kinds={data.kinds} /> : <span className="fw-spd-hint">{t('profile.noKinds')}</span> : null)
    const count = (field: 'valid' | 'expiring' | 'expired' | 'missing', tone: 'success' | 'warning' | 'danger') =>
      function CountCell({ data }: ICellRendererParams<ExpiringRow>) {
        if (!data) return null
        const value = data.docs[field]
        return value === 0 ? <span className="fw-spd-hint">0</span> : <Pill tone={tone}>{String(value)}</Pill>
      }
    return [
      { colId: 'name', headerName: t('expiring.col.supplier'), flex: 2, minWidth: 220, cellRenderer: NameCell, sortable: false },
      { colId: 'kinds', headerName: t('expiring.col.kinds'), flex: 1.6, minWidth: 180, cellRenderer: KindsCell, sortable: false },
      { colId: 'expiring', headerName: t('expiring.col.expiring'), flex: 0.8, minWidth: 110, cellRenderer: count('expiring', 'warning'), sortable: false },
      { colId: 'expired', headerName: t('expiring.col.expired'), flex: 0.8, minWidth: 110, cellRenderer: count('expired', 'danger'), sortable: false },
      { colId: 'missing', headerName: t('expiring.col.missing'), flex: 0.8, minWidth: 110, cellRenderer: count('missing', 'danger'), sortable: false },
      { colId: 'valid', headerName: t('expiring.col.valid'), flex: 0.8, minWidth: 100, cellRenderer: count('valid', 'success'), sortable: false },
    ]
  }, [model.prefix, t])

  const state =
    model.summary.status === 'error' ? (
      <EmptyState
        title={t('read.failed', { what: t('expiring.title') })}
        description={t(model.summary.problem)}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {t('read.retry')}
          </Button>
        }
      />
    ) : rows !== null && rows.length === 0 ? (
      <EmptyState icon={<FileQuestion size={24} aria-hidden />} title={t('expiring.empty')} description={t('expiring.emptyBody')} />
    ) : undefined
  const held = requestHeld(model.can, picked.length)

  return (
    <div className="fw-spd-stack">
      <div className="fw-spd-head">
        <p className="fw-spd-hint">{t('expiring.intro')}</p>
        <Button size="sm" variant="quiet" onClick={() => actions?.onClose?.()}>
          <X size={13} aria-hidden /> {t('expiring.close')}
        </Button>
      </div>
      <ListFrame<ExpiringRow>
        label={t('expiring.title')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('expiring.count', { count: rows.length }) : '—'}
        selection={{
          selected,
          onChange: (ids) => setSelected(ids),
          actions: (
            <>
              <Button size="sm" aria-label={t('list.request', { count: picked.length })} onClick={() => latest.current?.onRequest?.(picked.map((row) => ({ id: row.id, name: row.name })))} heldReason={held ? say(held) : null}>
                <FileQuestion size={13} aria-hidden /> <SelectionLabel>{t('list.request', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('expiring.export', { count: picked.length })} onClick={() => latest.current?.onExport?.(picked)}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('expiring.export', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        onHelp={() => actions?.onHelp?.()}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        listKey="purchasing.suppliers.2"
      />
    </div>
  )
}
