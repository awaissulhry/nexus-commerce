'use client'

import type { ReactNode } from 'react'
import { FileText } from 'lucide-react'
import { Card, PressableRow } from '@nexus/ui/components'
import { useDraftWords } from '../words'

/**
 * "Continue a draft" (od-w1.2, R1; 10-design-r1 § 1 the start): a full-width card under the products table, its rows side by side
 * (auto-fit ≥ 280 px, no empty strip beside the mail). Each row names the draft (its subject, else row 1's product, else "Draft order
 * {date}") and says what is still open, when and by whom it was saved — in the host's words (the portal never names a factory worker).
 * No drafts: the card hides (the office's quiet links then sit alone in its foot). `foot`: the office's quiet links.
 */

export interface ContinueRow {
  id: string
  title: string
  /** "2 still open · saved 24/11/2026 by Bianca Brand", in the host's words. */
  line: string
}

export function ContinueDrafts({ rows, title, foot, onOpen }: { rows: readonly ContinueRow[]; title: string; foot?: ReactNode; onOpen?: (id: string) => void }) {
  if (rows.length === 0 && !foot) return null
  return (
    <Card padded>
      <section className="fw-od-section" aria-labelledby={rows.length > 0 ? 'od-continue-title' : undefined}>
        {rows.length > 0 ? (
          <>
            <h2 id="od-continue-title" className="fw-od-h2">
              {title}
            </h2>
            <ul className="fw-od-continue">
              {rows.map((row) => (
                <li key={row.id}>
                  <PressableRow
                    leading={<FileText size={16} aria-hidden />}
                    label={
                      <span className="fw-od-rowtext">
                        <strong>{row.title}</strong>
                        <span className="fw-od-quiet">{row.line}</span>
                      </span>
                    }
                    onClick={() => onOpen?.(row.id)}
                  />
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {foot ? <div className="fw-od-continuefoot">{foot}</div> : null}
      </section>
    </Card>
  )
}

/** A row's second line from what the list says (R1 row fields), in the part's words; the portal's office saves read "the factory". */
export function useContinueLine(): (row: { openCount?: number; savedAt?: string; savedBy?: { who: string; name: string | null } }, fallback: string) => string {
  const { t, day } = useDraftWords()
  return (row, fallback) => {
    if (row.openCount === undefined || !row.savedAt) return fallback
    const when = day(row.savedAt)
    if (row.savedBy?.who === 'FACTORY') return t('start.draftRowFactory', { open: row.openCount, when })
    return row.savedBy?.name ? t('start.draftRow', { open: row.openCount, when, name: row.savedBy.name }) : fallback
  }
}
