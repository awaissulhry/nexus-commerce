'use client'

/**
 * Bid page, Bids view — one keyword's detail, the DS `DetailModal` (polish round 2: no side drawer; a centered dialog,
 * a full-screen sheet on a phone). Every action on a bid stays here (Owner 2026-10-10: the Bid page does all its work
 * itself).
 *
 *   header   the keyword · match · market · who sets it (a rule opens its detail, the Brain the Why tab) · ▲ n of N ▼
 *   tabs     Why (the Brain's own decision) · History (every change with Undo) · What if (the Brain at another target
 *            ACoS) — a new tab joins `TABS`
 *   body     a rail that stays on every tab — the bid now, the Brain's bid, the trend, where it lives, its numbers, Set
 *            bid (only where nothing automatic writes over it: You · nothing) and Lock / Unlock campaign bids — and the
 *            tab beside it (under it on a phone)
 *
 * Nothing here writes: each action asks the view, which opens the DS review ABOVE this dialog. Time, money and what
 * became of a change are the page's one helper set (`_shared/format.ts`, `_shared/delivery.ts`).
 */
import { useCallback, useEffect, useState } from 'react'
import { Hand, Lock, LockOpen, PencilLine, Sparkles, Target } from 'lucide-react'
import { Button, FilterChip, Input, Pill, Tag } from '@/design-system/primitives'
import { EntityLinks, Field, KeyValue, Sparkline } from '@/design-system/components'
import { DetailModal, type DetailNav, type DetailModalProps } from '@/design-system/patterns'
import { ChangeValue } from '@/design-system/grid'
import Link from '@/lib/workspaces/Link'
import { currencySymbol, money, moneyText, relWords, WEEK, whenWords } from '../_shared/format'
import { readCampaignLock, readHistory, readWhatIf, readWhy, type CampaignLock } from './bidsApi'
import { acosText, AUTO_WORDS, autoHeld, bidProblem, editHeldReason, lastChangeWords, matchWord, parseBid, writerName, type BidGridRow } from './bidsModel'
import { draftOf, GOAL_KEYS, GOAL_LABEL, goalChanges, goalHeld, goalText, parseGoal, type GoalDraft, type GoalValues } from './goalModel'
import { suggestedWords } from './suggestedModel'
import { NightFloorMark, OwnerChip, OwnerIcon, TREND_LABEL } from './bidsColumns'
import { HeldButton } from './HeldButton'
import { FullName } from '../_shared/FullName'
import { ChangeHistory, type HistoryRow, type WhoChip } from '../_shared/ChangeHistory'
import { historyLines, whoHref, type FeedRow, type HistoryLine } from './historyModel'
import { actionWord, decisionFacts, layerTag, parseAcosPct, type BrainDecision, type WhatIfDecision } from './whyModel'
import styles from './bids.module.css'

/** What the detail (and the table) asks the view to review and save. */
export type BidAsk =
  | { kind: 'bid'; row: BidGridRow; nextCents: number }
  | { kind: 'undo'; row: BidGridRow; line: HistoryLine }
  | { kind: 'lock'; row: BidGridRow; lock: boolean }
  /** Amazon's suggested bid, for one row or the selected rows. */
  | { kind: 'apply'; row: BidGridRow; rows: BidGridRow[] }
  /** Auto / Manual for one keyword. */
  | { kind: 'mode'; row: BidGridRow; next: 'AUTO' | 'MANUAL' }
  /** The keyword's own goal and max. */
  | { kind: 'goal'; row: BidGridRow; values: GoalValues }

/** What the detail can do beyond the plain table: the keyword-Auto fields the answer carries. */
export interface DetailFeatures { suggested: boolean; auto: boolean; goal: boolean }

type Load<T> = { state: 'loading' } | { state: 'failed'; error: string } | { state: 'ready'; value: T }

/** The detail's tabs. Every action on a bid stays here (Owner 2026-10-10): new tabs join this list. */
export const BID_TABS = ['why', 'history', 'whatif', 'goal'] as const
export type BidPanelTab = (typeof BID_TABS)[number]
export const isBidTab = (v: unknown): v is BidPanelTab => (BID_TABS as readonly unknown[]).includes(v)
const TABS: Array<{ id: BidPanelTab; label: string }> = [
  { id: 'why', label: 'Why' },
  { id: 'history', label: 'History' },
  { id: 'whatif', label: 'What if' },
  { id: 'goal', label: 'Goal' },
]
/** The tabs this answer can fill: Goal only when the answer carries the keyword's goal. */
export const tabsFor = (features: Pick<DetailFeatures, 'goal'>) => TABS.filter((t) => t.id !== 'goal' || features.goal)
const NOUN = {
  portfolio: { one: 'portfolio', many: 'portfolios' },
  campaign: { one: 'campaign', many: 'campaigns' },
  adGroup: { one: 'ad group', many: 'ad groups' },
}

/** Reads once per key; `version` reads again after a save; `again` reads again on Try again. */
function useLoad<T>(read: () => Promise<T>, key: string): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' })
  const [tries, setTries] = useState(0)
  useEffect(() => {
    let live = true
    setLoad({ state: 'loading' })
    read().then(
      (value) => { if (live) setLoad({ state: 'ready', value }) },
      (e: unknown) => { if (live) setLoad({ state: 'failed', error: e instanceof Error ? e.message : String(e) }) },
    )
    return () => { live = false }
    // `read` closes over the same key: the key (and Try again) is what changes it.
  }, [key, tries]) // eslint-disable-line react-hooks/exhaustive-deps
  return [load, useCallback(() => setTries((n) => n + 1), [])]
}

/** Where the bid lives, as links; one name that a phone cuts short shows whole on hover and on keyboard focus. */
function PlaceLinks({ items, noun }: { items: BidGridRow['campaigns']; noun: (typeof NOUN)[keyof typeof NOUN] }) {
  const links = <EntityLinks items={items} noun={noun} linkAs={Link} />
  return items.length === 1 ? <FullName full={items[0].name} className={styles.fill}>{links}</FullName> : links
}

function Muted({ children }: { children: string }) {
  return <p className={styles.muted}>{children}</p>
}

/** A read that failed: "<What> not read · Try again", the server's words on hover. */
function NotRead({ what, error, onRetry }: { what: string; error: string; onRetry: () => void }) {
  return (
    <span className={styles.row}>
      <span className={styles.muted} title={error}>{what} not read</span>
      <Button size="xs" variant="secondary" onClick={onRetry}>Try again</Button>
    </span>
  )
}

function WhyTab({ row, version }: { row: BidGridRow; version: number }) {
  const [why, again] = useLoad<BrainDecision | null>(() => readWhy(row.targetId), `${row.targetId}:${version}`)
  if (why.state === 'loading') return <Muted>Reading…</Muted>
  if (why.state === 'failed') return <NotRead what="Why" error={why.error} onRetry={again} />
  const d = why.value
  if (!d) return <Muted>—</Muted>
  const act = actionWord(d)
  const tag = layerTag(d.layer)
  return (
    <div className={styles.why}>
      <span className={styles.row}>
        <Pill tone={act.tone} size="sm">{act.label}</Pill>
        {tag && <Tag tone="neutral">{tag}</Tag>}
        <span className={styles.muted} title={whenWords(d.decidedAt)}>{relWords(d.decidedAt)}</span>
      </span>
      {typeof d.currentCents === 'number' && typeof d.decidedCents === 'number' && (
        <ChangeValue changes={[{ label: 'Bid', from: money(d.currentCents, row.currency), to: money(d.decidedCents, row.currency) }]} />
      )}
      <KeyValue labelCase="sentence" columns={2} dense items={decisionFacts(d, row.currency)} />
    </div>
  )
}

/** A keyword's History rows, for the one History table (`_shared/ChangeHistory.tsx`, the rule detail draws the same). */
function historyRows(lines: readonly HistoryLine[], row: BidGridRow, market: string | null, onWhy: () => void): HistoryRow[] {
  return lines.map((l) => {
    const href = whoHref(l.who, market)
    const who: WhoChip = l.who.kind === 'person' ? { word: 'You', tone: 'info' }
      : l.who.kind === 'brain' ? { word: l.who.name, onOpen: onWhy, hint: 'Why the Brain set it' }
        : { word: l.who.name, href }
    const from = l.from == null ? null : money(l.from, row.currency)
    return {
      id: l.id, at: l.at, change: { label: 'Bid', from, to: money(l.to, row.currency) }, who, state: l.state, undo: l.undo,
      undoLabel: `Undo ${from ? `${from} → ` : ''}${money(l.to, row.currency)}`,
    }
  })
}

function HistoryTab({ row, market, version, canEdit, onUndo, onWhy }: { row: BidGridRow; market: string | null; version: number; canEdit: boolean; onUndo: (line: HistoryLine) => void; onWhy: () => void }) {
  const [feed, again] = useLoad<FeedRow[]>(() => readHistory(row.targetId), `${row.targetId}:${version}`)
  const [raw, setRaw] = useState(false)
  if (feed.state === 'loading') return <Muted>Reading…</Muted>
  if (feed.state === 'failed') return <NotRead what="History" error={feed.error} onRetry={again} />
  const folded = historyLines(feed.value)
  const shown = raw ? historyLines(feed.value, { raw: true }) : folded
  const byId = new Map(shown.lines.map((l) => [l.id, l]))
  return (
    <div className={styles.why}>
      {folded.foldedSteps > 0 && (
        <span className={styles.row}>
          <FilterChip pressed={raw} count={folded.foldedSteps} onClick={() => setRaw(!raw)} title="Show the night floor and its morning give-back">
            Night floor
          </FilterChip>
        </span>
      )}
      {shown.lines.length === 0 ? <Muted>No change in 30 d</Muted> : (
        <ChangeHistory
          label={`Bid history of ${row.text}`} rows={historyRows(shown.lines, row, market, onWhy)} keywords={false} phone={false}
          undoHeld={canEdit ? null : 'Needs the ads campaigns permission'}
          onUndo={(r) => { const l = byId.get(r.id); if (l) onUndo(l) }}
        />
      )}
    </div>
  )
}

function WhatIfTab({ row }: { row: BidGridRow }) {
  const [text, setText] = useState('')
  const [answer, setAnswer] = useState<Load<WhatIfDecision | null> | null>(null)
  const pct = parseAcosPct(text)
  const check = useCallback(async () => {
    if (pct == null) return
    setAnswer({ state: 'loading' })
    try { setAnswer({ state: 'ready', value: await readWhatIf(row.targetId, pct) }) } catch (e) { setAnswer({ state: 'failed', error: e instanceof Error ? e.message : String(e) }) }
  }, [pct, row.targetId])
  const d = answer?.state === 'ready' ? answer.value : null
  const act = d ? actionWord({ action: d.whatIfAction, currentCents: d.currentCents, decidedCents: d.whatIfCents }) : null
  const tag = d ? layerTag(d.whatIfLayer) : null
  return (
    <div className={styles.why}>
      <form className={styles.actions} onSubmit={(e) => { e.preventDefault(); void check() }}>
        <span className={styles.acosInput}>
          <Field label="Target ACoS">
            <Input size="sm" fieldClassName={styles.field} inputMode="decimal" placeholder="20" suffix="%" value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        </span>
        <HeldButton size="sm" variant="secondary" type="submit" held={pct == null ? 'Type a target ACoS from 1 to 500 %' : answer?.state === 'loading' ? 'Reading…' : null}>
          Check
        </HeldButton>
      </form>
      {answer?.state === 'failed' && <NotRead what="What if" error={answer.error} onRetry={() => void check()} />}
      {answer?.state === 'ready' && !d && <Muted>—</Muted>}
      {d && act && (
        <>
          <span className={styles.row}>
            <Pill tone={act.tone} size="sm">{act.label}</Pill>
            {tag && <Tag tone="neutral">{tag}</Tag>}
          </span>
          <KeyValue
            labelCase="sentence"
            columns={2}
            dense
            items={[
              { label: 'Now', value: moneyText(d.currentCents, row.currency) },
              { label: 'Brain today', value: moneyText(d.decidedCents, row.currency) },
              { label: `At ${pct} %`, value: <strong>{moneyText(d.whatIfCents, row.currency)}</strong> },
            ]}
          />
        </>
      )}
    </div>
  )
}

/**
 * Goal: the keyword's own target ACoS, max bid and top-of-search share, saved in the brain's settings (the brain obeys them
 * from its next run). Each box empty = the campaign's or product's value applies. Review first; honest when no engine runs it.
 */
function GoalTab({ row, market, canGoal, onAsk }: { row: BidGridRow; market: string | null; canGoal: boolean; onAsk: (ask: BidAsk) => void }) {
  const [draft, setDraft] = useState<GoalDraft>(() => draftOf(row.goal))
  // Another keyword, or its goal changed (a save, a live read): the boxes start from it again.
  const goalKey = `${row.targetId}:${row.goal?.acosPct ?? ''}:${row.goal?.maxCents ?? ''}:${row.goal?.tosPct ?? ''}`
  useEffect(() => { setDraft(draftOf(row.goal)) }, [goalKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const held = goalHeld(row, market, canGoal)
  const { values, problems } = parseGoal(draft)
  const changes = goalChanges(row.goal, values)
  const first = GOAL_KEYS.map((k) => problems[k]).find(Boolean) ?? null
  const set = (key: keyof GoalDraft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [key]: e.target.value }))
  const by = row.goal?.by ? writerName({ kind: row.goal.by.kind, name: row.goal.by.name, id: row.goal.by.id ?? null }) : null
  return (
    <div className={styles.why}>
      <span className={styles.row}>
        <span>{goalText(row.goal, row.currency)}</span>
        {by && <span className={styles.muted} title={row.goal?.at ? whenWords(row.goal.at) : undefined}>{by}{row.goal?.at ? ` · ${relWords(row.goal.at)}` : ''}</span>}
      </span>
      {held && row.auto === 'NONE' ? <Muted>{held}</Muted> : (
        <form className={styles.goalForm} onSubmit={(e) => { e.preventDefault(); if (!held && !first && changes.length) onAsk({ kind: 'goal', row, values }) }}>
          <span className={styles.goalBox}>
            <Field label={GOAL_LABEL.targetAcosPct} error={problems.targetAcosPct}>
              <Input size="sm" fieldClassName={styles.field} inputMode="numeric" placeholder="—" suffix="%" value={draft.acos} onChange={set('acos')} />
            </Field>
          </span>
          <span className={styles.goalBox}>
            <Field label={GOAL_LABEL.maxBidCents} error={problems.maxBidCents}>
              <Input size="sm" fieldClassName={styles.field} inputMode="decimal" placeholder="—" prefix={currencySymbol(row.currency)} value={draft.max} onChange={set('max')} />
            </Field>
          </span>
          <span className={styles.goalBox}>
            <Field label={GOAL_LABEL.tosTargetPct} error={problems.tosTargetPct}>
              <Input size="sm" fieldClassName={styles.field} inputMode="numeric" placeholder="—" suffix="%" value={draft.tos} onChange={set('tos')} />
            </Field>
          </span>
          <HeldButton size="sm" variant="primary" type="submit" held={held ?? first ?? (changes.length ? null : 'Nothing changed')}>
            <Target size={14} aria-hidden /> Review goal
          </HeldButton>
        </form>
      )}
    </div>
  )
}

/** Amazon's suggested bid in the rail: the median, its range and age, and Apply when it differs from the bid now. */
function SuggestedLine({ row, canBids, onAsk }: { row: BidGridRow; canBids: boolean; onAsk: (ask: BidAsk) => void }) {
  const w = suggestedWords(row.suggested ?? { kind: 'loading' }, row.currency)
  const differs = w.mid !== null && typeof row.bidNow === 'number' && w.mid !== row.bidNow
  return (
    <span className={styles.row}>
      <span className={styles.inline} title={w.hint}><Sparkles size={14} aria-hidden className="nds-cell-glyph" /> Suggested {w.text}</span>
      {w.mid !== null && <span className={styles.muted}>{w.hint}</span>}
      {differs && (
        <HeldButton size="sm" variant="secondary" held={canBids ? null : 'Needs the ads bids permission'} onClick={() => onAsk({ kind: 'apply', row, rows: [row] })}>Apply</HeldButton>
      )}
    </span>
  )
}

/** The rail: what stays in view on every tab, and the two actions on the bid. */
function BidRail({ row, market, canEdit, canBids, features, version, onAsk }: { row: BidGridRow; market: string | null; canEdit: boolean; canBids: boolean; features: DetailFeatures; version: number; onAsk: (ask: BidAsk) => void }) {
  const [bidText, setBidText] = useState('')
  // Another keyword, or a save (the view bumps `version`): the box starts empty again.
  useEffect(() => { setBidText('') }, [row.targetId, version])
  const [lock] = useLoad<CampaignLock | null>(() => readCampaignLock(row.campaign, market), `${row.campaign.id}:${market ?? ''}:${version}`)

  const editHeld = editHeldReason(row, canEdit)
  const typed = parseBid(bidText)
  const problem = bidProblem(typed, row.currency)
  const same = typed !== null && typed === row.bidNow
  const lockHeld = !canEdit ? 'Needs the ads campaigns permission'
    : lock.state === 'loading' ? 'Reading the campaign\'s lock…'
      : lock.state === 'failed' || !lock.value ? 'The campaign\'s lock could not be read'
        : null
  const locked = lock.state === 'ready' && !!lock.value?.bidsLocked
  const last = lastChangeWords(row.lastChange, row.currency)

  return (
    <aside className={styles.rail} aria-label="This bid">
      <div className={styles.hero}>
        <span className={`${styles.inline} ${styles.big}`}>
          <NightFloorMark row={row} />
          {moneyText(row.bidNow, row.currency)}
        </span>
        {typeof row.brainAim === 'number' && (
          <span className={styles.inline} title="Brain bid: the bid the Brain's goal asks for">
            <OwnerIcon kind="BRAIN" />
            {money(row.brainAim, row.currency)}
            {row.heldBy && <span title={row.heldBy.reason ?? undefined}><Tag tone="neutral">{row.heldBy.label}</Tag></span>}
          </span>
        )}
        <Sparkline values={row.spark ?? []} label={TREND_LABEL} format={(n) => money(n, row.currency)} width={140} height={28} />
      </div>

      <form
        className={styles.actions}
        onSubmit={(e) => {
          e.preventDefault()
          if (!editHeld && !problem && !same && typed !== null) onAsk({ kind: 'bid', row, nextCents: typed })
        }}
      >
        {!editHeld && (
          <span className={styles.bidInput}>
            <Input size="sm" fieldClassName={styles.field} prefix={currencySymbol(row.currency)} inputMode="decimal" aria-label="New bid" placeholder={typeof row.bidNow === 'number' ? (row.bidNow / 100).toFixed(2) : ''} value={bidText} onChange={(e) => setBidText(e.target.value)} />
          </span>
        )}
        <HeldButton size="sm" variant="primary" type="submit" held={editHeld ?? (bidText.trim() === '' ? 'Type a bid' : problem ?? (same ? 'That is the bid now' : null))}>
          <PencilLine size={14} aria-hidden /> Set bid
        </HeldButton>
        {locked ? (
          <HeldButton size="sm" variant="secondary" type="button" held={lockHeld} onClick={() => onAsk({ kind: 'lock', row, lock: false })} title="Give every bid of this campaign back to automation">
            <LockOpen size={14} aria-hidden /> Unlock campaign bids
          </HeldButton>
        ) : (
          <HeldButton size="sm" variant="secondary" type="button" held={lockHeld} onClick={() => onAsk({ kind: 'lock', row, lock: true })} title="Every bid of this campaign: automation leaves them">
            <Lock size={14} aria-hidden /> Lock campaign bids
          </HeldButton>
        )}
      </form>

      {(features.suggested || features.auto) && (
        <div className={styles.actions}>
          {features.suggested && <SuggestedLine row={row} canBids={canBids} onAsk={onAsk} />}
          {/* No engine runs the campaign: nothing to switch, so no button (audit R1; the Goal tab says why). */}
          {features.auto && row.auto && row.auto !== 'NONE' && (
            <HeldButton
              size="sm"
              variant="secondary"
              held={autoHeld(row, canBids)}
              onClick={() => onAsk({ kind: 'mode', row, next: row.auto === 'AUTO' ? 'MANUAL' : 'AUTO' })}
              title={row.auto === 'AUTO' ? 'You hold this bid: automation leaves it until you switch it back' : 'The engine moves this bid again'}
            >
              <Hand size={14} aria-hidden /> {row.auto === 'AUTO' ? `Switch to ${AUTO_WORDS.off}` : `Switch to ${AUTO_WORDS.on}`}
            </HeldButton>
          )}
        </div>
      )}

      {/* One per line: a long campaign or ad group name reads in full here (the table's cell may cut it). */}
      <KeyValue
        labelCase="sentence"
        dense
        items={[
          { label: 'Portfolio', value: <PlaceLinks items={row.portfolios} noun={NOUN.portfolio} /> },
          { label: 'Campaign', value: <PlaceLinks items={row.campaigns} noun={NOUN.campaign} /> },
          { label: 'Ad group', value: <PlaceLinks items={row.adGroups} noun={NOUN.adGroup} /> },
        ]}
      />
      <KeyValue
        labelCase="sentence"
        columns={2}
        dense
        items={[
          { label: 'Last change', value: last ? <span title={last.title}>{last.text}</span> : '—' },
          { label: `Changes ${WEEK}`, value: row.changes7d },
          { label: `Clicks · orders ${WEEK}`, value: `${row.d7.clicks} · ${row.d7.orders}` },
          { label: `ACoS ${WEEK}`, value: acosText(row.d7.acosPct) },
          { label: 'Max CPC', value: <span title="The bid with its highest placement, this hour">{moneyText(row.maxCpc, row.currency)}</span> },
        ]}
      />
    </aside>
  )
}

/**
 * The keyword's detail. `row` null while the bids are read (`loading`) or when the address names a bid this view does not
 * hold (`missing`). `nav`: the table's rows in the order shown now, for ▲ / ▼ and K / J.
 */
export function BidDetail({ row, missing, loading, onRetry, tab, onTab, nav, market, canEdit, canBids, canGoal, features, version, onAsk, onClose, returnFocusTo }: {
  row: BidGridRow | null
  /** The address names a bid this view does not hold. */
  missing: boolean
  loading: boolean
  onRetry: () => void
  /** The open tab (the view keeps it in the address: `?bid=<targetId>&tab=<tab>`). */
  tab: BidPanelTab
  onTab: (tab: BidPanelTab) => void
  nav?: DetailNav
  market: string | null
  canEdit: boolean
  /** May send bids in bulk and switch a keyword (ads.bids.edit). */
  canBids: boolean
  /** May set a keyword's goal (the brain's settings: ads automation). */
  canGoal: boolean
  features: DetailFeatures
  /** Bumped by the view after a save: the detail reads its history and the lock again. */
  version: number
  onAsk: (ask: BidAsk) => void
  onClose: () => void
  returnFocusTo?: DetailModalProps['returnFocusTo']
}) {
  const shownMarket = row ? row.market ?? (market && market !== 'all' ? market : null) : null
  return (
    <DetailModal
      open
      onClose={onClose}
      title={row?.text ?? 'Bid'}
      subtitle={row ? [matchWord(row.match), shownMarket].filter((w) => w && w !== '—').join(' · ') : undefined}
      meta={row ? <OwnerChip row={row} onWhy={() => onTab('why')} /> : undefined}
      tabs={tabsFor(features)}
      activeTab={tab === 'goal' && !features.goal ? 'why' : tab}
      onTabChange={(id) => { if (isBidTab(id)) onTab(id) }}
      tabsLabel="Keyword"
      nav={nav}
      loading={!row && loading}
      error={!row && !loading && missing ? 'This bid is not in this view.' : undefined}
      onRetry={onRetry}
      returnFocusTo={returnFocusTo}
    >
      {row && (
        <div className={styles.detail}>
          <BidRail row={row} market={market} canEdit={canEdit} canBids={canBids} features={features} version={version} onAsk={onAsk} />
          <section className={styles.detailMain}>
            {tab === 'why' && <WhyTab row={row} version={version} />}
            {tab === 'history' && <HistoryTab row={row} market={market} version={version} canEdit={canEdit} onUndo={(line) => onAsk({ kind: 'undo', row, line })} onWhy={() => onTab('why')} />}
            {tab === 'whatif' && <WhatIfTab row={row} />}
            {tab === 'goal' && (features.goal ? <GoalTab row={row} market={market} canGoal={canGoal} onAsk={onAsk} /> : <WhyTab row={row} version={version} />)}
          </section>
        </div>
      )}
    </DetailModal>
  )
}
