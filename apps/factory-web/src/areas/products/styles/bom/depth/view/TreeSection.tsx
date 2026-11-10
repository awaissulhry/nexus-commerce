'use client'

import { useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { CornerDownRight } from 'lucide-react'
import { Banner, Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import { decimalText, REVISION_TONE } from '../../../model'
import type { TreeNode } from '../api'
import { depthHeld, ready, treeRowId, type BomDepthActions, type BomDepthModel } from '../model'

/**
 * Style › Materials (BOM) › Sub-assemblies (B-W2b-241 on B-W2b-223's structure; design style.bom.tree "Armour insert,
 * removable liner, hump, glove cuff with their own BOM", PRD-078; the view switch's Tree): the tree of parent and sub-BOMs
 * depth first to its deepest level — each sub-assembly line at its level, under the line that takes it, with the revision
 * of the other style it takes (its state), what that BOM makes and how many lines and sub-assemblies it has; "Open its BOM"
 * goes to that style's Materials (BOM) at that revision. Below it, where this style is itself a sub-assembly ("made once,
 * used in several jackets"). A sub-assembly is chosen on a component line we make (the line drawer). No money.
 */
export function TreeSection({ model, actions, prefix }: { model: BomDepthModel; actions?: BomDepthActions; prefix: string }) {
  const t = useT('products-bom-depth')
  const tp = useT('products')
  const locale = useLocale()
  const structure = ready(model.structure)
  const load = useRef(actions?.onLoadUsedIn)
  load.current = actions?.onLoadUsedIn
  useEffect(() => {
    if (structure) load.current?.()
  }, [structure?.revision.id])
  const rows = useMemo(() => structure?.tree ?? [], [structure])
  const held = depthHeld(structure, model.canManage, model.offline, model.busy)

  const columns = useMemo<ColDef<TreeNode>[]>(() => {
    const plain = { sortable: false, suppressHeaderMenuButton: true } as const
    const PartCell = ({ data }: ICellRendererParams<TreeNode>) =>
      data ? (
        <span className="fw-bmd-indent" style={{ ['--fw-bmd-level' as string]: data.level - 1 }}>
          {data.level > 1 && <CornerDownRight size={13} aria-label={t('tree.inside')} />}
          <span className="fw-bmd-cell">
            <span>
              <b>{data.item.code}</b> {data.item.name}
            </span>
            <span className="fw-bmd-sub">{t('tree.level', { level: data.level, seq: data.seq })}</span>
          </span>
        </span>
      ) : null
    const SubCell = ({ data }: ICellRendererParams<TreeNode>) =>
      data ? (
        <span className="fw-bmd-cell">
          <span>
            <Link className="fw-bmd-link" href={`${prefix}/products/styles/${data.subAssembly.style.id}?tab=bom&rev=${data.subAssembly.revision.id}`}>
              <b>{data.subAssembly.style.code}</b>
            </Link>{' '}
            {data.subAssembly.style.name}
          </span>
          <span className="fw-bmd-sub">{t('tree.makes', { qty: data.subAssembly.outputQuantity, unit: tp(`uom.${data.subAssembly.outputUom}`) })}</span>
        </span>
      ) : null
    const RevisionCell = ({ data }: ICellRendererParams<TreeNode>) =>
      data ? (
        <Tag tone={data.subAssembly.revision.status === 'RELEASED' ? 'success' : data.subAssembly.revision.status === 'DRAFT' ? 'warning' : 'neutral'}>
          {t('tree.revision', { revision: data.subAssembly.revision.revision, status: t(`revisionStatus.${data.subAssembly.revision.status}`) })}
        </Tag>
      ) : null
    const OpenCell = ({ data }: ICellRendererParams<TreeNode>) =>
      data ? (
        <Link className="fw-bmd-link" href={`${prefix}/products/styles/${data.subAssembly.style.id}?tab=bom&rev=${data.subAssembly.revision.id}`} aria-label={t('tree.openOne', { code: data.subAssembly.style.code, revision: data.subAssembly.revision.revision })}>
          {t('tree.open')}
        </Link>
      ) : null
    return [
      { colId: 'part', headerName: t('tree.col.part'), minWidth: 240, flex: 1.6, cellRenderer: PartCell, valueGetter: (params) => (params.data ? `${params.data.item.code} ${params.data.item.name}` : ''), ...plain },
      { colId: 'qty', headerName: t('tree.col.qty'), minWidth: 110, flex: 0.7, cellClass: 'fw-bmd-num', valueGetter: (params) => (params.data ? `${decimalText(params.data.qty, locale)} ${tp(`uom.${params.data.uom}`)}` : ''), ...plain },
      { colId: 'sub', headerName: t('tree.col.sub'), minWidth: 220, flex: 1.4, cellRenderer: SubCell, valueGetter: (params) => (params.data ? `${params.data.subAssembly.style.code} ${params.data.subAssembly.style.name}` : ''), ...plain },
      { colId: 'revision', headerName: t('tree.col.revision'), minWidth: 150, flex: 0.9, cellRenderer: RevisionCell, valueGetter: (params) => (params.data ? `r${params.data.subAssembly.revision.revision}` : ''), ...plain },
      { colId: 'bom', headerName: t('tree.col.bom'), minWidth: 170, flex: 1, valueGetter: (params) => (params.data ? t('tree.itsBom', { lines: params.data.lines, subs: params.data.subAssemblies }) : ''), ...plain },
      { colId: 'open', headerName: t('tree.col.open'), minWidth: 120, flex: 0.6, cellRenderer: OpenCell, ...plain },
    ]
  }, [t, tp, locale, prefix])

  if (model.structure.status === 'error')
    return (
      <Banner tone="danger" title={t('tree.failed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{tp('common.retry')}</Button>}>
        {tp(model.structure.problem)}
      </Banner>
    )
  if (!structure)
    return (
      <div className="fw-bmd-stack" aria-busy="true">
        <p className="fw-bmd-hint" role="status">
          <Spinner size={14} /> {t('tree.loading')}
        </p>
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} height={22} />
        ))}
      </div>
    )
  const usedIn = ready(model.usedIn)
  return (
    <div className="fw-bmd-stack">
      {held && held !== 'hold.busy' && held !== 'hold.frozen' && <Banner tone="info" title={t(held)} />}
      {rows.length === 0 ? (
        <EmptyState title={t('tree.empty.title')} description={t('tree.empty.body')} />
      ) : (
        <ListFrame<TreeNode>
          label={t('tree.table')}
          listKey={null}
          rows={rows}
          rowId={treeRowId}
          columns={columns}
          count={t('tree.count', { count: rows.length, levels: structure.levels })}
          keys={[{ keys: ['↵'], does: t('keyHint.openSub') }]}
          onOpen={(row) => {
            window.location.assign(`${prefix}/products/styles/${row.subAssembly.style.id}?tab=bom&rev=${row.subAssembly.revision.id}`)
          }}
        />
      )}
      <Card header={t('usedIn.title')} description={t('usedIn.intro', { code: structure.style.code })}>
        {model.usedIn.status === 'error' ? (
          <Banner tone="warning" title={t('usedIn.failed')} action={<Button size="sm" onClick={() => actions?.onLoadUsedIn?.()}>{tp('common.retry')}</Button>} />
        ) : !usedIn ? (
          <p className="fw-bmd-hint" role="status">
            <Spinner size={14} /> {t('usedIn.loading')}
          </p>
        ) : usedIn.usedIn.length === 0 ? (
          <p className="fw-bmd-hint">{t('usedIn.none')}</p>
        ) : (
          <SummaryTable
            label={t('usedIn.title')}
            stackOnPhone
            columns={[t('usedIn.col.style'), t('usedIn.col.revision'), t('usedIn.col.line'), t('usedIn.col.takes')]}
            rows={usedIn.usedIn.map((row) => ({
              id: `${row.revision.id}:${row.lineId}`,
              cells: [
                <Link key="s" className="fw-bmd-link" href={`${prefix}/products/styles/${row.style.id}?tab=bom&rev=${row.revision.id}`}>
                  <b>{row.style.code}</b> {row.style.name}
                </Link>,
                <Tag key="r" tone={REVISION_TONE[row.revision.status]}>
                  {t('tree.revision', { revision: row.revision.revision, status: t(`revisionStatus.${row.revision.status}`) })}
                </Tag>,
                t('usedIn.line', { seq: row.seq, qty: decimalText(row.qty, locale), unit: tp(`uom.${row.uom}`) }),
                t('tree.revision', { revision: row.takes.revision, status: t(`revisionStatus.${row.takes.status}`) }),
              ],
            }))}
          />
        )}
      </Card>
    </div>
  )
}
