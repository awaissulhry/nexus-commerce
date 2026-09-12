'use client'

/**
 * IO.1 — the import drawer (D15.4 / D15.11): file → diff → apply, in a DS `Drawer`, never a page.
 *
 * ── The rule the whole surface is built around ──────────────────────────────────────────────────
 * 🔴 **Nothing writes until the operator has applied a diff they saw.** Not "usually", not "unless
 * the file is small": the Apply control does not exist in step 1, and in step 2 it is offered only
 * when `applyBlockedReason` returns null. Every refusal is a SENTENCE rendered beside the control —
 * a disabled button with no explanation is the state an operator cannot get out of
 * (`reference_disabled_control_cannot_explain`).
 *
 * ── What this component is NOT allowed to decide ────────────────────────────────────────────────
 * Every count, verdict, sentence and block reason comes from `diffModel.ts`, which is pure and
 * tested (63 cases, 4/4 mutations killed). This file arranges them. That split is deliberate: the
 * failures worth fearing here are wrong NUMBERS and reassuring words over bad states, and neither
 * is catchable in a component the node suite cannot render (`reference_test_scoping_and_hidden_assertions`).
 *
 * ── Dark, and saying so ─────────────────────────────────────────────────────────────────────────
 * ── LIVE since #561 ─────────────────────────────────────────────────────────────────────────────
 * PES.5's endpoint shipped at 07:34:15 and this drawer now writes to the real catalogue. The
 * migration was one line, as designed: `liveTransport` reports `darkNote: null`, so the at-rest
 * banner and the "Applying is not available" footer removed themselves.
 *
 * The dark machinery stays and is not dead code. A transport that cannot write still announces
 * itself AT REST (#535) rather than first at the diff step — an operator who uploads a real file
 * must never learn afterwards that nothing could apply — and `applyBlockedReason` still refuses
 * through the payload's fixture flag as a second, independent guard, because a LIVE transport
 * returning fixture-flagged data is a state nobody designed for and must shout rather than write.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Banner, Drawer, FileDropzone } from '@/design-system/components'
import { Button, SegmentedControl } from '@/design-system/primitives'
import { GridPanel, NexusGrid } from '@/design-system/grid'

import { readCellVerdict, verifyImportDiff, type BlankCellMode, type ImportDiff, type ImportJob } from './contract'
import {
  applyBlockedReason,
  applyLabel,
  blankModeDisagreement,
  blankModeSentence,
  collapsedRowSentence,
  composeRowId,
  darkNoteFor,
  EXPANDED_ROW_LIMIT,
  hiddenColumnSentence,
  listingWriteWarning,
  orderedDiffRows,
  pinSentence,
  reconcileCounts,
  summariseDiff,
  visibleColumnKeys,
} from './diffModel'
import { buildDiffColumns, toGridRows, type DiffGridRow } from './diffColumns'
import { ImportJobPanel } from './ImportJobPanel'
import { ImportContractError, ImportNotShipped, liveTransport, type ImportTransport } from './transport'

import styles from './import.module.css'

/** 5MB, matching `PATCH /api/products/bulk`'s own `bodyLimit` — one number, not two. */
const MAX_FILE_BYTES = 5 * 1024 * 1024

/**
 * 🔴 MODULE-LEVEL, not an inline arrow — `check-grid-option-identity` caught this and was right.
 *
 * An inline callback is a new identity on every render, and AG re-runs its column model for each
 * (GDS decision 12). It is the same defect family as the `= []` prop default that repainted 651
 * cells: a prop the grid INVOKES on demand must never carry a changing identity.
 *
 * The fallback matters as much as the hoist. `rowId` is null exactly when the alias could not be
 * resolved (D15.13.3), and AG needs SOME stable key — so an unmatched row is keyed by its file
 * line, which is unique within a file and, unlike a guessed `primary:<productId>`, cannot collide
 * with a real sheet row id. Keying it as if it were a real row is how a diff row would come to
 * point at a listing nobody chose.
 */
const diffRowId = (prm: { data: DiffGridRow }): string =>
  prm.data.rowId ?? `unmatched:${prm.data.row.line ?? prm.data.row.sku}`

export interface ImportDrawerProps {
  open: boolean
  onClose: () => void
  /** The coordinate the sheet was on. The import writes THERE and nowhere else (D15.3). */
  scope: ImportDiff['scope']
  productId: string
  /**
   * Defaults to `liveTransport(productId, scope)` — live since #587. Still injectable: the fixture
   * transport keeps the node suite and the design lab honest.
   *
   * Still injectable, because the fixture transport keeps two real jobs: the node suite, and the
   * design lab, where a surface must be drivable through every state (`PARTIAL`, an unknown verdict,
   * an unresolved alias) without a server that can produce them on demand.
   */
  transport?: ImportTransport
  /**
   * Called after an apply settles, so the sheet can re-read. Passed the job, because a `PARTIAL`
   * job means the sheet and the file now disagree in ways only the outcomes list explains.
   */
  onApplied?: (job: ImportJob) => void
  /** D15.9's template download, when the scope has one. Absent renders a stated reason, not silence. */
  onDownloadTemplate?: () => void
  templateHint?: string
}

type Step = 'file' | 'diff' | 'apply'

export function ImportDrawer(p: ImportDrawerProps) {
  const [step, setStep] = useState<Step>('file')
  const [blankCells, setBlankCells] = useState<BlankCellMode>('ignore')
  const [file, setFile] = useState<File | null>(null)
  const [diff, setDiff] = useState<ImportDiff | null>(null)
  const [job, setJob] = useState<ImportJob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [contractProblems, setContractProblems] = useState<string[]>([])
  const [showAllRows, setShowAllRows] = useState(false)

  /*
   * 🔴 LIVE (#587). PES.5's route conformed at 07:53:04 and this drawer writes to the real
   * catalogue.
   *
   * The hold that preceded this is worth keeping in view: #561 ruled it live once already, I
   * flipped it, and the endpoint then failed this lane's own `verifyImportDiff` with four problems.
   * The guard caught it, not a review. So the acceptance for THIS switch was the same verifier run
   * against the live route — measured, not assumed — plus a walk of all four original divergences
   * as a checklist, because a conform can land partly.
   *
   * `darkNote` is null on the live transport, so the at-rest banner and the "Applying is not
   * available" footer remove themselves. The fixture stays for the node suite and the design lab,
   * where a surface must be drivable through states no server produces on demand.
   */
  const transport = useMemo(
    () => p.transport ?? liveTransport(p.productId, p.scope),
    [p.transport, p.productId, p.scope],
  )

  /**
   * 🔴 One in-flight request, and it is ABORTED when superseded — `useStudioRead`'s guarantee, kept
   * by hand because this is a POST with a file body rather than a GET that hook could own. A slow
   * first parse landing after a fast second one would replace the diff the operator is reading with
   * one for a file they already replaced.
   */
  const inflight = useRef<AbortController | null>(null)
  useEffect(() => () => inflight.current?.abort(), [])

  const reset = useCallback(() => {
    inflight.current?.abort()
    setStep('file')
    setFile(null)
    setDiff(null)
    setJob(null)
    setError(null)
    setContractProblems([])
    setShowAllRows(false)
  }, [])

  const close = useCallback(() => {
    /*
     * 🔴 A running job is NOT cancelled by closing the drawer, and the job panel says so in those
     * words. Closing a window cannot stop a server-side write, and a drawer that implied it could
     * would leave an operator believing they had aborted an import that is still writing.
     */
    reset()
    p.onClose()
  }, [reset, p])

  const runDiff = useCallback(
    async (picked: File, mode: BlankCellMode) => {
      inflight.current?.abort()
      const controller = new AbortController()
      inflight.current = controller
      setBusy(true)
      setError(null)
      setContractProblems([])
      try {
        const result = await transport.diff({ file: picked, blankCells: mode, signal: controller.signal })
        if (controller.signal.aborted) return
        // Belt and braces: the live transport already verifies, the fixture one does not go through
        // it. One parse, both paths — a fixture that skipped the gate would be a fixture testing a
        // render path production never uses.
        setContractProblems(verifyImportDiff(result))
        setDiff(result)
        setStep('diff')
      } catch (e) {
        if (controller.signal.aborted) return
        if (e instanceof ImportContractError) {
          setContractProblems(e.problems)
          setError(e.message)
        } else if (e instanceof ImportNotShipped) {
          setError(e.message)
        } else {
          setError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false)
      }
    },
    [transport],
  )

  const onFiles = useCallback(
    (files: File[]) => {
      const picked = files[0]
      if (!picked) return
      setFile(picked)
      void runDiff(picked, blankCells)
    },
    [runDiff, blankCells],
  )

  /**
   * Changing the blank-cell mode RE-DIFFS rather than re-labelling the diff in hand.
   *
   * The mode changes what the server would do, so a diff taken under `ignore` does not describe an
   * apply under `clear` — every blank cell in the file becomes a deletion. Re-using the old diff
   * would show the operator one thing and apply another, which is the exact failure D15.4 exists to
   * prevent. Cheap here: a family diff is ≤50 rows.
   */
  const onBlankMode = useCallback(
    (next: string) => {
      const mode = next as BlankCellMode
      setBlankCells(mode)
      if (file) void runDiff(file, mode)
    },
    [file, runDiff],
  )

  const onApply = useCallback(async () => {
    if (!diff) return
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    setBusy(true)
    setError(null)
    try {
      /*
       * D15.15: the diff token IS the job, and `applyBlockedReason` has already refused if there is
       * no `jobId` — so by here it exists. Non-null asserted rather than defaulted: a `?? ''` would
       * turn a guard failure into a request against a job called "", which the server would refuse
       * with a message about a missing job rather than about the real fault here.
       */
      const started = await transport.apply({ jobId: diff.jobId!, signal: controller.signal })
      if (controller.signal.aborted) return
      setJob(started)
      setStep('apply')
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [diff, transport])

  /* ── what the diff step shows ─────────────────────────────────────────────────────────────── */

  const view = useMemo(() => {
    if (!diff) return null
    const ordered = orderedDiffRows(diff.rows ?? [])
    const shown = showAllRows ? ordered : ordered.slice(0, EXPANDED_ROW_LIMIT)
    const { keys, hidden } = visibleColumnKeys(ordered)
    return {
      ordered,
      shown,
      keys,
      hidden,
      gridRows: toGridRows(shown, composeRowId),
      columns: buildDiffColumns({ keys, columns: diff.columns }),
      reconciliation: reconcileCounts(diff),
      blocked: applyBlockedReason(diff, blankCells, contractProblems),
      disagreement: blankModeDisagreement(blankCells, diff.blankCells),
    }
  }, [diff, showAllRows, blankCells, contractProblems])

  /*
   * 🔴 Read from the TRANSPORT first, so it is on screen the moment the drawer opens (#535).
   *
   * This used to read `diff.isFixture`, which is null until a diff exists — so the warning arrived
   * only AFTER the operator had chosen a file and waited for a parse. PES.2 caught it on their
   * screen. `darkNoteFor` keeps the payload as a second, independent source, because a live
   * transport returning fixture-flagged data is a state nobody designed for and it must still shout.
   */
  const darkNote = darkNoteFor(transport.darkNote, diff)

  /*
   * The grid's height follows the rows it holds rather than a constant, so a two-row diff is not a
   * 480px box with 440px of nothing in it (`feedback_no_dead_space_layouts`). Capped, because a
   * drawer cannot hand scrolling to the page the way a card can.
   */
  const gridHeight = view ? Math.min(480, 96 + view.gridRows.length * 44) : 200

  return (
    <Drawer
      open={p.open}
      onClose={close}
      width={step === 'file' ? 520 : 980}
      title="Import"
      subtitle={
        <span className={styles.scope}>
          {p.scope.label}
          {file && ` · ${file.name}`}
        </span>
      }
      footer={
        <div className={styles.footer}>
          <span className={styles.footerNote}>
            {step === 'diff' && view?.blocked}
            {step === 'file' &&
              /*
               * 🔴 The at-rest line is TRUE of a live import, which is exactly why it was
               * misleading here: on a dark drawer it describes a flow that cannot happen. The
               * banner above says the drawer cannot write; this line must not simultaneously
               * describe applying (#535).
               */
              (darkNote
                ? 'You can upload a file and read the diff. Applying is not available.'
                : 'Nothing is written until you have seen the diff and applied it.')}
          </span>
          {step !== 'file' && (
            <Button size="sm" onClick={reset} disabled={busy}>
              Start over
            </Button>
          )}
          {step === 'diff' && diff && (
            <Button size="sm" variant="primary" onClick={onApply} disabled={busy || view?.blocked != null}>
              {applyLabel(diff.counts)}
            </Button>
          )}
          <Button size="sm" onClick={close}>
            Close
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        {darkNote && (
          <Banner tone="warning" title="This drawer cannot write" className={styles.fixtureBanner}>
            {darkNote}
          </Banner>
        )}

        {error && (
          <div className={styles.problem} role="alert">
            {error}
          </div>
        )}

        {/* ── step 1: the file ─────────────────────────────────────────────────────────────── */}
        {step === 'file' && (
          <div className={styles.step}>
            <FileDropzone
              onFiles={onFiles}
              accept=".csv"
              maxBytes={MAX_FILE_BYTES}
              disabled={busy}
              hint={p.templateHint ?? 'A CSV exported from this sheet — Export ▾ → All attributes gives a full template. Row 1 is the English header, row 2 the key; the file you exported is the file you import (D15.1).'}
            />

            <div className={styles.option}>
              <div className={styles.optionRow}>
                <span className={styles.optionLabel}>Blank cells</span>
                <SegmentedControl
                  ariaLabel="What a blank cell in the file should do"
                  size="sm"
                  value={blankCells}
                  onChange={onBlankMode}
                  options={[
                    { value: 'ignore', label: 'Ignore' },
                    { value: 'clear', label: 'Clear' },
                  ]}
                />
              </div>
              <p className={styles.note}>
                {blankModeSentence(blankCells)}{' '}
                {blankCells === 'clear'
                  ? 'Every empty cell in the file will empty the value it sits on. A column you leave out of the file entirely is still ignored.'
                  : 'A column you leave out of the file entirely is ignored either way.'}
              </p>
            </div>

            <p className={styles.note}>
              {p.onDownloadTemplate ? (
                <Button size="sm" onClick={p.onDownloadTemplate}>
                  Download template
                </Button>
              ) : (
                <span>
                  No template download on this scope yet — the template endpoint (D15.9) is PES.5’s and has not
                  shipped. Export the sheet and edit that file instead; it is the same shape.
                </span>
              )}
            </p>

            {busy && <p className={styles.note}>Reading the file…</p>}
          </div>
        )}

        {/* ── step 2: the diff ─────────────────────────────────────────────────────────────── */}
        {step === 'diff' && diff && view && (
          <div className={styles.step}>
            {contractProblems.length > 0 && (
              <div className={styles.problem} role="alert">
                <strong>This response does not match the agreed contract.</strong>
                <ul>
                  {contractProblems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            )}

            {view.disagreement && (
              <div className={styles.problem} role="alert">
                {view.disagreement}
              </div>
            )}

            {view.reconciliation.map((problem) => (
              <div key={problem} className={styles.problem} role="alert">
                {problem}
              </div>
            ))}

            <div className={styles.stepHead}>
              <span className={styles.summary}>{summariseDiff(diff)}</span>
              <span className={styles.note}>{blankModeSentence(diff.blankCells)}</span>
            </div>

            {/*
              🔴 #577 — a master-scope file that would nevertheless write a LIVE listing.
              Rendered as a problem, not a note: the six prefixed columns sit beside ordinary master
              columns in the same export, and this is the difference between editing a spreadsheet
              and editing what buyers see.
            */}
            {listingWriteWarning(diff) && (
              <div className={styles.problem} role="alert">
                {listingWriteWarning(diff)}
              </div>
            )}

            {pinSentence(diff.counts.wouldPin) && (
              <p className={`${styles.note} ${styles.noteStrong}`}>{pinSentence(diff.counts.wouldPin)}</p>
            )}

            {/* #357: what this view cannot see, in the server's own words, rendered always. */}
            {diff.coverageNote && <p className={styles.note}>{diff.coverageNote}</p>}

            {diff.truncated && (
              <p className={`${styles.note} ${styles.noteStrong}`}>
                {diff.truncated.note} Showing {diff.truncated.rowsReturned} of {diff.truncated.rowsTotal} rows.
              </p>
            )}

            {view.ordered.length === 0 ? (
              /*
               * D15.1's acceptance test, as a rendered sentence. A blank grid cannot tell "the round
               * trip is clean" from "the parse produced nothing", and only one of those means the
               * feature works.
               */
              <Banner tone="success" title="Nothing in this file changes anything">
                Every cell matches the sheet’s current values. This is what a clean export → import round
                trip looks like.
              </Banner>
            ) : (
              <>
                <GridPanel className={styles.grid}>
                  <NexusGrid<DiffGridRow>
                    rowData={view.gridRows}
                    columnDefs={view.columns}
                    height={gridHeight}
                    density="compact"
                    getRowId={diffRowId}
                    suppressCellFocus
                  />
                </GridPanel>

                <p className={styles.note}>
                  {collapsedRowSentence(view.shown.length, view.ordered.length)}{' '}
                  {hiddenColumnSentence(view.hidden)}{' '}
                  {!showAllRows && view.ordered.length > view.shown.length && (
                    <Button size="sm" onClick={() => setShowAllRows(true)}>
                      Show all {view.ordered.length} rows
                    </Button>
                  )}
                </p>
              </>
            )}

            {(diff.unmatchedRows?.length ?? 0) > 0 && (
              <div className={styles.step}>
                <span className={styles.optionLabel}>Lines that match no row in this family</span>
                <ul className={styles.unmatched}>
                  {diff.unmatchedRows!.map((u) => (
                    <li key={`${u.line}`} className={styles.unmatchedItem}>
                      <span className={styles.unmatchedKey}>Line {u.line}</span>
                      {u.sku ? ` · ${u.sku}` : ''} — {u.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {(diff.unmatchedColumns?.length ?? 0) > 0 && (
              <div className={styles.step}>
                <span className={styles.optionLabel}>Columns that will not be written</span>
                <ul className={styles.unmatched}>
                  {diff.unmatchedColumns!.map((u) => (
                    <li key={u.header} className={styles.unmatchedItem}>
                      <span className={styles.unmatchedKey}>{u.header}</span> — {u.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Informational columns (an empty key cell) are ignored by design — the export writes
                them for humans. Counted and named, so "ignored" is a fact on screen, not a silence. */}
            {(diff.ignoredColumns?.length ?? 0) > 0 && (
              <p className={styles.note}>
                {diff.ignoredColumns!.length} informational {diff.ignoredColumns!.length === 1 ? 'column' : 'columns'} ignored
                {' '}({diff.ignoredColumns!.join(', ')}) — no key on row 2, nothing to write.
              </p>
            )}
          </div>
        )}

        {/* ── step 3: the job ──────────────────────────────────────────────────────────────── */}
        {step === 'apply' && job && (
          <ImportJobPanel
            job={job}
            diff={diff}
            transport={transport}
            onJob={(next) => {
              setJob(next)
              p.onApplied?.(next)
            }}
          />
        )}
      </div>
    </Drawer>
  )
}

/** Re-exported so a caller can count a diff's verdicts without reaching into the contract module. */
export { readCellVerdict }
