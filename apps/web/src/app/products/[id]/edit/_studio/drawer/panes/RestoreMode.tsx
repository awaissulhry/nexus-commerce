'use client'

/**
 * PES.4.10 — the record as it stood, and putting it back.
 *
 * A MODE inside the History pane, not a fifth pane (Owner, 2026-09-01). The two answer different
 * questions — per-field history is "what happened to THIS field", this is "what did the RECORD
 * look like" — and the mode switch is what keeps both readable without a second home for the word
 * "restore".
 *
 * ## What this restore does, exactly, because the copy must not overstate it
 *
 * Master restore is a DIFFERENT mechanism from the listing snapshot/restore of PES.5 §12, and
 * conflating them would be the expensive mistake here. §12's listing restore writes captured values
 * onto a `ChannelListing` and sets `isPublished = false`; it has an `undoSnapshotId`; the
 * marketplace keeps serving the old content until someone publishes. NONE of that applies here:
 * `POST /products/:id/restore` (§12.1) rewrites the MASTER record's own scalar fields through the
 * same `AuditLog` trail as an ordinary edit, and makes **no channel call at all** (verified in the
 * handler — one `product.update`, an audit write, an event; no `masterContentService`, no publish).
 *
 * So the confirm says what is true of THIS mechanism: the master record changes, the values being
 * replaced are recorded first (so the restore is itself undoable and appears in each field's
 * history), and nothing is pushed to a marketplace by this action.
 *
 * ## `uncertain` fields are EXCLUDED, not defaulted off
 *
 * Owner decision, and it is the right one: the server grades a field `uncertain` when it changed
 * after the chosen time and no prior value was ever recorded. Restoring one would write a value
 * NOBODY HAS — an invention wearing the costume of a rollback. They are listed with the reason, so
 * the operator sees what cannot be recovered rather than wondering why the list is short.
 */

import { useCallback, useMemo, useState } from 'react'
import { AlertTriangle, History, Info, RotateCcw } from 'lucide-react'
import { Button } from '@/design-system/primitives/Button'
import { Checkbox } from '@/design-system/primitives/Checkbox'
import { Spinner } from '@/design-system/primitives/Spinner'
import type { DrawerConfirmApi } from '../DrawerConfirm'
import { notRestorableReason, type FieldCoverage, type RecordStateResult } from '../useRecordState'
import { notRestorablePointReason, type RestorePoint, type RestorePointsState } from '../useRestorePoints'
import { ago, when } from '../format'
import { PressableRow } from '@/design-system/components/PressableRow'
import styles from '../drawer.module.css'


function show(v: unknown): string {
  if (v == null || v === '') return '(empty)'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 160 ? `${s.slice(0, 160)}…` : s
}

const COVERAGE_WORD: Record<FieldCoverage, string> = {
  unchanged: 'unchanged since',
  reconstructed: 'recovered',
  uncertain: 'not recorded',
}

export interface RestoreModeProps {
  productId: string
  recordState: RecordStateResult
  /** The moments that actually hold changes (#366) — this pane no longer invents instants. */
  restorePoints: RestorePointsState
  confirm: DrawerConfirmApi
  /** Runs the write; the host owns nothing here — see the header. */
  onRestore: (
    at: string,
    fields: Record<string, unknown>,
  ) => Promise<{ ok: boolean; message?: string; currentVersion?: number }>
  /** Receives the version the restore produced, when the server returned one. */
  onRestored: (currentVersion?: number) => void
  /** The formula verb (#488) — a different write from `onRestore`, not a mode of it. */
  onRestoreFormula: (auditLogId: string) => Promise<{ ok: boolean; message?: string }>
}

export function RestoreMode({ recordState, restorePoints, confirm, onRestore, onRestored, onRestoreFormula }: RestoreModeProps) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const data = recordState.data
  const at = data?.reconstructedAt ?? null

  /**
   * The fields the SERVER says changed — not the ones a client-side diff thinks changed.
   *
   * `coverage` is the endpoint's own answer and it is sparse ON PURPOSE: a field absent from it
   * saw no edit after the chosen time, so there is nothing to restore. Measured on GALE-JACKET,
   * 3 of 93 state fields carry coverage. Deriving the list by comparing values instead produced 28
   * rows — every internal column the endpoint happens to return (`createdAt`, `categoryAttributes`,
   * `amazonAsin`…) plus false "(empty) → value" diffs from the keyspace mismatch. Asking the
   * server which fields moved is both shorter and correct.
   */
  const rows = useMemo(() => {
    if (!data) return []
    return Object.entries(data.coverage)
      .filter(([, coverage]) => coverage !== 'unchanged')
      .map(([field, coverage]) => ({
        field,
        was: data.state[field],
        now: data.current?.[field],
        coverage,
        blocked: notRestorableReason(field, coverage),
      }))
      .sort((a, b) => Number(!!a.blocked) - Number(!!b.blocked) || a.field.localeCompare(b.field))
  }, [data])

  const restorable = rows.filter((r) => !r.blocked)
  const blocked = rows.filter((r) => r.blocked)

  const run = useCallback(async () => {
    if (!at || picked.size === 0) return
    const chosen = rows.filter((r) => picked.has(r.field) && !r.blocked)
    const ok = await confirm.confirm({
      title: `Restore ${chosen.length} field${chosen.length === 1 ? '' : 's'} to ${new Date(at).toLocaleString()}?`,
      body: (
        <>
          <p>These master values are overwritten with the values from that time:</p>
          <ul>
            {chosen.slice(0, 8).map((r) => (
              <li key={r.field}>
                <strong>{r.field}</strong>: {show(r.now)} → {show(r.was)}
              </li>
            ))}
            {chosen.length > 8 && <li>…and {chosen.length - 8} more</li>}
          </ul>
          {/* Every true thing the operator needs, and nothing that overstates it. */}
          <p>
            The values being replaced are recorded first, so this restore appears in each field&rsquo;s history
            and can itself be undone.
          </p>
          <p>
            This writes the <strong>master record</strong>, so it affects every channel that inherits these
            fields — but it makes no marketplace call: nothing is published by restoring.
          </p>
          {data?.warnings?.map((w) => (
            <p key={w}>
              <strong>Note:</strong> {w}
            </p>
          ))}
        </>
      ),
      confirmLabel: `Restore ${chosen.length} field${chosen.length === 1 ? '' : 's'}`,
      tone: 'danger',
      acknowledge: 'I have read what will be overwritten',
    })
    if (!ok) return
    setBusy(true)
    setResult(null)
    const fields = Object.fromEntries(chosen.map((r) => [r.field, r.was]))
    const res = await onRestore(at, fields)
    setBusy(false)
    setResult(res.ok ? `Restored ${chosen.length} field${chosen.length === 1 ? '' : 's'}.` : (res.message ?? 'Restore failed.'))
    if (res.ok) {
      setPicked(new Set())
      onRestored(res.currentVersion)
    }
    // Depends on the stable `confirm.confirm` callback, not the whole api object — the second half
    // of #153's fix, and the half that keeps working even if a future hook forgets to memoise.
  }, [at, picked, rows, confirm.confirm, onRestore, onRestored, data])

  /**
   * A formula point does NOT go through the reconstruction flow.
   *
   * There is nothing to reconstruct and nothing to tick: it is one audit row, one field, one
   * expression, restored by re-creating the formula and re-evaluating. Sending it through the
   * field checklist would ask the operator to choose master scalars for a write that touches none.
   */
  const runFormula = useCallback(
    async (point: RestorePoint) => {
      const f = point.formula
      if (!f) return
      const ok = await confirm.confirm({
        title: 'Re-apply this formula?',
        body: (
          <>
            <p>
              This puts the formula back on <strong>{f.fieldKey}</strong> and recalculates it, replacing
              whatever literal value was typed over it.
            </p>
            {f.expr ? (
              <p>
                The formula being restored: <code>{f.expr}</code>
              </p>
            ) : (
              // 🔴 Never an opaque id dressed up as a formula. `expr` is nullable on the wire.
              <p>
                The expression was not recorded on this entry, so it cannot be shown here — the server
                restores it from the pinned row either way.
              </p>
            )}
            <p>
              Re-evaluating may cascade to cells that depend on this one. It writes no marketplace:
              nothing is published by restoring.
            </p>
          </>
        ),
        confirmLabel: 'Re-apply formula',
        tone: 'danger',
        acknowledge: 'I have read what will be recalculated',
      })
      if (!ok) return
      setBusy(true)
      setResult(null)
      const res = await onRestoreFormula(f.auditLogId)
      setBusy(false)
      setResult(res.ok ? `Formula re-applied to ${f.fieldKey}.` : (res.message ?? 'Could not re-apply the formula.'))
      if (res.ok) onRestored(undefined)
    },
    [confirm.confirm, onRestoreFormula, onRestored],
  )

  return (
    <>
      {/* 🔴 The free `datetime-local` is gone (#366), and `min`/`max` with it.
          Bounding an input to the first and last restorable point would have been an improvement to
          a control that should not exist: an operator picking 14:32 is asking a question whose true
          answer is "the same as the last recorded change", because nothing happened at 14:32. The
          list IS the history, so there is no arbitrary instant left to bound. */}
      <RestorePointList
        points={restorePoints}
        selected={at}
        busy={recordState.status === 'loading'}
        onPick={(iso) => recordState.load(iso)}
        onPickFormula={runFormula}
      />

      {/**
        * 🔴 The outcome renders HERE, outside the reconstruction branch, because both flows report
        * through it and only one of them loads a reconstruction.
        *
        * It used to sit in the master restore's footer, inside `recordState.status === 'ready' &&
        * data`. A formula restore never loads a reconstruction, so that block never renders and the
        * message was unreachable: measured end-to-end — the write returned 200, the formula was
        * re-created, and the operator saw NOTHING. A silent success is the same defect class as a
        * silent failure; it just fails the other way, and the person is left clicking again.
        */}
      {result && (
        <div className={`${styles.note} ${styles.noteInfo}`}>
          <span>{result}</span>
        </div>
      )}

      {recordState.status === 'idle' && restorePoints.status === 'ready' && restorePoints.points.length > 0 && (
        <div className={`${styles.note} ${styles.noteInfo}`}>
          <History size={14} className={styles.noteIcon} aria-hidden />
          <span>
            Choose a moment above to see what this record held then. Values are reconstructed from what was
            recorded about the changes since — not from a stored copy, so some fields cannot be recovered.
          </span>
        </div>
      )}

      {recordState.status === 'loading' && (
        <div className={`${styles.note} ${styles.noteInfo}`}>
          <Spinner size={14} />
          <span>Walking the audit trail back…</span>
        </div>
      )}

      {recordState.status === 'unavailable' && (
        <div className={`${styles.note} ${styles.noteWarn}`}>
          <AlertTriangle size={14} className={styles.noteIcon} aria-hidden />
          <span>Time-travel is not available on this API build.</span>
        </div>
      )}

      {recordState.status === 'error' && (
        <div className={`${styles.note} ${styles.noteError}`}>
          <AlertTriangle size={14} className={styles.noteIcon} aria-hidden />
          <span>Could not reconstruct: {recordState.error}</span>
        </div>
      )}

      {recordState.status === 'ready' && data && (
        <>
          {/* Server-authored. Rendered verbatim — re-deriving these is how the old modal's tags
              became a guess. */}
          {data.warnings.map((w) => (
            <div key={w} className={`${styles.note} ${styles.noteWarn}`}>
              <AlertTriangle size={14} className={styles.noteIcon} aria-hidden />
              <span>{w}</span>
            </div>
          ))}

          {rows.length === 0 ? (
            <div className={`${styles.note} ${styles.noteInfo}`}>
              <Info size={14} className={styles.noteIcon} aria-hidden />
              <span>Nothing differs between now and then — there is nothing to restore.</span>
            </div>
          ) : (
            <>
              {restorable.map((r) => (
                <label key={r.field} className={styles.restoreRow}>
                  <Checkbox
                    checked={picked.has(r.field)}
                    onChange={(e) =>
                      setPicked((s) => {
                        const n = new Set(s)
                        if (e.target.checked) n.add(r.field)
                        else n.delete(r.field)
                        return n
                      })
                    }
                  />
                  <span className={styles.restoreField}>
                    <span className={styles.cmpTarget}>{r.field}</span>
                    <span className={styles.hMeta}>{COVERAGE_WORD[r.coverage]}</span>
                    <span className={styles.hDiff}>
                      <span className={styles.hOld}>{show(r.now)}</span>
                      <span aria-hidden>→</span>
                      <span className={styles.hNew}>{show(r.was)}</span>
                    </span>
                  </span>
                </label>
              ))}

              {/* Shown, never omitted: an operator must see what cannot be recovered rather than
                  wondering why the list is shorter than the change they remember. */}
              {blocked.length > 0 && (
                <div className={styles.restoreBlocked}>
                  <div className={styles.cmpField}>Cannot be restored ({blocked.length})</div>
                  {blocked.map((r) => (
                    <div key={r.field} className={styles.restoreRow}>
                      <span className={styles.restoreField}>
                        <span className={styles.cmpTarget}>{r.field}</span>
                        <span className={styles.absent}>{r.blocked}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className={styles.restoreFoot}>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={picked.size === 0 || busy}
                  title={picked.size === 0 ? 'Tick the fields to restore' : undefined}
                  onClick={() => void run()}
                >
                  <RotateCcw size={12} aria-hidden /> {busy ? 'Restoring…' : `Restore ${picked.size || ''}`.trim()}
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}

/**
 * The recorded moments, newest first.
 *
 * 🔴 A `restorable: false` row is rendered and NOT clickable, with its reason in text on the row.
 * Hiding it would omit real history — the change happened — and enabling it would promise a write
 * `POST /restore` refuses, since it accepts master scalar columns only. The reason is text rather
 * than a `title`, because an explanation that lives only on a disabled control is unreachable to
 * the person who most needs it: disabled controls take no hover on touch and no focus by keyboard.
 */
function RestorePointList({
  points,
  selected,
  busy,
  onPick,
  onPickFormula,
}: {
  points: RestorePointsState
  selected: string | null
  busy: boolean
  onPick: (iso: string) => void
  onPickFormula: (point: RestorePoint) => void
}) {
  if (points.status === 'loading') {
    return (
      <div className={`${styles.note} ${styles.noteInfo}`}>
        <Spinner size={14} />
        <span>Reading the recorded moments…</span>
      </div>
    )
  }

  if (points.status === 'unavailable') {
    return (
      <div className={`${styles.note} ${styles.noteWarn}`}>
        <AlertTriangle size={14} className={styles.noteIcon} aria-hidden />
        <span>The restore-points read has not shipped on this API build.</span>
      </div>
    )
  }

  if (points.status === 'error') {
    return (
      <div className={`${styles.note} ${styles.noteError}`}>
        <AlertTriangle size={14} className={styles.noteIcon} aria-hidden />
        <span>Could not read the recorded moments: {points.error}.</span>
      </div>
    )
  }

  if (points.status === 'ready' && points.points.length === 0) {
    // 🔴 "No moments" and "moments exist but none records values" are different facts, and the
    // coverage block is what tells them apart. Measured on a real product: 23 audit rows, all
    // image-publish events, 0 points. Without this sentence that reads as "nothing ever happened".
    const c = points.coverage
    return (
      <div className={`${styles.note} ${styles.noteInfo}`}>
        <Info size={14} className={styles.noteIcon} aria-hidden />
        <span>
          {c && c.auditRowsScanned > 0
            ? `No moment here can be restored. ${c.auditRowsScanned} recorded ${
                c.auditRowsScanned === 1 ? 'row' : 'rows'
              }, of which ${c.eventRowsExcluded} record an event rather than values${
                c.unreadableRowsExcluded > 0 ? ` and ${c.unreadableRowsExcluded} could not be read` : ''
              }.`
            : 'Nothing has been recorded for this record yet.'}
        </span>
      </div>
    )
  }

  return (
    <ul className={styles.rpList}>
      {points.points.map((p) => (
        <RestorePointRow
          key={p.at}
          point={p}
          selected={p.at === selected}
          busy={busy}
          onPick={onPick}
          onPickFormula={onPickFormula}
        />
      ))}
    </ul>
  )
}

function RestorePointRow({
  point,
  selected,
  busy,
  onPick,
  onPickFormula,
}: {
  point: RestorePoint
  selected: boolean
  busy: boolean
  onPick: (iso: string) => void
  onPickFormula: (point: RestorePoint) => void
}) {
  const reason = notRestorablePointReason(point)
  const n = point.restorableFields.length
  return (
    <li className={`${styles.rpRow} ${selected ? styles.rpRowOn : ''}`}>
      {/* A SELECTION, so `current` — not `active`. Clicking loads that moment; it is the current
          one of a set, which is what `aria-current` says and `aria-pressed` would not. */}
      <PressableRow
        className={styles.rpBtn}
        disabled={!point.restorable || busy}
        current={selected}
        // 🔴 Routed on `restoreVia`, never on the action name (#482). A formula pin goes straight
        // to its own verb: there is nothing to reconstruct and no field checklist to fill in.
        onClick={() => (point.restoreVia === 'formula' ? onPickFormula(point) : onPick(point.at))}
        // Both spans are the NAME: "3 hours ago · update · someone · 1 field restorable" is what an
        // operator would say to mean this row. The meta is not `children`, which would sit outside
        // the accessible name and leave rows named only by a relative time.
        label={
          <>
            <span className={styles.rpWhen}>
          <time dateTime={point.at} title={when(point.at)}>
            {ago(point.at)}
              </time>
            </span>
            {/* 🔴 An explicit separator, because the two spans are ONE accessible name and adjacent
                elements concatenate with nothing between them. Read from the tree, the name was
                "53 seconds agoupdate" — the defect is invisible on screen, where the spans are laid
                out apart, and invisible in the props, where they are two children. */}
            {' · '}
            <span className={styles.rpMeta}>
          {point.action}
          {point.actor ? ` · ${point.actor}` : ''}
          {/* The row says which verb it is, so the two are distinguishable before clicking. */}
          {point.restoreVia === 'formula'
            ? ` · formula on ${point.formula?.fieldKey ?? 'a field'}`
            : point.restorable
              ? ` · ${n} field${n === 1 ? '' : 's'} restorable`
              : ''}
            </span>
          </>
        }
      />
      {reason && <span className={styles.rpReason}>{reason}</span>}
    </li>
  )
}
