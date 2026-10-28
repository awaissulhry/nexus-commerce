'use client'

import { Pill } from '../../primitives/Pill'
import { InfoTip } from '../../primitives/InfoTip'
export interface SheetStatus {
  tone: 'neutral' | 'info' | 'warning' | 'danger'
  label: string
  detail?: string
  /**
   * Makes the mark a control: "2 rejected on Amazon · IT" shows those rows. Without it the mark only reports.
   * An action in the "+N" overflow is not reachable from the mark, so keep the same action available elsewhere
   * (a filter, a menu) — the mark is a shortcut, never the only way.
   */
  onSelect?: () => void
  /** What `onSelect` does, read after the label and detail: "Show these rows". */
  actionLabel?: string
  /** The action is engaged (a filter that is on): emits `aria-pressed`. Needs `onSelect`. */
  selected?: boolean
}
export interface SheetStatusesProps { status?: readonly SheetStatus[]; compact?: boolean }
const showDetail = () => {} // InfoTip opens on the real pill button’s focus, including touch clicks.
/** Label, detail and action as one spoken sentence, without a doubled full stop between the parts. */
const sentence = (item: SheetStatus) => {
  const parts = [item.label, item.detail, item.onSelect ? item.actionLabel : undefined].filter((part): part is string => part != null && part !== '')
  return parts.map((part, i) => (i < parts.length - 1 ? part.replace(/[.\s]+$/, '') : part)).join('. ')
}
function Status({ item }: { item: SheetStatus }) {
  const named = item.detail != null || (item.onSelect != null && item.actionLabel != null)
  const pill = <Pill tone={item.tone} size="md" onClick={item.onSelect ?? (item.detail != null ? showDetail : undefined)}
    pressed={item.onSelect != null ? item.selected : undefined}
    aria-label={named ? sentence(item) : undefined}>{item.label}</Pill>
  return <span role={item.tone === 'danger' ? 'alert' : undefined}>
    {item.detail != null ? <InfoTip tip={item.detail}>{pill}</InfoTip> : pill}
  </span>
}
/**
 * Which marks stay on the bar. Severity outranks order: a `danger` mark never folds into "+N" — not under the
 * three-mark cap and not on the host's compact tier — because a failure that only a screen reader can find is a
 * failure the operator does not see (WCAG 1.4.1 and the honest-UI rule). Only the other tones fold.
 *
 * Measured why (sheet publish parity, step 2, 2026-10-02): on the studio sheet at 1280px the compact tier latched
 * while "Amazon · IT is processing 21 products" was on the bar (18px over), and the "2 rejected on Amazon · IT"
 * that replaced it was folded into a neutral "+2" — invisible, though the bar had 337px for marks once the search
 * slot gave up its width. A danger mark is one pill (≈170px); keeping it costs less than the room the fold freed.
 * Original order is kept among the marks that stay.
 */
export function partitionSheetStatuses(status: readonly SheetStatus[], compact: boolean): { visible: SheetStatus[]; folded: SheetStatus[] } {
  const danger = status.filter(s => s.tone === 'danger').length
  // Room for the OTHER tones: none on the compact tier; up to three marks in all, two plus "+N" once there are more.
  let others = compact ? 0 : status.length > 3 ? Math.max(0, 2 - danger) : status.length
  const visible: SheetStatus[] = [], folded: SheetStatus[] = []
  for (const s of status) {
    if (s.tone === 'danger') visible.push(s)
    else if (others > 0) { visible.push(s); others-- }
    else folded.push(s)
  }
  return { visible, folded }
}

/** At most three visible marks, and every danger mark. Every folded sentence remains keyboard reachable on "+N". */
export function SheetStatuses({ status = [], compact = false }: SheetStatusesProps) {
  const { visible, folded } = partitionSheetStatuses(status, compact)
  return <span className="nds-sheet-statuses">
    {visible.map((item, i) => <Status key={i} item={item} />)}
    {folded.length > 0 && <Status item={{ tone: 'neutral', label: `+${folded.length}`, detail: folded.map(s => `${s.label}${s.detail != null ? `. ${s.detail}` : ''}`).join('; ') }} />}
  </span>
}
