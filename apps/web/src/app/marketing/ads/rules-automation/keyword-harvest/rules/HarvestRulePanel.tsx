'use client'

/**
 * Keyword Harvest page, Rules view — the detail of one harvest rule (2026-10-11, lane HRULES): the DS `DetailModal`, the
 * Bid rule modal's look. Overview · Waiting · Preview · History; the brain's detail is read only (Overview · Waiting ·
 * History). A phone gets the full-screen sheet.
 *
 * Address: `?rule=<id>&tab=<tab>` (the view's `useDetailParam`: open pushes, Prev / Next and a tab replace, close goes
 * back). ▲ / ▼ and K / J walk the table's rows as shown now. Esc closes it and the focus goes back to the rule's cell.
 *
 * The detail never writes. A mode pick, an archive, a restore, a decision on asks or the Undo of a harvest asks the VIEW,
 * which reviews it in the DS `ReviewChangesModal` stacked ON TOP of this detail; the focus comes back to the control
 * that opened it. "Edit" opens the one rule editor (the bid builder, its Keyword Harvest type).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Brain, RotateCw, Undo2 } from 'lucide-react'
import { Button, SegmentedControl, Skeleton, Tag, ToolbarButton, Tooltip } from '@/design-system/primitives'
import { Banner, EntityLinks, EntityPath, KeyValue, Listbox, type EntityLinkComponent, type ListboxPanelOption } from '@/design-system/components'
import { DetailModal, type DetailNav } from '@/design-system/patterns'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import Link from '@/lib/workspaces/Link'
import { currencyOf, moneyText, periodWord, relWords, whenWords } from '../../bid/_shared/format'
import {
  LAST_WEEK, MODES, MODE_WORD, REF_HEADER, autoLockOf, holdReason, holdsOf, isBrain, nextRunView, plural, readError,
  type BidMode, type BidRuleRow, type RefKind,
} from '../../bid/rules/bidRulesModel'
import { RefLinks } from '../../bid/rules/RulesTable'
import { previewHarvestRule, readCandidates, readRuleHistory } from '../_shared/harvestApi'
import type { HarvestCandidateRow, HistoryRow, RulePreviewAnswer } from '../_shared/types'
import { ReviewDialogs, approveHeld, decideButtonWords, decideHeld as rowDecideHeld, statusOf, useTermsReview, waitingDecision } from '../terms'
import {
  BRAIN_HARVEST_LOCK, HARVEST_MODE_MEANS, HISTORY_DAYS, autoCapWords, autoMeans, blocksWord, destinationWords, effectParts,
  brainTermsLine, type BrainOwned, harvestHeldStep, harvestLast7Parts, historyStateView, keywordRuns, plainStale, previewView, harvestMatchWord, harvestUndoView,
  plainHold, ruleLine, scheduleShort, verdictView,
  type RuleEffect,
} from './harvestRulesModel'
import type { HarvestPanelTab } from './HarvestRulesTable'
import { modeBase } from './harvestRuleChanges'
import styles from '../../bid/bid.module.css'

const WorkspaceLink = Link as unknown as EntityLinkComponent
const ONE = { one: 'item', many: 'items' }
const KINDS: readonly RefKind[] = ['portfolios', 'campaigns', 'adGroups']
const PRODUCT_NOUN = { one: 'product', many: 'products' }
/** The products a row runs (the brain's `scope.products`, HCORE S11); none for a rule. */
const productsOf = (r: BidRuleRow): Array<{ id: string; name: string; href?: string | null }> => {
  const list = (r.scope as { products?: unknown }).products
  return Array.isArray(list) ? list as Array<{ id: string; name: string; href?: string | null }> : []
}

export interface HarvestRulePanelProps {
  row: BidRuleRow
  tab: HarvestPanelTab
  onTab(tab: HarvestPanelTab): void
  nav: DetailNav
  returnFocusTo: () => HTMLElement | null
  market: string
  phone: boolean
  /** The mode the view's draft holds for this rule, if any. */
  drafted: BidMode | null
  modeHeld: string | null
  archiveHeld: string | null
  /** Why this person may not decide asks or undo a harvest (permission), or null. */
  decideHeld: string | null
  /** The Owner's D2 cap on Auto (new keywords a day per rule), once read. */
  capPerDay: number | null
  effect: RuleEffect | null
  effectDays: number
  /** Bumped after a saved change, so the open tab reads again. */
  reloadKey: number
  onClose(): void
  onMode(next: BidMode): void
  onArchive(): void
  onRestore(): void
  onEdit(): void
  /** A decision on the rule's asks ran (the review is Terms' own): read the rules again. */
  onChanged(): void
  onUndo(h: HistoryRow): void
  /** The brain row's mode (its Preview line says what it does with its terms), or null when the list has no brain. */
  brainMode: BidMode | null
  /** Show the brain's detail (from a rule's Preview). */
  onOpenBrain(): void
}

const ruleTabs = (waiting: number, open: boolean, brain: boolean): Array<{ id: HarvestPanelTab; label: string; count?: number }> => [
  { id: 'overview', label: 'Overview' },
  ...(waiting > 0 || open ? [{ id: 'waiting' as const, label: 'Waiting', count: waiting }] : []),
  ...(brain ? [] : [{ id: 'preview' as const, label: 'Preview' }]),
  { id: 'history', label: 'History' },
]

/** The market a rule's money is in: its own, else the page's (one market), else euros. */
const marketOf = (row: BidRuleRow, market: string): string | null => row.market ?? (market !== 'all' ? market : null)

export function HarvestRulePanel(p: HarvestRulePanelProps) {
  const brain = isBrain(p.row)
  const tabs = ruleTabs(p.row.waiting, p.tab === 'waiting', brain)
  const tab = tabs.some((t) => t.id === p.tab) ? p.tab : 'overview'
  const footer = brain ? null : (
    <>
      <span data-return="archive">
        {p.row.archived
          ? <Button size="sm" variant="secondary" heldReason={p.archiveHeld} onClick={p.onRestore}>Restore…</Button>
          : <Button size="sm" variant="danger-outline" heldReason={p.archiveHeld} onClick={p.onArchive}>Archive…</Button>}
      </span>
      <span className="grow" />
      <span data-return="edit">
        <Button size="sm" variant="secondary" heldReason={p.archiveHeld ?? (p.row.archived ? 'Archived: restore it first' : null)} onClick={p.onEdit}>Edit</Button>
      </span>
    </>
  )
  const meta = (
    <>
      {p.row.archived && <Tag>Archived</Tag>}
      {!brain && <Tag>{p.row.market ?? 'All markets'}</Tag>}
    </>
  )
  return (
    <DetailModal
      open
      onClose={p.onClose}
      title={<span className={styles.panelTitle}>{brain && <Brain size={16} aria-hidden className={styles.brainIcon} />}{p.row.name}</span>}
      subtitle={ruleLine(p.row.sentence)}
      meta={meta}
      tabs={tabs.map((t) => ({ id: t.id, label: t.label, ...(t.count !== undefined ? { count: t.count } : {}) }))}
      activeTab={tab}
      onTabChange={(id) => p.onTab(id as HarvestPanelTab)}
      tabsLabel={`${p.row.name}: sections`}
      nav={p.nav}
      footer={footer}
      returnFocusTo={p.returnFocusTo}
    >
      <div className={styles.panelBody}>
        {tab === 'overview' && <Overview {...p} />}
        {tab === 'waiting' && <WaitingTab row={p.row} market={p.market} phone={p.phone} reloadKey={p.reloadKey} decideHeld={p.decideHeld} onChanged={p.onChanged} />}
        {tab === 'preview' && !brain && <Preview row={p.row} market={p.market} reloadKey={p.reloadKey} brainMode={p.brainMode} onOpenBrain={p.onOpenBrain} />}
        {tab === 'history' && <History {...p} />}
      </div>
    </DetailModal>
  )
}

/** A chip whose meaning is on hover and focus. */
function HintTag({ label, hint, tone = 'neutral' }: { label: string; hint: string; tone?: 'neutral' | 'warning' | 'info' | 'success' | 'danger' }) {
  return <Tooltip label={hint} portal><span tabIndex={0} aria-label={`${label}: ${hint}`}><Tag tone={tone}>{label}</Tag></span></Tooltip>
}

function Loading() {
  return <div className={styles.stack} aria-busy="true"><Skeleton height={16} /><Skeleton height={16} /><Skeleton height={16} /></div>
}

function NotRead({ what, error, onRetry }: { what: string; error: string; onRetry?: () => void }) {
  return (
    <Banner tone="danger" title={`${what} not read`} action={onRetry ? <Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button> : undefined}>
      {readError(error)}
    </Banner>
  )
}

function useLoad<T>(load: () => Promise<T>, keys: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setState({ data: null, error: null })
    load().then((data) => { if (alive) setState({ data, error: null }) }, (e: unknown) => { if (alive) setState({ data: null, error: (e as Error).message }) })
    return () => { alive = false }
  }, [...keys, tick]) // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: () => setTick((t) => t + 1) }
}

// ── overview ────────────────────────────────────────────────────────────────────────────────────────────────────────

function Refs({ row, set }: { row: BidRuleRow; set: 'scope' | 'changed' }) {
  return (
    <KeyValue
      dense
      columns={3}
      items={KINDS.map((k) => ({
        label: REF_HEADER[k],
        value: <RefLinks row={row} kind={k} set={set} listLabel={`${REF_HEADER[k]} it ${set === 'scope' ? 'harvests from' : `harvested into · ${LAST_WEEK.toLowerCase()}`}`} />,
      }))}
    />
  )
}

function ModePicker(p: HarvestRulePanelProps) {
  const r = p.row
  // One mode word (re-audit N-S2): a rule that acts higher than set shows what it does.
  const value = p.drafted ?? modeBase(r.mode)
  // From Off, Auto is held with its plain reason ("Turn on Watch first"), never offered and then refused.
  const options = useMemo<ListboxPanelOption[]>(() => MODES
    .map((m) => {
      const held = harvestHeldStep(r, m)
      const means = m === 'AUTO' ? autoMeans() : HARVEST_MODE_MEANS[m]
      return { value: m, label: MODE_WORD[m], note: held ?? means, ...(held ? { heldReason: held } : {}) }
    }), [r, p.capPerDay])
  if (isBrain(r) || r.archived || p.modeHeld) {
    const why = isBrain(r) ? BRAIN_HARVEST_LOCK : r.archived ? 'Archived: restore it first' : p.modeHeld
    return <Tooltip label={why ?? HARVEST_MODE_MEANS[r.mode.set]} portal><span className={styles.modeWord} tabIndex={0} aria-description={why ?? undefined}>{MODE_WORD[r.mode.set]}</span></Tooltip>
  }
  return (
    <span className={styles.line}>
      <Listbox size="sm" width={140} ariaLabel={`Mode of ${r.name}`} options={options} value={value} onChange={(v) => { if ((MODES as readonly string[]).includes(v)) p.onMode(v as BidMode) }} />
      {p.drafted && <Tag tone="info">Not saved</Tag>}
    </span>
  )
}

function Overview(p: HarvestRulePanelProps) {
  const r = p.row
  const brain = isBrain(r)
  const holds = holdsOf(r.mode).map(plainHold)
  const autoLock = autoLockOf(r)
  const auto = autoLock ? plainHold(autoLock) : null
  const acts = r.mode.acts !== r.mode.set
  const parts = harvestLast7Parts(r)
  const effect = effectParts(p.effect)
  const next = nextRunView(r)
  const nextHint = r.nextRunAt ? [whenWords(r.nextRunAt), scheduleShort(r.schedule)].filter(Boolean).join(' · ') : next.hint ?? undefined
  const into = r.changed7d.portfolios.length + r.changed7d.campaigns.length + r.changed7d.adGroups.length > 0
  const cap = autoCapWords(p.capPerDay)
  const products = productsOf(r)
  return (
    <div className={styles.stack}>
      <KeyValue
        columns={3}
        items={[
          { label: 'Mode', value: <span data-return="mode"><ModePicker {...p} /></span>, hint: acts ? `Acts as ${MODE_WORD[r.mode.acts]}` : undefined },
          { label: 'Next run', value: next.value, hint: nextHint },
          { label: 'Last run', value: relWords(r.lastRunAt), hint: r.lastRunAt ? whenWords(r.lastRunAt) : undefined },
        ]}
      />
      {/* One chip row: what holds it, and (a rule) its caps on Auto (audit S20). */}
      {(holds.length > 0 || auto || (!brain && cap)) && (
        <div className={styles.chips} aria-label="What holds it">
          {holds.map((h, i) => <HintTag key={`${h.kind}-${i}`} label={h.label} hint={holdReason(h)} tone={i === 0 && acts ? 'warning' : 'neutral'} />)}
          {auto && <HintTag label={auto.label} hint={holdReason(auto)} />}
          {!brain && cap && <Tag>{cap}</Tag>}
        </div>
      )}
      <section className={styles.section} aria-label={LAST_WEEK}>
        <h3 className={styles.h}>{LAST_WEEK}</h3>
        <div className={styles.chips}>
          {parts.map((x) => (x.tab
            ? <Button key={x.key} size="xs" variant="tonal" onClick={() => p.onTab(x.tab!)} aria-label={`${x.text}: open ${x.tab === 'waiting' ? 'the asks' : 'History'}`}>{x.text}</Button>
            : <Tag key={x.key} tone={x.tone ?? 'neutral'}>{x.text}</Tag>))}
          {r.waiting > 0 && <Button size="xs" variant="warning" onClick={() => p.onTab('waiting')} aria-label={`${r.waiting} waiting: open them`}>{r.waiting} waiting</Button>}
          {!parts.length && !r.waiting && <span className={styles.muted}>{r.last7d.runs ? `${plural(r.last7d.runs, 'run')}, nothing harvested` : 'No runs'}</span>}
        </div>
      </section>
      <section className={styles.section} aria-label="Effect">
        <h3 className={styles.h}>Effect · {periodWord(p.effectDays)}</h3>
        <div className={styles.chips}>
          {effect.length
            ? effect.map((x) => <Button key={x.key} size="xs" variant="tonal" onClick={() => p.onTab('history')} aria-label={`${x.text}: open History`}>{x.text}</Button>)
            : <span className={styles.muted}>No harvests</span>}
        </div>
      </section>
      <section className={styles.section} aria-label="Harvests from">
        <h3 className={styles.h}>Harvests from{r.scope.product && !products.length ? <Tag>{r.scope.product.name}</Tag> : null}</h3>
        {/* The brain (S11): the products it runs, then their source campaigns and ad groups. */}
        {products.length > 0 && <div className={styles.chips}><EntityLinks items={products} noun={PRODUCT_NOUN} linkAs={WorkspaceLink} listLabel="Products it runs" /></div>}
        {/* A rule over the whole market says so, without three lists of its market (audit §2). */}
        {r.scope.all && !brain ? <div className={styles.chips}><Tag>Whole market</Tag></div> : <Refs row={r} set="scope" />}
      </section>
      {into && (
        <section className={styles.section} aria-label={`Harvested into · ${LAST_WEEK.toLowerCase()}`}>
          <h3 className={styles.h}>Harvested into · {LAST_WEEK.toLowerCase()}</h3>
          <Refs row={r} set="changed" />
        </section>
      )}
    </div>
  )
}

// ── waiting ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type WaitingRow = HarvestCandidateRow

/**
 * The rule's asks (or the brain's requests) that wait — the SAME rows, holds and review as the Terms view (re-audit N-M1):
 * the candidates in WAITING whose request is this rule's (`waiting.tool === 'rule:<id>'`) or the brain's. Every row starts
 * ticked; Approve leaves out the asks the server would refuse now (out of date: their rule changed) and says how many,
 * Reject takes them. The review is Terms' own (`useTermsReview` + `ReviewDialogs`), stacked on this detail.
 */
function WaitingTab({ row, market, phone, reloadKey, decideHeld, onChanged }: {
  row: BidRuleRow
  market: string
  phone: boolean
  reloadKey: number
  decideHeld: string | null
  onChanged(): void
}) {
  const brain = isBrain(row)
  const [tick, setTick] = useState(0)
  const { data, error, reload } = useLoad<WaitingRow[]>(async () => {
    const a = await readCandidates({ market, state: ['WAITING'], pageSize: 500 })
    return a.rows.filter((r) => (brain ? r.waiting?.by.kind === 'BRAIN' : r.waiting?.tool === `rule:${row.id}`))
  }, [row.id, market, reloadKey, tick])
  const rows = useMemo(() => data ?? [], [data])
  const review = useTermsReview({ after: async () => { setTick((t) => t + 1); onChanged() } })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const touched = useRef(false)
  useEffect(() => {
    setSelected((s) => (touched.current ? new Set(rows.filter((r) => s.has(r.id)).map((r) => r.id)) : new Set(rows.map((r) => r.id))))
  }, [rows])
  const ticked = rows.filter((r) => selected.has(r.id))
  const approve = waitingDecision('approve', ticked, rows)
  const reject = waitingDecision('reject', ticked, rows)
  const none = 'Tick at least one'
  const aHeld = decideHeld ?? (!ticked.length ? none : !approve.rows.length ? plainStale(approveHeld(ticked[0])) : null)
  const rHeld = decideHeld ?? (!ticked.length ? none : !reject.rows.length ? rowDecideHeld(ticked[0]) : null)
  const currency = currencyOf(marketOf(row, market))

  const term: Column<WaitingRow> = {
    key: 'term', label: 'Search term', render: (r) => (
      <span className={styles.two}>
        <span className={styles.line}><span className={styles.ellipsis} title={r.term}>{r.term}</span></span>
        <span className={styles.subline}><EntityLinks items={[r.product]} noun={ONE} linkAs={WorkspaceLink} /></span>
      </span>
    ),
  }
  const goes: Column<WaitingRow> = {
    key: 'to', label: 'Goes to', render: (r) => (
      <span className={styles.two}>
        <DestinationCell d={r.destination} />
        <span className={styles.chips}>
          {r.destination && <Tag>{harvestMatchWord(r.destination.match)}</Tag>}
          {r.startBidCents != null && <Tag>{moneyText(r.startBidCents, r.currency ?? currency)}</Tag>}
        </span>
      </span>
    ),
  }
  const status: Column<WaitingRow> = {
    key: 'status', label: 'Status', render: (r) => {
      const stale = r.waiting?.stale ? plainStale(r.waiting.stale.why) : null
      const v = statusOf(r)
      return stale
        ? <HintTag label="Out of date" hint={stale} />
        : <span className={styles.two}><Tag tone="warning">{v.word}</Tag>{v.hint && <span className={styles.sub}>{v.hint}</span>}</span>
    },
  }
  return (
    <div className={styles.stack}>
      <div className={styles.chips} data-return="decide">
        <Button size="sm" variant="primary" heldReason={aHeld} onClick={() => review.ask({ kind: 'approve', ...approve })}>{approve.rows.length ? decideButtonWords('approve', approve.rows).label : 'Approve'}</Button>
        <Button size="sm" variant="secondary" heldReason={rHeld} onClick={() => review.ask({ kind: 'reject', ...reject })}>{reject.rows.length ? decideButtonWords('reject', reject.rows).label : 'Reject'}</Button>
        {approve.leftOut > 0 && ticked.length > 0 && <HintTag label={`${approve.leftOut} out of date`} hint={plainStale(rows.find((r) => r.waiting?.stale)?.waiting?.stale?.why ?? null) ?? ''} />}
      </div>
      {error && <NotRead what="Asks" error={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && rows.length > 0 && (
        <DataGrid
          ariaLabel={`${plural(rows.length, 'term')} waiting`}
          columns={phone ? [term, status] : [term, goes, status]}
          rows={rows}
          rowKey={(r) => r.id}
          selectable={!decideHeld}
          selected={selected}
          onSelectedChange={(next) => { touched.current = true; setSelected(new Set(next)) }}
          selectAllHint="Tick every waiting term"
          selectRowHint="Tick this term"
          headerMenus={false}
        />
      )}
      {data && !rows.length && !error && <p className={styles.muted}>Nothing waiting.</p>}
      <ReviewDialogs {...review} />
    </div>
  )
}

// ── preview ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type Sample = RulePreviewAnswer['sample'][number]

function Preview({ row, market, reloadKey, brainMode, onOpenBrain }: { row: BidRuleRow; market: string; reloadKey: number; brainMode: BidMode | null; onOpenBrain(): void }) {
  const { data, error, reload } = useLoad<RulePreviewAnswer>(async () => {
    const out = await previewHarvestRule({ ruleId: row.id, limit: 50 })
    if (!out.ok) throw new Error(out.words)
    return out.data
  }, [row.id, reloadKey])
  const currency = currencyOf(data?.market ?? marketOf(row, market))
  const view = data ? previewView(data as RulePreviewAnswer & { brainOwned?: BrainOwned | null }, 50) : null
  const columns: Array<Column<Sample>> = [
    {
      key: 'term', label: 'Search term', render: (s) => (
        <span className={styles.two}>
          <span className={styles.ellipsis} title={s.term}>{s.term}</span>
          <span className={styles.subline}><EntityLinks items={[s.product]} noun={ONE} linkAs={WorkspaceLink} /></span>
        </span>
      ),
    },
    { key: 'to', label: 'Goes to', render: (s) => <DestinationCell d={s.destination} /> },
    {
      key: 'bid', label: 'Start bid', render: (s) => (
        <span className={styles.chips}>
          {s.startBidCents === undefined ? <span className={styles.muted} title="Needs the ad spend permission">—</span> : <span>{moneyText(s.startBidCents ?? null, currency)}</span>}
          {s.heldBy && <HintTag label={s.heldBy.label} hint={s.heldBy.reason} tone="warning" />}
        </span>
      ),
    },
  ]
  return (
    <div className={styles.stack}>
      <div className={styles.lineBetween}>
        <span className={styles.chips}>
          {data && <Tag>{plural(data.wouldHarvest, 'keyword')}</Tag>}
          {view && view.held > 0 && <Tag tone="warning">{view.held} held</Tag>}
        </span>
        <ToolbarButton icon={<RotateCw size={14} aria-hidden />} label="Run again" onClick={reload} />
      </div>
      {error && <NotRead what="Preview" error={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {/* The brain's terms: one line with a way to its row, never N rows of "Brain decides" (audit S12). */}
      {view && view.brainTerms > 0 && (
        <div className={styles.chips}>
          <span className={styles.muted}>{view.words ?? brainTermsLine(view.brainTerms, brainMode, view.ofFirst)}</span>
          <Button size="xs" variant="tonal" onClick={onOpenBrain}><Brain size={12} aria-hidden /> Brain</Button>
        </div>
      )}
      {view && view.rows.length > 0 && <DataGrid ariaLabel="What it would harvest" columns={columns} rows={view.rows} rowKey={(s) => s.candidateId} headerMenus={false} />}
      {view && !view.rows.length && !view.brainTerms && <p className={styles.muted}>Nothing to harvest now.</p>}
    </div>
  )
}

/** The preview's destination (the engine's shape): "Campaign › Ad group" as links, or "New · name". */
function DestinationCell({ d }: { d: unknown }) {
  const dest = d as Parameters<typeof destinationWords>[0]
  if (dest && dest.kind === 'existing') {
    return <EntityPath items={[dest.campaign, dest.adGroup]} linkAs={WorkspaceLink} label="Goes to" />
  }
  return <span className={styles.ellipsis}>{destinationWords(dest)}</span>
}

// ── history ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function History(p: HarvestRulePanelProps) {
  const r = p.row
  const [days, setDays] = useState(30)
  const { data, error, reload } = useLoad(() => readRuleHistory(r.id, { market: p.market, days, limit: 200 }), [r.id, days, p.reloadKey, p.market])
  const rows = data?.harvests ?? []
  const when: Column<HistoryRow> = { key: 'when', label: 'When', render: (h) => <span title={whenWords(h.at)}>{relWords(h.at)}</span> }
  const columns: Array<Column<HistoryRow>> = [
    ...(p.phone ? [] : [when]),
    {
      key: 'term', label: 'Search term', render: (h) => (
        <span className={styles.two}>
          <span className={styles.line}><span className={styles.ellipsis} title={h.term}>{h.term}</span><Tag>{harvestMatchWord(h.match)}</Tag></span>
          <span className={styles.subline}>{p.phone && <span className={styles.muted}>{relWords(h.at)}</span>}<EntityLinks items={[h.product]} noun={ONE} linkAs={WorkspaceLink} /></span>
        </span>
      ),
    },
    {
      key: 'to', label: 'Went to', render: (h) => (h.destination?.campaign
        ? <EntityPath items={[h.destination.campaign, h.destination.adGroup]} linkAs={WorkspaceLink} label="Went to" />
        : <span className={styles.muted}>—</span>),
    },
    { key: 'status', label: 'Result · Undo', render: (h) => <ResultCell h={h} held={p.decideHeld} onUndo={p.onUndo} /> },
  ]
  return (
    <div className={styles.stack}>
      <div className={styles.lineBetween}>
        <SegmentedControl size="sm" ariaLabel="Days" options={HISTORY_DAYS} value={String(days)} onChange={(v) => setDays(Number(v))} />
        {data && <Tag>{plural(rows.length, 'harvest')}</Tag>}
      </div>
      {error && <NotRead what="History" error={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && rows.length > 0 && <DataGrid ariaLabel="Harvests" columns={columns} rows={rows} rowKey={(h) => h.harvestId} headerMenus={false} />}
      {data && !rows.length && <p className={styles.muted}>No harvests in {days} d.</p>}
    </div>
  )
}

/** What became of a harvest, its verdict, the blocks it added, and its Undo (or why not). */
function ResultCell({ h, held, onUndo }: { h: HistoryRow; held: string | null; onUndo(h: HistoryRow): void }): ReactNode {
  const s = historyStateView(h)
  // A harvest whose keyword no longer runs is not judged on the row (audit M3): its state says it.
  const v = keywordRuns(h) && h.status !== 'UNDONE' ? verdictView(h.judge) : null
  const blocks = blocksWord(h)
  const undo = harvestUndoView(h)
  return (
    <span className={styles.chips}>
      <Tag tone={s.tone}>{s.word}</Tag>
      {v && (v.hint ? <HintTag label={v.word} hint={v.hint} tone={v.tone === 'success' ? 'success' : v.tone === 'danger' ? 'danger' : 'neutral'} /> : <Tag tone={v.tone}>{v.word}</Tag>)}
      {blocks && <Tag>{blocks}</Tag>}
      {undo.kind === 'undo'
        ? <span data-return={`undo:${h.harvestId}`}><Button size="xs" variant="secondary" heldReason={held} onClick={() => onUndo(h)} aria-label={`Undo the harvest of ${h.term}`}><Undo2 size={13} aria-hidden /> Undo…</Button></span>
        : <span className={styles.cant}>{undo.reason}</span>}
    </span>
  )
}
