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
 *
 * "Complaint spike" is still a labelled placeholder (build spec ruling 3).
 */
import { Card, MultiSelect } from '@/design-system/components'
import { Button, Checkbox, Pill, Skeleton, Tag, Toggle } from '@/design-system/primitives'
import { ReadFailed } from './ReadFailed'
import { ALERT_NAME, ALERT_WHEN, ALERTS_WITH_VIA, ratingDropWords, recipientsHint, type AlertForm, type AlertKey, type AlertVia, type RatingDropRule } from './settingsForm'
import s from './settings.module.css'

export interface AlertsSectionProps {
  alerts: AlertForm[] | null
  error: string | null
  onRetry: () => void
  team: Array<{ userId: string; name: string; owner: boolean }>
  digestFallback: string[]
  /** When "Rating drop" opens an alert (null while the settings are read). */
  ratingDropRule: RatingDropRule | null
  onOn: (key: AlertKey, on: boolean) => void
  onRecipients: (key: AlertKey, ids: string[]) => void
  onVia: (key: AlertKey, via: AlertVia, on: boolean) => void
}

/** ⛔ KEEP — placeholders (build spec ruling 3): these alerts arrive with Insights in Phase 2 (PR E). */
const LATER: ReadonlyArray<{ name: string; when: string }> = [
  { name: 'Complaint spike', when: 'A theme suddenly shows up in many more reviews than usual.' },
]

export function AlertsSection({ alerts, error, onRetry, team, digestFallback, ratingDropRule, onOn, onRecipients, onVia }: AlertsSectionProps) {
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
                  {a.key === 'ratingDrop' && ratingDropRule && ratingDropWords(ratingDropRule).map((line) => <span key={line} className={s.cellSub}>{line}</span>)}
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
            {/* ⛔ KEEP — placeholders (build spec ruling 3): "Complaint spike" arrives with Insights (Phase 2, PR E).
                Shown labelled, never hidden: the switch is held until then. */}
            {LATER.map((l) => (
              <div key={l.name} className={s.alert}>
                <Button size="sm" heldReason={`Coming later: “${l.name}” arrives with the new Insights pages.`}>Off</Button>
                <div className={`${s.alertName} ${s.dim}`}>
                  <span className={s.cellLine}><span className={s.cellStrong}>{l.name}</span><Tag tone="neutral">Coming later</Tag><Pill tone="neutral">Sample</Pill></span>
                  <span className={s.cellSub}>{l.when}</span>
                </div>
                <div className={`${s.alertField} ${s.dim}`}>
                  <span className={s.fieldLabel}>Who</span>
                  <span className={s.cellSub}>The people you pick</span>
                </div>
                <div className={`${s.alertField} ${s.dim}`}>
                  <span className={s.fieldLabel}>How</span>
                  <span className={s.cellSub}>In Nexus or by e-mail</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
