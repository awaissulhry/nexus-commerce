'use client'

/**
 * GridSheetNote — the sheet's honest message, in the footer strip.
 *
 * 🔴 DISCLOSED EDIT under PES.2's `design-system/grid/**` claim (hub ruling #255). Built by DS.1 for
 * v2 §6.2 rule 6 + §6.3; merged by DS.2 with `components/RefusalLine.tsx`, which was a second
 * component for the same slot — two components for one slot put the kind→tone mapping in two places,
 * which is the exact drift §6.3 exists to prevent. `RefusalLine` is deleted; its contract survives
 * here.
 *
 * ONE SLOT, FOUR OCCUPANTS, in §6.5 priority order — `refusal` › `slow` › `provenance` › `hint`.
 * The KIND owns the glyph, the tone and the politeness, never the bar it sits in (§6.3, from the
 * chip bar that stamped an `AlertTriangle` on every chip including a count of AI drafts):
 *
 *   `refusal`    — a channel refused these coordinates. Danger ink, assertive. INTERACTIVE.
 *   `slow`       — readiness has not answered yet, so nothing below it can be trusted. Muted.
 *   `provenance` — the read is not what it appears: stale schema, no cached schema, contract
 *                  mismatch, adapted read. Warning ink.
 *   `hint`       — the keyboard hint. It occupies the slot only while nothing above it does; it
 *                  teaches a gesture learned once, and it is what you can afford to lose while
 *                  something is wrong (§6.5).
 *
 * WHY THE SLOT IS THIS SLOT. The studio used to carry refusals in a band above the sheet. The band
 * was conditional, so it moved every band below it 31px when it appeared and `GridSheet` sizes
 * itself from its own top edge — the grid resized under the operator. Removing it traded a layout
 * defect for a quieter one: the refusal's only visible text became scope-chip tooltips and
 * `Publish ▾`, i.e. hover. UX.1 priced a 28px reserved track (0.8 of a row; 89.4% → 86.3% of
 * viewport, back under ruling #169) and rejected it. So a note takes the HINT's place in the strip
 * that already exists, and the strip's height never changes.
 *
 * 🔴 `onShow` is REQUIRED on `refusal`, and that is the whole enforcement. A count of work must be a
 * view (§6.2 rule 1); an optional handler would permit a refusal that leads nowhere, which is the
 * hover-only bug wearing a button's clothes. The union below makes "a count you cannot act on"
 * unrepresentable rather than merely discouraged.
 *
 * 🔴 There is deliberately no `onDismiss`, and adding one is a design change, not a feature. An
 * honest message may never be dismissable into silence; the prop being ABSENT rather than optional
 * is what turns that from a convention every caller can forget into something the type refuses.
 *
 * 🔴 `title` is ADDITIVE. Hover may elaborate; hover may never be the only way to the reason. That
 * is the specific rule that stops this rebuilding the surface it replaced.
 *
 * 🔴 A collapsible full list is NOT here. The strip sits inside `.nds-gridcard`, which is
 * `overflow: hidden` to round its corners, so an absolutely-positioned panel is painted, invisible
 * and un-hit-testable (`reference_gridcard_clips_dropdowns`, the same trap three times over in this
 * codebase). A detail surface must be portalled and fixed — the DS popover primitive's job, not a
 * footer span's. `onShow` narrowing the sheet IS the detail surface; `more` states the scale.
 *
 * Sized for the strip, not for the page: the DS `Banner` is the page-scale callout and is the wrong
 * instrument here (18px icon, title, description, action slot, dismiss). Measured in situ — see the
 * height note in `grid.css` before changing any font size or padding.
 *
 * Tokens: only the `*-text` / `--nds-text-*` inks, all of which flip under `.dark` (verified
 * 2026-09-01: `--nds-danger-text` #9c2f2a → #ef9c93, `--nds-warning-text` #6d3f10 → #f0b46a,
 * `--nds-text-2` #5b6573 → #aab6c2). `--nds-warning`/`--nds-danger` and the `--nds-note-*` /
 * `--nds-tonal-*` families are absent from both `.dark` blocks and would hold their light values on
 * a dark surface; `--nds-warning-border` does not flip either (measured `warningBorderFlips: false`).
 * None of them are used here.
 *
 * Requires `design-system/grid/theme/grid.css`.
 */
import type { ReactNode } from 'react'
import { AlertTriangle, AlertCircle, Clock, WifiOff } from 'lucide-react'

export type GridSheetNoteKind = 'offline' | 'refusal' | 'slow' | 'provenance' | 'hint'

/** Priority when more than one could occupy the slot — index 0 wins. §6.5. */
/*
 * `offline` outranks even a refusal. While the connection is gone, "3 cells blocked" describes the
 * wrong world — nothing was blocked by a rule, the server was never reached — and it points the
 * operator at their data when the thing to know is that we are not talking to the server. It is
 * also the only one of these that resolves itself, so it holds the slot briefly and gives it back.
 */
export const GRID_SHEET_NOTE_PRIORITY: readonly GridSheetNoteKind[] = ['offline', 'refusal', 'slow', 'provenance', 'hint']

interface NoteCommon {
  /** Additive elaboration only — never the sole home of the reason. */
  title?: string
  className?: string
}

interface RefusalNote extends NoteCommon {
  kind: 'refusal'
  /** How many coordinates are blocked. */
  count: number
  /** What is being counted, singular. Pluralised for you: "coordinate" / "row" / "cell". */
  noun?: string
  /** ONE example, already phrased — "Amazon · DE needs 7 fields". A list here is the band again. */
  lead?: ReactNode
  /** REQUIRED. Narrow the sheet to the affected coordinates. See the note above on why. */
  onShow: () => void
  children?: never
  more?: never
}

interface MessageNote extends NoteCommon {
  kind: 'offline' | 'slow' | 'provenance' | 'hint'
  /** The message, in words, always visible. Never a count on its own. */
  children: ReactNode
  /** How many further coordinates this reason covers — rendered `· N more`. */
  more?: number
  count?: never
  onShow?: never
}

export type GridSheetNoteProps = RefusalNote | MessageNote

const GLYPH: Record<GridSheetNoteKind, ReactNode> = {
  offline: <WifiOff size={13} aria-hidden />,
  refusal: <AlertCircle size={13} aria-hidden />,
  slow: <Clock size={13} aria-hidden />,
  provenance: <AlertTriangle size={13} aria-hidden />,
  hint: null,
}

export function GridSheetNote(props: GridSheetNoteProps) {
  const { kind, title, className } = props
  const cls = ['nds-grid-sheet-note', kind, className].filter(Boolean).join(' ')

  if (props.kind === 'refusal') {
    const { count, noun = 'coordinate', lead, onShow } = props
    // Rendering "0 blocked" is a claim that nothing is wrong, made by the one thing whose job is to
    // say something is. A caller with nothing to refuse renders a different kind.
    if (count <= 0) return null
    return (
      // A button, not `role="alert"`: overriding the role on an interactive element would announce
      // the text and destroy the affordance that makes the count a view. `aria-live` is a global
      // attribute, so it makes this a live region WITHOUT clobbering the button semantics.
      <button type="button" className={cls} onClick={onShow} title={title} aria-live="assertive">
        <span className="nds-grid-sheet-note-glyph">{GLYPH.refusal}</span>
        <span className="nds-grid-sheet-note-count">
          {count.toLocaleString('en-GB')} {count === 1 ? noun : `${noun}s`} blocked
        </span>
        {lead != null && (
          <>
            <span className="nds-grid-sheet-note-sep" aria-hidden>
              ·
            </span>
            <span className="nds-grid-sheet-note-text">{lead}</span>
          </>
        )}
      </button>
    )
  }

  const { children, more } = props
  return (
    <span className={cls} role="status" aria-live="polite" title={title}>
      {GLYPH[kind] != null && <span className="nds-grid-sheet-note-glyph">{GLYPH[kind]}</span>}
      <span className="nds-grid-sheet-note-text">{children}</span>
      {more !== undefined && more > 0 && <span className="nds-grid-sheet-note-more">· {more} more</span>}
    </span>
  )
}
