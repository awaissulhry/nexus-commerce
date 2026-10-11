'use client'

/**
 * Negative Targeting page — a rule's "Waiting" tab (2026-10-11): the pauses and negatives it (or the Brain) left for a
 * person, decided here (Owner: never send the job to another page). One compact list — the keyword or search term, where
 * it runs (campaign › ad group links), what it would do, its numbers and age — a tick per ask (all ticked to start),
 * then Approve N or Reject N. The view reviews the choice in the DS `ReviewChangesModal` stacked on the detail and sends
 * it through POST /api/advertising/waste/waiting/decide. Nothing here writes.
 *
 * Read: GET /api/advertising/waste/rows?show=waiting — every row waiting in this market, kept to this rule's
 * (`waiting.by.id`). One ask may cover the same term in two ad groups: it is one decision, said "+1".
 * States: reading, not read (+ Try again), nothing waiting, and asks the rule counts that the page does not list (a row
 * the page hides, such as a paused campaign) — said, never silent.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Tag } from '@/design-system/primitives'
import { Banner, EntityPath, type EntityLinkComponent } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import Link from '@/lib/workspaces/Link'
import { moneyText, relWords, whenWords } from '../../bid/_shared/format'
import { WAITING_PAGE, fetchWaitingRows } from './wasteRulesApi'
import { askWhat, plural, waitingAsksOf, waitingGap, type WaitingAsk, type WasteRuleRow } from './wasteRulesModel'
import { KindMark, MatchChip } from '../waste/marks'
import { xCpaText } from '../waste/wasteModel'
import type { Match } from '../waste/wasteTypes'
import { HintTag, Loading, NotRead } from './parts'
import styles from './rules.module.css'

const WorkspaceLink = Link as unknown as EntityLinkComponent

/** Keep the asks still waiting from a choice (after a re-read). */
const keep = (s: ReadonlySet<string>, asks: readonly WaitingAsk[]) => new Set(asks.map((a) => a.approvalId).filter((id) => s.has(id)))

export function WasteWaitingTab({ row, market, phone, reloadKey, decideHeld, onDecide }: {
  row: WasteRuleRow
  market: string
  phone: boolean
  reloadKey: number
  /** Why this person may not decide (permission), or null. */
  decideHeld: string | null
  onDecide(kind: 'approve' | 'reject', asks: WaitingAsk[]): void
}) {
  const [data, setData] = useState<{ asks: WaitingAsk[]; capped: boolean } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const where = row.market ?? market

  useEffect(() => {
    let alive = true
    setData(null); setErr(null)
    fetchWaitingRows(where).then(
      (out) => { if (alive) setData({ asks: waitingAsksOf(out.rows, row.id), capped: out.total > out.rows.length }) },
      (e: unknown) => { if (alive) setErr((e as Error).message) },
    )
    return () => { alive = false }
  }, [row.id, where, reloadKey, tick])

  const asks = useMemo(() => data?.asks ?? [], [data])
  // Every ask starts ticked; once the person ticks or unticks, a re-read keeps their choice for the asks still waiting.
  const touched = useRef(false)
  useEffect(() => { setSelected((s) => (touched.current ? keep(s, asks) : new Set(asks.map((a) => a.approvalId)))) }, [asks])
  const choose = (next: Set<string>) => { touched.current = true; setSelected(next) }
  const picked = asks.filter((a) => selected.has(a.approvalId))
  const held = decideHeld ?? (picked.length ? null : 'Tick an ask first')
  const gap = data ? waitingGap(row.waiting, asks) : 0

  const term: Column<WaitingAsk> = {
    key: 'term', label: row.kind === 'PAUSE_KEYWORD' && row.source === 'rule' ? 'Keyword' : 'Keyword / term', render: (a) => {
      const first = a.rows[0]
      return (
        <span className={styles.two}>
          <span className={styles.main}>
            <KindMark kind={first.kind} match={first.match as Match} />
            <span className={styles.ellipsis} title={first.text}>{first.text}</span>
            <MatchChip match={first.match as Match} />
            {a.rows.length > 1 && <HintTag label={`${a.rows.length} places`} hint={a.rows.map((x) => x.adGroup.name).join(' · ')} />}
          </span>
          <span className={styles.line}>
            <EntityPath items={[first.campaign, first.adGroup]} linkAs={WorkspaceLink} label="Where" />
          </span>
        </span>
      )
    },
  }
  const does: Column<WaitingAsk> = {
    key: 'does', label: 'Does', render: (a) => {
      const h = a.rows[0]?.verb.held
      return (
        <span className={styles.chips}>
          <Tag tone="info">{askWhat(a)}</Tag>
          {h && <HintTag label={h.label} hint={h.reason} tone="warning" />}
        </span>
      )
    },
  }
  const numbers: Column<WaitingAsk> = {
    key: 'numbers', label: 'Spend · clicks · orders', render: (a) => {
      const d = a.rows[0].d
      const spend = typeof d.spendCents === 'number' ? moneyText(d.spendCents, a.rows[0].currency) : null
      return (
        <span className={styles.chips}>
          <span>{[spend, `${d.clicks}`, `${d.orders}`].filter((x) => x != null).join(' · ')}</span>
          {typeof d.xCpa === 'number' && <HintTag label={xCpaText(d.xCpa)} hint="Spend ÷ the target cost per order" />}
        </span>
      )
    },
  }
  const age: Column<WaitingAsk> = {
    key: 'age', label: 'Asked', render: (a) => (
      <span className={styles.two}>
        <span title={whenWords(a.at)}>{relWords(a.at)}</span>
        {a.expiresAt && <span className={styles.muted} title={whenWords(a.expiresAt)}>ends {relWords(a.expiresAt)}</span>}
      </span>
    ),
  }
  const columns = phone ? [term, does] : [term, does, numbers, age]

  return (
    <div className={styles.stack}>
      <div className={styles.chips} data-return="decide">
        <Button size="sm" variant="primary" heldReason={held} onClick={() => onDecide('approve', picked)}>Approve {picked.length}</Button>
        <Button size="sm" variant="secondary" heldReason={held} onClick={() => onDecide('reject', picked)}>Reject {picked.length}</Button>
        {gap > 0 && <HintTag label={`${gap} hidden`} hint="Its other asks are on rows this page hides (a paused campaign, a day not settled yet)" tone="warning" />}
      </div>
      {err && <NotRead what="Waiting asks" error={err} onRetry={() => setTick((t) => t + 1)} />}
      {data?.capped && <Banner tone="warning" title={`Only the first ${WAITING_PAGE} waiting rows of the market were read`} />}
      {!data && !err && <Loading label="Reading the asks" />}
      {data && asks.length > 0 && (
        <DataGrid
          ariaLabel={`${plural(asks.length, 'ask')} waiting`}
          columns={columns}
          rows={asks}
          rowKey={(a) => a.approvalId}
          selectable={!decideHeld}
          selected={selected}
          onSelectedChange={choose}
          selectAllHint="Tick every waiting ask"
          selectRowHint="Tick this ask"
          headerMenus={false}
        />
      )}
      {data && !asks.length && !err && gap === 0 && <p className={styles.muted}>Nothing waiting.</p>}
    </div>
  )
}
