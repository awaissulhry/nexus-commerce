'use client'

import { useEffect, useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { FileClock, Search } from 'lucide-react'
import { Banner, Card, DetailPopover, EmptyState, KeyValue, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { IdentityCell, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { DetailModal } from '@nexus/ui/patterns'
import { Button, Input, SegmentedControl, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { useKeysHelp } from '../../kit/list'
import { FrameState } from '../../shared/view/parts'
import { AdminPageMessages } from '../../kit/messages'
import { AUDIT_SURFACES, type AuditEntry } from '../api'
import {
  ACTION_AREAS,
  AUDIT_PERIODS,
  changedRows,
  changeRows,
  deviceTimeDiffers,
  didKey,
  entryHref,
  fieldKey,
  fieldWords,
  filterCount,
  findOnPage,
  NO_FILTERS,
  paramsOf,
  RECORD_TYPES,
  recordHistoryFilters,
  recordHref,
  recordLabel,
  shortId,
  TILES,
  typeKey,
  whereOf,
  whoOf,
  withQuery,
  type AuditFilters,
  type AuditMode,
  type AuditViewModel,
  type Words,
} from '../model'
import '../../shared/admin.css'
import '../audit.css'

export type { AuditViewModel } from '../model'

export interface AuditActions {
  onFilters?: (filters: AuditFilters) => void
  onMode?: (mode: AuditMode) => void
  onFind?: (find: string) => void
  onOpen?: (id: string | null) => void
  onOlder?: () => void
  onRetry?: () => void
}

/** The field the `/` key focuses. */
export const FIND_ID = 'fw-adm-audit-find'

/**
 * SCR-018 — Admin › Audit log (design 02 admin.audit): every write as a sentence (Story, a feed) or a row (Table, the
 * Office's read-only list frame: the find field is its search, the filters its tools, "Show older" its footer, the keys
 * in its footer icon), the saved views as tiles, filters in the address, one entry in a centred DetailModal with every
 * field before → after, its context and the rows its request wrote. Fetches nothing (AuditPage.tsx reads the API).
 */
export function AuditView({ model, actions }: { model: AuditViewModel; actions?: AuditActions }) {
  return (
    <AdminPageMessages namespace="admin-audit">
      <Audit model={model} actions={actions} />
    </AdminPageMessages>
  )
}

/** The first key of `keys` this page has words for, else the fallback. */
function useWords() {
  const t = useT('admin-audit')
  const say = (words: Words) => t(words.key, words.params)
  /** Whether this page has words of its own for the action (else "changed", with the code shown beside it). */
  const knows = (entry: Pick<AuditEntry, 'action'>) => t(didKey(entry.action)) !== didKey(entry.action)
  const did = (entry: Pick<AuditEntry, 'action'>) => (knows(entry) ? t(didKey(entry.action)) : t('audit.did.other'))
  const type = (recordType: string) => {
    const key = typeKey(recordType)
    const text = t(key)
    return text === key ? recordType : text
  }
  const field = (name: string) => {
    const key = fieldKey(name)
    const text = t(key)
    return text === key ? fieldWords(name) : text
  }
  const who = (entry: AuditEntry) => say(whoOf(entry))
  const record = (entry: AuditEntry) => {
    const label = recordLabel(entry)
    return `${type(entry.recordType)} ${label ?? shortId(entry.recordId)}`
  }
  return { t, say, did, knows, type, field, who, record }
}

function Audit({ model, actions }: { model: AuditViewModel; actions?: AuditActions }) {
  const words = useWords()
  const { t } = words
  const ta = useT('admin')
  const locale = useLocale()
  const filters = model.filters
  const items = model.entries.items
  const shown = items ? findOnPage(items, model.find, (entry) => `${words.who(entry)} ${words.did(entry)} ${words.record(entry)} ${entry.reason ?? ''}`) : []

  // S switches Story and Table, / goes to the find field (00 §3.17), when no field or dialog has the focus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || model.open) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === '/') {
        event.preventDefault()
        document.getElementById(FIND_ID)?.focus()
      } else if (event.key === 's' || event.key === 'S') {
        event.preventDefault()
        actions?.onMode?.(model.mode === 'story' ? 'table' : 'story')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!model.canRead) {
    return (
      <div className="fw-adm">
        <Card padded>
          <EmptyState icon={<FileClock size={24} aria-hidden />} title={ta('record.forbiddenTitle')} description={t('audit.noAccess')} />
        </Card>
      </div>
    )
  }

  const find = (
    <Input
      id={FIND_ID}
      size="sm"
      fieldClassName="fw-adm-fill"
      type="search"
      leadingIcon={<Search size={14} aria-hidden />}
      aria-label={t('audit.find.label')}
      aria-keyshortcuts="/"
      placeholder={t('audit.find.placeholder')}
      value={model.find}
      onChange={(event) => actions?.onFind?.(event.target.value)}
    />
  )
  return (
    <div className="fw-adm fw-adm-audit">
      <div className="fw-adm-head">
        <div className="fw-adm-head-text">
          <p className="fw-adm-intro">{t('audit.intro')}</p>
          <span className="fw-adm-asof" role="status">
            {model.asOf ? <time dateTime={model.asOf}>{ta('list.updated', { time: formatTime(model.asOf, { locale }) })}</time> : ta('list.notYet')}
          </span>
        </div>
        <div className="fw-adm-actions">
          <Button size="sm" heldReason={t('audit.held.export')}>
            {t('audit.export')}
          </Button>
        </div>
      </div>

      <MetricStrip
        metrics={TILES.map((tile) => ({
          label: t(`audit.tile.${tile}`),
          value: model.counts ? String(model.counts[tile]) : '—',
          hint: t(`audit.tileHint.${tile}`),
          active: filters.view === tile,
          onClick: () => actions?.onFilters?.({ ...filters, view: filters.view === tile ? null : tile }),
        }))}
      />
      <p className="fw-adm-hint">{t('audit.tilesWindow')}</p>

      {model.mode === 'table' ? (
        <>
          {(filters.view || filters.recordId) && <Showing model={model} />}
          {model.hiddenGrains.length > 0 && <p className="fw-adm-hint">{t('audit.hidden', { grains: model.hiddenGrains.map((grain) => ta(`grains.short.${grain}`)).join(', ') })}</p>}
          <Table model={model} entries={shown} actions={actions} find={find} tools={<Filters model={model} actions={actions} compact />} />
        </>
      ) : (
        <>
          <div className="fw-adm-toolbar fw-adm-audit-toolbar">
            <ModeSwitch model={model} actions={actions} />
            <span className="fw-adm-toolbar-search">{find}</span>
          </div>
          <Filters model={model} actions={actions} />
          {(filters.view || filters.recordId) && <Showing model={model} />}
          {model.hiddenGrains.length > 0 && <p className="fw-adm-hint">{t('audit.hidden', { grains: model.hiddenGrains.map((grain) => ta(`grains.short.${grain}`)).join(', ') })}</p>}
          {model.entries.problem || items === null ? (
            <States problem={model.entries.problem} onRetry={actions?.onRetry} />
          ) : items.length === 0 ? (
            <Card padded>
              <NothingYet model={model} actions={actions} />
            </Card>
          ) : shown.length === 0 ? (
            <Card padded>
              <NoMatch actions={actions} />
            </Card>
          ) : (
            <Story model={model} entries={shown} total={items.length} />
          )}
          {items && items.length > 0 && (model.nextBefore || model.older?.problem) && (
            <div className="fw-adm-audit-older">
              {model.older?.problem && <Banner tone="danger" title={ta(model.older.problem)} />}
              <Button size="sm" onClick={() => actions?.onOlder?.()} heldReason={model.older?.loading ? t('audit.held.loading') : null}>
                {model.older?.loading && <Spinner size={14} />} {t('audit.older')}
              </Button>
            </div>
          )}
        </>
      )}
      {items && items.length > 0 && !model.nextBefore && !model.older?.problem && <p className="fw-adm-hint">{t('audit.end')}</p>}
      <p className="fw-adm-hint">{t('audit.later')}</p>

      <EntryModal model={model} entries={shown} actions={actions} />
    </div>
  )
}

/** Story or Table (S switches them). */
function ModeSwitch({ model, actions }: { model: AuditViewModel; actions?: AuditActions }) {
  const { t } = useWords()
  return (
    <SegmentedControl
      ariaLabel={t('audit.mode.label')}
      size="sm"
      value={model.mode}
      onChange={(value) => actions?.onMode?.(value as AuditMode)}
      options={[
        { value: 'story', label: t('audit.mode.story') },
        { value: 'table', label: t('audit.mode.table') },
      ]}
    />
  )
}

/**
 * The filters (who, where it came from, record type, area, company, period) and Clear: under the find field in the
 * Story; in the Table they are the frame's tools (with Story / Table first), each select named by its label.
 */
function Filters({ model, actions, compact = false }: { model: AuditViewModel; actions?: AuditActions; compact?: boolean }) {
  const words = useWords()
  const { t } = words
  const ta = useT('admin')
  const filters = model.filters
  const set = (next: Partial<AuditFilters>) => actions?.onFilters?.({ ...filters, ...next })
  const selects = (
    <>
      {model.people && (
        <FilterSelect compact={compact} label={t('audit.filter.who')} value={filters.actorId ?? ''} onChange={(value) => set({ actorId: value || null })} any={t('audit.filter.anyone')}>
          {model.people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </FilterSelect>
      )}
      <FilterSelect compact={compact} label={t('audit.filter.surface')} value={filters.audience ?? ''} onChange={(value) => set({ audience: (value || null) as AuditFilters['audience'] })} any={t('audit.filter.anySurface')}>
        {AUDIT_SURFACES.map((surface) => (
          <option key={surface} value={surface}>
            {t(`audit.surface.${surface}`)}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect compact={compact} label={t('audit.filter.type')} value={filters.recordType ?? ''} onChange={(value) => set({ recordType: value || null, recordId: null })} any={t('audit.filter.anyType')}>
        {[...new Set([...RECORD_TYPES, ...(filters.recordType ? [filters.recordType] : [])])].map((type) => (
          <option key={type} value={type}>
            {words.type(type)}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect compact={compact} label={t('audit.filter.area')} value={filters.area ?? ''} onChange={(value) => set({ area: (value || null) as AuditFilters['area'] })} any={t('audit.filter.anyArea')}>
        {ACTION_AREAS.map((area) => (
          <option key={area} value={area}>
            {t(`audit.area.${area}`)}
          </option>
        ))}
      </FilterSelect>
      {model.companies.length > 0 && (
        <FilterSelect compact={compact} label={t('audit.filter.company')} value={filters.companyId ?? ''} onChange={(value) => set({ companyId: value || null })} any={t('audit.filter.anyCompany')}>
          {model.companies.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </FilterSelect>
      )}
      <FilterSelect compact={compact} label={t('audit.filter.period')} value={filters.period} onChange={(value) => set({ period: value as AuditFilters['period'] })}>
        {AUDIT_PERIODS.map((period) => (
          <option key={period} value={period}>
            {t(`audit.period.${period}`)}
          </option>
        ))}
      </FilterSelect>
      {filterCount(filters) > 0 && (
        <Button size="sm" variant="quiet" onClick={() => actions?.onFilters?.(NO_FILTERS)}>
          {ta('list.clearFilters')}
        </Button>
      )}
    </>
  )
  if (compact)
    return (
      <>
        <ModeSwitch model={model} actions={actions} />
        {selects}
      </>
    )
  return (
    <div className="fw-adm-audit-filters" role="group" aria-label={t('audit.filter.label')}>
      {selects}
    </div>
  )
}

/** What the list is narrowed to beyond the filters: a saved view, one record's history. */
function Showing({ model }: { model: AuditViewModel }) {
  const words = useWords()
  const { t } = words
  const filters = model.filters
  return (
    <span className="fw-adm-tags">
      {filters.view && <Tag tone="info">{t('audit.showing.view', { view: t(`audit.tile.${filters.view}`) })}</Tag>}
      {filters.recordId && <Tag tone="info">{t('audit.showing.record', { record: `${filters.recordType ? words.type(filters.recordType) : ''} ${model.recordWords ?? shortId(filters.recordId)}`.trim() })}</Tag>}
    </span>
  )
}

function NothingYet({ model, actions }: { model: AuditViewModel; actions?: AuditActions }) {
  const { t } = useWords()
  const ta = useT('admin')
  const narrowed = filterCount(model.filters) > 0
  return (
    <EmptyState
      icon={<FileClock size={24} aria-hidden />}
      title={narrowed ? t('audit.empty.filteredTitle') : t('audit.empty.title')}
      description={narrowed ? t('audit.empty.filteredBody') : t('audit.empty.body')}
      action={
        narrowed ? (
          <Button size="sm" onClick={() => actions?.onFilters?.(NO_FILTERS)}>
            {ta('list.clearFilters')}
          </Button>
        ) : undefined
      }
    />
  )
}

function NoMatch({ actions }: { actions?: AuditActions }) {
  const { t } = useWords()
  const ta = useT('admin')
  return (
    <EmptyState
      title={ta('list.noMatch')}
      description={t('audit.find.none')}
      action={
        <Button size="sm" onClick={() => actions?.onFind?.('')}>
          {ta('list.clearSearch')}
        </Button>
      }
    />
  )
}

function FilterSelect({ label, value, onChange, any, children, compact = false }: { label: string; value: string; onChange: (value: string) => void; any?: string; children?: ReactNode; compact?: boolean }) {
  if (compact)
    return (
      <Select size="sm" aria-label={label} title={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {any !== undefined && <option value="">{any}</option>}
        {children}
      </Select>
    )
  return (
    <label className="fw-adm-audit-filter">
      <span className="fw-adm-audit-filter-label">{label}</span>
      <Select size="sm" value={value} onChange={(event) => onChange(event.target.value)}>
        {any !== undefined && <option value="">{any}</option>}
        {children}
      </Select>
    </label>
  )
}

function States({ problem, onRetry }: { problem?: string | null; onRetry?: () => void }) {
  const ta = useT('admin')
  if (problem) {
    return (
      <Card padded>
        <EmptyState
          title={ta('list.failedTitle')}
          description={ta(problem)}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {ta('common.retry')}
            </Button>
          }
        />
      </Card>
    )
  }
  return (
    <Card padded aria-busy="true">
      <p className="fw-adm-loading" role="status">
        <Spinner size={14} /> {ta('list.loading')}
      </p>
    </Card>
  )
}

/** "Which time is this?" (design popover `time`). */
function TimeHelp() {
  const { t } = useWords()
  return (
    <DetailPopover trigger={<span className="fw-adm-audit-timehelp">{t('audit.time.which')}</span>} triggerLabel={t('audit.time.which')} label={t('audit.time.title')} hoverDelay={0}>
      <div className="fw-adm-audit-popover">
        <p>{t('audit.time.server')}</p>
        <p>{t('audit.time.floor')}</p>
      </div>
    </DetailPopover>
  )
}

function Story({ model, entries, total }: { model: AuditViewModel; entries: readonly AuditEntry[]; total: number }) {
  const words = useWords()
  const { t } = words
  const locale = useLocale()
  const days: Array<{ day: string; entries: AuditEntry[] }> = []
  for (const entry of entries) {
    const day = formatDate(entry.at, { locale })
    const last = days[days.length - 1]
    if (last && last.day === day) last.entries.push(entry)
    else days.push({ day, entries: [entry] })
  }
  return (
    <Card className="fw-adm-tablecard">
      <div className="fw-adm-audit-countline">
        <p className="fw-adm-count" role="status">
          {t('audit.count', { shown: entries.length, total })}
        </p>
        <TimeHelp />
      </div>
      <div className="fw-adm-audit-story">
        {days.map((group) => (
          <section key={group.day} aria-label={group.day}>
            <h3 className="fw-adm-audit-day">{group.day}</h3>
            <ol className="fw-adm-audit-lines">
              {group.entries.map((entry) => {
                const href = recordHref(model.prefix, entry)
                return (
                  <li key={entry.id} className="fw-adm-audit-line">
                    <span className="fw-adm-audit-sentence">
                      <Link className="fw-adm-name" href={entryHref(model.prefix, model, entry.id)}>
                        {words.who(entry)} {words.did(entry)}
                      </Link>{' '}
                      {href ? (
                        <Link className="fw-adm-audit-record" href={href}>
                          {words.record(entry)}
                        </Link>
                      ) : (
                        <span className="fw-adm-audit-record">{words.record(entry)}</span>
                      )}
                    </span>
                    <span className="fw-adm-audit-meta">
                      <Time entry={entry} /> · {t(`audit.surface.${entry.audience}`)}
                      {entry.reason && (
                        <>
                          {' · '}
                          {t('audit.why', { reason: entry.reason })}
                        </>
                      )}
                    </span>
                  </li>
                )
              })}
            </ol>
          </section>
        ))}
      </div>
    </Card>
  )
}

/** The server's time in the viewer's zone; the device's too when the floor recorded a different one (PLT-084). */
function Time({ entry, full = false }: { entry: AuditEntry; full?: boolean }) {
  const { t } = useWords()
  const locale = useLocale()
  const text = (value: string) => (full ? formatDateTime(value, { locale }) : formatTime(value, { locale }))
  return (
    <>
      <time dateTime={entry.at}>{text(entry.at)}</time>
      {deviceTimeDiffers(entry) && entry.deviceTime && <span className="fw-adm-audit-device"> {t('audit.deviceTime', { time: text(entry.deviceTime) })}</span>}
    </>
  )
}

/** What changed, in a cell of two lines: the first field from → to, then the next one or how many more. */
export function ChangedCell({ entry }: { entry: AuditEntry }) {
  const words = useWords()
  const rows = changedRows(entry.before, entry.after)
  if (rows.length === 0) return <span className="fw-adm-hint">{words.t('audit.change.none')}</span>
  const line = (row: (typeof rows)[number]) => words.t('audit.change.row', { field: words.field(row.field), from: row.from ?? '—', to: row.to ?? '—' })
  return (
    <span className="fw-adm-two">
      <span className="fw-adm-audit-change" title={line(rows[0]!)}>
        {line(rows[0]!)}
      </span>
      {rows.length === 2 ? (
        <span className="fw-adm-audit-change" title={line(rows[1]!)}>
          {line(rows[1]!)}
        </span>
      ) : rows.length > 2 ? (
        <span className="fw-adm-hint">{words.t('audit.change.more', { count: rows.length - 1 })}</span>
      ) : null}
    </span>
  )
}

/** When (a link that opens the entry; the tablet's own time under it when it differs) and, for a screen reader, what. */
export function TimeCell({ model, entry }: { model: Pick<AuditViewModel, 'prefix' | 'filters' | 'mode'>; entry: AuditEntry }) {
  const words = useWords()
  const locale = useLocale()
  const when = formatDateTime(entry.at, { locale })
  return (
    <IdentityCell
      noImage
      href={entryHref(model.prefix, model, entry.id)}
      title={
        <>
          {when}
          <span className="fw-adm-sr"> — {words.t('audit.openEntry', { what: `${words.who(entry)} ${words.did(entry)}` })}</span>
        </>
      }
      titleAttr={when}
      sub={deviceTimeDiffers(entry) && entry.deviceTime ? <span>{words.t('audit.deviceTime', { time: formatDateTime(entry.deviceTime, { locale }) })}</span> : undefined}
    />
  )
}

/** The action in words; one this page has no words for says "changed" with its code under it. */
export function ActionCell({ entry }: { entry: AuditEntry }) {
  const words = useWords()
  if (words.knows(entry)) return <>{words.did(entry)}</>
  return (
    <span className="fw-adm-two">
      <span>{words.did(entry)}</span>
      <code className="fw-adm-code">{entry.action}</code>
    </span>
  )
}

/** The Table's columns (one entry per row, newest first). */
export function useAuditColumns(model: Pick<AuditViewModel, 'prefix' | 'filters' | 'mode' | 'companies'>): ColDef<AuditEntry>[] {
  const words = useWords()
  const { t } = words
  const { prefix, filters, mode, companies } = model
  // The page reads the filters from the address on each render: their content, not their identity, is the dependency.
  const filtersKey = JSON.stringify(filters)
  return useMemo<ColDef<AuditEntry>[]>(() => {
    const at = { prefix, filters, mode }
    return [
      { colId: 'time', headerName: t('audit.col.time'), flex: 1.2, minWidth: 160, cellRenderer: ({ data }: ICellRendererParams<AuditEntry>) => (data ? <TimeCell model={at} entry={data} /> : null) },
      { colId: 'who', headerName: t('audit.col.who'), flex: 1.2, minWidth: 140, valueGetter: ({ data }) => (data ? words.who(data) : ''), tooltipValueGetter: ({ value }) => value as string },
      { colId: 'where', headerName: t('audit.col.where'), flex: 1.2, minWidth: 140, valueGetter: ({ data }) => (data ? (whereOf(data, companies) ?? '—') : ''), tooltipValueGetter: ({ value }) => value as string },
      { colId: 'surface', headerName: t('audit.col.surface'), flex: 0.7, minWidth: 90, valueGetter: ({ data }) => (data ? t(`audit.surface.${data.audience}`) : '') },
      { colId: 'action', headerName: t('audit.col.action'), flex: 1.3, minWidth: 150, cellRenderer: ({ data }: ICellRendererParams<AuditEntry>) => (data ? <ActionCell entry={data} /> : null) },
      {
        colId: 'record',
        headerName: t('audit.col.record'),
        flex: 1.3,
        minWidth: 160,
        cellRenderer: ({ data }: ICellRendererParams<AuditEntry>) => {
          if (!data) return null
          const href = recordHref(prefix, data)
          return href ? (
            <Link className="fw-adm-name" href={href}>
              {words.record(data)}
            </Link>
          ) : (
            words.record(data)
          )
        },
      },
      { colId: 'changed', headerName: t('audit.col.changed'), flex: 1.8, minWidth: 220, cellRenderer: ({ data }: ICellRendererParams<AuditEntry>) => (data ? <ChangedCell entry={data} /> : null) },
      { colId: 'why', headerName: t('audit.col.why'), flex: 1, minWidth: 120, valueGetter: ({ data }) => (data ? (data.reason ?? '—') : ''), tooltipValueGetter: ({ value }) => value as string },
    ]
    // `words` reads `t`; it is rebuilt with it. `filters` changes with `filtersKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, prefix, filtersKey, mode, companies])
}

/** The Table: the Office's read-only list frame (search = the find field, tools = Story / Table and the filters). */
function Table({ model, entries, actions, find, tools }: { model: AuditViewModel; entries: readonly AuditEntry[]; actions?: AuditActions; find: ReactNode; tools: ReactNode }) {
  const words = useWords()
  const { t } = words
  const ta = useT('admin')
  const columns = useAuditColumns(model)
  const own: ListKey[] = [{ keys: ['s'], does: t('audit.keys.mode') }]
  const { onHelp, help } = useKeysHelp(own, false)
  const items = model.entries.items
  const state: ReactNode = model.entries.problem ? (
    <FrameState problem={model.entries.problem} onRetry={actions?.onRetry} />
  ) : items && items.length === 0 ? (
    <NothingYet model={model} actions={actions} />
  ) : items && entries.length === 0 ? (
    <NoMatch actions={actions} />
  ) : undefined
  const older = items && items.length > 0 && (model.nextBefore || model.older?.problem)
  return (
    <>
      <ListFrame<AuditEntry>
        label={t('audit.tableLabel')}
        rows={model.entries.problem ? [] : items === null ? null : entries}
        rowId={(entry) => entry.id}
        columns={columns}
        count={items ? t('audit.count', { shown: entries.length, total: items.length }) : '—'}
        search={find}
        tools={tools}
        right={<TimeHelp />}
        more={older ? { label: t('audit.older'), onMore: () => actions?.onOlder?.(), held: model.older?.loading ? t('audit.held.loading') : null } : null}
        keys={own}
        onHelp={onHelp}
        onOpen={(entry) => actions?.onOpen?.(entry.id)}
        state={state}
      />
      {model.older?.problem && <Banner tone="danger" title={ta(model.older.problem)} />}
      {help}
    </>
  )
}

function EntryModal({ model, entries, actions }: { model: AuditViewModel; entries: readonly AuditEntry[]; actions?: AuditActions }) {
  const words = useWords()
  const { t } = words
  const locale = useLocale()
  const open = model.open
  const entry = open?.entry ?? null
  const href = entry ? recordHref(model.prefix, entry) : null
  const ids = entries.map((item) => item.id)
  return (
    <DetailModal
      open={!!open}
      onClose={() => actions?.onOpen?.(null)}
      title={entry ? `${words.who(entry)} ${words.did(entry)}` : t('audit.entry.title')}
      subtitle={entry ? `${words.record(entry)} · ${formatDateTime(entry.at, { locale })}` : undefined}
      meta={
        entry ? (
          <>
            <Tag>{t(`audit.surface.${entry.audience}`)}</Tag>
            <Tag>{words.type(entry.recordType)}</Tag>
          </>
        ) : undefined
      }
      actions={
        entry ? (
          <>
            <Button size="sm" asChild>
              <Link href={withQuery(`${model.prefix}/admin/audit`, paramsOf(recordHistoryFilters(entry), model.mode))}>{t('audit.entry.history')}</Link>
            </Button>
            {href ? (
              <Button size="sm" variant="primary" asChild>
                <Link href={href}>{t('audit.entry.openRecord')}</Link>
              </Button>
            ) : (
              <Button size="sm" variant="primary" heldReason={t('audit.held.noPage', { type: words.type(entry.recordType) })}>
                {t('audit.entry.openRecord')}
              </Button>
            )}
          </>
        ) : undefined
      }
      nav={open && entry && ids.includes(open.id) ? { ids, current: open.id, onGo: (id) => actions?.onOpen?.(id), noun: t('audit.entry.noun') } : undefined}
    >
      {!open ? null : !entry ? (
        <Banner tone="info" title={t('audit.entry.notShownTitle')}>
          {t('audit.entry.notShownBody')}
        </Banner>
      ) : (
        <EntryDetail model={model} entry={entry} />
      )}
    </DetailModal>
  )
}

/**
 * The body of an open entry (exported for the tests: the DetailModal draws its body only in the browser): every field
 * before → after, why, how and where (with both times), and the other rows the same request wrote.
 */
export function EntryDetail({ model, entry }: { model: AuditViewModel; entry: AuditEntry }) {
  const words = useWords()
  const { t } = words
  const ta = useT('admin')
  const locale = useLocale()
  const open = model.open
  const siblings = open?.siblings.items?.filter((item) => item.id !== entry.id) ?? null
  return (
    <div className="fw-adm-modal-body fw-adm-audit-entry">
      <section aria-labelledby="fw-adm-audit-changes">
        <h3 id="fw-adm-audit-changes" className="fw-adm-audit-heading">
          {t('audit.entry.changes')}
        </h3>
        <ChangeTable entry={entry} />
        {model.hiddenGrains.length > 0 && <p className="fw-adm-hint">{t('audit.hidden', { grains: model.hiddenGrains.map((grain) => ta(`grains.short.${grain}`)).join(', ') })}</p>}
      </section>
      <section aria-labelledby="fw-adm-audit-why">
        <h3 id="fw-adm-audit-why" className="fw-adm-audit-heading">
          {t('audit.entry.why')}
        </h3>
        <p>{entry.reason ?? t('audit.entry.noReason')}</p>
      </section>
      <section aria-labelledby="fw-adm-audit-context">
        <h3 id="fw-adm-audit-context" className="fw-adm-audit-heading">
          {t('audit.entry.context')} · <TimeHelp />
        </h3>
        <KeyValue
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('audit.ctx.who'), value: words.who(entry) },
            { label: t('audit.ctx.where'), value: whereOf(entry, model.companies) ?? '—' },
            { label: t('audit.ctx.serverTime'), value: formatDateTime(entry.at, { locale }), hint: t('audit.ctx.utc', { time: entry.at }) },
            { label: t('audit.ctx.deviceTime'), value: entry.deviceTime ? formatDateTime(entry.deviceTime, { locale }) : '—', hint: entry.deviceTime ? t('audit.ctx.utc', { time: entry.deviceTime }) : undefined },
            { label: t('audit.ctx.device'), value: entry.deviceName ?? '—' },
            { label: t('audit.ctx.surface'), value: t(`audit.surface.${entry.audience}`) },
            { label: t('audit.ctx.action'), value: <code className="fw-adm-code">{entry.action}</code> },
            { label: t('audit.ctx.record'), value: <code className="fw-adm-code">{`${entry.recordType} ${entry.recordId}`}</code> },
            { label: t('audit.ctx.request'), value: <code className="fw-adm-code">{entry.requestId}</code> },
            { label: t('audit.ctx.key'), value: entry.idempotencyKey ? <code className="fw-adm-code">{entry.idempotencyKey}</code> : '—', hint: t('audit.ctx.keyHint') },
          ]}
        />
        <p className="fw-adm-hint">{t('audit.ctx.ip')}</p>
      </section>
      <section aria-labelledby="fw-adm-audit-same">
        <h3 id="fw-adm-audit-same" className="fw-adm-audit-heading">
          {t('audit.entry.same')}
        </h3>
        {open?.siblings.problem ? (
          <Banner tone="danger" title={ta(open.siblings.problem)} />
        ) : siblings === null ? (
          <p className="fw-adm-loading" role="status">
            <Spinner size={14} /> {ta('list.loading')}
          </p>
        ) : siblings.length === 0 ? (
          <p className="fw-adm-hint">{t('audit.entry.sameNone')}</p>
        ) : (
          <ul className="fw-adm-audit-lines">
            {siblings.map((item) => (
              <li key={item.id} className="fw-adm-audit-line">
                <Link className="fw-adm-name" href={entryHref(model.prefix, model, item.id)}>
                  {words.did(item)} {words.record(item)}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function ChangeTable({ entry }: { entry: AuditEntry }) {
  const words = useWords()
  const { t } = words
  const rows = changeRows(entry.before, entry.after)
  if (rows.length === 0) return <p className="fw-adm-hint">{t('audit.entry.noFields')}</p>
  return (
    <SummaryTable
      label={t('audit.entry.changesLabel')}
      columns={[t('audit.col.field'), t('audit.col.before'), t('audit.col.after')]}
      widths={['30%', '35%', '35%']}
      align={['left', 'left', 'left']}
      density="roomy"
      stackOnPhone
      rows={rows.map((row) => ({
        id: row.field,
        cells: [
          <span key="field" className="fw-adm-cell-row">
            {words.field(row.field)}
            {row.changed && <Tag tone="info">{t('audit.entry.changed')}</Tag>}
          </span>,
          <span key="from" className="fw-adm-audit-value">
            {row.from ?? '—'}
          </span>,
          <span key="to" className="fw-adm-audit-value">
            {row.to ?? '—'}
          </span>,
        ],
      }))}
    />
  )
}
