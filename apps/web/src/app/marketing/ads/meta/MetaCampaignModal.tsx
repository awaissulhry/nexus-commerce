'use client'

/**
 * Meta ads step 2 — one Meta campaign, in a centred DS Modal: its settings as Meta holds them and its days in the page's
 * window (a day not read says "Not read" and shows no number).
 *
 * Read only: no control here changes the campaign. Changes are made in Meta Ads Manager for now.
 */
import { useEffect, useRef, useState } from 'react'
import { Banner, KeyValue, Modal, PerformanceGraph, SummaryTable, type KeyValueItem } from '@/design-system/components'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import { chart } from '@/design-system/tokens'
import { fetchMetaCampaignDays, type MetaAdsCampaignDays, type MetaAdsCampaignRow } from '@/lib/meta-ads/contract'
import {
  DAY_COLUMNS, bidStrategyLabel, budgetText, chartHasMoney, chartPoints, coverageNote, dayRows, effectiveText, formatDay,
  formatMoment, formatMoney, formatWindow, objectiveLabel, provisionalDays, provisionalNote, statusLabel, toMinor,
} from './metaAds'

type Part<T> = { data: T | null; error: string | null }

export function MetaCampaignModal({ campaign, currency, range, onClose }: {
  campaign: MetaAdsCampaignRow
  currency: string | null
  range: { from: string; to: string }
  onClose: () => void
}) {
  const { from, to } = range
  const [days, setDays] = useState<Part<MetaAdsCampaignDays> | null>(null)
  const [attempt, setAttempt] = useState(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    setDays(null)
    fetchMetaCampaignDays(campaign.campaignId, { from, to })
      .then((data) => { if (alive.current) setDays({ data, error: null }) })
      .catch((err: unknown) => { if (alive.current) setDays({ data: null, error: err instanceof Error ? err.message : 'Nexus could not load the days.' }) })
    return () => { alive.current = false }
  }, [campaign.campaignId, from, to, attempt])

  const c = days?.data?.campaign ?? campaign
  const ccy = days?.data?.currency ?? currency
  const facts: KeyValueItem[] = [
    { label: 'Status', value: <Pill tone={c.status === 'ACTIVE' ? 'success' : 'neutral'} size="sm">{statusLabel(c.status)}</Pill>, hint: effectiveText(c.status, c.effectiveStatus) ?? undefined },
    { label: 'Objective', value: objectiveLabel(c.objective) },
    { label: 'Bid strategy', value: bidStrategyLabel(c.bidStrategy) },
    { label: 'Budget', value: budgetText(c, ccy, 'On the ad sets'), hint: 'A campaign budget is Advantage+ campaign budget; otherwise each ad set has its own.' },
    { label: 'Starts', value: c.startTime ? formatDay(c.startTime) : '—' },
    { label: 'Ends', value: c.stopTime ? formatDay(c.stopTime) : 'No end date' },
    { label: 'Settings read', value: c.settingsReadAt ? formatMoment(c.settingsReadAt) ?? '—' : 'Not read yet', hint: 'When Nexus last read these settings from Meta.' },
  ]
  const d = days?.data
  const note = d ? provisionalNote(provisionalDays(d.days, d.window.provisionalFrom)) : null
  const gaps = d ? coverageNote(d) : null

  return (
    <Modal open onClose={onClose} size="lg" title={c.name}
      subtitle="Read from Meta. Changes to this campaign are made in Meta Ads Manager for now."
      busy={!days}
      footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
      <div className="mads-modal">
        <KeyValue items={facts} columns={2} />
        <section className="mads-section" aria-labelledby="mads-days-h">
          <h3 id="mads-days-h">Days, {formatWindow(from, to)}</h3>
          {!days && <Skeleton height={200} radius="var(--nds-radius-lg)" />}
          {days?.error && <Banner tone="danger" title="The days could not be loaded" action={<Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}>{days.error}</Banner>}
          {d && <>
            {gaps && <Banner tone="warning">{gaps}</Banner>}
            {chartHasMoney(d.days) && ccy ? (
              <PerformanceGraph
                data={chartPoints(d.days, ccy)}
                xKey="day"
                left={{ key: 'spend', label: 'Amount spent', axisLabel: `Amount spent (${ccy})`, color: chart.cap, axis: 'left', format: (v) => formatMoney(toMinor(v, ccy), ccy) }}
                right={{ key: 'value', label: 'Purchase value', axisLabel: `Purchase value (${ccy})`, color: chart.actual, axis: 'right', format: (v) => formatMoney(toMinor(v, ccy), ccy) }}
                height={200}
              />
            ) : (
              <p className="mads-meta">No amount spent or purchase value to draw for these days.</p>
            )}
            {note && <p className="mads-note">{note}</p>}
            <div className="mads-table" tabIndex={0} role="region" aria-label="Days table">
              <SummaryTable label={`Days of ${c.name}`} columns={DAY_COLUMNS} rows={dayRows(d.days, ccy)} />
            </div>
          </>}
        </section>
        <p className="mads-note">Changes to this campaign are made in Meta Ads Manager for now. Nexus reads them and changes nothing.</p>
      </div>
    </Modal>
  )
}
