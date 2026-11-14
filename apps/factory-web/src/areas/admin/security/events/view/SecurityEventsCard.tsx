'use client'

import { useMemo, useState } from 'react'
import { Search, ShieldAlert } from 'lucide-react'
import { Banner, Card, KeyValue } from '@nexus/ui/components'
import { type ColDef } from '@nexus/ui/grid'
import { Button, Input, Pill, SegmentedControl, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { DetailModal } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Translate } from '../../../../../lib/i18n/messages'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { countryName } from '../../../../me/sessions/model'
import { cellOf } from '../../../shared/view/cells'
import { FrameState, ListKeysHelp } from '../../../shared/view/parts'
import { permissionKey } from '../../../shared/view/PermissionMatrix'
import { SECURITY_SURFACES, type SecurityEvent } from '../api'
import { detailLines, filterCount, looksLikeAddress, NO_EVENT_FILTERS, RESULT_TONE, summaryOf, whoWords, type EventFilters } from '../model'
import '../../sessions/security-depth.css'

export interface SecurityEventsModel {
  filters: EventFilters
  /** Null while the first page reads. */
  events: readonly SecurityEvent[] | null
  problem: string | null
  nextBefore: string | null
  older: { loading: boolean; problem: string | null }
  /** The open event (`?event=`): read alone with the others from the same address. */
  open: { id: string; event: SecurityEvent | null; related: readonly SecurityEvent[] | null; problem: string | null } | null
}

export interface SecurityEventsActions {
  onFilters?: (filters: EventFilters) => void
  onOpen?: (eventId: string | null) => void
  onOlder?: () => void
  onRetry?: () => void
}

function useEventWords() {
  const t = useT('admin-security-depth')
  const ta = useT('admin')
  const locale = useLocale()
  return useMemo(() => {
    const permission = (name: string) => {
      const key = permissionKey(name)
      const words = ta(key)
      return words === key ? name : words
    }
    const time = (iso: string) => formatDateTime(iso, { locale })
    const country = (code: string | null) => (code ? countryName(code, locale) : t('events.country.unknown'))
    return { t, ta, permission, time, country }
  }, [t, ta, locale])
}

/** The events' columns (exported: a test draws each cell alone). */
export function eventColumns(words: { t: Translate; permission: (name: string) => string; time: (iso: string) => string; country: (code: string | null) => string }): ColDef<SecurityEvent>[] {
  const { t } = words
  return [
    { colId: 'at', headerName: t('events.col.time'), valueGetter: ({ data }) => data?.at ?? '', width: 170, cellRenderer: cellOf<SecurityEvent>((event) => words.time(event.at)) },
    {
      colId: 'kind',
      headerName: t('events.col.event'),
      valueGetter: ({ data }) => (data ? t(`events.kind.${data.kind}`) : ''),
      flex: 1.6,
      minWidth: 220,
      cellRenderer: cellOf<SecurityEvent>((event) => {
        const summary = summaryOf(event, t, words.permission)
        return (
          <span className="fw-sec-depth-row">
            <span className="fw-adm-name">{t(`events.kind.${event.kind}`)}</span>
            {summary && <span className="fw-adm-hint">{summary}</span>}
          </span>
        )
      }),
    },
    { colId: 'who', headerName: t('events.col.who'), valueGetter: ({ data }) => (data ? whoWords(data, t) : ''), flex: 1, minWidth: 160 },
    { colId: 'surface', headerName: t('events.col.surface'), valueGetter: ({ data }) => (data ? t(`events.surface.${data.surface}`) : ''), width: 120 },
    { colId: 'country', headerName: t('events.col.country'), valueGetter: ({ data }) => (data ? words.country(data.ipCountry) : ''), width: 150 },
    {
      colId: 'result',
      headerName: t('events.col.result'),
      valueGetter: ({ data }) => (data ? t(`events.result.${data.result}`) : ''),
      width: 130,
      cellRenderer: cellOf<SecurityEvent>((event) => <Pill tone={RESULT_TONE[event.result]}>{t(`events.result.${event.result}`)}</Pill>),
    },
  ]
}

/**
 * Admin › Security › Security events (SCR-166 section `events`, B-W2b-413; PLT-075): failed sign-ins, lockouts, two-factor
 * changes, refusals, role changes, exports — time, the event in words, who (or "unknown"), the address's country, the result
 * — in the Office list frame (listKey `admin.security`: its Export ▾ is "Download security events (CSV)", the address's terms
 * are the export's), saved filters All · Failed sign-ins · Exports, the surface, an address typed; a row opens the event
 * (pop:event, J / K) with the other events from the same address. Rows only. Fetches nothing.
 */
export function SecurityEventsCard({ model, actions }: { model: SecurityEventsModel; actions?: SecurityEventsActions }) {
  const words = useEventWords()
  const { t } = words
  const [help, setHelp] = useState(false)
  const [typed, setTyped] = useState(model.filters.ip ?? '')
  const columns = useMemo(() => eventColumns(words), [words])
  const filters = model.filters
  const set = (patch: Partial<EventFilters>) => actions?.onFilters?.({ ...filters, ...patch })
  const applyAddress = () => {
    const value = typed.trim()
    if (value === '' || looksLikeAddress(value)) set({ ip: value === '' ? null : value })
  }
  const badAddress = typed.trim() !== '' && !looksLikeAddress(typed)
  const events = model.events
  const state = model.problem ? (
    <FrameState problem={model.problem} onRetry={actions?.onRetry} />
  ) : events && events.length === 0 ? (
    filterCount(filters) > 0 ? (
      <FrameState noMatch={{ onClear: () => actions?.onFilters?.(NO_EVENT_FILTERS), clearLabel: t('events.clear') }} />
    ) : (
      <FrameState empty={{ icon: <ShieldAlert size={24} aria-hidden />, title: t('events.empty.title'), body: t('events.empty.body') }} />
    )
  ) : undefined
  return (
    <section id="events" aria-labelledby="sec-events" className="fw-sec-section">
      <Card header={<span id="sec-events">{t('events.title')}</span>} description={t('events.hint')} headingLevel={2} padded>
        <div className="fw-sec-depth-stack">
          <ListFrame<SecurityEvent>
            label={t('events.title')}
            listKey="admin.security"
            title={t('events.title')}
            rows={model.problem ? [] : events}
            rowId={(event) => event.id}
            columns={columns}
            count={events ? t('events.count', { count: events.length }) : '—'}
            search={
              <Input
                size="sm"
                type="search"
                fieldClassName="fw-adm-fill"
                leadingIcon={<Search size={14} aria-hidden />}
                aria-label={t('events.ip.label')}
                aria-invalid={badAddress || undefined}
                title={badAddress ? t('events.ip.bad') : undefined}
                placeholder={t('events.ip.placeholder')}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') applyAddress()
                }}
                onBlur={applyAddress}
              />
            }
            tools={
              <span className="fw-sec-depth-tools">
                <SegmentedControl
                  ariaLabel={t('events.view.label')}
                  size="sm"
                  value={filters.view ?? 'all'}
                  onChange={(value) => set({ view: value === 'all' ? null : (value as EventFilters['view']) })}
                  options={(['all', 'failed-sign-ins', 'exports'] as const).map((value) => ({ value, label: t(`events.view.${value}`) }))}
                />
                <Select size="sm" aria-label={t('events.surface.label')} title={t('events.surface.label')} value={filters.surface ?? ''} onChange={(event) => set({ surface: (event.target.value || null) as EventFilters['surface'] })}>
                  <option value="">{t('events.surface.any')}</option>
                  {SECURITY_SURFACES.map((surface) => (
                    <option key={surface} value={surface}>
                      {t(`events.surface.${surface}`)}
                    </option>
                  ))}
                </Select>
                {filterCount(filters) > 0 && (
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => {
                      setTyped('')
                      actions?.onFilters?.(NO_EVENT_FILTERS)
                    }}
                  >
                    {t('events.clear')}
                  </Button>
                )}
              </span>
            }
            more={events && events.length > 0 && model.nextBefore ? { label: t('events.older'), onMore: () => actions?.onOlder?.(), held: model.older.loading ? t('events.held.older') : null } : null}
            onHelp={() => setHelp(true)}
            onOpen={(event) => actions?.onOpen?.(event.id)}
            state={state}
          />
          {badAddress && <p className="fw-adm-hint">{t('events.ip.bad')}</p>}
          {model.older.problem && <Banner tone="danger" title={words.ta(model.older.problem)} />}
          <p className="fw-adm-hint">{t('events.rows')}</p>
        </div>
      </Card>
      <EventModal model={model} actions={actions} />
      <ListKeysHelp open={help} onClose={() => setHelp(false)} keys={[]} selection={false} />
    </section>
  )
}

/** pop:event — one event in full and the others from the same address (J / K moves through the rows read). */
function EventModal({ model, actions }: { model: SecurityEventsModel; actions?: SecurityEventsActions }) {
  const words = useEventWords()
  const { t } = words
  const open = model.open
  const event = open?.event ?? null
  const ids = (model.events ?? []).map((row) => row.id)
  return (
    <DetailModal
      open={!!open}
      onClose={() => actions?.onOpen?.(null)}
      title={event ? t(`events.kind.${event.kind}`) : t('events.one.title')}
      subtitle={event ? `${whoWords(event, t)} · ${words.time(event.at)}` : undefined}
      meta={
        event ? (
          <>
            <Tag>{t(`events.surface.${event.surface}`)}</Tag>
            <Pill tone={RESULT_TONE[event.result]}>{t(`events.result.${event.result}`)}</Pill>
          </>
        ) : undefined
      }
      nav={open && ids.includes(open.id) ? { ids, current: open.id, onGo: (id) => actions?.onOpen?.(id), noun: t('events.one.noun') } : undefined}
    >
      {!open ? null : open.problem ? (
        <Banner tone="danger" title={words.ta(open.problem)} />
      ) : !event ? (
        <p className="fw-adm-loading" role="status">
          <Spinner size={14} /> {t('session.stillLoading')}
        </p>
      ) : (
        <EventDetail event={event} related={open.related} onOpen={(id) => actions?.onOpen?.(id)} />
      )}
    </DetailModal>
  )
}

/** The body of an open event (exported for the tests: the DetailModal draws its body only in the browser). */
export function EventDetail({ event, related, onOpen }: { event: SecurityEvent; related: readonly SecurityEvent[] | null; onOpen?: (eventId: string) => void }) {
  const words = useEventWords()
  const { t } = words
  const lines = detailLines(event.details, t, words)
  return (
    <div className="fw-adm-modal-body fw-sec-depth-stack">
      <KeyValue
        columns={2}
        labelCase="sentence"
        items={[
          { label: t('events.col.time'), value: words.time(event.at), hint: t('events.one.utc', { time: event.at }) },
          { label: t('events.col.who'), value: whoWords(event, t), hint: event.actor.kind === 'WORKER' ? t('events.one.workerHint') : undefined },
          { label: t('events.col.surface'), value: t(`events.surface.${event.surface}`) },
          { label: t('events.col.result'), value: t(`events.result.${event.result}`) },
          { label: t('events.col.country'), value: words.country(event.ipCountry), hint: t('events.one.countryHint') },
          { label: t('events.one.record'), value: event.record ? <code className="fw-adm-code">{`${event.record.type} ${event.record.id}`}</code> : '—' },
          ...lines.map((line) => ({ label: line.label, value: line.key === 'route' || line.key === 'listKey' ? <code className="fw-adm-code">{line.value}</code> : line.value })),
        ]}
      />
      <section aria-labelledby="fw-sec-related" className="fw-sec-depth-block">
        <h3 id="fw-sec-related" className="fw-sec-sub">
          {t('events.one.related')}
        </h3>
        <p className="fw-adm-hint">{t('events.one.relatedHint')}</p>
        {related === null ? (
          <p className="fw-adm-loading" role="status">
            <Spinner size={14} /> {t('session.stillLoading')}
          </p>
        ) : related.length === 0 ? (
          <p className="fw-adm-hint">{t('events.one.relatedNone')}</p>
        ) : (
          <ul className="fw-sec-depth-list">
            {related.map((other) => (
              <li key={other.id} className="fw-sec-depth-row">
                <Button size="sm" variant="quiet" onClick={() => onOpen?.(other.id)}>
                  {t(`events.kind.${other.kind}`)}
                </Button>
                <span>{whoWords(other, t)}</span>
                <span className="fw-adm-hint">{words.time(other.at)}</span>
                <Pill tone={RESULT_TONE[other.result]}>{t(`events.result.${other.result}`)}</Pill>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
