'use client'

/**
 * Grid audit wave 3 (Owner 2026-10-13, the PSIE shape) — the Publish review as ONE table, one row per change: the
 * window's "All markets" view (a Where column) and each market's tab use it. Rules in `reviewRows.ts`.
 *
 * A product's row says what Publish does with it (the design system's Action or Status words), its tick and what WILL
 * happen ("Will be sent", "Will be deleted"…) — after the send, its real result; under it, a row per field that changes
 * (what the channel has now and what Nexus sends, both whole), each ticked by itself, and on a Full update the values the
 * channel loses. A status change or Delete reads "Active on eBay · IT" → "Removed". The review's problems are rows,
 * first: their words beside their "Problem" tag, the SKUs they are on, and "Show in sheet" where the sheet behind the
 * window can land on the product. "All markets" adds one quiet row of notes per market. A filter narrows the rows to
 * the problems or to what a send removes; every number above the table is the window's one count (`reviewCounts`).
 * Every tick goes back to the window through its market's `onTicksChange`.
 *
 * It replaces the per-market table with "3 of 5 fields" and a per-row "Show fields" (audit D3), its 175 px sentence
 * column and an always-empty "Set by" (D3), its cut values (D6) and its header menus and resize handles (D11).
 */
import { useEffect, useMemo, useState } from 'react'
import { blockedChanges, moveModeLabel } from '@nexus/shared/studio-publication'
import { Button, Checkbox, Pill, SegmentedControl, Tag } from '@/design-system/primitives'
import { Disclosure, MetricStrip, Pagination, useNarrow } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { PublishActionView, PublishStatusPill, SellingStatusView, SEND_MODE_WORD, STATUS_TARGET_WORD } from '@/design-system/grid'
import { NOT_LISTED_ASIDE, NO_LONGER_APPLIES, STARTS_UNTICKED, rowSends, toggleRowTicks, withProductTicks, type ActionPlanRow } from './actionPlan'
import { replacesWords } from './PublicationChanges'
import {
  fieldNote, fieldStatus, fieldTick, fieldValues, lifecycleValues, planRowTag, removalTag, reviewCounts, reviewPages, reviewTableRows, showInSheetTarget,
  type ReviewFilter, type ReviewTableMarket, type ReviewTableRow,
} from './reviewRows'
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
  /** "All markets": a Where column, the summary strip over every market and one row of notes per market. */
  allMarkets?: boolean
  /** A market's row offers "Check again" or "Open its tab". */
  onCheckAgain?(key: string): void
  onOpen?(key: string): void
  /**
   * "Show in sheet" on a problem that names a product, on a market the sheet behind the window shows (`inSheet`): the
   * window closes and the sheet lands on that product's row, on the problem's field when the sheet has its column.
   */
  onShowField?(destinationKey: string, productId: string, field: string | null): void
}

/** Up to this many SKUs a problem lists them under its count; more open on demand. */
const SKU_LIST_OPEN = 6

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

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

/**
 * What a product's row sends, whole: what a status change or Delete makes of the listing ("Removed"), the sentence, what
 * it creates, its warning and what the channel checks when sending.
 */
function SentCell({ row, becomes }: { row: ActionPlanRow; becomes: string | null }) {
  const quiet = !!row.notSent || row.tick === 'off'
  return <span className={styles.lines}>
    {becomes && <span className={quiet ? styles.quiet : `${styles.value} ${styles.sends}`}>{becomes}</span>}
    {row.creates && <span className={quiet ? styles.quiet : undefined}>{row.creates.sentence}</span>}
    <span className={quiet ? styles.quiet : undefined}>{row.sent}</span>
    {row.warning && <span><strong>Warning:</strong> {row.warning}</span>}
    {row.checkedAtSend && <span><strong>Checked when sending:</strong> {row.checkedAtSend}</span>}
  </span>
}

/** A problem's SKUs: the one SKU, or how many with the list under it (a long list opens on demand). */
function ProblemSkus({ skus }: { skus: string[] }) {
  if (!skus.length) return <span className={styles.sku}>Whole listing</span>
  if (skus.length === 1) return <span className={styles.sku}>{skus[0]}</span>
  return <span className={styles.lines}>
    <span className={styles.sku}>{plural(skus.length, 'SKU', 'SKUs')}</span>
    {skus.length <= SKU_LIST_OPEN ? <span className={styles.quiet}>{skus.join(', ')}</span>
      : <Disclosure className={styles.skuList} summary="Show them"><span className={styles.quiet}>{skus.join(', ')}</span></Disclosure>}
  </span>
}

export function ReviewTable({ markets, locked, now, ariaLabel, allMarkets = false, onCheckAgain, onOpen, onShowField }: ReviewTableProps) {
  const [filter, setFilter] = useState<ReviewFilter>('all')
  const rows = useMemo(() => reviewTableRows(markets, filter, { notes: allMarkets }), [markets, filter, allMarkets])
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
  // Phone width (DS `useNarrow`, the window's own sheet breakpoint): the columns narrow so "Channel now" and "Nexus sends"
  // fit side by side once scrolled to (300 px in the 358 px body of a 390 px screen; at 240 px each they never did), and
  // the SKU is not pinned, as the sheet pins no column on a phone (`useNarrowSheet`).
  const narrow = useNarrow()

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
    ...(allMarkets ? [{ key: 'where', label: 'Where', width: narrow ? 100 : 110, render: (r: ReviewTableRow) => <span className={styles.where}>{r.market.label}</span> }] : []),
    { key: 'sku', label: 'SKU', width: narrow ? 110 : 130, sticky: !narrow, render: r => {
      if (r.type === 'plan') return <span className={r.row.notSent ? `${styles.sku} ${styles.quiet}` : styles.sku}>{r.row.sku}</span>
      if (r.type === 'problem') return <ProblemSkus skus={r.skus} />
      return null
    } },
    // A problem's and a note's own words sit beside their tag: they are what the row is, not what the channel has now.
    { key: 'field', label: 'What', width: narrow ? 130 : 150, render: r => {
      if (r.type === 'plan') return <WhatCell row={r.row} now={now} />
      if (r.type === 'field') return <span className={styles.fieldName}>{r.change.label}</span>
      if (r.type === 'removal') return <span className={styles.fieldName}>{r.label}</span>
      if (r.type === 'problem') return <span className={styles.lines}><Tag tone="danger">Problem</Tag><span>{r.message}</span></span>
      if (r.type === 'note') return <span className={styles.lines}><Tag tone="neutral">{r.notes.length === 1 ? 'Note' : `${r.notes.length.toLocaleString('en')} notes`}</Tag>
        {r.notes.map(note => <span key={note} className={styles.quiet}>{note}</span>)}</span>
      return allMarkets ? null : <span>{r.market.label}</span>
    } },
    // Desktop: the widths fill the window's body (984 px) without running past it (audit D2). Phone: see `narrow`.
    { key: 'now', label: 'Channel now', width: narrow ? 150 : allMarkets ? 195 : 240, render: r => {
      if (r.type === 'field') return <span className={styles.value}>{fieldValues(r.change).now}</span>
      if (r.type === 'removal') return <span className={styles.value}>{r.value}</span>
      if (r.type === 'plan') {
        const values = lifecycleValues(r.row, r.market.label)
        return values ? <span className={styles.value}>{values.now}</span> : null
      }
      // The channel's own words behind a problem: what it says now.
      if (r.type === 'problem') return r.detail ? <span className={`${styles.value} ${styles.quiet}`}>{r.detail}</span> : null
      if (r.type === 'state') return <span className={styles.lines}><span>{r.state.text}</span></span>
      return null
    } },
    { key: 'sends', label: 'Nexus sends', width: narrow ? 150 : allMarkets ? 195 : 240, render: r => {
      if (r.type === 'plan') return <SentCell row={r.row} becomes={lifecycleValues(r.row, r.market.label)?.sends ?? null} />
      if (r.type === 'field') return <span className={`${styles.value} ${styles.sends}`}>{fieldValues(r.change).sends}</span>
      if (r.type === 'removal') return <span className={styles.lines}><span className={styles.quiet}>{rowSends(r.row) ? 'Removed from the channel' : 'Nothing: its row is not sent'}</span></span>
      if (r.type === 'problem') return <span className={styles.lines}><span className={styles.quiet}>{r.holds}</span></span>
      return null
    } },
    { key: 'note', label: 'Note', width: narrow ? 140 : 150, render: r => {
      if (r.type === 'plan') {
        const tag = planRowTag(r.row, marketOf.get(r.market.key)?.results)
        return <span className={styles.lines}>{tag.meta ? <span title={tag.meta.hint}><PublishStatusPill meta={tag.meta} /></span> : <Tag tone={tag.tone}>{tag.label}</Tag>}
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
      if (r.type === 'removal') { const tag = removalTag(r.row); return <span className={styles.lines}><Tag tone={tag.tone}>{tag.label}</Tag></span> }
      if (r.type === 'problem') {
        const target = onShowField ? showInSheetTarget(r, marketOf.get(r.market.key)) : null
        return <span className={styles.lines}>
          {target && <Button size="sm" onClick={() => onShowField!(r.market.key, target.productId, target.field)}
            aria-label={`Show ${r.skus[0] ?? 'this product'} in the sheet`}>Show in sheet</Button>}
          <span className={styles.quiet}>Fix it, then check again.</span></span>
      }
      if (r.type === 'note') return null
      return <span className={styles.lines}>
        {r.state.action === 'check' && onCheckAgain && !locked && <Button size="sm" onClick={() => onCheckAgain(r.market.key)}>Check again</Button>}
        {r.state.action === 'open' && onOpen && <Button size="sm" onClick={() => onOpen(r.market.key)}>Open {r.market.label}</Button>}
      </span>
    } },
  ]

  const filters = [
    { value: 'all', label: 'All' },
    { value: 'problems', label: `Problems${counts.problems ? ` · ${counts.problems.toLocaleString('en')}` : ''}` },
    { value: 'removes', label: `Removes${counts.removesListed ? ` · ${counts.removesListed.toLocaleString('en')}` : ''}` },
  ]
  const removedHint = [counts.removedListings ? plural(counts.removedListings, 'listing', 'listings') : null, counts.removedValues ? plural(counts.removedValues, 'value', 'values') : null]
    .filter(Boolean).join(' · ')

  return <div className={styles.table}>
    {allMarkets && <MetricStrip metrics={[
      { label: 'Markets', value: counts.markets.toLocaleString('en') },
      { label: 'Listings', value: counts.listings.toLocaleString('en'), hint: 'that send something' },
      { label: 'Changes', value: counts.changes.toLocaleString('en'), hint: 'ticked to send' },
      { label: 'Problems', value: counts.problems.toLocaleString('en'), hint: counts.problemSkus ? `on ${plural(counts.problemSkus, 'SKU', 'SKUs')}` : undefined },
      { label: 'Removes', value: (counts.removedListings + counts.removedValues).toLocaleString('en'), hint: removedHint ? `${removedHint}, ticked` : undefined },
    ]} />}
    <SegmentedControl ariaLabel="Show" size="sm" options={filters} value={filter} onChange={v => setFilter(v as ReviewFilter)} />
    {/* Keyed by the view and the width: "All markets" and one market have different columns, a phone other widths and
        pins, and a width is where a column STARTS (the engine's rule) — the same grid kept the other view's widths. */}
    <DataGrid key={`${allMarkets ? 'all' : 'one'}-${narrow ? 'phone' : 'wide'}`} ariaLabel={ariaLabel} size="md" headerMenus={false} columns={columns} rows={pageRows} rowKey={r => r.key}
      // A field row (and a value a Full update removes) is the DataGrid's child row: sunken, with the rail, under its product.
      rowClassName={r => (r.type === 'field' || r.type === 'removal' ? 'nds-grid-kid' : undefined)}
      emptyState={filter === 'all' ? 'Nothing is waiting to be sent here.' : filter === 'problems' ? 'No problems.' : 'Nothing is removed.'} />
    {pages.length > 1 && <div className={styles.pager}>
      <span className={styles.quiet}>Rows {(firstRow + 1).toLocaleString('en')}–{(firstRow + pageRows.length).toLocaleString('en')} of {rows.length.toLocaleString('en')}</span>
      <Pagination page={shownPage} pageCount={pages.length} onPage={setPage} />
    </div>}
  </div>
}
