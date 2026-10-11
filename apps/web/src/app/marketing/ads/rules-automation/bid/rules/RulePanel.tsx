'use client'

/**
 * Bid page, Rules view — the detail of one rule (2026-10-10, polish round 2): a centered DS `DetailModal` (the Owner: no
 * side drawer), a full-screen sheet on a phone. Overview · Waiting · Preview · History · Effect · Settings; the brain's
 * detail is read only here (Overview · Clashes · History · Effect).
 *
 * Address: `?rule=<id>&tab=<tab>` — the tabs are links (they replace the address, so Back closes the detail); ▲ / ▼ and
 * K / J move to the previous / next rule of the table as it is shown now. Esc closes it and the focus goes back to the
 * rule's cell in the table (the row now shown, after Prev / Next).
 *
 * The detail never writes. A mode pick, an archive, a restore, an Undo, a run's roll back or a decision on asks asks the
 * PAGE, which reviews it in the DS `ReviewChangesModal` stacked ON TOP of this detail; when the review closes the focus
 * goes back to the control that opened it, inside this detail (audit M10). "Edit all" opens the bid builder. Each write
 * control is held with its reason (a permission, or a market Nexus only reads — the page passes the held words, A1).
 *
 * Overview says what the table cannot: the mode with its holds, when it runs, what it works on and what it changed — not
 * the Effect again (its own tab says it, C-UI 5), and no "Changed" block that would only show dashes (C-UI 6).
 */
import { forwardRef, useEffect, useMemo, useState, type ComponentProps } from 'react'
import { Activity, Brain, CircleCheck, Inbox, RotateCw, Undo2 } from 'lucide-react'
import { Button, InfoTip, SegmentedControl, Skeleton, Tag, ToolbarButton, Tooltip } from '@/design-system/primitives'
import {
  Banner, Disclosure, EntityLinks, KeyValue, Listbox, type EntityLinkComponent, type ListboxPanelOption, type TabLinkComponent,
} from '@/design-system/components'
import { DetailModal, type DetailNav } from '@/design-system/patterns'
import { ChangeValue } from '@/design-system/grid'
import { currencyOf, dayWords, money, periodWord, relWords, whenWords } from '../_shared/format'
import { changeStateView, undoView } from '../_shared/delivery'
import {
  BRAIN_LOCK, BRAIN_STEP_MEANS, LAST_WEEK, brainStepOf, MODES, MODE_MEANS, MODE_WORD, REF_HEADER, autoLockOf, changeFromTo, fieldWord,
  heldStep, holdReason, holdsOf, isBrain, last7Parts, marketMoney, nextRunView, noEffectWords, plural, previewParts, readError,
  sampleFromTo, sampleHold, whoWord, worksOn,
  type BidMode, type BidRuleRow, type BrainPick, type BrainStep, type Effect, type PreviewResult, type PreviewSample, type RefKind, type RuleChange, type RuleHistory,
} from './bidRulesModel'
import { fetchBrainDiff, fetchHistory, fetchPreview, fetchRuns, fetchStoredRule, type BrainDiffDay } from './ruleApi'
import { runRollbackable, runSummary, runWord, settingGroups, type RunRow, type SettingGroup } from './ruleSettings'
import { RefLinks, type PanelTab } from './RulesTable'
import { WaitingTab } from './WaitingTab'
import { PanelGrid, type PanelColumn } from '../_shared/PanelGrid'
import { ChangeHistory, KeywordCell, type HistoryRow } from '../_shared/ChangeHistory'
import { TabEmpty } from '../_shared/TabEmpty'
import type { WaitingAsk } from './waitingModel'
import Link from '@/lib/workspaces/Link'
import styles from '../bid.module.css'

const WorkspaceLink = Link as unknown as EntityLinkComponent
const KINDS: readonly RefKind[] = ['portfolios', 'campaigns', 'adGroups']

/** The detail's tabs are links that REPLACE the address and keep the scroll: a tab is a view of the same detail. */
const TabLinkImpl = forwardRef<HTMLAnchorElement, ComponentProps<typeof Link>>(function TabLink(props, ref) {
  return <Link {...props} ref={ref} replace scroll={false} />
})
const TabLink = TabLinkImpl as unknown as TabLinkComponent

export type BrainTab = 'overview' | 'campaigns' | 'clashes' | 'history' | 'effect'
export type AnyTab = PanelTab | 'clashes' | 'campaigns'

export interface RulePanelProps {
  row: BidRuleRow
  tab: AnyTab
  /** Change the tab in place (a chip that opens a tab). */
  onTab(tab: AnyTab): void
  /** The address of a tab of this rule (the link tabs). */
  tabHref(tab: AnyTab): string
  /** Prev / Next over the table's rows as shown now. */
  nav: DetailNav
  /** Where the focus goes when the detail closes: the rule's cell in the table. */
  returnFocusTo: () => HTMLElement | null
  market: string
  /** A phone: the panel tables keep three columns. */
  phone: boolean
  /** The mode the page's draft holds for this rule, if any. */
  drafted: BidMode | null
  canMode: boolean
  modeHeld: string | null
  archiveHeld: string | null
  /** Why "Edit all" cannot open the builder here (a market Nexus only reads), or null. */
  editHeld: string | null
  undoHeld: string | null
  /** Bumped after a saved change, so the open tab reads again. */
  reloadKey: number
  onClose(): void
  onMode(next: BidMode): void
  onArchive(): void
  onRestore(): void
  onUndo(change: RuleChange): void
  onRollback(run: RunRow): void
  onEditAll(): void
  /** Why this person may not approve or reject asks (permission), or null. */
  decideHeld: string | null
  onDecide(kind: 'approve' | 'reject', asks: WaitingAsk[]): void
  /** The brain: why its campaigns' steps cannot be changed at all (permission), or null. */
  brainHeld: string | null
  /** The brain: why Auto cannot be picked for a campaign (the server switch, the approver's permission), or null. */
  brainAutoHeld: string | null
  onBrainPick(pick: BrainPick): void
}

/** The rule's tabs; Waiting while the rule has asks waiting (its count on the tab), or while it is open. */
const ruleTabs = (waiting: number, open: boolean): Array<{ id: PanelTab; label: string; count?: number }> => [
  { id: 'overview', label: 'Overview' },
  ...(waiting > 0 || open ? [{ id: 'waiting' as const, label: 'Waiting', count: waiting }] : []),
  { id: 'preview', label: 'Preview' }, { id: 'history', label: 'History' },
  { id: 'effect', label: 'Effect' }, { id: 'settings', label: 'Settings' },
]
const BRAIN_TABS: ReadonlyArray<{ id: BrainTab; label: string }> = [
  { id: 'overview', label: 'Overview' }, { id: 'campaigns', label: 'Campaigns' }, { id: 'clashes', label: 'Clashes' },
  { id: 'history', label: 'History' }, { id: 'effect', label: 'Effect' },
]

/** The market a rule's money is in: its own, else the page's (one market), else euros. */
const marketOf = (row: BidRuleRow, market: string): string | null => row.market ?? (market !== 'all' ? market : null)

export function RulePanel(p: RulePanelProps) {
  const brain = isBrain(p.row)
  const tabs: ReadonlyArray<{ id: AnyTab; label: string; count?: number }> = brain ? BRAIN_TABS : ruleTabs(p.row.waiting, p.tab === 'waiting')
  const tab = tabs.some((t) => t.id === p.tab) ? p.tab : 'overview'
  const footer = brain ? null : (
    <>
      <span data-return="archive">
        {p.row.archived
          ? <Button size="sm" variant="secondary" heldReason={p.archiveHeld} onClick={p.onRestore}>Restore…</Button>
          : <Button size="sm" variant="danger-outline" heldReason={p.archiveHeld} onClick={p.onArchive}>Archive…</Button>}
      </span>
      <span className="grow" />
      <span data-return="editall"><Button size="sm" variant="secondary" heldReason={p.editHeld} onClick={p.onEditAll}>Edit all</Button></span>
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
      subtitle={p.row.sentence}
      meta={meta}
      tabs={tabs.map((t) => ({ id: t.id, label: t.label, href: p.tabHref(t.id), ...(t.count !== undefined ? { count: t.count } : {}) }))}
      activeTab={tab}
      linkAs={TabLink}
      tabsLabel={`${p.row.name}: sections`}
      nav={p.nav}
      footer={footer}
      returnFocusTo={p.returnFocusTo}
    >
      <div className={styles.panelBody}>
        {tab === 'overview' && <Overview {...p} />}
        {tab === 'waiting' && !brain && <WaitingTab row={p.row} market={p.market} phone={p.phone} reloadKey={p.reloadKey} decideHeld={p.decideHeld} onDecide={p.onDecide} />}
        {tab === 'preview' && !brain && <Preview row={p.row} market={p.market} reloadKey={p.reloadKey} />}
        {tab === 'history' && <History {...p} />}
        {tab === 'effect' && <EffectTab row={p.row} market={p.market} />}
        {tab === 'settings' && !brain && <Settings row={p.row} market={p.market} reloadKey={p.reloadKey} />}
        {tab === 'clashes' && brain && <Clashes market={p.market} />}
        {tab === 'campaigns' && brain && <BrainCampaigns row={p.row} market={p.market} reloadKey={p.reloadKey} held={p.brainHeld} autoHeld={p.brainAutoHeld} onPick={p.onBrainPick} />}
      </div>
    </DetailModal>
  )
}

/**
 * The detail before its rule is known: opened from an address while the list is read ("Reading…"), or for a rule the
 * list does not hold (not in this market, or gone) — said, with Try again.
 */
export function RuleDetailPending({ loading, error, onRetry, onClose, returnFocusTo }: {
  loading: boolean
  error: string | null
  onRetry(): void
  onClose(): void
  returnFocusTo: () => HTMLElement | null
}) {
  return (
    <DetailModal open onClose={onClose} title="Rule" loading={loading} error={error ?? undefined} onRetry={onRetry} returnFocusTo={returnFocusTo} />
  )
}

/** A chip whose meaning is on hover and focus (a hold: its label, and its reason). */
function HintTag({ label, hint, tone = 'neutral' }: { label: string; hint: string; tone?: 'neutral' | 'warning' | 'info' }) {
  return <Tooltip label={hint} portal><span tabIndex={0} aria-label={`${label}: ${hint}`}><Tag tone={tone}>{label}</Tag></span></Tooltip>
}

function Loading() {
  return <div className={styles.stack} aria-busy="true"><Skeleton height={16} /><Skeleton height={16} /><Skeleton height={16} /></div>
}

/** "X not read" with Try again; the server's own sentence under it when it said one (never a bare HTTP code). */
function NotRead({ what, error, onRetry }: { what: string; error: string; onRetry?: () => void }) {
  const detail = readError(error)
  return (
    <Banner tone="danger" title={`${what} not read`} action={onRetry ? <Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button> : undefined}>
      {detail}
    </Banner>
  )
}

// ── overview ────────────────────────────────────────────────────────────────────────────────────────────────────────

function Refs({ row, set }: { row: BidRuleRow; set: 'scope' | 'changed' }) {
  return (
    <KeyValue
      labelCase="sentence"
      dense
      columns={3}
      items={KINDS.map((k) => ({
        label: REF_HEADER[k],
        value: <RefLinks row={row} kind={k} set={set} listLabel={`${REF_HEADER[k]} it ${set === 'scope' ? 'works on' : `changed · ${LAST_WEEK.toLowerCase()}`}`} />,
      }))}
    />
  )
}

function ModePicker(p: RulePanelProps) {
  const r = p.row
  const value = p.drafted ?? r.mode.set
  const options = useMemo<ListboxPanelOption[]>(() => MODES
    // From Off, Auto is not a step to take at once (§2: hide Auto while Off).
    .filter((m) => !(m === 'AUTO' && r.mode.set === 'OFF'))
    .map((m) => {
      const held = heldStep(r, m)
      return { value: m, label: MODE_WORD[m], note: held ?? MODE_MEANS[m], ...(held ? { heldReason: held } : {}) }
    }), [r])
  if (isBrain(r)) {
    // The brain is set per campaign (its Campaigns tab), never as one switch.
    return (
      <span className={styles.line}>
        <Tooltip label={MODE_MEANS[r.mode.set]} portal><span className={styles.modeWord} tabIndex={0}>{MODE_WORD[r.mode.set]}</span></Tooltip>
        <Button size="xs" variant="tonal" onClick={() => p.onTab('campaigns')} aria-label={`${BRAIN_LOCK}: open its campaigns`}>Per campaign</Button>
      </span>
    )
  }
  if (r.archived || !p.canMode) {
    const why = r.archived ? 'Archived: restore it first' : p.modeHeld
    return <Tooltip label={why ?? MODE_MEANS[r.mode.set]} portal><span className={styles.modeWord} tabIndex={0} aria-description={why ?? undefined}>{MODE_WORD[r.mode.set]}</span></Tooltip>
  }
  return (
    <span className={styles.line}>
      <Listbox size="sm" width={140} ariaLabel={`Mode of ${r.name}`} options={options} value={value} onChange={(v) => { if ((MODES as readonly string[]).includes(v)) p.onMode(v as BidMode) }} />
      {p.drafted && <Tag tone="info">Not saved</Tag>}
    </span>
  )
}

function Overview(p: RulePanelProps) {
  const r = p.row
  const holds = holdsOf(r.mode)
  const auto = autoLockOf(r)
  const acts = r.mode.acts !== r.mode.set
  const parts = last7Parts(r)
  const next = nextRunView(r)
  const changedAny = r.changed7d.bids > 0 || KINDS.some((k) => r.changed7d[k].length > 0)
  return (
    <div className={styles.stack}>
      <KeyValue
        labelCase="sentence"
        columns={3}
        items={[
          { label: 'Mode', value: <span data-return="mode"><ModePicker {...p} /></span>, hint: acts ? `Acts as ${MODE_WORD[r.mode.acts]}` : undefined },
          { label: 'Next run', value: next.value, hint: next.hint ?? undefined },
          { label: 'Last run', value: relWords(r.lastRunAt), hint: r.lastRunAt ? whenWords(r.lastRunAt) : undefined },
        ]}
      />
      {(holds.length > 0 || auto) && (
        <div className={styles.chips} aria-label="What holds it">
          {holds.map((h, i) => <HintTag key={`${h.kind}-${i}`} label={h.label} hint={holdReason(h)} tone={i === 0 && acts ? 'warning' : 'neutral'} />)}
          {auto && <HintTag label={auto.label} hint={holdReason({ ...auto, label: auto.label })} />}
        </div>
      )}
      <section className={styles.section} aria-label={LAST_WEEK}>
        <h3 className={styles.h}>{LAST_WEEK}</h3>
        <div className={styles.chips}>
          {parts.map((x) => (x.tab
            ? <Button key={x.key} size="xs" variant="tonal" onClick={() => p.onTab(x.tab!)} aria-label={`${x.text}: open ${x.tab === 'waiting' ? 'the asks' : 'History'}`}>{x.text}</Button>
            : <Tag key={x.key} tone={x.tone ?? 'neutral'}>{x.text}</Tag>))}
          {r.waiting > 0 && <Button size="xs" variant="warning" onClick={() => p.onTab('waiting')} aria-label={`${r.waiting} waiting: open them`}>{r.waiting} waiting</Button>}
          {!parts.length && !r.waiting && <span className={styles.muted}>{r.last7d.runs ? `${plural(r.last7d.runs, 'run')}, nothing changed` : 'No runs'}</span>}
        </div>
      </section>
      <section className={styles.section} aria-label="Works on">
        <h3 className={styles.h}>Works on{r.scope.all && !isBrain(r) ? <Tag>Whole market</Tag> : null}{r.scope.product ? <Tag>{r.scope.product.name}</Tag> : null}</h3>
        <Refs row={r} set="scope" />
      </section>
      {changedAny && (
        <section className={styles.section} aria-label={`Changed · ${LAST_WEEK.toLowerCase()}`}>
          <h3 className={styles.h}>Changed · {LAST_WEEK.toLowerCase()} {r.changed7d.bids > 0 && <Tag>{plural(r.changed7d.bids, 'bid')} · {plural(r.changed7d.keywords, 'keyword')}</Tag>}</h3>
          <Refs row={r} set="changed" />
        </section>
      )}
    </div>
  )
}

// ── preview ─────────────────────────────────────────────────────────────────────────────────────────────────────────

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

const ONE = { one: 'item', many: 'items' }
/** Row ids for the detail's tables. */
const idOf = (x: { id: string }) => x.id
const dayOf = (d: { day: string }) => d.day
const sampleId = (s: PreviewSample) => `${s.target?.id ?? ''}-${s.adGroup?.id ?? ''}`
function SampleTable({ rows, market }: { rows: PreviewSample[]; market: string | null }) {
  const columns: Array<PanelColumn<PreviewSample>> = [
    { key: 'kw', label: 'Keyword', render: (s) => <KeywordCell target={s.target} campaign={s.campaign} adGroup={s.adGroup} /> },
    {
      key: 'change', label: 'Change', numeric: true, render: (s) => {
        const hold = sampleHold(s)
        return (
          <span className={styles.chips}>
            {s.field !== 'state' && s.fromCents === undefined ? <span className={styles.muted} title="Needs the ad spend permission">—</span> : <ChangeValue changes={[sampleFromTo(s, market)]} hideLabels />}
            {hold && <HintTag label={hold.label} hint={hold.reason} tone={hold.tone} />}
          </span>
        )
      },
    },
  ]
  return <PanelGrid ariaLabel="What it would change" columns={columns} rows={rows} rowId={sampleId} />
}

function Preview({ row, market, reloadKey }: { row: BidRuleRow; market: string; reloadKey: number }) {
  const { data, error, reload } = useLoad<PreviewResult>(() => fetchPreview({ ruleId: row.id, limit: 50 }), [row.id, reloadKey])
  return (
    <div className={styles.stack}>
      <div className={styles.lineBetween}>
        <span className={styles.chips}>
          {data ? previewParts(data).map((x) => <Tag key={x.key} tone={x.tone ?? 'neutral'}>{x.text}</Tag>) : null}
          {data?.windowDays ? <Tag>{periodWord(data.windowDays)}</Tag> : null}
          {row.scope.all && <Tag>Whole market</Tag>}
        </span>
        <ToolbarButton icon={<RotateCw size={14} aria-hidden />} label="Run the preview again (nothing is written)" onClick={reload} />
      </div>
      {error && <NotRead what="Preview" error={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && data.note && <Banner tone="info" title={data.note} />}
      {data && data.sample.length > 0 && <SampleTable rows={data.sample} market={marketOf(row, market)} />}
      {data && !data.sample.length && !data.note && <TabEmpty icon={<CircleCheck size={20} aria-hidden />} title="Nothing would change now" />}
    </div>
  )
}

// ── history ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const DAYS = [7, 30, 90].map((d) => ({ value: String(d), label: periodWord(d) }))

/** A rule's History rows, for the one History table (`_shared/ChangeHistory.tsx`, the keyword detail draws the same). */
function historyRows(changes: readonly RuleChange[], ownerId: string, market: string | null, brain: boolean): HistoryRow[] {
  return changes.map((c) => {
    const ft = changeFromTo(c, market)
    const who = whoWord(c, ownerId)
    return {
      id: c.id, at: c.at, target: c.target, campaign: c.campaign, adGroup: c.adGroup,
      change: { label: fieldWord(c.field), from: ft.from, to: ft.to },
      who: who ? { word: who, tone: c.who.kind === 'person' ? 'info' : 'neutral' } : null,
      state: changeStateView({ delivery: c.delivery, undoBlocked: c.undoBlocked }).state,
      undo: brain ? null : undoView({ changeId: c.changeId, undoBlocked: c.undoBlocked, at: c.at }),
      undoLabel: `Undo ${fieldWord(c.field)} on ${c.target?.name ?? 'this keyword'}`,
    }
  })
}

function History(p: RulePanelProps) {
  const r = p.row
  const brain = isBrain(r)
  const [days, setDays] = useState(7)
  const market = marketOf(r, p.market)
  const { data, error, reload } = useLoad<RuleHistory>(() => fetchHistory(r.id, days, p.market), [r.id, days, p.reloadKey, p.market])
  const rows = useMemo(() => (data ? historyRows(data.changes, r.id, market, brain) : []), [data, r.id, market, brain])
  const byId = useMemo(() => new Map((data?.changes ?? []).map((c) => [c.id, c])), [data])
  return (
    <div className={styles.stack}>
      <div className={styles.lineBetween}>
        <SegmentedControl size="sm" ariaLabel="Days" options={DAYS} value={String(days)} onChange={(v) => setDays(Number(v))} />
        {data && <Tag>{plural(data.changes.length, 'change')}</Tag>}
      </div>
      {error && <NotRead what="History" error={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && rows.length > 0 && (
        <ChangeHistory
          label="Changes" rows={rows} keywords phone={p.phone} undoHeld={p.undoHeld} statusLabel={brain ? 'Status' : 'Status · Undo'}
          onUndo={(row) => { const c = byId.get(row.id); if (c) p.onUndo(c) }}
        />
      )}
      {data && !data.changes.length && <p className={styles.muted}>No changes in {periodWord(days)}.</p>}
      {!brain && <Runs row={r} reloadKey={p.reloadKey} onRollback={p.onRollback} undoHeld={p.undoHeld} />}
    </div>
  )
}

/** The rule's runs with their roll back — open from the start when it has run (use audit B6: Roll back sat folded away). */
function Runs({ row, reloadKey, onRollback, undoHeld }: { row: BidRuleRow; reloadKey: number; onRollback(run: RunRow): void; undoHeld: string | null }) {
  const [open, setOpen] = useState(() => !!row.lastRunAt || row.last7d.runs > 0)
  return (
    <span data-return="runs" className={styles.stack}>
      <Disclosure summary="Runs" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        {open && <RunList row={row} reloadKey={reloadKey} onRollback={onRollback} undoHeld={undoHeld} />}
      </Disclosure>
    </span>
  )
}

function RunList({ row, reloadKey, onRollback, undoHeld }: { row: BidRuleRow; reloadKey: number; onRollback(run: RunRow): void; undoHeld: string | null }) {
  const { data, error, reload } = useLoad<RunRow[]>(() => fetchRuns(row.id), [row.id, reloadKey])
  if (error) return <NotRead what="Runs" error={error} onRetry={reload} />
  if (!data) return <Loading />
  if (!data.length) return <p className={styles.muted}>No runs yet.</p>
  const columns: Array<PanelColumn<RunRow>> = [
    { key: 'when', label: 'When', width: 110, render: (x) => <span title={whenWords(x.startedAt)}>{relWords(x.startedAt)}</span> },
    { key: 'what', label: 'Result', render: (x) => { const w = runWord(x); return <Tag tone={w.tone}>{w.text}</Tag> } },
    {
      key: 'sum', label: 'Changed', render: (x) => (
        <span className={styles.chips}>
          <span className={styles.wrap}>{runSummary(x)}</span>
          {runRollbackable(x) && <Button size="sm" variant="secondary" heldReason={undoHeld} onClick={() => onRollback(x)}><Undo2 size={13} aria-hidden /> Roll back…</Button>}
        </span>
      ),
    },
  ]
  return <PanelGrid ariaLabel="Runs" columns={columns} rows={data} rowId={idOf} />
}

// ── effect ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function EffectTab({ row, market }: { row: BidRuleRow; market: string }) {
  const e: Effect | null = row.effect
  if (!e || e.keywords <= 0) return <TabEmpty icon={<Activity size={20} aria-hidden />} title="No effect yet" description={noEffectWords(row)} />
  const m = marketOf(row, market)
  const cash = (cents: number | undefined) => (cents == null ? '—' : e.currency ? money(cents, e.currency) : marketMoney(cents, m))
  const line = (label: string, a: string, b: string) => ({ label, value: <ChangeValue changes={[{ label, from: a, to: b }]} hideLabels /> })
  const acos = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 10) / 10} %`)
  const perSide = Math.round(e.days / Math.max(1, e.keywords))
  return (
    <div className={styles.stack}>
      <div className={styles.chips}>
        <Tag>{plural(e.keywords, 'keyword')}</Tag>
        <Tag>{periodWord(perSide)} before/after</Tag>
        {e.tooEarly > 0 && <HintTag label={`${e.tooEarly} too early`} hint="Fewer than 3 settled days after the change: not counted yet" tone="warning" />}
        <HintTag label={`ends ${dayWords(e.window.settledThrough)}`} hint={`Amazon still adds sales to the last ${periodWord(7)}, so the window ends here`} />
      </div>
      <KeyValue
        labelCase="sentence"
        columns={2}
        items={[
          line('ACoS', acos(e.before.acosPct), acos(e.after.acosPct)),
          line('Orders', String(e.before.orders), String(e.after.orders)),
          line('Spend', cash(e.before.spendCents), cash(e.after.spendCents)),
          line('Sales', cash(e.before.salesCents), cash(e.after.salesCents)),
          line('Clicks', String(e.before.clicks), String(e.after.clicks)),
        ]}
      />
    </div>
  )
}

// ── settings ────────────────────────────────────────────────────────────────────────────────────────────────────────

function Settings({ row, market, reloadKey }: { row: BidRuleRow; market: string; reloadKey: number }) {
  const ctx = { sentence: row.sentence, currency: currencyOf(marketOf(row, market)), schedule: row.schedule ?? null }
  const { data, error, reload } = useLoad<SettingGroup[]>(async () => settingGroups(await fetchStoredRule(row.id), ctx), [row.id, reloadKey, row.sentence, row.schedule, ctx.currency])
  return (
    <div className={styles.stack}>
      {error && <NotRead what="Settings" error={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && data.map((g) => (
        <section key={g.id} className={styles.section} aria-label={g.title}>
          <h3 className={styles.h}>{g.title}</h3>
          {/* One column count in every section, so the second item of each sits at the same place (audit R16). */}
          <KeyValue
            labelCase="sentence"
            dense
            columns={3}
            items={g.items.map((i) => ({ label: i.label, value: i.note ? <span className={styles.line}>{i.value}<InfoTip tip={i.note} /></span> : i.value }))}
          />
        </section>
      ))}
    </div>
  )
}

// ── the brain's campaigns ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The brain, per campaign (the Owner: the Bid page does this itself). Each campaign it works on reads Watch (it decides
 * and records) or Auto (it owns the campaign: its one bid writer); a pick asks for the change, reviewed by the page —
 * Auto with the approver's authenticator code (the API's rule: a new bid writer is a big door).
 */
function BrainCampaigns({ row, market, reloadKey, held, autoHeld, onPick }: {
  row: BidRuleRow
  market: string
  reloadKey: number
  held: string | null
  autoHeld: string | null
  onPick(pick: BrainPick): void
}) {
  const { data, error, reload } = useLoad(() => fetchBrainDiff(market), [market, reloadKey])
  const owned = useMemo(() => new Set(data?.owned ?? []), [data])
  const options = (step: BrainStep): ListboxPanelOption[] => (['WATCH', 'AUTO'] as const).map((m) => {
    const why = m === 'AUTO' && step !== 'AUTO' ? autoHeld : null
    return { value: m, label: MODE_WORD[m], note: why ?? BRAIN_STEP_MEANS[m], ...(why ? { heldReason: why } : {}) }
  })
  const columns: Array<PanelColumn<BidRuleRow['scope']['campaigns'][number]>> = [
    { key: 'campaign', label: 'Campaign', render: (c) => <EntityLinks items={[c]} noun={ONE} linkAs={WorkspaceLink} /> },
    {
      key: 'brain', label: 'Brain', render: (c) => {
        const step = brainStepOf(c.id, owned)
        if (held) return <Tooltip label={held} portal><span className={styles.modeWord} tabIndex={0} aria-description={held}>{MODE_WORD[step]}</span></Tooltip>
        return (
          <span data-return={`brain:${c.id}`}>
            <Listbox size="sm" width={130} ariaLabel={`Brain on ${c.name}`} options={options(step)} value={step} onChange={(v) => { if ((v === 'WATCH' || v === 'AUTO') && v !== step) onPick({ id: c.id, name: c.name, from: step, to: v }) }} />
          </span>
        )
      },
    },
  ]
  const { more, total } = worksOn(row, 'campaigns')
  return (
    <div className={styles.stack}>
      <div className={styles.chips}>
        {data && <Tag>{plural(owned.size, 'campaign')} on Auto</Tag>}
        {more > 0 && <Tag>first {row.scope.campaigns.length} of {total}</Tag>}
      </div>
      {error && <NotRead what="Campaigns" error={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && row.scope.campaigns.length > 0 && <PanelGrid ariaLabel="The Brain's campaigns" columns={columns} rows={row.scope.campaigns} rowId={idOf} />}
      {data && !row.scope.campaigns.length && <TabEmpty icon={<Inbox size={20} aria-hidden />} title={`No campaigns in ${LAST_WEEK.toLowerCase()}`} />}
    </div>
  )
}

// ── the brain's clashes ─────────────────────────────────────────────────────────────────────────────────────────────

function Clashes({ market }: { market: string }) {
  const { data, error, reload } = useLoad(() => fetchBrainDiff(market), [market])
  const days = useMemo(() => (data ? [...data.days].reverse() : []), [data])
  const columns: Array<PanelColumn<BrainDiffDay>> = [
    { key: 'day', label: 'Day', render: (d) => dayWords(d.day) },
    { key: 'decided', label: 'Decided', numeric: true, render: (d) => d.decided },
    { key: 'higher', label: 'Up', numeric: true, render: (d) => d.higher },
    { key: 'lower', label: 'Down', numeric: true, render: (d) => d.lower },
    { key: 'conflicts', label: 'Clashes', numeric: true, render: (d) => (d.conflicts ? <Tag tone="warning">{d.conflicts}</Tag> : 0) },
    { key: 'writes', label: 'Changes', numeric: true, render: (d) => d.writes },
  ]
  return (
    <div className={styles.stack}>
      <div className={styles.chips}>
        <HintTag label="Clashes (24 h)" hint="Two automatic writers changed one keyword within 24 hours" />
      </div>
      {error && <NotRead what="Clashes" error={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && data.days.length > 0 && <PanelGrid ariaLabel="Clashes by day" columns={columns} rows={days} rowId={dayOf} />}
      {data && !data.days.length && <TabEmpty icon={<Inbox size={20} aria-hidden />} title={`No days in ${LAST_WEEK.toLowerCase()}`} />}
    </div>
  )
}
