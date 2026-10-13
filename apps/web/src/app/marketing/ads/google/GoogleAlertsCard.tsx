'use client'

/**
 * Google Ads step 1b — "Needs a look": the alerts Nexus finds in what it read from Google (R14), most urgent first.
 *
 * Each alert is the server's own title and sentence (they carry no amount), at most one line of numbers (money only
 * for a role that may see ad spend), and "Open", which goes where the web decides from the alert's kind (PLAN-1B M4):
 * the campaign, Disapprovals, or "Google acts on its own". "No alerts" only when every check ran; a check that could
 * not run is named with its reason. Read only: nothing here changes Google Ads.
 */
import { useState } from 'react'
import { Banner, Card } from '@/design-system/components'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import { fetchGoogleAlerts, type GoogleAlerts } from '@/lib/google-ads/contract'
import {
  ALERTS_SHOWN,
  SEVERITY_TEXT,
  alertNumbersLine,
  alertSinceText,
  alertTarget,
  alertTone,
  alertsSummary,
  sortAlerts,
  type AlertTarget,
} from './googleAttention'
import { googleReadKey, useGoogleRead } from './useGoogleRead'

/** R14 for one account, shared by every caller through the read cache. */
export function useGoogleAlerts(account: string | null, enabled = true) {
  return useGoogleRead<GoogleAlerts>(enabled ? googleReadKey('alerts', account) : null, () => fetchGoogleAlerts({ account }), {
    fallbackError: 'Nexus could not check the Google Ads account.',
  })
}

export function GoogleAlertsCard({ account, currency, onOpen }: {
  account: string | null
  currency: string | null
  onOpen: (target: AlertTarget) => void
}) {
  const alerts = useGoogleAlerts(account)
  const [all, setAll] = useState(false)
  const data = alerts.data
  const summary = data ? alertsSummary(data) : null
  const items = data ? sortAlerts(data.items) : []
  const shown = all ? items : items.slice(0, ALERTS_SHOWN)

  return (
    <Card header="Needs a look" description={summary?.checked ?? 'What Nexus finds in what it read from Google.'} className="gads-card" headingLevel={2}>
      {alerts.loading && <Skeleton height={96} radius="var(--nds-radius-lg)" />}
      {alerts.error && (
        <Banner tone="danger" title="The alerts could not be loaded" action={<Button size="sm" onClick={alerts.reload}>Try again</Button>}>
          {alerts.error}
        </Banner>
      )}
      {data && summary && (
        <div className="gads-card-body">
          {summary.allClear && <p className="gads-note">{summary.allClear}</p>}
          {items.length > 0 && (
            <ul className="gads-alerts" aria-label="Alerts">
              {shown.map((a) => {
                const numbers = alertNumbersLine(a.numbers, currency)
                const since = alertSinceText(a.since)
                return (
                  <li key={a.alertId} className="gads-alert">
                    <div className="gads-alert-main">
                      <span className="gads-alert-head">
                        <Pill tone={alertTone(a.severity)} size="sm" dot>{SEVERITY_TEXT[a.severity]}</Pill>
                        <span className="gads-alert-title">{a.title}</span>
                      </span>
                      <span className="gads-alert-body">{a.body}</span>
                      {numbers && <span className="gads-dim">{numbers}</span>}
                      {since && <span className="gads-dim">{since}</span>}
                    </div>
                    <Button size="sm" onClick={() => onOpen(alertTarget(a))} aria-label={`Open: ${a.title}`}>Open</Button>
                  </li>
                )
              })}
            </ul>
          )}
          {items.length > ALERTS_SHOWN && (
            <Button variant="link" size="sm" onClick={() => setAll((v) => !v)} aria-expanded={all}>
              {all ? 'Show fewer' : `Show all ${items.length} alerts`}
            </Button>
          )}
          {summary.notChecked.length > 0 && (
            <div className="gads-notchecked">
              <span className="gads-dim">Not checked yet:</span>
              <ul className="gads-list">
                {summary.notChecked.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
