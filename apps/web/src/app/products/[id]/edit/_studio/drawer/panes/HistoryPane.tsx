'use client'

/**
 * PES.4.5 — who changed this, when, from what, on which layer.
 *
 * Decision C, 2026-09-01: show it honestly rather than hide the pane until the write path records
 * an author. Hiding it makes the gap invisible and permanent; naming it in the place an operator
 * looks for the answer is what gets it fixed.
 *
 * PES.5 §4 now fills `by` and `previous` for the single-product write path the studio autosaves
 * through — which does NOT make this pane's honesty machinery redundant. Two holes remain by
 * design: every row written before that change, and every catalogue-wide bulk-op after it. So
 * `coverageSince` is rendered at the top of the list, a row with no author says so, and a row
 * with no previous value says the previous value was not recorded — never an em dash standing in
 * for a name, never an empty string standing in for "we don't know", and never the row below
 * borrowed as if it were the prior state.
 */

import { useState } from 'react'
import { AlertTriangle, Clock, Info } from 'lucide-react'
import { Button } from '@/design-system/primitives/Button'
import { SegmentedControl } from '@/design-system/primitives/SegmentedControl'
import { Select } from '@/design-system/primitives/Select'
import { Spinner } from '@/design-system/primitives/Spinner'
import { LAYER_LABEL, previousWasRecorded, toLayer, type FieldHistoryEntry, type SheetColumn } from '../types'
import type { FieldHistoryState } from '../useFieldHistory'
import { RestoreMode, type RestoreModeProps } from './RestoreMode'
import { when } from '../format'
import styles from '../drawer.module.css'

function preview(v: unknown): string {
  if (v == null) return 'empty'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 140 ? `${s.slice(0, 140)}…` : s
}

/**
 * Two questions, one pane (Owner, 2026-09-01: a MODE, not a fifth pane).
 *
 *   Field history — what happened to THIS field: who, when, old→new, on which layer.
 *   Restore       — what did the RECORD look like at a moment, and put some of it back.
 *
 * They stay distinct in the UI because they are distinct questions; folding the record-level one
 * into the field list would have made "restore" mean two things depending on where you clicked.
 */
export function HistoryPane({
  fieldLabel,
  columns,
  fieldKey,
  onPickField,
  history,
  restore,
}: {
  fieldLabel: string | null
  /** §14.3 — the tab chooses its own subject rather than sending the operator to another tab. */
  columns: SheetColumn[]
  fieldKey: string | null
  onPickField: (key: string | null) => void
  history: FieldHistoryState
  /** Absent while the drawer has no row — the mode switch hides rather than offering a dead tab. */
  restore?: RestoreModeProps
}) {
  const [mode, setMode] = useState<'field' | 'restore'>('field')

  if (restore) {
    return (
      <>
        <div className={styles.modeBar}>
          <SegmentedControl
            ariaLabel="History mode"
            size="sm"
            value={mode}
            onChange={(v) => setMode(v as 'field' | 'restore')}
            options={[
              { value: 'field', label: 'Field history' },
              { value: 'restore', label: 'Restore record' },
            ]}
          />
        </div>
        {mode === 'restore' ? (
          <RestoreMode {...restore} />
        ) : (
          <>
            <FieldPicker columns={columns} fieldKey={fieldKey} onPickField={onPickField} />
            <FieldHistory fieldLabel={fieldLabel} history={history} />
          </>
        )}
      </>
    )
  }

  return (
    <>
      <FieldPicker columns={columns} fieldKey={fieldKey} onPickField={onPickField} />
      <FieldHistory fieldLabel={fieldLabel} history={history} />
    </>
  )
}

/** The verb this tab is named after (§14.3). Same control as the Compare tab's, same reason. */
function FieldPicker({
  columns,
  fieldKey,
  onPickField,
}: {
  columns: SheetColumn[]
  fieldKey: string | null
  onPickField: (key: string | null) => void
}) {
  return (
    <div className={styles.compareBar}>
      <Select
        size="sm"
        value={fieldKey ?? ''}
        aria-label="Field to show history for"
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
  )
}

function FieldHistory({ fieldLabel, history }: { fieldLabel: string | null; history: FieldHistoryState }) {
  if (!fieldLabel) {
    return (
      <div className={`${styles.note} ${styles.noteInfo}`}>
        <Info size={14} className={styles.noteIcon} aria-hidden />
        <span>Choose a field above, or the ⟲ beside any attribute on the Record tab.</span>
      </div>
    )
  }

  if (history.status === 'loading' && history.entries.length === 0) {
    return (
      <div className={`${styles.note} ${styles.noteInfo}`}>
        <Spinner size={14} />
        <span>Reading the audit trail for {fieldLabel}…</span>
      </div>
    )
  }

  if (history.status === 'unavailable') {
    return (
      <div className={`${styles.note} ${styles.noteWarn}`}>
        <AlertTriangle size={14} className={styles.noteIcon} aria-hidden />
        <span>
          The per-field history API has not shipped yet (PES.5). This is not “nothing has changed” — it is “nothing
          can be read”. The rows exist in <code>AuditLog</code>, <code>ChannelListingOverride</code> and{' '}
          <code>ProductEvent</code>; they have no single endpoint yet.
        </span>
      </div>
    )
  }

  if (history.status === 'error') {
    return (
      <div className={`${styles.note} ${styles.noteError}`}>
        <AlertTriangle size={14} className={styles.noteIcon} aria-hidden />
        <span>
          Could not read the history for {fieldLabel}: {history.error}.{' '}
          <Button variant="link" inline size="xs" onClick={history.reload}>
            Try again
          </Button>
        </span>
      </div>
    )
  }

  // An empty list means two completely different things depending on this one field, and the
  // difference is "nobody has touched it" versus "nothing was watching".
  if (history.entries.length === 0 && history.coverageNote) return <p className={styles.note}>{history.coverageNote}</p>

  if (history.entries.length === 0) {
    return history.coverageSince ? (
      <div className={`${styles.note} ${styles.noteInfo}`}>
        <Clock size={14} className={styles.noteIcon} aria-hidden />
        <span>
          No recorded change to {fieldLabel} on this scope since {when(history.coverageSince)}, which is as far
          back as per-cell history goes.
        </span>
      </div>
    ) : (
      <div className={`${styles.note} ${styles.noteWarn}`}>
        <AlertTriangle size={14} className={styles.noteIcon} aria-hidden />
        <span>
          Per-cell history is not being recorded yet, so this is not “{fieldLabel} has never changed” — it is
          “nothing was watching”. Edits made from here on will appear.
        </span>
      </div>
    )
  }

  return (
    <>
      <div className={`${styles.note} ${styles.noteInfo}`} style={{ marginBottom: 8 }}>
        <Clock size={14} className={styles.noteIcon} aria-hidden />
        <span>
          {history.coverageNote ?? (history.coverageSince
            ? `Per-cell history goes back to ${when(history.coverageSince)}. Anything earlier was not recorded.`
            : 'Per-cell history has no recorded start date, so older changes may exist without being listed.')}
        </span>
      </div>
      {history.entries.map((e, i) => (
        // The contract carries no row id, so the key is the change's own coordinates. `i` breaks
        // the tie for two writes to one field in the same millisecond.
        <HistoryRow key={`${e.at}:${e.fieldKey}:${i}`} entry={e} />
      ))}
    </>
  )
}

function HistoryRow({ entry }: { entry: FieldHistoryEntry }) {
  return (
    <div className={styles.hEntry}>
      <span className={styles.hWhen}>{when(entry.at)}</span>
      <span className={entry.by ? styles.hWho : `${styles.hWho} ${styles.hWhoUnknown}`}>
        {entry.by ?? 'author not recorded'}
      </span>

      <div className={styles.hDiff}>
        {/* "We don't know what it was" and "it was blank" are different claims, and an operator
            acts on the second. `previousWasRecorded` reads the server's explicit flag when it is
            there (hub ruling #14) and the payload's shape until then. */}
        {previousWasRecorded(entry) ? (
          <span className={styles.hOld}>{preview(entry.previous)}</span>
        ) : (
          <span className={styles.hOldUnknown}>previous value not recorded</span>
        )}
        <span aria-hidden>→</span>
        <span className={styles.hNew}>{preview(entry.next)}</span>
      </div>

      <div className={styles.hMeta}>
        {LAYER_LABEL[toLayer(entry.layer)]} · via {entry.source}
      </div>
    </div>
  )
}
