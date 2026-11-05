'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCheck, Eye, EyeOff, MoreHorizontal, Plus, X } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, type Metric } from '@nexus/ui/components'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { AsOf, Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import type { Translate } from '../../../../lib/i18n/messages'
import { WithMessages } from '../../../../record-panels/i18n'
import { isListKey } from '../../../../list-frame/model'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import type { IncidentPerson, IncidentRow } from '../api'
import { addressTerms, filtered, INCIDENTS_PATH, ROWS, STATUS_FILTERS, tileActive, tileFilter, tilesOf, whereText, type TileId } from '../model'
import type { IncidentsPageActions, IncidentsPageModel } from '../view-model'
import '../incidents.css'
import { DeadlineText, FilingStateTag, INCIDENT_NAMESPACES, KeysModal, KindTag, LIST_KEYS, NoIncidentsAccess, PeopleLaw, SectionFailed, SectionHead, SeverityTag, StatusTag, useWhen, useWords } from './parts'
import { ReportDialog } from './ReportDialog'

export type { IncidentsPageActions, IncidentsPageModel } from '../view-model'

/**
 * SCR-210 — Plant › Health & safety › Incidents (design plant.incidents; QHS-265, QHS-268, QHS-270): the band (the nearest
 * INAIL deadline as a live chip and when it was read; Report an incident, `c`; ⋯ export and print, both anonymised; the keys),
 * the critical banner (an INAIL deadline under 24 h or late, never missed: Open → the record's Authority notice), the five
 * tiles (each a filter of the list but Actions overdue), and the list — anonymised by default, Rows ▾, status, the number,
 * Site from the top bar (a Site column with "All sites"), "Show people" for the safety and HR roles (a recorded read, said
 * first; the names live in the page's state only), Mark seen N, Export N. One view model, nothing fetched; the page fills the
 * main area (no max-width); every word from the catalogues; every held button says why.
 */
export function IncidentsView({ model, actions }: { model: IncidentsPageModel; actions?: IncidentsPageActions }) {
  return (
    <WithMessages namespaces={INCIDENT_NAMESPACES}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: IncidentsPageModel; actions?: IncidentsPageActions | undefined }) {
  const t = useWords()
  const [keysOpen, setKeysOpen] = useState(model.keysOpen ?? false)
  const [heldSaid, setHeldSaid] = useState(false)
  const { address, can } = model
  const dialogOpen = address.report || keysOpen || model.people.state === 'confirm'
  const reportHeld = model.reportHeld ?? null

  // c reports an incident, ? the keys (not in a field, a menu or a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialogOpen || !isListKey(event, event.target as HTMLElement | null)) return
      if (event.key === 'c') {
        event.preventDefault()
        if (reportHeld) setHeldSaid(true)
        else actions?.onAddress?.({ report: true })
      } else if (event.key === '?') {
        event.preventDefault()
        setKeysOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!can.view) {
    return (
      <div className="fw-inc">
        <NoIncidentsAccess />
      </div>
    )
  }

  const counts = model.counts.status === 'ready' ? model.counts.value : null
  const printHref = `${model.prefix}${INCIDENTS_PATH}/print${addressTerms(address, false)}`

  return (
    <div className="fw-inc">
      <div className="fw-inc-band" role="group" aria-label={t('band.label')}>
        <span className="fw-inc-status">
          {counts?.next ? (
            <Tag tone={counts.next.countdown.late || counts.next.countdown.under24h ? 'danger' : 'warning'}>
              <DeadlineText countdown={counts.next.countdown} prefix={t('band.nextDeadline', { number: counts.next.number })} onDone={actions?.onRetryCounts} />
            </Tag>
          ) : counts ? (
            <span className="fw-inc-muted">{t('band.noDeadline')}</span>
          ) : null}
          {model.readAt ? <AsOf at={model.readAt} /> : <span className="fw-inc-muted">{t('band.reading')}</span>}
        </span>
        <span className="fw-inc-actions">
          <Button size="sm" variant="primary" aria-keyshortcuts="c" heldReason={reportHeld ? t(reportHeld) : null} onClick={() => actions?.onAddress?.({ report: true })}>
            <Plus size={14} aria-hidden /> {t('band.report')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'export', label: t('band.export'), description: t('band.exportHint'), onSelect: () => document.getElementById('fw-inc-list')?.focus() },
              { id: 'print', label: t('band.print'), description: t('band.printHint'), href: printHref, target: '_blank' },
              { id: 'keys', label: t('keys.title'), onSelect: () => setKeysOpen(true) },
            ]}
          />
        </span>
      </div>

      {heldSaid && reportHeld && <Banner tone="info" title={t(reportHeld)} onDismiss={() => setHeldSaid(false)} />}

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            model.notice.open ? (
              <Button size="sm" asChild>
                <Link href={`${model.prefix}${INCIDENTS_PATH}/${encodeURIComponent(model.notice.open.id)}`}>{t('notice.open', { number: model.notice.open.number })}</Link>
              </Button>
            ) : undefined
          }
          onDismiss={() => actions?.onDismissNotice?.()}
        >
          {model.notice.refused && model.notice.refused.length > 0 ? (
            <ul className="fw-inc-list">
              {model.notice.refused.map((entry, index) => (
                <li key={`${index}-${entry.label}`}>{t('notice.refusedRow', { label: entry.label, why: t(entry.key) })}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      )}

      <DeadlineSection model={model} actions={actions} />
      <TilesSection model={model} actions={actions} />
      <ListSection model={model} actions={actions} onHelp={() => setKeysOpen(true)} />

      {model.report && <ReportDialog model={model} state={model.report} actions={actions} />}
      {model.people.state === 'confirm' && <PeopleConfirm model={model} actions={actions} />}
      {keysOpen && <KeysModal keys={LIST_KEYS(t)} onClose={() => setKeysOpen(false)} />}
    </div>
  )
}

/** design sec:deadline — an INAIL deadline under 24 h is never missed: one critical banner, hidden when none. */
function DeadlineSection({ model, actions }: { model: IncidentsPageModel; actions?: IncidentsPageActions | undefined }) {
  const t = useWords()
  if (model.counts.status === 'loading') {
    return (
      <section className="fw-inc-section" aria-label={t('deadline.label')} aria-busy="true">
        <Skeleton height={52} />
      </section>
    )
  }
  if (model.counts.status === 'error') {
    return (
      <Banner
        tone="warning"
        title={t('deadline.failed')}
        action={
          <Button size="sm" onClick={() => actions?.onRetryCounts?.()}>
            {t('common.retry')}
          </Button>
        }
      >
        {t(model.counts.problem)}
      </Banner>
    )
  }
  const deadline = model.counts.value.deadline
  if (!deadline) return null
  return (
    <section className="fw-inc-section" aria-label={t('deadline.label')}>
      <Banner
        tone="danger"
        icon={<AlertTriangle size={18} aria-hidden />}
        title={
          <span className="fw-inc-banner-title">
            {t('deadline.title', { number: deadline.number })} <DeadlineText countdown={deadline.countdown} onDone={actions?.onRetryCounts} />
          </span>
        }
        action={
          <Button size="sm" variant="primary" asChild>
            <Link href={`${model.prefix}${INCIDENTS_PATH}/${encodeURIComponent(deadline.incidentId)}?tab=authority`}>{t('deadline.open')}</Link>
          </Button>
        }
      >
        {t('deadline.body')}
        {deadline.more > 0 ? ` ${t('deadline.more', { count: deadline.more })}` : ''}
      </Banner>
    </section>
  )
}

/** design sec:tiles — safety events now; a tile is a filter of the list (Actions overdue opens nothing: said in its hint). */
function TilesSection({ model, actions }: { model: IncidentsPageModel; actions?: IncidentsPageActions | undefined }) {
  const t = useWords()
  const counts = model.counts.status === 'ready' ? model.counts.value : null
  const metrics: Metric[] = tilesOf(counts).map((tile): Metric => {
    const filter = tileFilter(tile.id, model.today)
    const value = tile.value === null ? (model.counts.status === 'loading' ? <Skeleton width={40} height={24} /> : '—') : String(tile.value)
    const accent = (tile.id === 'inailOpen' || tile.id === 'actionsOverdue') && (tile.value ?? 0) > 0 ? { accent: 'var(--nds-danger)' } : tile.id === 'hazardsOpen' && (tile.value ?? 0) > 0 ? { accent: 'var(--nds-warning)' } : {}
    return {
      label: t(`tile.${tile.id}.label`),
      value,
      hint: t(`tile.${tile.id}.hint`),
      ...accent,
      ...(filter ? { onClick: () => actions?.onTile?.(tile.id as TileId), active: tileActive(tile.id, model.address, model.today) } : {}),
    }
  })
  return (
    <section className="fw-inc-section" aria-labelledby="fw-inc-tiles">
      <h2 id="fw-inc-tiles" className="fw-inc-vh">
        {t('tile.title')}
      </h2>
      <MetricStrip metrics={metrics} minTileWidth={180} />
      {model.counts.status === 'loading' && <span className="fw-inc-slow">{t('common.stillLoading')}</span>}
      {model.counts.status === 'error' && <p className="fw-inc-warn">{t('tile.failed')}</p>}
    </section>
  )
}

/** The injury in words (body parts, side, nature): only what a protected read handed the page. */
export const injuryText = (t: Translate, person: IncidentPerson): string =>
  [person.bodyParts.map((part) => t(`bodyPart.${part}`)).join(', '), person.bodySide ? t(`side.${person.bodySide}`) : null, person.nature ? t(`nature.${person.nature}`) : null, person.firstAidGiven ? t('person.firstAid') : null, person.sentToHospital ? t('person.hospital') : null]
    .filter(Boolean)
    .join(' · ')

/** design sec:list — injuries, near misses and hazards, anonymised by default. */
function ListSection({ model, actions, onHelp }: { model: IncidentsPageModel; actions?: IncidentsPageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const ds = useDsWords()
  const when = useWhen()
  const { address, scope, can } = model
  const list = model.list.status === 'ready' ? model.list.value : null
  const rows = list?.rows ?? null
  const [query, setQuery] = useState(address.q ?? '')
  useEffect(() => setQuery(address.q ?? ''), [address.q])
  const selected = model.selected ?? []
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const shown = model.people.state === 'shown' ? model.people : null
  const peopleOf = (row: IncidentRow): readonly IncidentPerson[] => shown?.byIncident[row.id] ?? []

  const columns = useMemo<ColDef<IncidentRow>[]>(() => {
    const NumberCell = ({ data }: ICellRendererParams<IncidentRow>) =>
      data ? (
        <span className="fw-inc-cell">
          {/* ⌘-click opens the record in a new tab (design tab:record); Enter and a click open it here. */}
          <Link href={`${model.prefix}${INCIDENTS_PATH}/${encodeURIComponent(data.id)}`}>{data.number}</Link>
          {!data.seen && data.status === 'OPEN' ? <span className="fw-inc-muted">{t('row.notSeen')}</span> : null}
        </span>
      ) : null
    const InailCell = ({ data }: ICellRendererParams<IncidentRow>) => {
      if (!data || !data.inail.state) return <span className="fw-inc-muted">{data ? t('row.noFiling') : ''}</span>
      return (
        <span className="fw-inc-cell">
          <FilingStateTag state={data.inail.state} />
          {data.inail.countdown && (data.inail.state === 'DUE' || data.inail.state === 'OVERDUE') ? <DeadlineText countdown={data.inail.countdown} /> : null}
        </span>
      )
    }
    const siteColumn: ColDef<IncidentRow> = { colId: 'site', headerName: t('col.site'), minWidth: 140, flex: 1, valueGetter: (params) => (params.data ? params.data.site.name : '') }
    const built: ColDef<IncidentRow>[] = [
      { colId: 'number', headerName: t('col.number'), minWidth: 170, flex: 1, valueGetter: (params) => params.data?.number ?? '', cellRenderer: NumberCell },
      { colId: 'kind', headerName: t('col.kind'), minWidth: 130, flex: 1, valueGetter: (params) => (params.data ? t(`kind.${params.data.kind}`) : ''), cellRenderer: ({ data }: ICellRendererParams<IncidentRow>) => (data ? <KindTag kind={data.kind} /> : null) },
      { colId: 'occurredAt', headerName: t('col.occurredAt'), minWidth: 150, flex: 1, valueGetter: (params) => params.data?.occurredAt ?? '', valueFormatter: (params) => (params.data ? when.at(params.data.occurredAt) : '') },
      ...(scope.allSites ? [siteColumn] : []),
      { colId: 'where', headerName: t('col.where'), minWidth: 180, flex: 1.6, valueGetter: (params) => (params.data ? whereText(params.data) || '—' : '') },
      { colId: 'machine', headerName: t('col.machine'), minWidth: 120, flex: 1, valueGetter: (params) => params.data?.machine?.assetNumber ?? '—' },
      { colId: 'severity', headerName: t('col.severity'), minWidth: 130, flex: 1, valueGetter: (params) => (params.data ? t(`severity.${params.data.severity ?? 'UNKNOWN'}`) : ''), cellRenderer: ({ data }: ICellRendererParams<IncidentRow>) => (data ? <SeverityTag severity={data.severity} /> : null) },
      { colId: 'inail', headerName: t('col.inail'), minWidth: 190, flex: 1.4, valueGetter: (params) => (params.data?.inail.state ? t(`filingState.${params.data.inail.state}`) : ''), cellRenderer: InailCell },
      { colId: 'status', headerName: t('col.status'), minWidth: 110, flex: 1, valueGetter: (params) => (params.data ? t(`status.${params.data.status}`) : ''), cellRenderer: ({ data }: ICellRendererParams<IncidentRow>) => (data ? <StatusTag status={data.status} /> : null) },
      {
        colId: 'actions',
        headerName: t('col.actions'),
        minWidth: 120,
        flex: 1,
        valueGetter: (params) => params.data?.actionsOpen ?? 0,
        valueFormatter: (params) => (params.data ? (params.data.actionsOverdue > 0 ? t('row.actionsOverdue', { count: params.data.actionsOpen, overdue: params.data.actionsOverdue }) : String(params.data.actionsOpen)) : ''),
      },
    ]
    // design: "Person and injury columns only for safety and HR roles, behind a 'Show people' toggle that is recorded". Never in
    // an export (the export source has no such column) or a print.
    if (shown) {
      built.splice(3, 0, {
        colId: 'people',
        headerName: t('col.people'),
        minWidth: 200,
        flex: 1.6,
        valueGetter: (params) => (params.data ? peopleOf(params.data).map((person) => person.employee?.name ?? person.outsideName ?? '').join(', ') || t('row.nobody') : ''),
      })
      built.splice(4, 0, {
        colId: 'injury',
        headerName: t('col.injury'),
        minWidth: 220,
        flex: 1.6,
        valueGetter: (params) => (params.data ? peopleOf(params.data).filter((person) => person.involvement === 'INJURED').map((person) => injuryText(t, person)).filter(Boolean).join(' | ') || '—' : ''),
      })
    }
    return built
    // The words follow the language; the people their read.
  }, [t, when, scope.allSites, model.prefix, shown])

  const search = (
    <form
      className="fw-inc-search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault()
        actions?.onAddress?.({ q: query.trim() || null })
      }}
    >
      <Input size="sm" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('list.search')} aria-label={t('list.search')} />
    </form>
  )

  const tools = (
    <span className="fw-inc-tools">
      <Select size="sm" aria-label={t('list.rows')} value={address.rows ?? ''} onChange={(event) => actions?.onAddress?.({ rows: (event.target.value || null) as typeof address.rows })}>
        <option value="">{t('rows.all')}</option>
        {ROWS.map((row) => (
          <option key={row} value={row}>
            {t(`rows.${row}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" aria-label={t('list.status')} value={address.status ?? ''} onChange={(event) => actions?.onAddress?.({ status: (event.target.value || null) as typeof address.status })}>
        <option value="">{t('statusFilter.default')}</option>
        {STATUS_FILTERS.map((status) => (
          <option key={status} value={status}>
            {t(`statusFilter.${status}`)}
          </option>
        ))}
      </Select>
      {filtered(address) && (
        <Button size="sm" variant="quiet" onClick={() => actions?.onAddress?.({ rows: null, status: null, from: null, to: null, q: null })}>
          <X size={13} aria-hidden /> {t('list.clear')}
        </Button>
      )}
    </span>
  )

  const peopleHeld = can.people ? (rows && rows.length === 0 ? t('held.noRows') : null) : t('held.noPeople')
  const peopleToggle =
    model.people.state === 'shown' ? (
      <Button size="sm" onClick={() => actions?.onHidePeople?.()}>
        <EyeOff size={13} aria-hidden /> {t('people.hide')}
      </Button>
    ) : (
      <Button size="sm" heldReason={model.people.state === 'reading' ? t('people.reading') : peopleHeld} onClick={() => actions?.onAskPeople?.()}>
        <Eye size={13} aria-hidden /> {t('people.show')}
      </Button>
    )

  const head = (
    <SectionHead id="fw-inc-list-title" title={t('list.title')} note={t('list.note')}>
      {peopleToggle}
      <ScopeSiteChip model={scope} />
    </SectionHead>
  )

  const canSeen = can.manage
  const state =
    model.list.status === 'error' ? (
      <SectionFailed title={t('list.failed')} problem={model.list.problem} onRetry={actions?.onRetryList} />
    ) : rows && rows.length === 0 ? (
      filtered(address) ? (
        <EmptyState title={t('list.noneMatchTitle')} description={t('list.noneMatch')} />
      ) : (
        <EmptyState
          title={t('list.emptyTitle')}
          description={t('list.empty')}
          action={
            can.report && !model.reportHeld ? (
              <Button size="sm" variant="primary" onClick={() => actions?.onAddress?.({ report: true })}>
                {t('band.report')}
              </Button>
            ) : undefined
          }
        />
      )
    ) : undefined

  return (
    <section className="fw-inc-section" aria-labelledby="fw-inc-list-title" id="fw-inc-list" tabIndex={-1}>
      {head}
      {shown && (
        <PrivacyNote level="protected" variant="panel" recorded text={t('people.shownNote', { count: shown.count })} whoMore={t('people.who')} law={<PeopleLaw />} labels={ds.privacyNote} />
      )}
      {model.people.state === 'error' && <Banner tone="warning" title={t('people.failed')}>{t(model.people.problem)}</Banner>}
      <ListFrame<IncidentRow>
        label={t('list.label')}
        title={t('list.title')}
        listKey="plant.incidents"
        rows={model.list.status === 'loading' ? null : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('list.count', { count: rows.length }) : '—'}
        search={search}
        tools={tools}
        selection={{
          selected,
          onChange: (ids) => actions?.onSelected?.(ids),
          exportSelected: true,
          actions: canSeen ? (
            <Button
              size="sm"
              variant="primary"
              aria-label={t('bulk.seen', { count: picked.filter((row) => !row.seen).length })}
              heldReason={model.bulkBusy ? t('held.saving') : picked.every((row) => row.seen) ? t('held.allSeen') : null}
              onClick={() => {
                void actions?.onBulkSeen?.(picked.filter((row) => !row.seen))
              }}
            >
              <CheckCheck size={13} aria-hidden /> <SelectionLabel>{t('bulk.seen', { count: picked.filter((row) => !row.seen).length })}</SelectionLabel>
            </Button>
          ) : (
            <span className="fw-inc-muted">{t('bulk.exportOnly')}</span>
          ),
        }}
        keys={LIST_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onOpen?.(row)}
        more={list?.nextCursor ? { label: t('list.more'), onMore: () => actions?.onMore?.(), held: model.listMore ? t('list.moreReading') : null } : null}
        state={state}
        cards={{ fields: { number: { role: 'title' } } }}
        today={model.today}
      />
      {model.list.status === 'loading' && <span className="fw-inc-slow">{t('common.stillLoading')}</span>}
    </section>
  )
}

/** "Show people": said before anything is read (PrivacyNote), then one recorded read of this page's incidents. */
function PeopleConfirm({ model, actions }: { model: IncidentsPageModel; actions?: IncidentsPageActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const count = model.list.status === 'ready' ? Math.min(model.list.value.rows.length, 100) : 0
  return (
    <Modal
      open
      onClose={() => actions?.onHidePeople?.()}
      title={t('people.confirmTitle')}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onHidePeople?.()}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => actions?.onShowPeople?.()}>
            <Eye size={14} aria-hidden /> {t('people.confirm', { count })}
          </Button>
        </>
      }
    >
      <div className="fw-inc-stack">
        <PrivacyNote level="protected" variant="panel" recorded text={t('people.confirmNote')} whoMore={t('people.who')} law={<PeopleLaw />} labels={ds.privacyNote} />
        <p className="fw-inc-muted">{t('people.confirmBody', { count })}</p>
      </div>
    </Modal>
  )
}
