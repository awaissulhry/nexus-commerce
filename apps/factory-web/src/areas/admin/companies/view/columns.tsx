'use client'

import { ExpandButton, ExpandSlot, IdentityCell, type ColDef } from '@nexus/ui/grid'
import { Pill, Tag } from '@nexus/ui/primitives'
import type { Translate } from '../../../../lib/i18n/messages'
import type { Site } from '../../shared/api'
import { adminHref, STATUS_TONE } from '../../shared/model'
import { cellOf as cell } from '../../shared/view/cells'
import { addressLine, type TreeRow } from '../model'

export interface OrgColumnsContext {
  t: Translate
  prefix: string
  /** sites.view: the sites, their structure and devices. */
  viewSites: boolean
  /** Fold or unfold a company's sites (its chevron, or ← / → on its row). */
  onToggle?: (companyId: string, expanded: boolean) => void
}

/** A tree row's id: its company's or its site's. */
export const treeRowId = (row: TreeRow) => (row.kind === 'company' ? row.company.id : row.site.id)

const totals = (row: Extract<TreeRow, { kind: 'company' }>) => {
  const active = row.company.sites.filter((site) => site.status === 'ACTIVE')
  return {
    lines: active.reduce((sum, site) => sum + site.counts.lines, 0),
    stations: active.reduce((sum, site) => sum + site.counts.stations, 0),
    devices: active.reduce((sum, site) => sum + site.counts.devices, 0),
  }
}

/**
 * SCR-008 the tree of companies and their sites, as rows of one list: a company row (its chevron folds its sites; ← / →
 * on the row too) and its site rows under it, one step in. Name, code, kind, VAT and address, invoicing, time zone,
 * lines and stations, devices, status.
 */
export function orgColumns(ctx: OrgColumnsContext): ColDef<TreeRow>[] {
  const { t } = ctx
  const href = (path: string) => adminHref(ctx.prefix, path)
  const structure = (row: TreeRow) => {
    if (!ctx.viewSites) return '—'
    if (row.kind === 'company') {
      const sum = totals(row)
      return t('org.structure', { lines: sum.lines, stations: sum.stations })
    }
    return t('org.structure', { lines: row.site.counts.lines, stations: row.site.counts.stations })
  }
  // ← / → on a company's row folds or unfolds its sites (the grid's own arrows move between cells elsewhere).
  const foldKeys = ({ event, data }: { event: KeyboardEvent; data?: TreeRow }) => {
    if (!data || data.kind !== 'company' || !ctx.viewSites || data.company.sites.length === 0) return false
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return false
    if (event.type === 'keydown') ctx.onToggle?.(data.company.id, event.key === 'ArrowRight')
    return true
  }
  return [
    {
      colId: 'name',
      headerName: t('org.col.name'),
      valueGetter: ({ data }) => (!data ? '' : data.kind === 'company' ? data.company.legalName : data.site.name),
      sortable: false,
      flex: 2,
      minWidth: 240,
      suppressKeyboardEvent: foldKeys,
      cellRenderer: cell<TreeRow>((row) => {
        if (row.kind === 'site')
          return (
            <IdentityCell
              noImage
              leading={
                <>
                  <ExpandSlot />
                  <ExpandSlot />
                </>
              }
              title={row.site.name}
              titleAttr={row.site.name}
              href={href(`/companies/${row.company.id}/sites/${row.site.id}`)}
            />
          )
        const { company } = row
        const foldable = ctx.viewSites && company.sites.length > 0
        return (
          <IdentityCell
            noImage
            leading={
              foldable ? (
                <ExpandButton
                  expanded={row.expanded}
                  labels={[t('org.expand', { name: company.legalName }), t('org.collapse', { name: company.legalName })]}
                  onToggle={() => ctx.onToggle?.(company.id, !row.expanded)}
                />
              ) : (
                <ExpandSlot />
              )
            }
            title={company.legalName}
            titleAttr={company.legalName}
            href={href(`/companies/${company.id}`)}
          />
        )
      }),
    },
    {
      colId: 'code',
      headerName: t('org.col.code'),
      valueGetter: ({ data }) => (!data ? '' : data.kind === 'company' ? data.company.code : data.site.code),
      sortable: false,
      minWidth: 90,
      flex: 0.5,
      cellRenderer: cell<TreeRow>((row) => <span className="fw-adm-code">{row.kind === 'company' ? row.company.code : row.site.code}</span>),
    },
    { colId: 'kind', headerName: t('org.col.kind'), valueGetter: ({ data }) => (!data ? '' : t(data.kind === 'company' ? 'org.kind.COMPANY' : `org.kind.${data.site.kind}`)), sortable: false, minWidth: 100, flex: 0.6 },
    {
      colId: 'vatAddress',
      headerName: t('org.col.vatAddress'),
      valueGetter: ({ data }) => (!data ? '' : data.kind === 'company' ? (data.company.vatNumber ?? '—') : (addressLine(data.site.address) ?? '—')),
      sortable: false,
      flex: 1.4,
      minWidth: 180,
      cellRenderer: cell<TreeRow>((row) =>
        row.kind === 'company' ? (
          <div className="fw-adm-cell2">
            <span>{row.company.vatNumber ?? '—'}</span>
            {addressLine(row.company.address) && <span className="nds-cell-sub">{addressLine(row.company.address)}</span>}
          </div>
        ) : (
          <span className="fw-adm-hint">{addressLine(row.site.address) ?? '—'}</span>
        ),
      ),
    },
    {
      colId: 'invoicing',
      headerName: t('org.col.invoicing'),
      valueGetter: ({ data }) => (!data || data.kind === 'site' ? '' : data.company.invoicing.ready ? t('org.invoicing.ready') : t('org.invoicing.missing', { count: data.company.invoicing.issues.length })),
      sortable: false,
      minWidth: 150,
      flex: 0.9,
      cellRenderer: cell<TreeRow>((row) =>
        row.kind === 'site' ? (
          '—'
        ) : row.company.invoicing.ready ? (
          <Pill tone="success">{t('org.invoicing.ready')}</Pill>
        ) : (
          <Pill tone="warning">{t('org.invoicing.missing', { count: row.company.invoicing.issues.length })}</Pill>
        ),
      ),
    },
    { colId: 'timezone', headerName: t('org.col.timezone'), valueGetter: ({ data }) => (!data ? '' : data.kind === 'company' ? data.company.timezone : data.site.timezone), sortable: false, minWidth: 120, flex: 0.7 },
    {
      colId: 'structure',
      headerName: t('org.col.structure'),
      valueGetter: ({ data }) => (data ? structure(data) : ''),
      sortable: false,
      minWidth: 150,
      flex: 0.9,
      cellRenderer: cell<TreeRow>((row) =>
        row.kind === 'site' && row.site.kind === 'PLANT' && row.site.counts.stations === 0 ? <Tag tone="warning">{t('org.noStations')}</Tag> : structure(row),
      ),
    },
    {
      colId: 'devices',
      headerName: t('org.col.devices'),
      valueGetter: ({ data }) => (!data ? '' : !ctx.viewSites ? '—' : String(data.kind === 'company' ? totals(data).devices : data.site.counts.devices)),
      sortable: false,
      minWidth: 100,
      flex: 0.4,
    },
    {
      colId: 'status',
      headerName: t('org.col.status'),
      valueGetter: ({ data }) => (!data ? '' : t(`status.${data.kind === 'company' ? data.company.status : data.site.status}`)),
      sortable: false,
      minWidth: 100,
      flex: 0.6,
      cellRenderer: cell<TreeRow>((row) => {
        const status = row.kind === 'company' ? row.company.status : row.site.status
        return <Pill tone={STATUS_TONE[status] ?? 'neutral'}>{t(`status.${status}`)}</Pill>
      }),
    },
  ]
}

/** SCR-008 the Company record's Sites: code, name (the Site record's link), kind, address, time zone, lines, stations, status. */
export function companySiteColumns(ctx: { t: Translate; prefix: string; companyId: string }): ColDef<Site>[] {
  const { t } = ctx
  return [
    {
      colId: 'name',
      headerName: t('org.col.name'),
      valueGetter: ({ data }) => data?.name ?? '',
      flex: 2,
      minWidth: 220,
      cellRenderer: cell<Site>((site) => <IdentityCell noImage title={site.name} titleAttr={site.name} href={adminHref(ctx.prefix, `/companies/${ctx.companyId}/sites/${site.id}`)} sub={site.code} />),
    },
    { colId: 'kind', headerName: t('org.col.kind'), valueGetter: ({ data }) => (data ? t(`org.kind.${data.kind}`) : ''), minWidth: 120, flex: 0.7 },
    { colId: 'address', headerName: t('company.field.address'), valueGetter: ({ data }) => (data ? (addressLine(data.address) ?? '—') : ''), flex: 1.6, minWidth: 220 },
    { colId: 'timezone', headerName: t('org.col.timezone'), valueGetter: ({ data }) => data?.timezone ?? '', minWidth: 140, flex: 0.8 },
    { colId: 'lines', headerName: t('site.col.lines'), valueGetter: ({ data }) => (data ? data.counts.lines : null), minWidth: 90, flex: 0.5 },
    { colId: 'stations', headerName: t('site.col.stations'), valueGetter: ({ data }) => (data ? data.counts.stations : null), minWidth: 100, flex: 0.5 },
    {
      colId: 'status',
      headerName: t('org.col.status'),
      valueGetter: ({ data }) => (data ? t(`status.${data.status}`) : ''),
      minWidth: 110,
      flex: 0.6,
      cellRenderer: cell<Site>((site) => <Pill tone={STATUS_TONE[site.status] ?? 'neutral'}>{t(`status.${site.status}`)}</Pill>),
    },
  ]
}
