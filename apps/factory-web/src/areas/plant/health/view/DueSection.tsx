'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { CalendarCheck, Printer, X } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { DueCell } from '@nexus/ui/components/DueCell/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Select } from '@nexus/ui/primitives'
import { VISIT_TYPES } from '@nexus/factory-domain/safety/health/rules'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import type { VisitRow } from '../api'
import { addressTerms, dueDayOf, dueFiltered, DUE_STATUSES, HEALTH_PATH, tileRows, visitSelectHeld, withAddress, type DueStatus } from '../model'
import type { HealthPageActions, HealthPageModel } from '../view-model'
import { PAGE_KEYS, personText, SectionFailed, SectionHead, useWhen, useWords, VisitStateTag, WhoLooked } from './parts'

/**
 * design sec:due — the due list, "Visits to book (QHS-253; art. 41)": person · role · visit type · due (DueCell) · booked ·
 * status. Its names come from a RECORDED read (one LIST view per company, said above the table): live changes wait behind
 * "N updates · Show" so nothing re-reads by itself. Choose open visits → "Mark N booked" (pop:booked) and "Print N for the
 * doctor"; a row opens the visit (its own recorded read); Who looked per row for HR and the DPO.
 */
export function DueSection({ model, actions, onHelp }: { model: HealthPageModel; actions?: HealthPageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const ds = useDsWords()
  const when = useWhen()
  const { address, scope } = model
  const due = model.due?.status === 'ready' ? model.due.value : null
  const rows = useMemo(() => (due ? tileRows(due.rows, address.tile, model.today) : null), [due, address.tile, model.today])
  const selected = model.dueSelected ?? []
  const picked = (rows ?? []).filter((row) => selected.includes(row.id) && visitSelectHeld(row) === null)
  const frame = model.frame.status === 'ready' ? model.frame.value : null
  const manage = frame?.can.manage ?? model.can.manage
  const views = frame?.can.views ?? model.can.views
  const visitHref = (row: VisitRow) => `${model.prefix}${HEALTH_PATH}${addressTerms(withAddress(address, { visit: row.id, judge: null, judgement: null, plan: null, planVisits: false }))}`

  const columns = useMemo<ColDef<VisitRow>[]>(() => {
    const PersonCell = ({ data }: ICellRendererParams<VisitRow>) =>
      data ? (
        <span className="fw-hv-cell">
          <Link href={visitHref(data)}>{data.employee.name}</Link>
          {data.employee.employeeCode ? <span className="fw-hv-muted">{data.employee.employeeCode}</span> : null}
        </span>
      ) : null
    const DueCellOf = ({ data }: ICellRendererParams<VisitRow>) => {
      if (!data) return null
      if (data.status === 'CANCELLED') return <span className="fw-hv-muted">—</span>
      const value = data.status === 'DONE' ? { state: 'done' as const, doneOn: data.doneOn } : { due: dueDayOf(data) }
      return <DueCell value={value} today={model.today} formatDate={(iso) => when.day(iso)} labels={{ ...ds.dueCell, validUntil: (text) => t('due.dueOn', { date: text }) }} />
    }
    const built: ColDef<VisitRow>[] = [
      { colId: 'person', headerName: t('col.person'), minWidth: 190, flex: 1.4, valueGetter: (params) => (params.data ? personText(params.data.employee) : ''), cellRenderer: PersonCell },
      { colId: 'role', headerName: t('col.role'), minWidth: 160, flex: 1.2, valueGetter: (params) => (params.data ? (params.data.role ? `${params.data.role.code} · ${params.data.role.name}` : '—') : '') },
      { colId: 'type', headerName: t('col.type'), minWidth: 170, flex: 1.2, valueGetter: (params) => (params.data ? t(`visitType.${params.data.type}`) : '') },
      { colId: 'due', headerName: t('col.due'), minWidth: 175, flex: 1.1, valueGetter: (params) => (params.data ? dueDayOf(params.data) : ''), cellRenderer: DueCellOf },
      {
        colId: 'booked',
        headerName: t('col.booked'),
        minWidth: 170,
        flex: 1.2,
        valueGetter: (params) => (params.data?.booked ? [when.day(params.data.booked.on), params.data.booked.place].filter(Boolean).join(' · ') : params.data ? '—' : ''),
      },
      { colId: 'status', headerName: t('col.status'), minWidth: 120, flex: 0.9, valueGetter: (params) => (params.data ? t(`visitState.${params.data.state}`) : ''), cellRenderer: ({ data }: ICellRendererParams<VisitRow>) => (data ? <VisitStateTag state={data.state} /> : null) },
    ]
    if (scope.allSites) built.splice(2, 0, { colId: 'site', headerName: t('col.site'), minWidth: 140, flex: 1, valueGetter: (params) => params.data?.employee.site.name ?? '' })
    if (views) {
      built.push({
        colId: 'who',
        headerName: t('col.who'),
        minWidth: 90,
        maxWidth: 110,
        sortable: false,
        valueGetter: () => '',
        cellRenderer: ({ data }: ICellRendererParams<VisitRow>) =>
          data ? <WhoLooked of={{ recordType: 'HEALTH_VISIT', recordId: data.id }} state={model.whoLooked} onOpen={actions?.onWhoLooked} label={t('who.visit', { name: data.employee.name })} compact /> : null,
      })
    }
    return built
    // The words follow the language; the log follows its read.
  }, [t, ds, when, scope.allSites, views, model.today, model.whoLooked, model.prefix, address])

  const tools = (
    <span className="fw-hv-tools">
      <Select size="sm" aria-label={t('due.statusLabel')} value={address.status ?? 'open'} onChange={(event) => actions?.onAddress?.({ status: event.target.value === 'open' ? null : (event.target.value as DueStatus), tile: null })}>
        {DUE_STATUSES.map((status) => (
          <option key={status} value={status}>
            {t(`dueStatus.${status}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" aria-label={t('due.typeLabel')} value={address.type ?? ''} onChange={(event) => actions?.onAddress?.({ type: (event.target.value || null) as typeof address.type })}>
        <option value="">{t('due.allTypes')}</option>
        {VISIT_TYPES.map((type) => (
          <option key={type} value={type}>
            {t(`visitType.${type}`)}
          </option>
        ))}
      </Select>
      {address.tile && <span className="fw-hv-chip">{t(`tile.${address.tile}.label`)}</span>}
      {dueFiltered(address) && (
        <Button size="sm" variant="quiet" onClick={() => actions?.onAddress?.({ tile: null, status: null, type: null })}>
          <X size={13} aria-hidden /> {t('due.clear')}
        </Button>
      )}
    </span>
  )

  const state =
    model.due?.status === 'error' ? (
      <SectionFailed title={t('due.failed')} problem={model.due.problem} onRetry={actions?.onRetryDue} />
    ) : rows && rows.length === 0 ? (
      dueFiltered(address) ? (
        <EmptyState title={t('due.noneMatchTitle')} description={t('due.noneMatch')} />
      ) : (
        <EmptyState
          title={t('due.emptyTitle')}
          description={t('due.empty')}
          action={
            manage ? (
              <Button size="sm" onClick={() => actions?.onAddress?.({ planVisits: true })}>
                {t('band.planVisits')}
              </Button>
            ) : undefined
          }
        />
      )
    ) : undefined

  const printHref = `${model.prefix}${HEALTH_PATH}/print?visits=${picked.map((row) => row.id).join(',')}`
  const bookHeld = !manage ? t('held.manage') : picked.length === 0 ? t('held.book.none') : picked.length > 100 ? t('held.book.tooMany', { most: 100 }) : null

  return (
    <section className="fw-hv-section" aria-labelledby="fw-hv-due" id="fw-hv-due-list">
      <SectionHead id="fw-hv-due" title={t('due.title')} note={due ? t('due.recorded', { time: when.at(due.at) }) : model.due === null ? t('due.waiting') : t('due.note')}>
        <ScopeSiteChip model={scope} />
      </SectionHead>
      <ListFrame<VisitRow>
        label={t('due.label')}
        title={t('due.title')}
        listKey={null}
        rows={model.due === null || model.due.status === 'loading' ? null : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('due.count', { count: rows.length }) : '—'}
        tools={tools}
        selection={{
          selected,
          onChange: (ids) => actions?.onDueSelected?.(ids),
          actions: (
            <>
              <Button size="sm" variant="primary" aria-label={t('bulk.book', { count: picked.length })} heldReason={bookHeld} onClick={() => actions?.onBook?.(picked.map((row) => row.id))}>
                <CalendarCheck size={13} aria-hidden /> <SelectionLabel>{t('bulk.book', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" asChild={picked.length > 0} heldReason={picked.length === 0 ? t('held.book.none') : null}>
                {picked.length > 0 ? (
                  <a href={printHref} target="_blank" rel="noopener noreferrer">
                    <Printer size={13} aria-hidden /> <SelectionLabel>{t('bulk.print', { count: picked.length })}</SelectionLabel>
                  </a>
                ) : (
                  <>
                    <Printer size={13} aria-hidden /> <SelectionLabel>{t('bulk.print', { count: 0 })}</SelectionLabel>
                  </>
                )}
              </Button>
            </>
          ),
        }}
        isRowSelectable={(row) => {
          const held = visitSelectHeld(row)
          return held ? t(held) : null
        }}
        updates={model.dueUpdates > 0 ? { count: model.dueUpdates, onShow: () => actions?.onDueUpdates?.() } : null}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onAddress?.({ visit: row.id })}
        more={due?.more ? { label: t('due.more'), onMore: () => actions?.onDueMore?.(), held: model.dueMore ? t('common.reading') : null } : null}
        state={state}
        cards={{ fields: { person: { role: 'title' } } }}
        today={model.today}
      />
      {model.due?.status === 'loading' && <span className="fw-hv-slow">{t('common.stillLoading')}</span>}
    </section>
  )
}
