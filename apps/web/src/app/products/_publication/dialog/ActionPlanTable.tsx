'use client'

/**
 * Sheet publish parity, build shape v2 (Owner 2026-10-04), phase P10 — the ONE table of a market tab in the Publish
 * window: tick · SKU · what · what is sent · set by (`actionPlanRows`, danger rows first).
 *
 * - A **Partial update** row's tick sends its default fields; the row opens to today's field ticks (`PublicationChanges`).
 * - A **Full update** row says "Everything is sent" and opens to the fields it sends and what it removes on the channel.
 * - A **lifecycle** row (Active, Inactive, Ended, Delete) shows the server's sentence, its warning and what the channel
 *   checks only when sending. A refused row stays waiting: its tick is off and locked, the row says why.
 * - Rows that send nothing (held, blocked, "No longer applies") stay in the table, quiet, with the reason.
 * - S10: a live Amazon listing moved to its own SKU reads "[Move to NEW]" (a danger row: it deletes OLD), never Partial or
 *   Full update, with "Creates NEW on Amazon · IT as a new offer, then deletes OLD there.".
 * - Delete and relist: a row Nexus deleted whose Status is Not listed reads "[Not listed] Left out" (unticked, locked,
 *   the server's sentence); a row its Status lists again reads "[Full update]" with "Lists GALE-M on ASIN … (was …)."
 *   and its warning.
 * - New listings: a row this Publish creates reads "[Full update]" (sent whole), and its first line says what it creates
 *   ("Creates GALE-M · Inactive — buyers cannot buy it yet."); a row whose Status is Not listed reads "[Not listed] Left
 *   out", held, quiet.
 * The words of Action and Status are the design system's (`PublishActionView`, `SellingStatusView`). The table owns only
 * which rows are open; every tick goes back to the window through `onTicksChange`.
 */
import { useCallback, useState } from 'react'
import { moveModeLabel, type StudioPublishReview } from '@nexus/shared/studio-publication'
import { Button, Checkbox, Pill } from '@/design-system/primitives'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { PublishActionView, SellingStatusView, SEND_MODE_WORD, STATUS_TARGET_WORD } from '@/design-system/grid'
import { PublicationChanges } from './PublicationChanges'
import { EVERYTHING_SENT, NOT_LISTED_ASIDE, NO_LONGER_APPLIES, STARTS_UNTICKED, toggleRowTicks, withProductTicks, type ActionPlanRow } from './actionPlan'
import styles from './publication.module.css'

export interface ActionPlanTableProps {
  rows: ActionPlanRow[]
  /** The market's content review (its field changes), or null when no content goes out here. */
  review: StudioPublishReview | null
  selectedIds: string[]
  lifecycleIds: string[]
  /** Nothing can change: a publish is under way or done, or the window is busy. */
  locked: boolean
  /** "Listings in this publish to Amazon · IT". */
  ariaLabel: string
  now: number
  onTicksChange(next: { selectedIds: string[]; lifecycleIds: string[] }): void
}

/** The row's value in words, for the tick's accessible name. */
function whatWord(row: ActionPlanRow): string {
  if (row.what.column === 'status') return STATUS_TARGET_WORD[row.what.target]
  if (row.what.column === 'move') return moveModeLabel(row.what.to)
  return SEND_MODE_WORD[row.what.mode]
}

function WhatCell({ row, now }: { row: ActionPlanRow; now: number }) {
  if (row.kind === 'outgrown') {
    return <span className={styles.whatCell}><Pill tone="neutral">{whatWord(row)}</Pill><span className={styles.quiet}>{NO_LONGER_APPLIES}</span></span>
  }
  const what = row.what
  // New listings: Publish leaves this row out — its Status, never a waiting value.
  if (what.column === 'status' && what.target === 'not_listed') {
    return <span className={styles.whatCell}><Pill tone="neutral">{STATUS_TARGET_WORD.not_listed}</Pill><span className={styles.quiet}>{NOT_LISTED_ASIDE}</span></span>
  }
  if (what.column === 'status') {
    return <SellingStatusView value={{ state: what.state, waiting: { target: what.target, setAt: what.setAt, setByName: what.setByName } }} now={now} />
  }
  // S10 — a moved Amazon listing: neither Partial nor Full update — the create of NEW, then the delete of OLD.
  if (what.column === 'move') return <span className={styles.whatCell}><Pill tone="danger">{moveModeLabel(what.to)}</Pill></span>
  return <PublishActionView value={{ mode: what.mode, setAt: what.setAt, setByName: what.setByName, ...(what.newRow ? { newRow: true } : {}) }} now={now} />
}

export function ActionPlanTable({ rows, review, selectedIds, lifecycleIds, locked, ariaLabel, now, onTicksChange }: ActionPlanTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const toggleOpen = useCallback((key: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  }), [])
  const tick = (row: ActionPlanRow, on: boolean) => onTicksChange(toggleRowTicks(row, on, { selectedIds, lifecycleIds }))

  const columns: Array<Column<ActionPlanRow>> = [
    // Widths fit the window's 620 px body at desktop; a phone scrolls the table sideways, ticks and SKUs first. What is
    // wide enough for "Inactive · now Active" (the waiting value and the live state beside it) without cutting it.
    { key: 'tick', label: <span className="nds-vh">Send</span>, width: 40, render: row => {
      const word = `${row.sku}: ${whatWord(row)}`
      if (row.tick === 'whole') return <Checkbox checked disabled aria-label={`${word}, sent whole`} />
      if (row.tick === 'none') return <Checkbox checked={false} disabled aria-label={`${word}, not sent`} />
      return <Checkbox checked={row.tick !== 'off'} disabled={locked || !row.tickable} aria-label={`Send ${word}`}
        ref={el => { if (el) el.indeterminate = row.tick === 'some' }} onChange={event => tick(row, event.target.checked)} />
    } },
    { key: 'sku', label: 'SKU', width: 130, className: styles.skuCol, render: row => <span className={row.notSent ? `${styles.sku} ${styles.quiet}` : styles.sku} title={row.sku}>{row.sku}</span> },
    { key: 'what', label: 'What', width: 175, render: row => <WhatCell row={row} now={now} /> },
    { key: 'sent', label: 'What is sent', width: 175, className: styles.textCol, render: row => {
      const open = expanded.has(row.key)
      const full = row.what.column === 'send' && row.what.mode === 'full'
      return <span className={styles.sentCell}>
        {row.creates && <span className={row.notSent || row.tick === 'off' ? styles.quiet : undefined}>{row.creates.sentence}</span>}
        <span className={row.notSent ? styles.quiet : undefined}>{row.sent}</span>
        {row.warning && <span><strong>Warning:</strong> {row.warning}</span>}
        {row.checkedAtSend && <span className={styles.quiet}><strong>Checked when sending:</strong> {row.checkedAtSend}</span>}
        {row.removals.length > 0 && <span><strong>Will be removed:</strong> {row.removals.map(r => r.label).join(', ')}</span>}
        {row.expandable && <span><Button size="sm" variant="ghost" aria-expanded={open} onClick={() => toggleOpen(row.key)}
          aria-label={`${open ? 'Hide' : 'Show'} ${full ? 'what is sent' : 'the fields'} for ${row.sku}`}>
          {open ? 'Hide' : full ? 'Show what is sent' : `Show fields`}</Button></span>}
      </span>
    } },
    { key: 'setBy', label: 'Set by', width: 100, className: styles.textCol, render: row => row.setBy
      ? <span className={styles.sentCell}><span className={row.notSent ? styles.quiet : undefined}>{row.setBy}</span>{row.stale && <span className={styles.quiet}>{STARTS_UNTICKED}</span>}</span>
      : <span className={styles.quiet}><span aria-hidden="true">—</span><span className="nds-vh">Nobody set a value here.</span></span> },
  ]

  const changesOf = (productId: string) => (review?.changes ?? []).filter(change => change.productId === productId)
  const renderExpanded = (row: ActionPlanRow) => {
    if (!expanded.has(row.key) || !row.expandable) return null
    const changes = changesOf(row.productId)
    if (row.what.column === 'send' && row.what.mode === 'full') {
      const sent = changes.filter(change => change.selectable)
      const kept = changes.filter(change => !change.selectable)
      return <div className={styles.expanded}>
        <div className={styles.body}>
          <p><strong>{EVERYTHING_SENT}</strong> {sent.length.toLocaleString('en')} {sent.length === 1 ? 'field' : 'fields'} that Nexus manages:</p>
          {sent.length > 0 && <ul className={styles.issues}>{sent.map(change => <li key={change.id}>{change.label}</li>)}</ul>}
          {kept.length > 0 && <>
            <p>Not sent:</p>
            <ul className={styles.issues}>{kept.map(change => <li key={change.id}>{change.label}: {change.reason}</li>)}</ul>
          </>}
          {row.removals.length > 0 && <>
            <p><strong>Will be removed.</strong> The channel holds these values and Nexus does not:</p>
            <ul className={styles.issues}>{row.removals.map((removal, at) => <li key={`${removal.label}-${at}`}>{removal.label}: {removal.value}</li>)}</ul>
          </>}
        </div>
      </div>
    }
    return <div className={styles.expanded}>
      <PublicationChanges compact changes={changes} selectedIds={selectedIds} disabled={locked || !review?.id} photosOnly={review?.photosOnly} channel={review?.scope.channel}
        onSelectionChange={ids => onTicksChange({ selectedIds: withProductTicks(selectedIds, row.changeIds, ids), lifecycleIds: [...lifecycleIds] })} />
    </div>
  }

  return <DataGrid ariaLabel={ariaLabel} size="sm" columns={columns} rows={rows} rowKey={row => row.key}
    renderExpanded={renderExpanded} expanded={expanded}
    emptyState={<span className={styles.quiet}>Nothing is waiting to be sent here.</span>} />
}
