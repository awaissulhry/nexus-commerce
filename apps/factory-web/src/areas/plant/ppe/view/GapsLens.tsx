'use client'

import { useEffect, useMemo } from 'react'
import { HandHelping, IdCard, ShieldCheck } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { ISSUE_LAW } from '@nexus/factory-domain/safety/ppe/rules'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { siteColumn } from '../../../../shell/scope/scope-context'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import type { GapLine, GapRow } from '../api'
import { GAP_SHOWS, gapRowsFor, itemName, missingText, type GapShow } from '../model'
import type { PpePageActions, PpePageModel } from '../view-model'
import { cardHref, PAGE_KEYS, SectionFailed, SectionHead, SectionLoading, useDay, useWords } from './parts'

/**
 * Gaps per person (design sec gaps; QHS-260; D.Lgs. 81/2008 art. 18 c.1 d): each person of the top bar's site (with "All sites"
 * a Site column and the site chip) against their role's kit — Person · role · missing items · last issue — as the list frame.
 * Show: who misses kit items (the API's own list), whose units are past their life, everyone. "Issue now" (and Enter) opens
 * Issue PPE prefilled from the person's kit; the person's PPE card opens in a new tab; Print PPE cards over the rows chosen.
 * A person is named as the register's subject only: no figure, ranking or total about a person.
 */
export function GapsLens({ model, actions, onHelp }: { model: PpePageModel; actions?: PpePageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const ds = useDsWords()
  const day = useDay()
  const locale = useLocale()
  const { address, scope } = model
  const answer = model.gaps.status === 'ready' ? model.gaps.value : null
  const rows = useMemo(() => (answer ? gapRowsFor(answer.people, address.show) : null), [answer, address.show])
  const selected = model.selected ?? []
  useEffect(() => {
    if (rows && selected.some((id) => !rows.some((row) => row.employee.id === id))) actions?.onSelected?.(selected.filter((id) => rows.some((row) => row.employee.id === id)))
  }, [rows, selected, actions])
  const roles = model.kits.status === 'ready' ? model.kits.value.roles : []

  const columns = useMemo<ColDef<GapRow>[]>(() => {
    const name = (line: GapLine) => itemName(line.item, locale)
    const PersonCell = ({ data }: ICellRendererParams<GapRow>) =>
      data ? (
        <span className="fw-ppe-cell">
          <span>{data.employee.name}</span>
          <span className="fw-ppe-muted">{data.employee.employeeCode ?? t('gaps.noCode')}</span>
        </span>
      ) : null
    const MissingCell = ({ data }: ICellRendererParams<GapRow>) => {
      if (!data) return null
      const shown = address.show === 'all' ? missingText(data.lines, name, 'missing') || missingText(data.lines, name, 'replace') : missingText(data.lines, name, address.show === 'replace' ? 'replace' : 'missing')
      if (!data.role) return <span className="fw-ppe-muted">{t('gaps.noRole')}</span>
      return <span className="fw-ppe-cell">{shown || <span className="fw-ppe-muted">{t('gaps.complete')}</span>}</span>
    }
    const ActionsCell = ({ data }: ICellRendererParams<GapRow>) =>
      data ? (
        <span className="fw-ppe-row">
          <Button size="sm" heldReason={!model.can.issue ? t('held.issue') : !data.canIssue ? t('held.personSite') : null} onClick={() => actions?.onAddress?.({ issue: data.employee.id })}>
            <HandHelping size={13} aria-hidden /> {t('gaps.issueNow')}
          </Button>
          <a className="fw-ppe-link" href={cardHref(model.prefix, [data.employee.id])} target="_blank" rel="noopener noreferrer" aria-label={t('gaps.cardOf', { name: data.employee.name })}>
            <IdCard size={13} aria-hidden /> {t('gaps.card')}
          </a>
        </span>
      ) : null
    const site = siteColumn<GapRow>(scope, (row) => row.siteId, t('col.site'))
    return [
      { colId: 'person', headerName: t('gaps.col.person'), minWidth: 200, flex: 1.2, valueGetter: (params) => params.data?.employee.name ?? '', cellRenderer: PersonCell },
      { colId: 'role', headerName: t('gaps.col.role'), minWidth: 150, flex: 0.9, valueGetter: (params) => (params.data ? (params.data.role?.name ?? t('gaps.noRole')) : '') },
      {
        colId: 'missing',
        headerName: t(address.show === 'replace' ? 'gaps.col.replace' : 'gaps.col.missing'),
        minWidth: 260,
        flex: 2,
        sortable: false,
        valueGetter: (params) => (params.data ? missingText(params.data.lines, name, address.show === 'replace' ? 'replace' : 'missing') : ''),
        cellRenderer: MissingCell,
      },
      { colId: 'lastIssue', headerName: t('gaps.col.lastIssue'), minWidth: 130, flex: 0.7, valueGetter: (params) => (params.data ? params.data.lastIssueAt ?? '' : ''), valueFormatter: (params) => (params.data ? (params.data.lastIssueAt ? day(params.data.lastIssueAt) : t('gaps.never')) : '') },
      ...(site ? [site] : []),
      { colId: 'actions', headerName: t('col.actions'), minWidth: 230, flex: 1, sortable: false, pinned: 'right', cellRenderer: ActionsCell },
    ]
  }, [t, day, scope, address.show, locale, model.can.issue, model.prefix, actions])

  const filters = (
    <span className="fw-ppe-row">
      <Input size="sm" type="search" value={address.q} placeholder={t('gaps.search')} aria-label={t('gaps.search')} onChange={(event) => actions?.onAddress?.({ q: event.target.value })} />
      <Select size="sm" value={address.show} aria-label={t('gaps.showLabel')} onChange={(event) => actions?.onAddress?.({ show: event.target.value as GapShow })}>
        {GAP_SHOWS.map((show) => (
          <option key={show} value={show}>
            {t(`gaps.show.${show}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" value={address.role ?? ''} aria-label={t('gaps.role')} onChange={(event) => actions?.onAddress?.({ role: event.target.value || null })}>
        <option value="">{t('gaps.allRoles')}</option>
        {roles.map((role) => (
          <option key={role.id} value={role.id}>
            {scope.allSites ? `${role.name} · ${role.site.code}` : role.name}
          </option>
        ))}
      </Select>
    </span>
  )

  const head = (
    <SectionHead id="fw-ppe-gaps" title={t('gaps.title')} note={<LawRef law={answer?.law.issue ?? ISSUE_LAW} plain={t('law.issue')} labels={ds.lawRef} />}>
      {answer && answer.withoutRole > 0 ? <span className="fw-ppe-muted">{t('gaps.withoutRole', { count: answer.withoutRole })}</span> : null}
      <ScopeSiteChip model={scope} />
    </SectionHead>
  )

  if (model.gaps.status === 'error') {
    return (
      <>
        {head}
        <SectionFailed title={t('gaps.failed')} problem={model.gaps.problem} onRetry={() => actions?.onRetry?.('gaps')} />
      </>
    )
  }
  if (!answer || !rows) {
    return (
      <>
        {head}
        <SectionLoading rows={6} />
      </>
    )
  }

  const filtered = address.q !== '' || address.role !== null
  const picked = rows.filter((row) => selected.includes(row.employee.id))
  return (
    <>
      {head}
      <ListFrame<GapRow>
        label={t('gaps.label')}
        title={t('gaps.title')}
        listKey="plant.ppe"
        rows={rows}
        rowId={(row) => row.employee.id}
        columns={columns}
        count={t('gaps.count', { count: rows.length })}
        search={filters}
        selection={{
          selected,
          onChange: (ids) => actions?.onSelected?.(ids),
          actions: (
            <Button size="sm" variant="primary" aria-label={t('bulk.cards', { count: picked.length })} onClick={() => actions?.onPrintCards?.(picked.map((row) => row.employee.id))}>
              <IdCard size={13} aria-hidden /> <SelectionLabel>{t('bulk.cards', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => (model.can.issue && row.canIssue ? actions?.onAddress?.({ issue: row.employee.id }) : actions?.onPrintCards?.([row.employee.id]))}
        more={answer.complete ? null : { label: t('gaps.more'), onMore: () => undefined, held: t('gaps.moreHeld') }}
        state={
          rows.length === 0 ? (
            filtered ? (
              <EmptyState icon={<ShieldCheck size={22} aria-hidden />} title={t('gaps.noneFiltered')} description={t('common.noneFilteredHint')} />
            ) : (
              <EmptyState icon={<ShieldCheck size={22} aria-hidden />} title={t(`gaps.empty.${address.show}`)} description={t(`gaps.emptyHint.${address.show}`)} />
            )
          ) : undefined
        }
        cards={{ fields: { person: { role: 'title' }, role: { role: 'subtitle' } } }}
      />
    </>
  )
}
