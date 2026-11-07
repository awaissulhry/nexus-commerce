'use client'

import { useMemo } from 'react'
import { ShieldCheck } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { CATALOGUE_LAW } from '@nexus/factory-domain/safety/ppe/rules'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { siteColumn } from '../../../../shell/scope/scope-context'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import type { KitRole } from '../api'
import { categoryMark, itemName, kitMatrix } from '../model'
import type { PpePageActions, PpePageModel } from '../view-model'
import { PAGE_KEYS, SectionFailed, SectionHead, SectionLoading, useWords } from './parts'

/**
 * Kits per role (design sec kits; QHS-260): the roles of the top bar's site × the items their kits name, each cell how many and
 * when to wear them. Read here, edited in the role sheet (one owner: Plant › Risk assessment, linked once that page is built).
 * A read-only matrix in the list frame (no selection: nothing applies to many rows here).
 */
export function KitsLens({ model, actions, onHelp }: { model: PpePageModel; actions?: PpePageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const ds = useDsWords()
  const locale = useLocale()
  const { scope } = model
  const answer = model.kits.status === 'ready' ? model.kits.value : null
  const matrix = useMemo(() => (answer ? kitMatrix(answer) : null), [answer])

  const columns = useMemo<ColDef<KitRole>[]>(() => {
    if (!matrix) return []
    const RoleCell = ({ data }: ICellRendererParams<KitRole>) =>
      data ? (
        <span className="fw-ppe-cell">
          <span>{data.name}</span>
          <span className="fw-ppe-muted fw-ppe-code">{data.code}</span>
        </span>
      ) : null
    const itemColumns = matrix.items.map((item): ColDef<KitRole> => {
      const Cell = ({ data }: ICellRendererParams<KitRole>) => {
        const cell = data ? matrix.cell(data.id, item.id) : null
        if (!data) return null
        if (!cell) return <span className="fw-ppe-muted">—</span>
        return (
          <span className="fw-ppe-cell">
            <span>{t('kits.quantity', { count: cell.quantity })}</span>
            <span className="fw-ppe-muted">{cell.whenToWear || t('kits.always')}</span>
          </span>
        )
      }
      return {
        colId: `item-${item.id}`,
        headerName: `${itemName(item, locale)} (${categoryMark(item.category)})`,
        headerTooltip: item.code,
        minWidth: 170,
        flex: 1,
        sortable: false,
        valueGetter: (params) => {
          const cell = params.data ? matrix.cell(params.data.id, item.id) : null
          return cell ? `${cell.quantity} · ${cell.whenToWear}` : ''
        },
        cellRenderer: Cell,
      }
    })
    const site = siteColumn<KitRole>(scope, (row) => row.siteId, t('col.site'))
    return [
      { colId: 'role', headerName: t('kits.col.role'), minWidth: 180, flex: 1, pinned: 'left', valueGetter: (params) => params.data?.name ?? '', cellRenderer: RoleCell },
      { colId: 'people', headerName: t('kits.col.people'), minWidth: 100, flex: 0.4, type: 'numericColumn', valueGetter: (params) => params.data?.people ?? null },
      ...(site ? [site] : []),
      ...itemColumns,
    ]
  }, [matrix, t, scope, locale])

  const head = (
    <SectionHead id="fw-ppe-kits" title={t('kits.title')} note={<LawRef law={CATALOGUE_LAW} plain={t('law.catalogue')} labels={ds.lawRef} />}>
      {model.riskPage ? (
        <>
          <span className="fw-ppe-muted">{t('kits.readHere')}</span>
          <a className="fw-ppe-link" href={`${model.prefix}/plant/risk`}>
            {t('kits.editInRisk')}
          </a>
        </>
      ) : (
        <span className="fw-ppe-muted">{t('kits.riskLater')}</span>
      )}
      <ScopeSiteChip model={scope} />
    </SectionHead>
  )

  if (model.kits.status === 'error') {
    return (
      <>
        {head}
        <SectionFailed title={t('kits.failed')} problem={model.kits.problem} onRetry={() => actions?.onRetry?.('kits')} />
      </>
    )
  }
  if (!answer || !matrix) {
    return (
      <>
        {head}
        <SectionLoading rows={5} />
      </>
    )
  }

  return (
    <>
      {head}
      <ListFrame<KitRole>
        label={t('kits.label')}
        title={t('kits.title')}
        listKey="plant.ppe.3"
        rows={matrix.roles}
        rowId={(row) => row.id}
        columns={columns}
        count={t('kits.count', { count: matrix.roles.length, items: matrix.items.length })}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        more={answer.complete ? null : { label: t('kits.more'), onMore: () => undefined, held: t('kits.moreHeld') }}
        state={
          matrix.roles.length === 0 || matrix.items.length === 0 ? (
            <EmptyState icon={<ShieldCheck size={22} aria-hidden />} title={t(matrix.roles.length === 0 ? 'kits.noRoles' : 'kits.noKits')} description={t(model.riskPage ? 'kits.emptyHint' : 'kits.emptyHintLater')} />
          ) : undefined
        }
        cards={{ fields: { role: { role: 'title' } } }}
      />
    </>
  )
}
