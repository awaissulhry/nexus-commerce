'use client'

/**
 * PES.7 — per-channel publish health.
 *
 * Fed from the jobs the surrounding record already loaded; no second fetch, and no possibility of
 * the cards and the list below them disagreeing about the same data.
 *
 * 🔴 No percentages anywhere. See `health.ts`: on this product a "success rate" would be computed
 * from 6 of Amazon's 43 attempts and would read 100%.
 */
import { useMemo } from 'react'

import { Pill } from '@/design-system/primitives'

import { failureHeadline } from './auditEvents'
import { formatDuration, outcomeSentence, summariseHealth } from './health'
import type { PublishJob } from './jobs'
import styles from '../channel/amazon/matrix.module.css'

export interface HealthCardsProps { jobs: readonly PublishJob[] }

export function HealthCards({ jobs }: HealthCardsProps) {
  const health = useMemo(() => summariseHealth(jobs), [jobs])
  if (health.length === 0) return null

  return (
    <div className={styles.healthRow}>
      {health.map((h) => (
        <article key={h.channel} className={styles.healthCard}>
          <header className={styles.healthHead}>
            <span className={styles.healthChannel}>{h.channel}</span>
            <span className={styles.count}>{h.attempts} attempts</span>
            {h.skuRejected > 0 && <Pill tone="danger">{h.skuRejected} rejected</Pill>}
            {h.recordedFailure > 0 && <Pill tone="danger">{h.recordedFailure} failed</Pill>}
          </header>

          <p className={styles.healthLine}>{outcomeSentence(h)}</p>

          <dl className={styles.healthStats}>
            <div>
              <dt>Last attempt</dt>
              <dd>{h.lastAttemptAt ? new Date(h.lastAttemptAt).toLocaleDateString() : '—'}</dd>
            </div>
            <div>
              <dt>Typical time</dt>
              {/* Absent rather than estimated: a duration nobody measured is not shown. */}
              <dd>{h.duration ? formatDuration(h.duration.medianSeconds) : 'Not recorded'}</dd>
            </div>
            <div>
              <dt>Slowest</dt>
              <dd>{h.duration ? formatDuration(h.duration.maxSeconds) : '—'}</dd>
            </div>
            <div>
              <dt>SKU lines</dt>
              <dd>{h.skuLines > 0 ? h.skuLines : '—'}</dd>
            </div>
          </dl>

          {h.durationNote && <p className={styles.healthNote}>{h.durationNote}</p>}

          {h.errors.length > 0 && (
            <ul className={styles.healthErrors}>
              {h.errors.slice(0, 3).map((e) => (
                <li key={e.message} title={e.message}>
                  {/* The sentence, not the JSON body eBay embeds in it; the title keeps the rest. */}
                  {e.count > 1 && <strong>{e.count}× </strong>}{failureHeadline(e.message)}
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </div>
  )
}
