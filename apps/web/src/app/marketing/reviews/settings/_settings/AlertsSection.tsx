'use client'

/**
 * Reviews › Settings › Alerts — who hears about what, and how. Part of the page's draft, saved with the EditModeBar.
 *
 *   New negative review   a new review of 1–2 stars or negative feedback: in Nexus (the bell) and/or by e-mail, to the
 *                         people picked (nobody picked = the business's owners). Imported files never alert.
 *   Daily digest          the morning e-mail: on/off and who gets it (nobody picked = where it went before).
 *   Rating drop           (Phase 3) a product family's average stars fall in one market — the rule in words, from the
 *                         API (`ratingDropRule`); off until switched on; opens an alert in Insights › Alerts and tells
 *                         the people picked, in Nexus and/or by e-mail.
 *   Complaint spike       complaints about one theme rise fast for a product in one market — the spike check's rule in
 *                         words, from the API (`complaintSpikeRule`); the hourly check opens these alerts in Insights ›
 *                         Alerts either way; off until switched on, then the people picked hear about each new one, in
 *                         Nexus and/or by e-mail.
 */
import { Card, MultiSelect } from '@/design-system/components'
import { Checkbox, Skeleton, Toggle } from '@/design-system/primitives'
import { ReadFailed } from './ReadFailed'
import {
  ALERT_NAME, ALERT_WHEN, ALERTS_WITH_VIA, complaintSpikeWords, ratingDropWords, recipientsHint, type AlertForm, type AlertKey, type AlertVia,
  type ComplaintSpikeRule, type RatingDropRule,
} from './settingsForm'
import s from './settings.module.css'

export interface AlertsSectionProps {
  alerts: AlertForm[] | null
  error: string | null
  onRetry: () => void
  team: Array<{ userId: string; name: string; owner: boolean }>
  digestFallback: string[]
  /** When "Rating drop" opens an alert (null while the settings are read). */
  ratingDropRule: RatingDropRule | null
  /** When "Complaint spike" opens an alert (null while the settings are read). */
  complaintSpikeRule: ComplaintSpikeRule | null
  onOn: (key: AlertKey, on: boolean) => void
  onRecipients: (key: AlertKey, ids: string[]) => void
  onVia: (key: AlertKey, via: AlertVia, on: boolean) => void
}

/** The rule of an alert that has one, in words (one line each). */
function ruleLines(key: AlertKey, ratingDropRule: RatingDropRule | null, complaintSpikeRule: ComplaintSpikeRule | null): string[] {
  if (key === 'ratingDrop' && ratingDropRule) return ratingDropWords(ratingDropRule)
  if (key === 'complaintSpike' && complaintSpikeRule) return complaintSpikeWords(complaintSpikeRule)
  return []
}

export function AlertsSection({ alerts, error, onRetry, team, digestFallback, ratingDropRule, complaintSpikeRule, onOn, onRecipients, onVia }: AlertsSectionProps) {
  const options = team.map((m) => ({ value: m.userId, label: m.owner ? `${m.name} (owner)` : m.name }))
  return (
    <div className={s.section}>
      <p className={s.lead}>Who hears about what, and how. Saved with the page’s Save changes.</p>
      <Card padded={false}>
        {error && !alerts ? (
          <div className={s.pad}><ReadFailed error={error} onRetry={onRetry} /></div>
        ) : !alerts ? (
          <div className={s.skeletonRows} aria-hidden>{[0, 1].map((i) => <Skeleton key={i} height={64} />)}</div>
        ) : (
          <div className={s.alerts}>
            {alerts.map((a) => (
              <div key={a.key} className={s.alert}>
                <Toggle checked={a.on} onChange={(on) => onOn(a.key, on)} aria-label={`Alert: ${ALERT_NAME[a.key]}`} />
                <div className={`${s.alertName} ${a.on ? '' : s.dim}`}>
                  <span className={s.cellStrong}>{ALERT_NAME[a.key]}</span>
                  <span className={s.cellSub}>{ALERT_WHEN[a.key]}</span>
                  {ruleLines(a.key, ratingDropRule, complaintSpikeRule).map((line) => <span key={line} className={s.cellSub}>{line}</span>)}
                </div>
                <div className={`${s.alertField} ${a.on ? '' : s.dim}`}>
                  <span className={s.fieldLabel} id={`alert-who-${a.key}`}>Who</span>
                  <MultiSelect
                    size="sm"
                    options={options}
                    value={a.recipients}
                    onChange={(ids) => onRecipients(a.key, ids)}
                    labelledBy={`alert-who-${a.key}`}
                    placeholder="Nobody picked"
                    heldReason={options.length ? null : 'Nexus knows no team member of this business to pick yet. Invite people in Settings › Team.'}
                    formatLabel={(ids) => (ids.length === 1 ? (team.find((m) => m.userId === ids[0])?.name ?? '1 person') : `${ids.length} people`)}
                  />
                  <span className={s.cellSub}>{recipientsHint(a, digestFallback)}</span>
                </div>
                <div className={`${s.alertField} ${a.on ? '' : s.dim}`}>
                  <span className={s.fieldLabel}>How</span>
                  {ALERTS_WITH_VIA.includes(a.key) ? (
                    <div className={s.choices} role="group" aria-label={`How “${ALERT_NAME[a.key]}” arrives`}>
                      <Checkbox label="In Nexus" checked={a.via.includes('app')} onChange={(e) => onVia(a.key, 'app', e.target.checked)} />
                      <Checkbox label="By e-mail" checked={a.via.includes('email')} onChange={(e) => onVia(a.key, 'email', e.target.checked)} />
                    </div>
                  ) : (
                    <span className={s.cellSub}>By e-mail, daily at 08:00 UTC</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
