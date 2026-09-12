'use client'

/**
 * PES.4.6 — current value against master, another locale, another alias, with copy-across.
 *
 * The semantics come from `DiffVsMasterPanel` (PIM B.3), which answered one question — "where does
 * this channel diverge from master" — for five SSOT fields. This generalises it to any field and
 * any pair of coordinates, and adds the verb that panel deliberately left out ("accept channel
 * value into master" was its documented out-of-scope B.3b).
 *
 * ── Why this is NOT a grid (hub ruling #17 offered NexusGrid or a DS non-table layout) ──
 *
 * It was a raw `<table>`, which was wrong — that is what the grid-kit ratchet caught. But the fix
 * is not AG Grid, and the reason is mechanical rather than aesthetic:
 *
 *   1. The dock is non-modal SO THAT the sheet behind it keeps its keyboard. A second AG Grid
 *      inside the panel would give the page two grids both claiming the arrow keys, with no way
 *      for an operator to see which one has focus. That is a correctness problem the drawer's
 *      whole design exists to avoid.
 *   2. The shape is one field × a handful of coordinates — not a matrix. Rendered as columns in a
 *      380–900px panel, five targets get ~70px each, which is why the table needed a horizontal
 *      scroller. Needing one inside a drawer was the smell.
 *   3. Each cell is a chip, a value that may be a paragraph of HTML, a copy button and a note.
 *      That is card content, not a cell.
 *
 * So: one section per field, one row per coordinate — the same card idiom as the Listings pane, so
 * the two panes read alike. If compare ever grows to many fields at once, the sections stack and
 * it is still not a grid.
 *
 * Two rules the copy button obeys:
 *   1. A copy is a WRITE on the target's scope, through the host's mutator — the same
 *      `PATCH /api/products/bulk` every other edit uses. No compare-specific write path, because
 *      a second write path is a second provenance story.
 *   2. Copying ONTO a value someone pinned asks first, through the drawer's own overlay confirm.
 *      Copying onto an inherited value does not — nothing is being destroyed.
 */

import { AlertTriangle, ArrowRight, Check, Info } from 'lucide-react'
import { Button } from '@/design-system/primitives/Button'
import { Select } from '@/design-system/primitives/Select'
import { Spinner } from '@/design-system/primitives/Spinner'
import { ProvenanceChip } from '../fields/ProvenanceChip'
import { isInherited, type CompareCell, type CompareRow, type SheetColumn } from '../types'
import type { CompareState } from '../useCompare'
import styles from '../drawer.module.css'

function show(v: unknown): string {
  if (v == null || v === '') return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 220 ? `${s.slice(0, 220)}…` : s
}

export interface ComparePaneProps {
  /** The scope the drawer is open on — its value is the one copies are made FROM. */
  sourceTargetId: string
  compare: CompareState
  onCopy: (row: CompareRow, from: CompareCell, to: CompareCell) => void
  /** Every column of this scope — the pane chooses its own subject (§14.3). */
  columns: SheetColumn[]
  /** The field being compared, or null. */
  fieldKey: string | null
  onPickField: (key: string | null) => void
}

/**
 * §14.3 — the tab carries its own verb.
 *
 * Compare used to be reachable ONLY from a per-field icon on the Record tab: 97 of them, one per
 * field, for a pane that shows one field at a time. The tab itself was then a surface with no way
 * to do the thing it is named after — open it directly and it asked you to go somewhere else. The
 * icons are gone (#330) and the choice lives here, where the result appears.
 */
export function ComparePane({
  sourceTargetId,
  compare,
  onCopy,
  columns,
  fieldKey,
  onPickField,
}: ComparePaneProps) {
  return (
    <>
      <div className={styles.compareBar}>
        <Select
          size="sm"
          value={fieldKey ?? ''}
          aria-label="Field to compare"
          onChange={(e) => onPickField(e.target.value || null)}
        >
          <option value="">Choose a field…</option>
          {columns.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </Select>
      </div>
      <CompareBody sourceTargetId={sourceTargetId} compare={compare} onCopy={onCopy} />
    </>
  )
}

function CompareBody({
  sourceTargetId,
  compare,
  onCopy,
}: Pick<ComparePaneProps, 'sourceTargetId' | 'compare' | 'onCopy'>) {
  if (compare.status === 'idle') {
    // 🔴 Two different facts both arrive as `idle`, and telling an operator the wrong one is worse
    // than saying nothing. No targets means the HOST wired none — picking a field will never help,
    // so "pick a field" would blame the operator for a state they cannot act on. Measured on the
    // eBay scope, where `ChannelSheet` passes `compareTargets={[]}`: a field was selected and the
    // pane still asked for one.
    if (compare.targets.length === 0) {
      return (
        <div className={`${styles.note} ${styles.noteInfo}`}>
          <Info size={14} className={styles.noteIcon} aria-hidden />
          <span>No other scopes are wired to compare against on this sheet.</span>
        </div>
      )
    }
    return (
      <div className={`${styles.note} ${styles.noteInfo}`}>
        <Info size={14} className={styles.noteIcon} aria-hidden />
        <span>Choose a field above to compare it across scopes.</span>
      </div>
    )
  }

  if (compare.status === 'loading') {
    return (
      <div className={`${styles.note} ${styles.noteInfo}`}>
        <Spinner size={14} />
        <span>Reading the other coordinates…</span>
      </div>
    )
  }

  if (compare.status === 'unavailable') {
    return (
      <div className={`${styles.note} ${styles.noteWarn}`}>
        <AlertTriangle size={14} className={styles.noteIcon} aria-hidden />
        <span>
          The studio sheet read has not shipped yet (PES.5 §3.2), so nothing is being compared. This is not a claim
          that the scopes agree.
        </span>
      </div>
    )
  }

  if (compare.status === 'error') {
    return (
      <div className={`${styles.note} ${styles.noteError}`}>
        <AlertTriangle size={14} className={styles.noteIcon} aria-hidden />
        <span>
          Could not compare: {compare.error}.{' '}
          <Button variant="link" inline size="xs" onClick={compare.reload}>
            Try again
          </Button>
        </span>
      </div>
    )
  }

  if (compare.rows.length === 0) {
    return (
      <div className={`${styles.note} ${styles.noteInfo}`}>
        <Info size={14} className={styles.noteIcon} aria-hidden />
        <span>No field selected to compare.</span>
      </div>
    )
  }

  return (
    <>
      {compare.rows.map((row) => {
        const source = row.cells.find((c) => c.targetId === sourceTargetId)
        return (
          <section key={row.key} className={styles.cmpGroup}>
            {compare.rows.length > 1 && <h3 className={styles.cmpField}>{row.label}</h3>}
            <ul className={styles.cmpList}>
              {row.cells.map((cell) => (
                <CompareItem
                  key={cell.targetId}
                  cell={cell}
                  source={source}
                  isSource={cell.targetId === sourceTargetId}
                  onCopy={() => source && onCopy(row, source, cell)}
                />
              ))}
            </ul>
          </section>
        )
      })}
    </>
  )
}

function CompareItem({
  cell,
  source,
  isSource,
  onCopy,
}: {
  cell: CompareCell
  source: CompareCell | undefined
  isSource: boolean
  onCopy: () => void
}) {
  const same = source != null && show(cell.value) === show(source.value)
  const value = show(cell.value)

  return (
    <li className={`${styles.cmpItem}${isSource ? ` ${styles.cmpHere}` : ''}`}>
      <div className={styles.cmpHead}>
        <span className={styles.cmpTarget}>
          {cell.label}
          {isSource && <span className={styles.cmpHereTag}>this record</span>}
        </span>
        {cell.exists && <ProvenanceChip layer={cell.layer} />}
        {/* Agreement is worth stating, not just worth inferring from two identical strings the
            operator has to read twice. */}
        {!isSource && cell.exists && same && (
          <span className={styles.cmpSameTag}>
            <Check size={11} aria-hidden /> same
          </span>
        )}
        {!isSource && cell.exists && !same && source && (
          <Button
            size="xs"
            variant="ghost"
            className={styles.cmpCopy}
            disabled={cell.readOnlyReason != null}
            // A disabled control must be able to say why it is disabled.
            title={cell.readOnlyReason ?? `Copy this record’s value into ${cell.label}`}
            onClick={onCopy}
          >
            <ArrowRight size={11} aria-hidden /> Copy here
          </Button>
        )}
      </div>

      {/* "No listing here" and "a listing with an empty value" are different facts, and the
          operator acts differently on each. */}
      {!cell.exists ? (
        <p className={styles.absent}>{cell.readOnlyReason ?? 'No listing on this coordinate.'}</p>
      ) : value === '' ? (
        <p className={styles.absent}>empty</p>
      ) : (
        <p className={same && !isSource ? styles.cmpValueSame : styles.cmpValue}>{value}</p>
      )}

      {cell.exists && isInherited(cell.layer) && !isSource && (
        <p className={styles.cmpNote}>Tracks its source — a copy here pins it.</p>
      )}
    </li>
  )
}
