'use client'

/**
 * Grid audit wave 3 (Owner 2026-10-13, the PSIE shape) — the Publish review as ONE table, one row per change: the
 * window's "All markets" view (a Where column) and each market's tab use it. Rules in `reviewRows.ts`.
 *
 * A product's row says what Publish does with it (the design system's Action or Status words), its tick and why nothing
 * is sent; under it, a row per field that changes — what the channel has now and what Nexus sends, both whole — each
 * ticked by itself, and on a Full update the values the channel loses. The review's problems are rows, first. A filter
 * narrows the rows to Problems or Deletes. Every tick goes back to the window through its market's `onTicksChange`.
 *
 * It replaces the per-market table with "3 of 5 fields" and a per-row "Show fields" (audit D3), its 175 px sentence
 * column and an always-empty "Set by" (D3), its cut values (D6) and its header menus and resize handles (D11).
 */
import { useEffect, useMemo, useState } from 'react'
import { blockedChanges, moveModeLabel } from '@nexus/shared/studio-publication'
import { Button, Checkbox, Pill, SegmentedControl, Tag } from '@/design-system/primitives'
import { Disclosure, MetricStrip, Pagination } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { PublishActionView, SellingStatusView, SEND_MODE_WORD, STATUS_TARGET_WORD } from '@/design-system/grid'
import { NOT_LISTED_ASIDE, NO_LONGER_APPLIES, STARTS_UNTICKED, toggleRowTicks, withProductTicks, type ActionPlanRow } from './actionPlan'
import { replacesWords } from './PublicationChanges'
import { fieldNote, fieldStatus, fieldTick, fieldValues, reviewCounts, reviewPages, reviewTableRows, type ReviewFilter, type ReviewTableMarket, type ReviewTableRow } from './reviewRows'
import styles from './reviewTable.module.css'

export interface ReviewTableMarketProps extends ReviewTableMarket {
  channel: string
  onTicksChange(next: { selectedIds: string[]; lifecycleIds: string[] }): void
}

export interface ReviewTableProps {
  markets: ReviewTableMarketProps[]
  /** Nothing can change: a publish is under way or done, or the window is busy. */
  locked: boolean
  now: number
  ariaLabel: string
  /** "All markets": a Where column and the summary strip over every market. */
  allMarkets?: boolean
  /** A market's row offers "Check again" or "Open its tab". */
  onCheckAgain?(key: string): void
  onOpen?(key: string): void
}

/** Up to this many SKUs a problem lists them under its words; more open on demand. */
const SKU_LIST_OPEN = 6

/** The row's value in words, for the tick's accessible name. */
function whatWord(row: ActionPlanRow): string {
  if (row.what.column === 'status') return STATUS_TARGET_WORD[row.what.target]
  if (row.what.column === 'move') return moveModeLabel(row.what.to)
  return SEND_MODE_WORD[row.what.mode]
}

function WhatCell({ row, now }: { row: ActionPlanRow; now: number }) {
  if (row.kind === 'outgrown') return <span className={styles.what}><Pill tone="neutral">{whatWord(row)}</Pill><span className={styles.quiet}>{NO_LONGER_APPLIES}</span></span>
  const what = row.what
  if (what.column === 'status' && what.target === 'not_listed') return <span className={styles.what}><Pill tone="neutral">{STATUS_TARGET_WORD.not_listed}</Pill><span className={styles.quiet}>{NOT_LISTED_ASIDE}</span></span>
  if (what.column === 'status') return <SellingStatusView value={{ state: what.state, waiting: { target: what.target, setAt: what.setAt, setByName: what.setByName } }} now={now} />
  if (what.column === 'move') return <span className={styles.what}><Pill tone="danger">{moveModeLabel(what.to)}</Pill></span>
  return <PublishActionView value={{ mode: what.mode, setAt: what.setAt, setByName: what.setByName, ...(what.newRow ? { newRow: true } : {}) }} now={now} />
}

/** What a product's row sends, whole: the sentence, what it creates, its warning and what the channel checks when sending. */
function SentCell({ row }: { row: ActionPlanRow }) {
  const quiet = !!row.notSent || row.tick === 'off'
  return <span className={styles.lines}>
    {row.creates && <span className={quiet ? styles.quiet : undefined}>{row.creates.sentence}</span>}
    <span className={quiet ? styles.quiet : undefined}>{row.sent}</span>
    {row.warning && <span><strong>Warning:</strong> {row.warning}</span>}
    {row.checkedAtSend && <span><strong>Checked when sending:</strong> {row.checkedAtSend}</span>}
  </span>
}

/** A product's row in one word, with its tone: it sends, it is left out, nothing of it is sent, or it deletes. */
function rowTag(row: ActionPlanRow): { label: string; tone: 'danger' | 'neutral' | 'info' | 'success' } {
  if (row.notSent || row.tick === 'none') return { label: 'Not sent', tone: 'neutral' }
  if (row.tick === 'off') return { label: 'Left out', tone: 'neutral' }
  if (row.danger) return { label: row.action === 'end' ? 'Ends' : 'Deletes', tone: 'danger' }
  return { label: 'Sent', tone: 'success' }
}

export function ReviewTable({ markets, locked, now, ariaLabel, allMarkets = false, onCheckAgain, onOpen }: ReviewTableProps) {
  const [filter, setFilter] = useState<ReviewFilter>('all')
  const rows = useMemo(() => reviewTableRows(markets, filter), [markets, filter])
  // Page by page, about 100 rows each (a product with its fields is never split): a family on several markets can list
  // a thousand rows, and the window froze drawing them all at once.
  const pages = useMemo(() => reviewPages(rows), [rows])
  const [page, setPage] = useState(1)
  useEffect(() => { setPage(1) }, [filter])
  const shownPage = Math.min(page, Math.max(1, pages.length))
  const pageRows = pages[shownPage - 1] ?? []
  const firstRow = pages.slice(0, shownPage - 1).reduce((n, p) => n + p.length, 0)
  const counts = useMemo(() => reviewCounts(markets), [markets])
  const marketOf = useMemo(() => new Map(markets.map(m => [m.key, m])), [markets])
  // Option A (Owner 2026-10-19) — per market, the changes a problem leaves out, each with that problem.
  const leftOutOf = useMemo(() => new Map(markets.map(m => [m.key, m.review?.id ? blockedChanges(m.review) : new Map()])), [markets])

  const planTick = (r: Extract<ReviewTableRow, { type: 'plan' }>) => {
    const m = marketOf.get(r.market.key)!
    const row = r.row
    const word = `${row.sku}: ${whatWord(row)}`
    if (row.tick === 'whole') return <Checkbox checked disabled aria-label={`${word}, sent whole`} />
    if (row.tick === 'none') return <Checkbox checked={false} disabled aria-label={`${word}, not sent`} />
    return <Checkbox checked={row.tick !== 'off'} disabled={locked || !row.tickable} aria-label={`Send ${word}`}
      ref={el => { if (el) el.indeterminate = row.tick === 'some' }}
      onChange={event => m.onTicksChange(toggleRowTicks(row, event.target.checked, { selectedIds: m.selectedIds, lifecycleIds: m.lifecycleIds }))} />
  }
  const fieldCheckbox = (r: Extract<ReviewTableRow, { type: 'field' }>) => {
    const m = marketOf.get(r.market.key)!
    const tick = fieldTick(r.row, r.change, { selectedIds: m.selectedIds, locked, reviewId: m.review?.id, leftOut: leftOutOf.get(m.key) })
    return <Checkbox checked={tick.on} disabled={!tick.enabled} aria-label={`Send ${r.change.label} of ${r.row.sku}`}
      onChange={event => {
        const mine = r.row.changeIds
        const chosen = m.selectedIds.filter(id => mine.includes(id) && id !== r.change.id)
        m.onTicksChange({ selectedIds: withProductTicks(m.selectedIds, mine, event.target.checked ? [...chosen, r.change.id] : chosen), lifecycleIds: [...m.lifecycleIds] })
      }} />
  }

  const columns: Column<ReviewTableRow>[] = [
    { key: 'tick', label: <span className="nds-vh">Send</span>, width: 44, sticky: true, render: r => r.type === 'plan' ? planTick(r) : r.type === 'field' ? fieldCheckbox(r) : null },
    ...(allMarkets ? [{ key: 'where', label: 'Where', width: 110, render: (r: ReviewTableRow) => <span className={styles.where}>{r.market.label}</span> }] : []),
    { key: 'sku', label: 'SKU', width: 130, sticky: true, render: r => {
      if (r.type === 'plan') return <span className={r.row.notSent ? `${styles.sku} ${styles.quiet}` : styles.sku}>{r.row.sku}</span>
      if (r.type === 'problem') return <span className={styles.sku}>{r.skus.length === 1 ? r.skus[0] : `${r.skus.length.toLocaleString('en')} SKUs`}</span>
      return null
    } },
    { key: 'field', label: 'What', width: 150, render: r => {
      if (r.type === 'plan') return <WhatCell row={r.row} now={now} />
      if (r.type === 'field') return <span className={styles.fieldName}>{r.change.label}</span>
      if (r.type === 'removal') return <span className={styles.fieldName}>{r.label}</span>
      if (r.type === 'problem') return <Tag tone="danger">Problem</Tag>
      return allMarkets ? null : <span>{r.market.label}</span>
    } },
    // The widths fill the window's body (984 px) without running past it (audit D2); a phone scrolls sideways, tick and
    // SKU pinned.
    { key: 'now', label: 'Channel now', width: allMarkets ? 195 : 240, render: r => {
      if (r.type === 'field') return <span className={styles.value}>{fieldValues(r.change).now}</span>
      if (r.type === 'removal') return <span className={styles.value}>{r.value}</span>
      // A problem is what is wrong NOW (and the channel's own words under it); a market's row says why it lists nothing.
      if (r.type === 'problem') return <span className={styles.lines}><span>{r.message}</span>{r.detail && <span className={styles.quiet}>{r.detail}</span>}
        {r.skus.length > 1 && r.skus.length <= SKU_LIST_OPEN && <span className={styles.quiet}>On {r.skus.join(', ')}</span>}
        {/* A long list (a problem on every variant) opens on demand: the problem itself is the row's words. */}
        {r.skus.length > SKU_LIST_OPEN && <Disclosure className={styles.skuList} summary={`On ${r.skus.length.toLocaleString('en')} SKUs`}>
          <span className={styles.quiet}>{r.skus.join(', ')}</span>
        </Disclosure>}</span>
      if (r.type === 'state') return <span className={styles.lines}><span>{r.state.text}</span></span>
      return null
    } },
    { key: 'sends', label: 'Nexus sends', width: allMarkets ? 195 : 240, render: r => {
      if (r.type === 'plan') return <SentCell row={r.row} />
      if (r.type === 'field') return <span className={`${styles.value} ${styles.sends}`}>{fieldValues(r.change).sends}</span>
      if (r.type === 'removal') return <span className={styles.lines}><span className={styles.quiet}>Removed from the channel</span></span>
      if (r.type === 'problem') return <span className={styles.lines}><span className={styles.quiet}>Not sent until it is fixed</span></span>
      return null
    } },
    { key: 'note', label: 'Note', width: 150, render: r => {
      if (r.type === 'plan') {
        const tag = rowTag(r.row)
        return <span className={styles.lines}><Tag tone={tag.tone}>{tag.label}</Tag>
          {r.row.notSent && r.row.notSent !== r.row.sent && <span className={styles.quiet}>{r.row.notSent}</span>}
          {r.row.setBy && <span className={styles.quiet}>{r.row.setBy}</span>}
          {r.row.stale && <span className={styles.quiet}>{STARTS_UNTICKED}</span>}</span>
      }
      if (r.type === 'field') {
        const status = fieldStatus(r.change)
        const m = marketOf.get(r.market.key)!
        const leftOut = leftOutOf.get(m.key)
        const words = r.change.selectable && !leftOut?.has(r.change.id) ? replacesWords(r.change, m.selectedIds.includes(r.change.id), m.channel) : null
        const reason = fieldNote(r.change, leftOut)
        return <span className={styles.lines}><Tag tone={status.tone}>{status.label}</Tag>
          {reason && <span className={styles.quiet}>{reason}</span>}
          {words && <span className={words.warning ? undefined : styles.quiet}>{words.warning && <strong>Warning: </strong>}{words.text}</span>}</span>
      }
      if (r.type === 'removal') return <span className={styles.lines}><Tag tone="danger">Will be removed</Tag></span>
      if (r.type === 'problem') return <span className={styles.lines}><span className={styles.quiet}>Fix it, then check again.</span></span>
      return <span className={styles.lines}>
        {r.state.action === 'check' && onCheckAgain && !locked && <Button size="sm" onClick={() => onCheckAgain(r.market.key)}>Check again</Button>}
        {r.state.action === 'open' && onOpen && <Button size="sm" onClick={() => onOpen(r.market.key)}>Open {r.market.label}</Button>}
      </span>
    } },
  ]

  const filters = [
    { value: 'all', label: 'All' },
    { value: 'problems', label: `Problems${counts.problemKinds ? ` · ${counts.problemKinds.toLocaleString('en')}` : ''}` },
    { value: 'deletes', label: `Deletes${counts.deletes ? ` · ${counts.deletes.toLocaleString('en')}` : ''}` },
  ]

  return <div className={styles.table}>
    {allMarkets && <MetricStrip metrics={[
      { label: 'Markets', value: counts.markets.toLocaleString('en') },
      { label: 'Listings', value: counts.listings.toLocaleString('en'), hint: 'that send something' },
      { label: 'Changes', value: counts.changes.toLocaleString('en'), hint: 'ticked to send' },
      { label: 'Problems', value: counts.problems.toLocaleString('en'), hint: counts.problemKinds && counts.problemKinds < counts.problems ? `${counts.problemKinds.toLocaleString('en')} to fix` : undefined },
      { label: 'Deletes', value: counts.deletes.toLocaleString('en') },
    ]} />}
    <SegmentedControl ariaLabel="Show" size="sm" options={filters} value={filter} onChange={v => setFilter(v as ReviewFilter)} />
    {/* Keyed by the view: "All markets" and one market have different columns and widths, and a width is where a column
        STARTS (the engine's rule) — the same grid switching views kept the other view's widths and ran past the window. */}
    <DataGrid key={allMarkets ? 'all' : 'one'} ariaLabel={ariaLabel} size="md" headerMenus={false} columns={columns} rows={pageRows} rowKey={r => r.key}
      // A field row (and a value a Full update removes) is the DataGrid's child row: sunken, with the rail, under its product.
      rowClassName={r => (r.type === 'field' || r.type === 'removal' ? 'nds-grid-kid' : undefined)}
      emptyState={filter === 'all' ? 'Nothing is waiting to be sent here.' : filter === 'problems' ? 'No problems.' : 'Nothing is deleted.'} />
    {pages.length > 1 && <div className={styles.pager}>
      <span className={styles.quiet}>Rows {(firstRow + 1).toLocaleString('en')}–{(firstRow + pageRows.length).toLocaleString('en')} of {rows.length.toLocaleString('en')}</span>
      <Pagination page={shownPage} pageCount={pages.length} onPage={setPage} />
    </div>}
  </div>
}
