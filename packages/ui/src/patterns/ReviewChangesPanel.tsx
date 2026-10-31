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
 * tabs, each change names its tab in `group`; an empty tab is left out), a Result's own `tone`, `doneLine` (the
 * host's own Done line when counting results cannot say it: "Asked · waits for approval") and `lead` (a form above it
 * all, whose table the host recomputes as it is filled in: the Bid page's Change bid). Rules:
 * `reviewChangesPanelModel.ts`.
 *
 * On a phone (≤ 760 px, 2026-10-26) the table is a list of cards, one per change: Where, What, Now → New, Note and Result
 * each on their own line, so nothing scrolls sideways (`reviewCardFields`). Automatic; the words are the table's.
 */
import { useId, useState, type ReactNode } from 'react'

import { Button, Checkbox, Tag } from '../primitives'
import { Banner } from '../components/Banner'
import { MetricStrip, type Metric } from '../components/MetricStrip'
import { KeyValue } from '../components/KeyValue'
import { SummaryTable } from '../components/SummaryTable'
import { Tabs, tabPanelProps } from '../components/Tabs'
import { ackWords, doneSummary, raiseCount, resultWords, reviewColumns, reviewNote, reviewTitle, type ReviewState } from './reviewChangesModel'
import {
  activeGroup, changesIn, groupCounts, resultTone, reviewCardFields,
  type ReviewGroup, type ReviewPanelChange, type ReviewPanelResult,
} from './reviewChangesPanelModel'
import { mergeLabels } from '../lib/labels'
import { REVIEW_CHANGES_LABELS, type ReviewChangesLabels } from './ReviewChangesModalLabels'

/** "Now → New", with the arrow said as "to". */
const NowToNew = ({ now, next, to = ' to ' }: { now: ReactNode; next: ReactNode; to?: string }) => (
  <>{now} <span aria-hidden="true">→</span><span className="nds-vh">{to}</span> {next}</>
)

/** A column key of `reviewColumns` in the person's words; the rules keep the English keys. */
const columnWords = (words: ReviewChangesLabels): Readonly<Record<string, string>> =>
  ({ Where: words.where, What: words.what, Now: words.now, New: words.next, Result: words.result, Note: words.note })

/** The review's changes on a phone: one card per change, each column on its own line (`reviewCardFields`). */
function ReviewCards({ label, columns, rows, words }: { label: string; columns: readonly string[]; rows: ReadonlyArray<{ id: string; cells: readonly ReactNode[] }>; words: ReviewChangesLabels }) {
  const heading = columnWords(words)
  return (
    <ul className="nds-review-cards" aria-label={label}>
      {rows.map((row) => (
        <li key={row.id} className="nds-review-card">
          <KeyValue dense items={reviewCardFields(columns, row.cells).map((f) => f.kind === 'change'
            ? { label: <NowToNew now={words.now} next={words.next} to={words.to} />, value: <NowToNew now={f.now} next={f.next} to={words.to} /> }
            : { label: heading[f.label] ?? f.label, value: f.value })} />
        </li>
      ))}
    </ul>
  )
}

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
  /** A form above everything else (a bulk change's How and value): the host recomputes `changes` as it is filled in.
   *  Not shown once done. */
  lead?: ReactNode
  /** Its words in the person's language (B-W2b-04), shared with `ReviewChangesModal`. Default English; `label`,
   *  `ackLabel`, `doneVerb` and `doneLine` win where they apply. */
  labels?: Partial<ReviewChangesLabels>
}

export function ReviewChangesPanel({
  changes, state = { phase: 'ready' }, label, metrics, problems = [], warnings = [], ackLabel, ack, onAckChange, onRetry,
  doneVerb = 'saved', groups = [], doneLine, lead, labels,
}: ReviewChangesPanelProps) {
  const words = mergeLabels(REVIEW_CHANGES_LABELS, labels)
  const idBase = useId()
  const [wanted, setWanted] = useState<string | null>(null)
  const count = changes.length
  const raises = raiseCount(changes)
  const done = state.phase === 'done'
  const saving = state.phase === 'saving'
  const result = done ? doneLine ?? doneSummary(changes, state.results, doneVerb, words) : null
  const tabs = groupCounts(changes, groups)
  const tab = activeGroup(tabs, wanted)
  const shown = changesIn(changes, groups, tab)
  const columns = reviewColumns(shown, done)
  const hasWhere = columns[0] === 'Where'
  const hasLast = columns[columns.length - 1] !== 'New'
  const rows = shown.map((c) => {
    const r = done ? (state.results[c.id] as ReviewPanelResult | undefined) : undefined
    const last = done ? (r ? <Tag tone={resultTone(r)}>{resultWords(c, r, words)}</Tag> : '—') : reviewNote(c, words)
    return { id: c.id, cells: [...(hasWhere ? [c.where ?? ''] : []), c.what, c.now, c.next, ...(hasLast ? [last] : [])] }
  })
  const tableLabel = done ? words.whatWas(doneVerb) : label ?? reviewTitle(count, words)
  const heading = columnWords(words)
  // Both forms, the stylesheet shows one (≤ 760 px: the cards); the hidden one is out of the accessibility tree too.
  const table = <>
    <SummaryTable label={tableLabel} columns={columns.map((key) => heading[key] ?? key)} rows={rows} />
    <ReviewCards label={tableLabel} columns={columns} rows={rows} words={words} />
  </>

  return (
    <div className="nds-review">
      {!done && lead}
      {result && <p className={`nds-review-line ${result.tone}`} role="status">{result.line}</p>}
      {state.phase === 'reading' && <p className="nds-review-line" role="status">{words.reading}</p>}
      {state.phase === 'failed' && (
        <Banner tone="danger" title={words.failedTitle} action={onRetry ? <Button size="sm" onClick={onRetry}>{words.tryAgain}</Button> : undefined}>
          {state.error} {words.failedBody}
        </Banner>
      )}
      {state.phase === 'ready' && !!state.conflicts?.length && (
        <Banner tone="warning" title={words.conflictsTitle}>
          <ul className="nds-review-list">{state.conflicts.map((c, i) => <li key={i}>{words.conflict(c.label, c.was, c.now)}</li>)}</ul>
        </Banner>
      )}
      {!done && problems.length > 0 && (
        <Banner tone="danger" title={words.problemsTitle}>
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
        <Checkbox checked={ack} disabled={saving} onChange={(e) => onAckChange(e.target.checked)} label={ackLabel ?? ackWords(raises, words)} />
      )}
    </div>
  )
}
