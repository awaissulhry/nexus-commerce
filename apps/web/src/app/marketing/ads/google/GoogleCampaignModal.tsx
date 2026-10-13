'use client'

/**
 * Google Ads step 1a, W2 — one Google campaign, in a centred DS Modal: its settings as Google holds them, its days in
 * the page's window (R3; a day not read says "Not read" and shows no number), and Google's change history for it (R4,
 * "Changes in the last 30 days": when, where the change was made in words, and what changed — never who by e-mail).
 *
 * Read only: no control here changes the campaign. Changes are made in Google Ads.
 */
import { useEffect, useRef, useState } from 'react'
import { Banner, KeyValue, Modal, PerformanceGraph, SummaryTable, type KeyValueItem } from '@/design-system/components'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import { chart } from '@/design-system/tokens'
import {
  fetchGoogleCampaignChanges,
  fetchGoogleCampaignDays,
  type GoogleCampaign,
  type GoogleCampaignChanges,
  type GoogleCampaignDays,
} from '@/lib/google-ads/contract'
import {
  CHANGE_COLUMNS,
  DAY_COLUMNS,
  biddingLabel,
  budgetText,
  campaignStatusHint,
  campaignStatusLabel,
  campaignTypeLabel,
  changeRows,
  changesNote,
  chartHasMoney,
  chartPoints,
  coverageNote,
  formatDay,
  formatMoney,
  formatWindow,
  dayRows,
  provisionalDays,
  provisionalNote,
  servingText,
  settingsReadText,
  toMinor,
} from './googleAds'

type Part<T> = { data: T | null; error: string | null }

export function GoogleCampaignModal({ campaign, currency, range, onClose }: {
  campaign: GoogleCampaign
  currency: string | null
  /** The page's window (as the server answered it). */
  range: { from: string; to: string }
  onClose: () => void
}) {
  const { from, to } = range
  const [days, setDays] = useState<Part<GoogleCampaignDays> | null>(null)
  const [changes, setChanges] = useState<Part<GoogleCampaignChanges> | null>(null)
  const [attempt, setAttempt] = useState(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    setDays(null)
    setChanges(null)
    fetchGoogleCampaignDays(campaign.campaignId, { from, to })
      .then((data) => { if (alive.current) setDays({ data, error: null }) })
      .catch((err: unknown) => { if (alive.current) setDays({ data: null, error: err instanceof Error ? err.message : 'Nexus could not load the days.' }) })
    fetchGoogleCampaignChanges(campaign.campaignId)
      .then((data) => { if (alive.current) setChanges({ data, error: null }) })
      .catch((err: unknown) => { if (alive.current) setChanges({ data: null, error: err instanceof Error ? err.message : 'Nexus could not load the change history.' }) })
    return () => { alive.current = false }
  }, [campaign.campaignId, from, to, attempt])

  // The days answer carries the campaign as Google holds it now; until it arrives, the grid's row.
  const c = days?.data?.campaign ?? campaign
  const ccy = days?.data?.currency ?? currency
  const serving = servingText(c)
  const facts: KeyValueItem[] = [
    { label: 'Status', value: <Pill tone={c.status === 'ENABLED' ? 'success' : 'neutral'} size="sm">{campaignStatusLabel(c.status)}</Pill>, hint: serving ?? campaignStatusHint(c.status) ?? undefined },
    { label: 'Type', value: campaignTypeLabel(c.type) },
    { label: 'Bidding', value: biddingLabel(c.biddingStrategy) },
    { label: 'Daily budget', value: budgetText(c, ccy) },
    { label: 'Starts', value: formatDay(c.startDate) },
    { label: 'Ends', value: c.endDate ? formatDay(c.endDate) : 'No end date' },
    { label: 'Settings read', value: settingsReadText(c), hint: 'When Nexus last read these settings from Google.' },
  ]

  const d = days?.data
  const note = d ? provisionalNote(provisionalDays(d.days, d.window.provisionalFrom)) : null
  const gaps = d ? coverageNote(d) : null
  const changeItems = changes?.data ? changeRows(changes.data.items) : []

  return (
    <Modal open onClose={onClose} size="lg" title={c.name}
      subtitle="Read from Google. Changes to this campaign are made in Google Ads."
      busy={!days || !changes}
      footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
      <div className="gads-modal">
        <KeyValue items={facts} columns={2} />

        <section className="gads-section" aria-labelledby="gads-days-h">
          <h3 id="gads-days-h">Days, {formatWindow(from, to)}</h3>
          {!days && <Skeleton height={200} radius="var(--nds-radius-lg)" />}
          {days?.error && <Banner tone="danger" title="The days could not be loaded" action={<Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}>{days.error}</Banner>}
          {d && <>
            {gaps && <Banner tone="warning">{gaps}</Banner>}
            {chartHasMoney(d.days) && ccy ? (
              <PerformanceGraph
                data={chartPoints(d.days, ccy)}
                xKey="day"
                left={{ key: 'cost', label: 'Cost', axisLabel: `Cost (${ccy})`, color: chart.cap, axis: 'left', format: (v) => formatMoney(toMinor(v, ccy), ccy) }}
                right={{ key: 'value', label: 'Conversion value', axisLabel: `Conversion value (${ccy})`, color: chart.actual, axis: 'right', format: (v) => formatMoney(toMinor(v, ccy), ccy) }}
                height={200}
              />
            ) : (
              <p className="gads-meta">No cost or conversion value to draw for these days.</p>
            )}
            {note && <p className="gads-note">{note}</p>}
            <div className="gads-table gads-days" tabIndex={0} role="region" aria-label="Days table">
              <SummaryTable label={`Days of ${c.name}`} columns={DAY_COLUMNS} rows={dayRows(d.days, ccy)} />
            </div>
          </>}
        </section>

        <section className="gads-section" aria-labelledby="gads-changes-h">
          <h3 id="gads-changes-h">Changes in the last 30 days</h3>
          {!changes && <Skeleton height={80} radius="var(--nds-radius-lg)" />}
          {changes?.error && <Banner tone="danger" title="The change history could not be loaded" action={<Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}>{changes.error}</Banner>}
          {changes?.data && <>
            <p className="gads-meta">{changesNote(changes.data, changes.data.items.length)}</p>
            {changeItems.length > 0 && (
              <div className="gads-table" tabIndex={0} role="region" aria-label="Changes table">
                <SummaryTable label={`Changes to ${c.name}`} columns={CHANGE_COLUMNS} rows={changeItems} />
              </div>
            )}
          </>}
        </section>

        <p className="gads-note">Changes to this campaign are made in Google Ads. Nexus reads them and changes nothing.</p>
      </div>
    </Modal>
  )
}
