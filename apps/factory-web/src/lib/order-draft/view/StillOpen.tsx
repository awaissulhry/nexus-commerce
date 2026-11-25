'use client'

import { Hourglass, Info } from 'lucide-react'
import { Card } from '@nexus/ui/components'
import { Tag } from '@nexus/ui/primitives'
import type { StillOpenEntry } from '../model'
import { useDraftWords } from '../words'

/**
 * Still open (od-w1.2, R1; 10-design-r1 § 4) — INFORMATION only, never a hold: one item per row with what is "Not decided yet" there
 * ("Team gloves · row 3 — Sizing · Colour · Pieces"), and the delivery date. An item is a button that moves the focus to its row. The
 * count is neutral (never danger); the foot says Send may go at any time (portal) / what the Confirm window asks (office). "Products:
 * none yet" while the table is empty. The data is the server's `stillOpen` (no price item, ever).
 */
export function StillOpen({ entries, openCount, noProducts, onGo }: { entries: readonly StillOpenEntry[]; openCount: number; noProducts: boolean; onGo?: (entry: StillOpenEntry) => void }) {
  const { t } = useDraftWords()
  return (
    <Card padded>
      <section className="fw-od-section" aria-labelledby="od-still-title">
        <div className="fw-od-parthead">
          <h2 id="od-still-title" className="fw-od-h2">
            {t('still.title')}
          </h2>
          {openCount > 0 ? <Tag tone="neutral">{openCount === 1 ? t('still.count_one', { n: openCount }) : t('still.count_other', { n: openCount })}</Tag> : null}
        </div>
        {noProducts ? <p className="fw-od-quiet">{t('still.noProducts')}</p> : null}
        {entries.length > 0 ? (
          <ul className="fw-od-still">
            {entries.map((entry) => (
              <li key={entry.id}>
                <button type="button" className="fw-od-stillitem" onClick={() => onGo?.(entry)}>
                  <span className="fw-od-stillname">
                    <strong>{entry.label}</strong>
                    {entry.what ? <span className="fw-od-quiet">{entry.what}</span> : null}
                  </span>
                  <Tag tone="neutral">
                    <Hourglass size={12} aria-hidden /> {t('state.OPEN')}
                  </Tag>
                </button>
              </li>
            ))}
          </ul>
        ) : !noProducts ? (
          <p className="fw-od-quiet">{t('still.none')}</p>
        ) : null}
        <p className="fw-od-quiet">
          <Info size={14} aria-hidden /> {t('still.info')}
        </p>
      </section>
    </Card>
  )
}
