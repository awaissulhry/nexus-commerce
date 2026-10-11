'use client'

/**
 * ReviewChangesPanel — the review's body without the Modal frame (Keyword Harvest page, lane HTO, 2026-10-11; design
 * gap H2). `ReviewChangesModal` renders it inside its dialog; a window whose review is a STEP ("Harvest to…": set up →
 * Review → Done in one dialog, never a dialog on a dialog) renders it in its own body and keeps its own footer.
 *
 * The same body as the modal: the Done line, "Reading…", the failed read with Try again, conflicts, problems that hold
 * Save, optional tiles, one table (Where · What · Now · New · Note, a Result once done) and the one tick for a change
 * that lets automation do more. The tick is the HOST's state (`ack` / `onAckChange`) because the host's Save reads it
 * (`saveHeldReason`). Optional, for a step: `warnings` (lines that inform and never hold Save), `groups` (the table in
 * tabs, each change names its tab in `group`; an empty tab is left out), a Result's own `tone`, and `doneLine` (the
 * host's own Done line when counting results cannot say it: "Asked · waits for approval"). Rules:
 * `reviewChangesPanelModel.ts`.
 */
import { useId, useState, type ReactNode } from 'react'

import { Button, Checkbox, Tag } from '../primitives'
import { Banner } from '../components/Banner'
import { MetricStrip, type Metric } from '../components/MetricStrip'
import { SummaryTable } from '../components/SummaryTable'
import { Tabs, tabPanelProps } from '../components/Tabs'
import { ackWords, doneSummary, raiseCount, resultWords, reviewColumns, reviewNote, reviewTitle, type ReviewState } from './reviewChangesModel'
import {
  activeGroup, changesIn, groupCounts, resultTone,
  type ReviewGroup, type ReviewPanelChange, type ReviewPanelResult,
} from './reviewChangesPanelModel'

export interface ReviewChangesPanelProps {
  changes: readonly ReviewPanelChange[]
  /** Default `{ phase: 'ready' }`. */
  state?: ReviewState
  /** The table's name (the review's title). Default "Review 3 changes"; once done "What was saved". */
  label?: string
  /** Optional tiles above the table. */
  metrics?: Metric[]
  /** Problems that hold Save, one sentence each. */
  problems?: readonly string[]
  /** Lines that inform and never hold Save ("2 terms left out: …"). Not shown once done. */
  warnings?: readonly ReactNode[]
  /** Replaces the default acknowledgement sentence. */
  ackLabel?: string
  /** The one tick (a change that lets automation do more): the host's state, since its Save reads it. */
  ack: boolean
  onAckChange: (ack: boolean) => void
  /** The re-read failed: "Try again". */
  onRetry?: () => void
  /** The verb the Done line counts a result under when it names none. Default "saved". */
  doneVerb?: string
  /** The table in tabs, in this order ("Keywords", "Negatives"); each change names its tab in `group`. */
  groups?: readonly ReviewGroup[]
  /** The host's own Done line, when counting the results cannot say it (may hold a live part: a `Countdown`). */
  doneLine?: { line: ReactNode; tone: 'success' | 'warning' | 'danger' }
}

export function ReviewChangesPanel({
  changes, state = { phase: 'ready' }, label, metrics, problems = [], warnings = [], ackLabel, ack, onAckChange, onRetry,
  doneVerb = 'saved', groups = [], doneLine,
}: ReviewChangesPanelProps) {
  const idBase = useId()
  const [wanted, setWanted] = useState<string | null>(null)
  const count = changes.length
  const raises = raiseCount(changes)
  const done = state.phase === 'done'
  const saving = state.phase === 'saving'
  const result = done ? doneLine ?? doneSummary(changes, state.results, doneVerb) : null
  const tabs = groupCounts(changes, groups)
  const tab = activeGroup(tabs, wanted)
  const shown = changesIn(changes, groups, tab)
  const columns = reviewColumns(shown, done)
  const hasWhere = columns[0] === 'Where'
  const hasLast = columns[columns.length - 1] !== 'New'
  const rows = shown.map((c) => {
    const r = done ? (state.results[c.id] as ReviewPanelResult | undefined) : undefined
    const last = done ? (r ? <Tag tone={resultTone(r)}>{resultWords(c, r)}</Tag> : '—') : reviewNote(c)
    return { id: c.id, cells: [...(hasWhere ? [c.where ?? ''] : []), c.what, c.now, c.next, ...(hasLast ? [last] : [])] }
  })
  const tableLabel = done ? `What was ${doneVerb}` : label ?? reviewTitle(count)
  const table = <SummaryTable label={tableLabel} columns={columns} rows={rows} />

  return (
    <div className="nds-review">
      {result && <p className={`nds-review-line ${result.tone}`} role="status">{result.line}</p>}
      {state.phase === 'reading' && <p className="nds-review-line" role="status">Reading today&apos;s values, so “Now” is true. Save waits for it.</p>}
      {state.phase === 'failed' && (
        <Banner tone="danger" title="Save is held" action={onRetry ? <Button size="sm" onClick={onRetry}>Try again</Button> : undefined}>
          {state.error} Nexus reads them again before it saves, so it never overwrites a value it has not shown you.
        </Banner>
      )}
      {state.phase === 'ready' && !!state.conflicts?.length && (
        <Banner tone="warning" title="Changed since you opened this page">
          <ul className="nds-review-list">{state.conflicts.map((c, i) => <li key={i}>{c.label}: was {c.was}, now {c.now}</li>)}</ul>
        </Banner>
      )}
      {!done && problems.length > 0 && (
        <Banner tone="danger" title="Fix these before you save">
          <ul className="nds-review-list">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </Banner>
      )}
      {!done && warnings.length > 0 && (
        <Banner tone="warning">
          {warnings.length === 1 ? warnings[0] : <ul className="nds-review-list">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        </Banner>
      )}
      {!done && metrics && metrics.length > 0 && <MetricStrip metrics={metrics} />}
      {tabs.length > 0 && tab !== null ? (
        <>
          <Tabs ariaLabel={tableLabel} idBase={idBase} tabs={tabs.map((t) => ({ id: t.id, label: t.label, count: t.count }))} active={tab} onChange={setWanted} overflow="scroll" />
          <div className="nds-review-table" {...tabPanelProps(idBase, tab)}>{table}</div>
        </>
      ) : (
        <div className="nds-review-table">{table}</div>
      )}
      {!done && raises > 0 && (
        <Checkbox checked={ack} disabled={saving} onChange={(e) => onAckChange(e.target.checked)} label={ackLabel ?? ackWords(raises)} />
      )}
    </div>
  )
}
