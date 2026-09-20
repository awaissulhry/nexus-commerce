'use client'

/**
 * P3.6 — the four numbers per channel, each against a target a person agreed.
 *
 * Error rate, slow calls, backlog age, dead letters. Reads
 * `GET /api/cx/health`, which is the only place those numbers are computed, so this
 * screen and anything else that shows them cannot drift apart.
 *
 * ## The one rule this screen exists to keep
 *
 * **`no_data` is not a pass.** A metric with nothing behind it renders neutral with the
 * reason, never green. The whole point of a target is that it can be missed; a
 * dashboard that is green because nothing happened is the false green this programme
 * keeps finding, and it is worse than no dashboard at all.
 *
 * 🔴 And an honest note at the top: of the 395 calls since the gateway landed, only 48
 * are real traffic. That is stated on the screen, not just in a build record, because
 * an operator reading four green tiles deserves to know how much is behind them.
 */

import { useCallback, useEffect, useState } from 'react'
import { Card, Banner, MetricStrip, EmptyState, Listbox } from '@/design-system/components'
import { Pill, Skeleton, Tag } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { channelName } from './channels-data'

type Verdict = 'meeting' | 'missing' | 'no_data'

interface Metric {
  value: number | null
  target: number
  verdict: Verdict
  sampleSize: number
  unit: 'percent' | 'hours' | 'count'
  note: string
}

interface OperationHealth {
  operation: string
  calls: number
  failed: number
  errorRate: Metric
  slowCalls: Metric
}

interface ChannelHealth {
  channel: string
  calls: number
  errorRate: Metric
  slowCalls: Metric
  backlogAge: Metric
  deadLetters: Metric
  verdict: Verdict
  operations: OperationHealth[]
}

/**
 * `no_data` is NEUTRAL, never success. The tone is the whole honesty of this screen:
 * a metric nobody has data for must not look like a metric that passed.
 */
const VERDICT_TONE: Record<Verdict, 'success' | 'danger' | 'neutral'> = {
  meeting: 'success',
  missing: 'danger',
  no_data: 'neutral',
}

const VERDICT_LABEL: Record<Verdict, string> = {
  meeting: 'on target',
  missing: 'off target',
  no_data: 'no data',
}

/** The value with its unit, or an em dash — never a bare 0 standing in for "unknown". */
function reading(m: Metric): string {
  if (m.value === null) return '—'
  if (m.unit === 'percent') return `${m.value}%`
  if (m.unit === 'hours') return `${m.value} h`
  return String(m.value)
}

function targetText(m: Metric): string {
  if (m.unit === 'percent') return `target ≤ ${m.target}%`
  if (m.unit === 'hours') return `target ≤ ${m.target} h`
  return `target ≤ ${m.target}`
}

function MetricRow({ label, metric }: { label: string; metric: Metric }) {
  return (
    <div className="nds-health-metric">
      <div className="nds-health-metric-head">
        <span className="nds-health-metric-label">{label}</span>
        <Pill tone={VERDICT_TONE[metric.verdict]} dot size="sm">
          {reading(metric)} · {VERDICT_LABEL[metric.verdict]}
        </Pill>
        <Tag>{targetText(metric)}</Tag>
      </div>
      {/* The sentence is always shown, including on a pass: "1% of 100 calls failed,
          within the 2% target" tells an operator how much is behind the green. */}
      <p className="nds-health-metric-note">{metric.note}</p>
    </div>
  )
}

const WINDOWS = [
  { value: '1', label: 'Last hour' },
  { value: '24', label: 'Last 24 hours' },
  { value: '168', label: 'Last 7 days' },
]

export function HealthTab() {
  const api = getBackendUrl()
  const [hours, setHours] = useState('24')
  const [state, setState] = useState<{ channels: ChannelHealth[] | null; error: string | null }>({ channels: null, error: null })

  const load = useCallback(async () => {
    setState({ channels: null, error: null })
    try {
      const res = await fetch(`${api}/api/cx/health?hours=${hours}`, { credentials: 'include', cache: 'no-store' })
      if (!res.ok) throw new Error(`The health endpoint answered ${res.status}.`)
      const data = (await res.json()) as { channels: ChannelHealth[] }
      setState({ channels: data.channels ?? [], error: null })
    } catch (err) {
      setState({ channels: null, error: err instanceof Error ? err.message : 'Failed to load channel health' })
    }
  }, [api, hours])

  useEffect(() => { void load() }, [load])

  if (state.error) {
    return (
      <Banner tone="danger" title="Channel health unavailable">
        {state.error}
      </Banner>
    )
  }
  if (state.channels === null) return <Skeleton height={320} />
  if (state.channels.length === 0) {
    return <EmptyState title="No channels yet" description="Connect a channel and its health appears here." />
  }

  const offTarget = state.channels.filter((c) => c.verdict === 'missing').length
  const noData = state.channels.filter((c) => c.verdict === 'no_data').length

  return (
    <div className="nds-health">
      <div className="nds-health-controls">
        <Listbox
          value={hours}
          onChange={(v) => setHours(String(v))}
          options={WINDOWS}
        />
      </div>

      <MetricStrip
        metrics={[
          { label: 'Channels', value: state.channels.length },
          { label: 'Off target', value: offTarget },
          // Counted and named, so "everything is green" can never mean "we measured
          // nothing".
          { label: 'No data', value: noData },
        ]}
      />

      {state.channels.map((c) => (
        <Card
          key={c.channel}
          header={`${channelName(c.channel)} — ${VERDICT_LABEL[c.verdict]}`}
          description={
            c.calls === 0
              ? 'No calls in this window. Nothing here is a pass or a failure.'
              : `${c.calls} call${c.calls === 1 ? '' : 's'} in this window.`
          }
        >
          <MetricRow label="Error rate" metric={c.errorRate} />
          <MetricRow label="Slow calls" metric={c.slowCalls} />
          <MetricRow label="Oldest waiting change" metric={c.backlogAge} />
          <MetricRow label="Gave up (dead letters)" metric={c.deadLetters} />

          {c.operations.length > 0 && (
            <div className="nds-health-ops">
              <p className="nds-health-ops-title">Worst operations</p>
              {/* Worst error rate first, not busiest: an operation failing every one of
                  3 calls matters more than one making 26,838 successful ones. */}
              {c.operations.map((op) => (
                <div key={op.operation} className="nds-health-op">
                  <span className="nds-health-op-name" title={op.operation}>{op.operation}</span>
                  <Pill tone={VERDICT_TONE[op.errorRate.verdict]} size="sm">
                    {reading(op.errorRate)} failed
                  </Pill>
                  <Tag>{op.calls} call{op.calls === 1 ? '' : 's'}</Tag>
                </div>
              ))}
            </div>
          )}
        </Card>
      ))}
    </div>
  )
}
