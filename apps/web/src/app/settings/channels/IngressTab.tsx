'use client'

/**
 * P2.8 — the Ingress tab: every inbound event, by channel and status, with retry and
 * replay.
 *
 * Until P2.1 there was nothing worth a screen. Shopify had never recorded an event at
 * all, eBay had no subscription, Etsy had no receiver, and a failed event sat at
 * `failed` for ever because nothing retried it. The Diagnostics tab's inbound list
 * could show three states derived from a boolean — yes / pending / failed — which
 * cannot tell a DEAD LETTER from an event that will be tried again in four minutes.
 * Those are the two rows an operator most needs to tell apart, because one of them
 * needs a person and the other does not.
 *
 * Composed entirely from design-system parts: `MetricStrip`, `FilterChip`, `Listbox`,
 * `Card`, `Banner`, `Button`, and the shared `InboundGrid` the Diagnostics tab already
 * uses — so the two screens cannot disagree about what a status means.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, Banner, Field, Listbox, MetricStrip, EmptyState } from '@/design-system/components'
import { Button, FilterChip, Skeleton } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { InboundGrid, inboundStatusOf, type InboundRow, type InboundStatus } from './ChannelEventsGrid'

const STATUSES: Array<{ id: InboundStatus; label: string; hint: string }> = [
  { id: 'dlq', label: 'Dead letters', hint: 'Out of attempts. Nothing will try these again.' },
  { id: 'failed', label: 'Will retry', hint: 'Failed and scheduled for another attempt.' },
  { id: 'pending', label: 'Pending', hint: 'Arrived, not finished.' },
  { id: 'done', label: 'Done', hint: 'Handled.' },
]

const WINDOWS = [
  { value: '24', label: 'Last 24 hours' },
  { value: '72', label: 'Last 3 days' },
  { value: '168', label: 'Last 7 days' },
  { value: '720', label: 'Last 30 days' },
]

interface Totals {
  byChannel: Array<{ channel: string; count: number }>
  byStatus?: Array<{ status: string; count: number }>
}

export function IngressTab() {
  const api = getBackendUrl()
  const [channel, setChannel] = useState<string>('')
  const [statuses, setStatuses] = useState<Set<InboundStatus>>(new Set())
  const [windowHours, setWindowHours] = useState('24')
  const [rows, setRows] = useState<InboundRow[] | null>(null)
  const [totals, setTotals] = useState<Totals | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let live = true
    const since = new Date(Date.now() - Number(windowHours) * 3600_000).toISOString()
    const params = new URLSearchParams({ since, limit: '200' })
    if (channel) params.set('channel', channel)
    if (statuses.size) params.set('status', [...statuses].join(','))
    setRows(null)
    setError(null)
    fetch(`${api}/api/sync-logs/webhooks?${params}`, { credentials: 'include' })
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`The event list could not be read (HTTP ${r.status}).`))))
      .then((body) => {
        if (!live) return
        setRows(body.items ?? [])
        setTotals(body.totals ?? null)
      })
      .catch((e: Error) => { if (live) { setError(e.message); setRows([]) } })
    return () => { live = false }
  }, [api, channel, statuses, windowHours, reload])

  const act = useCallback(async (id: string, action: 'retry' | 'replay') => {
    setBusyId(id)
    setNotice(null)
    try {
      const res = await fetch(`${api}/api/sync-logs/webhooks/${id}/${action}`, { method: 'POST', credentials: 'include' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error ?? `The ${action} did not succeed (HTTP ${res.status}).`)
      setNotice({
        tone: 'success',
        text: action === 'retry'
          ? 'Queued. The retry worker picks it up within a minute.'
          : 'Replayed, and it succeeded.',
      })
      setReload((n) => n + 1)
    } catch (e) {
      setNotice({ tone: 'danger', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusyId(null)
    }
  }, [api])

  const statusCount = useCallback(
    (id: InboundStatus) => totals?.byStatus?.find((s) => s.status === id)?.count ?? 0,
    [totals],
  )

  const metrics = useMemo(() => STATUSES.map((s) => ({
    label: s.label,
    value: statusCount(s.id),
    hint: s.hint,
  })), [statusCount])

  const channelOptions = useMemo(() => [
    { value: '', label: 'Every channel' },
    ...(totals?.byChannel ?? []).map((c) => ({ value: c.channel, label: `${c.channel} (${c.count})` })),
  ], [totals])

  const toggle = (id: InboundStatus) => setStatuses((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  // Only a row that is genuinely stuck offers an action. A `done` event has nothing to
  // retry, and a `pending` one is either being handled right now or already queued —
  // offering a button there invites an operator to race the worker for it.
  const actionable = (row: InboundRow) => {
    const status = inboundStatusOf(row)
    return status === 'dlq' || status === 'failed'
  }
  const stuck = (rows ?? []).filter(actionable)

  return (
    <div className="nds-ingress">
      <MetricStrip metrics={metrics} />

      <Card
        header="Inbound events"
        description="Everything a channel has sent us, and what became of it."
      >
        <div className="nds-ingress-filters">
          <Field label="Channel">
            <Listbox ariaLabel="Channel" value={channel} onChange={setChannel} options={channelOptions} />
          </Field>
          <Field label="Window">
            <Listbox ariaLabel="Window" value={windowHours} onChange={setWindowHours} options={WINDOWS} />
          </Field>
          <div className="nds-ingress-chips" role="group" aria-label="Filter by status">
            {STATUSES.map((s) => (
              <FilterChip
                key={s.id}
                pressed={statuses.has(s.id)}
                count={statusCount(s.id)}
                onClick={() => toggle(s.id)}
                title={s.hint}
              >
                {s.label}
              </FilterChip>
            ))}
          </div>
        </div>

        {error && <Banner tone="danger" title="The list could not be read">{error}</Banner>}
        {notice && <Banner tone={notice.tone} title={notice.tone === 'success' ? 'Done' : 'That did not work'}>{notice.text}</Banner>}

        {rows === null ? <Skeleton height={220} /> : (
          <InboundGrid
            rows={rows}
            emptyTitle="No inbound events in this window"
            emptyDescription="Nothing has arrived on these channels for the period selected. A channel with no subscription sends nothing at all — check the Diagnostics tab."
          />
        )}
      </Card>

      {stuck.length > 0 && (
        <Card
          header={`${stuck.length} event${stuck.length === 1 ? '' : 's'} need attention`}
          description="Retry puts an event back in the worker's queue. Replay runs it now and tells you what happened."
        >
          <ul className="nds-ingress-stuck">
            {stuck.map((row) => (
              <li key={row.id}>
                <div className="nds-ingress-stuck-what">
                  <strong>{row.channel ?? '—'} · {row.eventType}</strong>
                  <span>{row.lastError ?? row.error ?? 'No reason was recorded.'}</span>
                </div>
                <div className="nds-ingress-stuck-do">
                  <Button size="sm" variant="secondary" disabled={busyId === row.id} onClick={() => act(row.id, 'retry')}>
                    Retry
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busyId === row.id} onClick={() => act(row.id, 'replay')}>
                    Replay now
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {rows !== null && rows.length === 0 && !error && (
        <EmptyState
          title="Nothing has arrived"
          description="No channel has sent an inbound event in this window."
        />
      )}
    </div>
  )
}
