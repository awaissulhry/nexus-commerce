'use client'

/**
 * Bid page — a rule's "Waiting" tab (2026-10-10): the asks it left for you, decided here. One compact list (keyword +
 * match, its campaign · ad group links; now → asked, with "Brain decides" / "Brain off" where the Brain runs the campaign;
 * the ask's numbers, its age and when it ends), a tick per ask and tick-all, then Approve N or Reject N — each reviewed by
 * the page in the DS `ReviewChangesModal` (the panel hands the ticked asks over and closes; a modal opened from a drawer
 * would sit behind it), Done with Undo. The Bid page does this work itself: no hand-off to another page (Owner
 * 2026-10-10). Nothing here writes.
 *
 * States: reading (skeleton), not read (the server's words + Try again), nothing waiting, the rule held (Approve held with
 * its reason, Reject still offered), more asks than the server lists in one read (said).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Skeleton, Tag, Tooltip } from '@/design-system/primitives'
import { Banner, EntityLinks, type EntityLinkComponent } from '@/design-system/components'
import { ChangeValue } from '@/design-system/grid'
import Link from '@/lib/workspaces/Link'
import { plural, readError, type BidRuleRow } from './bidRulesModel'
import { SUGGESTIONS_LIMIT, fetchOwners, fetchStoredRule, fetchSuggestions } from './ruleApi'
import {
  GATE_MEANS, GATE_WORD, approveHeld, approveLabel, askOf, decideCounts, expiryWindowMs, keepSelected, rejectHeld, rejectLabel,
  ruleApproveHeld, waitingOf, type WaitingAsk,
} from './waitingModel'
import { PanelGrid, type PanelColumn, type PanelSelection } from '../_shared/PanelGrid'
import styles from '../bid.module.css'

const WorkspaceLink = Link as unknown as EntityLinkComponent
const ONE = { one: 'item', many: 'items' }
const askId = (a: WaitingAsk) => a.id

export function WaitingTab({ row, market, phone, reloadKey, decideHeld, onDecide }: {
  row: BidRuleRow
  market: string
  phone: boolean
  reloadKey: number
  /** Why this person may not decide asks (permission), or null. */
  decideHeld: string | null
  onDecide(kind: 'approve' | 'reject', asks: WaitingAsk[]): void
}) {
  const [data, setData] = useState<{ asks: WaitingAsk[]; capped: boolean } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const ruleHeld = ruleApproveHeld(row, decideHeld)

  useEffect(() => {
    let alive = true
    setData(null); setErr(null)
    ;(async () => {
      try {
        const [list, stored] = await Promise.all([fetchSuggestions('pending', market), fetchStoredRule(row.id).catch(() => null)])
        const mine = waitingOf(list.items, row.id)
        const campaigns = mine.filter((s) => s.entityType === 'AD_TARGET' && s.source?.campaignId).map((s) => s.source!.campaignId!)
        const owners = await fetchOwners(market, campaigns)
        const ctx = { market: row.market ?? (market !== 'all' ? market : null), owners, ruleHeld, expiryMs: expiryWindowMs(stored?.actions), now: Date.now() }
        if (alive) setData({ asks: mine.map((s) => askOf(s, ctx)), capped: list.capped })
      } catch (e) { if (alive) setErr((e as Error).message) }
    })()
    return () => { alive = false }
  }, [row.id, row.market, market, reloadKey, ruleHeld, tick])

  const asks = useMemo(() => data?.asks ?? [], [data])
  // Every ask starts ticked (a default for every choice: "Approve 3" is one click from the review); once the person
  // ticks or unticks, a re-read keeps their choice for the asks still waiting.
  const touched = useRef(false)
  useEffect(() => { setSelected((s) => (touched.current ? keepSelected(s, asks) : new Set(asks.map((a) => a.id)))) }, [asks])
  const selection = useMemo<PanelSelection | undefined>(() => (decideHeld ? undefined : {
    selected,
    onChange: (next) => { touched.current = true; setSelected(next) },
  }), [decideHeld, selected])
  const counts = useMemo(() => decideCounts(asks, selected), [asks, selected])
  const aHeld = approveHeld(counts, decideHeld)
  const rHeld = rejectHeld(counts, decideHeld)

  const keyword: PanelColumn<WaitingAsk> = {
    key: 'kw', label: 'Keyword', render: (a) => (
      <span className={styles.two}>
        <span className={styles.line}><span className={styles.ellipsis} title={a.keyword}>{a.keyword}</span>{a.match && <Tag>{a.match}</Tag>}</span>
        <span className={styles.subline}>
          {a.campaign ? <EntityLinks items={[a.campaign]} noun={ONE} linkAs={WorkspaceLink} /> : <span className={styles.muted}>—</span>}
          {a.adGroup && !phone && <><span className={styles.muted} aria-hidden>·</span><EntityLinks items={[a.adGroup]} noun={ONE} linkAs={WorkspaceLink} /></>}
        </span>
      </span>
    ),
  }
  const change: PanelColumn<WaitingAsk> = {
    key: 'change', label: 'Now → asked', render: (a) => (
      <span className={styles.two}>
        <span className={styles.chips}>
          <ChangeValue changes={[{ label: a.what, from: a.now, to: a.next }]} hideLabels />
          {a.gate && (
            <Tooltip label={GATE_MEANS[a.gate]} portal>
              <span tabIndex={0} aria-label={`${GATE_WORD[a.gate]}: ${GATE_MEANS[a.gate]}`}><Tag tone={a.gate === 'brain' ? 'info' : 'warning'}>{GATE_WORD[a.gate]}</Tag></span>
            </Tooltip>
          )}
        </span>
        {phone && <span className={`${styles.muted} ${styles.wrap}`}>{a.reason}</span>}
      </span>
    ),
  }
  const why: PanelColumn<WaitingAsk> = {
    key: 'why', label: 'Why', render: (a) => (
      <span className={styles.two}>
        <span className={styles.muted}>{a.reason}</span>
        <span className={styles.sub} title="When it ends if no run asks it again">{a.age}{a.expires ? ` · ends ${a.expires}` : ''}</span>
      </span>
    ),
  }
  const columns = phone ? [keyword, change] : [keyword, change, why]

  return (
    <div className={styles.stack}>
      <div className={styles.chips} data-return="decide">
          <Decide label={approveLabel(counts.approve.length)} held={aHeld} variant="primary" onClick={() => onDecide('approve', counts.approve)} />
          <Decide label={rejectLabel(counts.reject.length)} held={rHeld} variant="secondary" onClick={() => onDecide('reject', counts.reject)} />
          {counts.held.length > 0 && counts.approve.length > 0 && (
            <Tooltip label={counts.held[0].held ?? ''} portal>
              <span tabIndex={0} aria-label={`${counts.held.length} can’t be approved: ${counts.held[0].held ?? ''}`}><Tag tone="warning">{counts.held.length} can’t be approved</Tag></span>
            </Tooltip>
          )}
      </div>
      {ruleHeld && !decideHeld && <Banner tone="warning" title={ruleHeld} />}
      {err && (
        <Banner tone="danger" title="Asks not read" action={<Button size="sm" variant="secondary" onClick={() => setTick((t) => t + 1)}>Try again</Button>}>
          {readError(err)}
        </Banner>
      )}
      {data?.capped && <Banner tone="warning" title={`Only the newest ${SUGGESTIONS_LIMIT.toLocaleString('en-GB')} asks of the account were read: older ones of this rule may not show`} />}
      {!data && !err && <div className={styles.stack} aria-busy="true" aria-label="Reading the asks"><Skeleton height={16} /><Skeleton height={16} /><Skeleton height={16} /></div>}
      {data && asks.length > 0 && (
        <PanelGrid
          ariaLabel={`${plural(asks.length, 'ask')} waiting`}
          columns={columns}
          rows={asks}
          rowId={askId}
          selection={selection}
        />
      )}
      {data && !asks.length && !err && <p className={styles.muted}>Nothing waiting.</p>}
    </div>
  )
}

/** Approve / Reject: held with its reason (focusable, says why, does nothing), never `disabled`. */
function Decide({ label, held, variant, onClick }: { label: string; held: string | null; variant: 'primary' | 'secondary'; onClick(): void }) {
  if (!held) return <Button size="sm" variant={variant} onClick={onClick}>{label}</Button>
  return <Tooltip label={held} portal><Button size="sm" variant={variant} aria-disabled aria-description={held}>{label}</Button></Tooltip>
}
