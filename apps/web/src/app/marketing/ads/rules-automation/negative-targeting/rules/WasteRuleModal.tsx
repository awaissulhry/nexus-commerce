'use client'

/**
 * Negative Targeting page, Rules view — the detail of one rule (2026-10-11): the DS `DetailModal` (centered; a full-screen
 * sheet on a phone), like the Bid page's rule detail. Overview · Preview · History · Waiting · Settings; the Brain and
 * Harvest rows are read only here (Overview · History · Waiting) and say who owns them, with a link to their page.
 *
 * Address: `?rule=<id>&tab=<tab>` — the tabs are links that replace the address (Back closes the detail); ▲ / ▼ and
 * K / J walk the table's rows as shown. Esc closes it and the focus goes back to the rule's cell.
 *
 * The detail never writes. A mode pick, an archive, an unarchive, an Undo, a decision on waiting asks, an edit of its
 * fields asks the VIEW, which reviews it in the DS `ReviewChangesModal` stacked ON TOP of this detail; when the review
 * closes the focus goes back to the control that opened it (`data-return`). "Edit all": a stop-waste rule's fields are
 * its Settings tab (the builder cannot carry its test); a rule made in a builder opens that builder.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { RotateCw, Undo2 } from 'lucide-react'
import { Button, SegmentedControl, Tag, ToolbarButton, Tooltip } from '@/design-system/primitives'
import {
  Banner, Disclosure, EntityLinks, EntityPath, KeyValue, Listbox, type EntityLinkComponent, type ListboxPanelOption,
} from '@/design-system/components'
import { DetailModal, type DetailNav } from '@/design-system/patterns'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { ChangeValue } from '@/design-system/grid'
import Link from '@/lib/workspaces/Link'
import { currencyOf, money, periodWord, relWords, whenWords } from '../../bid/_shared/format'
import { changeStateView, undoView } from '../../bid/_shared/delivery'
import { MODES, MODE_WORD, holdReason, holdsOf, nextRunView, type BidMode } from '../../bid/rules/bidRulesModel'
import { fetchStoredRule } from '../../bid/rules/ruleApi'
import { settingGroups, type SettingGroup, type StoredRule } from '../../bid/rules/ruleSettings'
import { fetchWasteHistory, fetchWastePreview } from './wasteRulesApi'
import {
  KIND_WORD, LAST_WEEK, WASTE_MODE_MEANS, actionWord, autoLockOf, changeFromTo, heldStep, isPseudo, isStopWaste, last7Parts, ownerOf, plural,
  previewParts, refusalWhy, sharedWhy, scopeCount, scopePath, whoWord,
  type PreviewItem, type WaitingAsk, type WasteHistory, type WastePreview, type WasteRuleChange, type WasteRuleRow,
} from './wasteRulesModel'
import { fieldProblems, fieldsOfSaved, fieldsPatch, testWords, verbWords, type RuleFields } from './newRuleModel'
import { RuleFieldsForm } from './RuleFieldsForm'
import { RuleMark, type PanelTab } from './WasteRulesTable'
import { WasteWaitingTab } from './WasteWaitingTab'
import { HintTag, Loading, NotRead } from './parts'
import styles from './rules.module.css'

const WorkspaceLink = Link as unknown as EntityLinkComponent
const ONE = { one: 'item', many: 'items' }
const NOUN = {
  portfolios: { one: 'portfolio', many: 'portfolios' },
  campaigns: { one: 'campaign', many: 'campaigns' },
  adGroups: { one: 'ad group', many: 'ad groups' },
} as const
const REF_HEADER = { portfolios: 'Portfolios', campaigns: 'Campaigns', adGroups: 'Ad groups' } as const
type RefKind = keyof typeof NOUN


/** Which builder made a rule (its first action's type), so "Edit all" opens that one; null: the engine made it. */
export function builderSlugOf(actions: unknown): string | null {
  const a0 = Array.isArray(actions) ? (actions[0] as { type?: unknown } | undefined) : undefined
  const t = typeof a0?.type === 'string' ? a0.type : ''
  return t === 'negative-targeting' || t === 'bid' || t === 'keyword-harvesting' ? t : null
}

export interface WasteRuleModalProps {
  row: WasteRuleRow
  tab: PanelTab
  /** Show another tab (the address is replaced: Back still closes the detail). */
  onTab(tab: PanelTab): void
  nav: DetailNav
  returnFocusTo: () => HTMLElement | null
  market: string
  phone: boolean
  /** The mode the view's draft holds for this rule, if any. */
  drafted: BidMode | null
  /** Why this person may not change the mode / archive / undo / decide (permission), or null. */
  modeHeld: string | null
  archiveHeld: string | null
  undoHeld: string | null
  decideHeld: string | null
  /** Bumped after a saved change, so the open tab reads again. */
  reloadKey: number
  onClose(): void
  onMode(next: BidMode): void
  onArchive(): void
  onUnarchive(): void
  onUndo(change: WasteRuleChange): void
  onDecide(kind: 'approve' | 'reject', asks: WaitingAsk[]): void
  /** A stop-waste rule's fields changed: the view reviews and saves them. */
  onSaveFields(before: RuleFields, after: RuleFields): void
  /** A rule made in a builder: open that builder on it. */
  onEditBuilder(slug: string): void
}

const ruleTabs = (row: WasteRuleRow, open: PanelTab): Array<{ id: PanelTab; label: string; count?: number }> => {
  const waiting = row.waiting > 0 || open === 'waiting' ? [{ id: 'waiting' as const, label: 'Waiting', count: row.waiting }] : []
  if (isPseudo(row)) return [{ id: 'overview', label: 'Overview' }, ...waiting, { id: 'history', label: 'History' }]
  return [{ id: 'overview', label: 'Overview' }, { id: 'preview', label: 'Preview' }, { id: 'history', label: 'History' }, ...waiting, { id: 'settings', label: 'Settings' }]
}

/** The market a rule's money is in: its own, else the view's (one market), else euros. */
const marketOf = (row: WasteRuleRow, market: string): string | null => row.market ?? (market !== 'all' ? market : null)

function useLoad<T>(load: () => Promise<T>, keys: unknown[], enabled = true): { data: T | null; error: string | null; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    setState({ data: null, error: null })
    load().then((data) => { if (alive) setState({ data, error: null }) }, (e: unknown) => { if (alive) setState({ data: null, error: (e as Error).message }) })
    return () => { alive = false }
  }, [...keys, tick, enabled]) // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: () => setTick((t) => t + 1) }
}

export function WasteRuleModal(p: WasteRuleModalProps) {
  const r = p.row
  const pseudo = isPseudo(r)
  const owner = ownerOf(r)
  const tabs = ruleTabs(r, p.tab)
  const tab = tabs.some((t) => t.id === p.tab) ? p.tab : 'overview'
  // The stored rule: a stop-waste rule's verb and run time, a builder rule's own type. Not for the Brain, Harvest or an
  // archived rule (the engine no longer serves it).
  const stored = useLoad<StoredRule>(() => fetchStoredRule(r.id), [r.id, p.reloadKey], !pseudo && !r.archived)
  const slug = stored.data ? builderSlugOf(stored.data.actions) : null
  const editHeld = r.archived ? 'Archived: unarchive it first'
    : p.modeHeld ? p.modeHeld
      : isStopWaste(r) ? null
        : !stored.data ? (stored.error ? 'Its settings were not read' : 'Reading its settings…')
          : slug ? null : 'Made by the rule engine: only its mode changes here'
  const editAll = () => {
    if (isStopWaste(r)) { p.onTab('settings'); requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-fields] input')?.focus()); return }
    if (slug) p.onEditBuilder(slug)
  }

  const footer = owner ? (
    <>
      <span className={styles.footerGrow} />
      <Button size="sm" variant="secondary" asChild><Link href={owner.href}>Open {owner.page}</Link></Button>
    </>
  ) : (
    <>
      <span data-return="archive">
        {r.archived
          ? <Button size="sm" variant="secondary" heldReason={p.archiveHeld} onClick={p.onUnarchive}>Unarchive…</Button>
          : <Button size="sm" variant="danger-outline" heldReason={p.archiveHeld} onClick={p.onArchive}>Archive…</Button>}
      </span>
      <span className={styles.footerGrow} />
      <span data-return="editall"><Button size="sm" variant="secondary" heldReason={editHeld} onClick={editAll}>Edit all</Button></span>
    </>
  )
  const meta = (
    <>
      {owner && <Tooltip label={owner.lock} portal><span tabIndex={0} aria-label={`${owner.word}: ${owner.lock}`}><Tag tone="info">{owner.word}</Tag></span></Tooltip>}
      {!owner && <Tag>{KIND_WORD[r.kind]}</Tag>}
      {r.archived && <Tag>Archived</Tag>}
      <Tag>{r.market ?? 'All markets'}</Tag>
    </>
  )
  return (
    <DetailModal
      open
      onClose={p.onClose}
      title={<span className={styles.panelTitle}><RuleMark row={r} size={16} />{r.name}</span>}
      subtitle={r.sentence}
      meta={meta}
      tabs={tabs.map((t) => ({ id: t.id, label: t.label, ...(t.count !== undefined ? { count: t.count } : {}) }))}
      activeTab={tab}
      onTabChange={(t) => p.onTab(t as PanelTab)}
      tabsLabel={`${r.name}: sections`}
      nav={p.nav}
      footer={footer}
      returnFocusTo={p.returnFocusTo}
    >
      <div className={styles.panelBody}>
        {tab === 'overview' && <Overview {...p} />}
        {tab === 'preview' && !pseudo && <PreviewTab row={r} reloadKey={p.reloadKey} />}
        {tab === 'history' && <HistoryTab {...p} />}
        {tab === 'waiting' && <WasteWaitingTab row={r} market={p.market} phone={p.phone} reloadKey={p.reloadKey} decideHeld={p.decideHeld} onDecide={p.onDecide} />}
        {tab === 'settings' && !pseudo && <SettingsTab {...p} stored={stored.data} storedError={stored.error} onRetry={stored.reload} />}
      </div>
    </DetailModal>
  )
}

/** The detail before its rule is known: read from an address while the list is read, or a rule the list does not hold. */
export function RuleDetailPending({ loading, error, onRetry, onClose, returnFocusTo }: {
  loading: boolean
  error: string | null
  onRetry(): void
  onClose(): void
  returnFocusTo: () => HTMLElement | null
}) {
  return <DetailModal open onClose={onClose} title="Rule" loading={loading} error={error ?? undefined} onRetry={onRetry} returnFocusTo={returnFocusTo} />
}

// ── overview ────────────────────────────────────────────────────────────────────────────────────────────────────────

function ModePicker(p: WasteRuleModalProps) {
  const r = p.row
  const value = p.drafted ?? r.mode.set
  const options = useMemo<ListboxPanelOption[]>(() => MODES
    .filter((m) => !(m === 'AUTO' && r.mode.set === 'OFF'))
    .map((m) => {
      const held = heldStep(r, m)
      return { value: m, label: MODE_WORD[m], note: held ?? WASTE_MODE_MEANS[m], ...(held ? { heldReason: held } : {}) }
    }), [r])
  const owner = ownerOf(r)
  const locked = owner?.lock ?? (r.archived ? 'Archived: unarchive it first' : p.modeHeld)
  if (locked) {
    return <Tooltip label={locked} portal><span className={styles.modeWord} tabIndex={0} aria-description={locked}>{MODE_WORD[r.mode.set]}</span></Tooltip>
  }
  return (
    <span className={styles.line}>
      <Listbox size="sm" width={140} ariaLabel={`Mode of ${r.name}`} options={options} value={value} onChange={(v) => { if ((MODES as readonly string[]).includes(v)) p.onMode(v as BidMode) }} />
      {p.drafted && <Tag tone="info">Not saved</Tag>}
    </span>
  )
}

function Refs({ row, set }: { row: WasteRuleRow; set: 'scope' | 'changed' }) {
  const from = set === 'scope' ? row.scope : row.changed7d
  return (
    <KeyValue
      dense
      columns={3}
      items={(Object.keys(NOUN) as RefKind[]).map((k) => {
        const total = Math.max(from[k].length, from.counts?.[k] ?? 0)
        return {
          label: REF_HEADER[k],
          value: set === 'scope' && k === 'adGroups' && !row.scope.adGroup && !from[k].length
            ? <Tooltip label="Every ad group of its campaigns" portal><span tabIndex={0}><Tag>All</Tag></span></Tooltip>
            : <EntityLinks items={from[k]} total={total} noun={NOUN[k]} linkAs={WorkspaceLink} listLabel={`${REF_HEADER[k]} ${set === 'scope' ? 'it acts on' : `it changed · ${LAST_WEEK.toLowerCase()}`}`} />,
        }
      })}
    />
  )
}

function Overview(p: WasteRuleModalProps) {
  const r = p.row
  const holds = holdsOf(r.mode)
  const auto = autoLockOf(r)
  const acts = r.mode.acts !== r.mode.set
  const parts = last7Parts(r)
  const next = nextRunView({ nextRunAt: r.nextRunAt, firstRunAt: r.firstRunAt ?? null, thenRunAt: r.thenRunAt ?? null, schedule: r.schedule ?? null })
  const currency = currencyOf(marketOf(r, p.market))
  const count = scopeCount(r)
  return (
    <div className={styles.panelBody}>
      <KeyValue
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
          {auto && <HintTag label={auto.label} hint={holdReason(auto)} />}
        </div>
      )}
      <section className={styles.section} aria-label="Scope">
        <h3 className={styles.h}>Scope{r.scope.all && !r.scope.product ? <Tag>Whole market</Tag> : null}{count > 1 ? <Tag>{plural(count, 'campaign')}</Tag> : null}</h3>
        <EntityPath items={scopePath(r)} linkAs={WorkspaceLink} label={`Where ${r.name} acts`} />
        {count > 1 && <Refs row={r} set="scope" />}
      </section>
      {r.test && (
        <section className={styles.section} aria-label="Test">
          <h3 className={styles.h}>Test</h3>
          <div className={styles.chips}>
            {testWords(r.test).map((w) => <Tag key={w}>{w}</Tag>)}
            {typeof r.test.spendFloorCents === 'number' && <HintTag label={`else ≥ ${money(r.test.spendFloorCents, currency)}`} hint="The spend bar for a product with no target cost per order" />}
            <Tag tone="info">{r.kind === 'PAUSE_KEYWORD' ? verbWords(r.kind, { match: 'EXACT', level: 'AD_GROUP' }) : r.sentence.split('→').pop()?.trim() || 'Negative'}</Tag>
          </div>
        </section>
      )}
      <section className={styles.section} aria-label={LAST_WEEK}>
        <h3 className={styles.h}>{LAST_WEEK}</h3>
        <div className={styles.chips}>
          {parts.map((x) => (x.tab
            ? <Button key={x.key} size="xs" variant="tonal" onClick={() => p.onTab(x.tab!)} aria-label={`${x.text}: open ${x.tab === 'waiting' ? 'Waiting' : 'History'}`}>{x.text}</Button>
            : x.hint ? <HintTag key={x.key} label={x.text} hint={x.hint} tone={x.tone ?? 'neutral'} /> : <Tag key={x.key} tone={x.tone ?? 'neutral'}>{x.text}</Tag>))}
          {r.waiting > 0 && <Button size="xs" variant="warning" onClick={() => p.onTab('waiting')} aria-label={`${r.waiting} waiting: open them`}>{r.waiting} waiting</Button>}
          {!parts.length && !r.waiting && <span className={styles.muted}>{r.last7d.runs ? `${plural(r.last7d.runs, 'run')}, nothing stopped` : 'No runs'}</span>}
        </div>
      </section>
      {(r.changed7d.campaigns.length > 0 || r.changed7d.adGroups.length > 0) && (
        <section className={styles.section} aria-label={`Changed · ${LAST_WEEK.toLowerCase()}`}>
          <h3 className={styles.h}>Changed · {LAST_WEEK.toLowerCase()}</h3>
          <Refs row={r} set="changed" />
        </section>
      )}
    </div>
  )
}

// ── preview ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A term or keyword, and under it where it is: each a link (the ad group page opens on it). */
function TermCell({ row, campaign, adGroup, when }: { row: { id: string; name: string; href?: string | null } | null; campaign: PreviewItem['campaign']; adGroup: PreviewItem['adGroup']; when?: string }) {
  return (
    <span className={styles.two}>
      <span className={styles.line}>{row ? <EntityLinks items={[row]} noun={ONE} linkAs={WorkspaceLink} /> : '—'}</span>
      {(campaign || adGroup || when) && (
        <span className={styles.line}>
          {when && <span className={styles.muted}>{when}</span>}
          {(campaign || adGroup) && <EntityPath items={[campaign, adGroup]} linkAs={WorkspaceLink} label="Where" />}
        </span>
      )}
    </span>
  )
}

/** A key per line: a term can come back once per place, and an engine rule's sample has no place at all. */
const keyed = (sample: readonly PreviewItem[]): Array<PreviewItem & { key: string }> => sample.map((s, i) => ({ ...s, key: `${i}|${s.row.id}|${s.adGroup?.id ?? s.campaign?.id ?? ''}` }))

function PreviewTab({ row, reloadKey }: { row: WasteRuleRow; reloadKey: number }) {
  const { data, error, reload } = useLoad<WastePreview>(() => fetchWastePreview({ ruleId: row.id }, 50), [row.id, reloadKey])
  const columns: Array<Column<PreviewItem & { key: string }>> = [
    { key: 'term', label: row.kind === 'PAUSE_KEYWORD' ? 'Keyword' : 'Search term', render: (s) => <TermCell row={s.row} campaign={s.campaign} adGroup={s.adGroup} /> },
    {
      key: 'does', label: 'Does', render: (s) => (
        <span className={styles.chips}>
          <Tag>{actionWord(s.action)}</Tag>
          {s.alone ? <HintTag label="Alone" hint="Inside its caps: it would act without asking" tone="info" /> : s.asks ? <HintTag label="Asks" hint={s.asks} /> : null}
        </span>
      ),
    },
    { key: 'why', label: 'Why', render: (s) => <span className={`${styles.muted} ${styles.wrap}`}>{s.why}</span> },
  ]
  // One "why" shared by every line is said once, above the list (audit words: never the same line on every row).
  const shared = data ? sharedWhy(data.sample) : null
  const shown = shared ? columns.filter((c) => c.key !== 'why') : columns
  return (
    <div className={styles.stack}>
      <div className={styles.lineBetween}>
        <span className={styles.chips}>
          {data ? previewParts(data).map((x) => <Tag key={x.key} tone={x.tone ?? 'neutral'}>{x.text}</Tag>) : null}
          {data?.windowDays ? <Tag>{periodWord(data.windowDays)}</Tag> : null}
          {shared && <span className={styles.muted}>{shared}</span>}
        </span>
        <ToolbarButton icon={<RotateCw size={14} aria-hidden />} label="Run the preview again (nothing is written)" onClick={reload} />
      </div>
      {error && <NotRead what="Preview" error={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data?.note && <Banner tone="info" title={data.note} />}
      {data && data.sample.length > 0 && <DataGrid ariaLabel="What it would stop now" columns={shown} rows={keyed(data.sample)} rowKey={(s) => s.key} headerMenus={false} />}
      {data && !data.sample.length && !data.note && <p className={styles.muted}>Nothing would change now.</p>}
      {data && data.refused.length > 0 && (
        <Disclosure summary={`${plural(data.refused.length, 'refused')}`}>
          <DataGrid
            ariaLabel="Refused"
            columns={[
              { key: 'term', label: 'Term', render: (x: WastePreview['refused'][number] & { key: string }) => <span className={styles.ellipsis} title={x.row.name}>{x.row.name}</span> },
              { key: 'why', label: 'Why', render: (x: WastePreview['refused'][number] & { key: string }) => <span className={`${styles.muted} ${styles.wrap}`}>{refusalWhy(x.why)}</span> },
            ]}
            rows={data.refused.map((x, i) => ({ ...x, key: `${i}|${x.row.id}` }))}
            rowKey={(x) => x.key}
            headerMenus={false}
          />
        </Disclosure>
      )}
    </div>
  )
}

// ── history ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const DAYS = [7, 30, 90].map((d) => ({ value: String(d), label: periodWord(d) }))

function StatusCell({ c, ownerId, undoHeld, onUndo, readOnly }: { c: WasteRuleChange; ownerId: string; undoHeld: string | null; onUndo(c: WasteRuleChange): void; readOnly: boolean }) {
  const state = changeStateView({ delivery: c.delivery, undoBlocked: c.undoBlocked })
  const who = whoWord(c, ownerId)
  const undo = readOnly ? null : undoView({ changeId: c.changeId, undoBlocked: c.undoBlocked, at: c.at })
  return (
    <span className={styles.chips} data-return={`undo:${c.id}`}>
      {who && <Tag tone={c.who.kind === 'person' ? 'info' : 'neutral'}>{who}</Tag>}
      {state.state && <Tag tone={state.tone}>{state.word}</Tag>}
      {undo?.kind === 'undo' && (
        <Button size="sm" variant="secondary" heldReason={undoHeld} onClick={() => onUndo(c)} aria-label={`Undo on ${c.target?.name ?? 'this keyword'}`}><Undo2 size={13} aria-hidden /> Undo…</Button>
      )}
      {undo?.kind === 'cant' && state.state !== 'undone' && (
        <Tooltip label={undo.reason} portal><span tabIndex={0} className={styles.cant} aria-label={`${undo.word}: ${undo.reason}`}>{undo.word}</span></Tooltip>
      )}
    </span>
  )
}

function HistoryTab(p: WasteRuleModalProps) {
  const r = p.row
  const [days, setDays] = useState(7)
  const { data, error, reload } = useLoad<WasteHistory>(() => fetchWasteHistory(r.id, days, p.market), [r.id, days, p.reloadKey, p.market])
  const when: Column<WasteRuleChange> = { key: 'when', label: 'When', render: (c) => <span title={whenWords(c.at)}>{relWords(c.at)}</span> }
  const columns: Array<Column<WasteRuleChange>> = [
    ...(p.phone ? [] : [when]),
    { key: 'term', label: 'Keyword / term', render: (c) => <TermCell row={c.target} campaign={c.campaign} adGroup={c.adGroup} when={p.phone ? relWords(c.at) : undefined} /> },
    { key: 'change', label: 'Change', render: (c) => { const ft = changeFromTo(c); return <ChangeValue changes={[{ label: ft.what, from: ft.from, to: ft.to }]} hideLabels /> } },
    { key: 'status', label: isPseudo(r) ? 'Status' : 'Status · Undo', render: (c) => <StatusCell c={c} ownerId={r.id} undoHeld={p.undoHeld} onUndo={p.onUndo} readOnly={isPseudo(r)} /> },
  ]
  return (
    <div className={styles.stack}>
      <div className={styles.lineBetween}>
        <SegmentedControl size="sm" ariaLabel="Days" options={DAYS} value={String(days)} onChange={(v) => setDays(Number(v))} />
        {data && <Tag>{plural(data.changes.length, 'change')}</Tag>}
      </div>
      {error && <NotRead what="History" error={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && data.changes.length > 0 && <DataGrid ariaLabel="Changes" columns={columns} rows={data.changes} rowKey={(c) => c.id} headerMenus={false} />}
      {data && !data.changes.length && <p className={styles.muted}>No changes in {periodWord(days)}.</p>}
    </div>
  )
}

// ── settings ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The Bid page's settings in this page's words: "Works on" is the path above (never raw ids), If · Then, no Order. */
const SETTING_WORD: Readonly<Record<string, string>> = { Trigger: 'If', 'When → then': 'If → then' }
function plainSettings(groups: SettingGroup[]): SettingGroup[] {
  return groups
    .filter((g) => g.id !== 'scope')
    .map((g) => ({ ...g, title: SETTING_WORD[g.title] ?? g.title, items: g.items.filter((i) => i.label !== 'Order').map((i) => ({ ...i, label: SETTING_WORD[i.label] ?? i.label })) }))
    .filter((g) => g.items.length > 0)
}

function SettingsTab(p: WasteRuleModalProps & { stored: StoredRule | null; storedError: string | null; onRetry(): void }) {
  const r = p.row
  const currency = currencyOf(marketOf(r, p.market))
  if (isStopWaste(r) && r.test) return <StopWasteSettings {...p} currency={currency} />
  // The stored rule's groups, with "Works on" as the path (links), never its raw ids.
  const groups: SettingGroup[] | null = p.stored ? plainSettings(settingGroups(p.stored, { sentence: r.sentence, currency, schedule: r.schedule ?? null })) : null
  if (r.archived) return <p className={styles.muted}>Archived: unarchive it to read its settings.</p>
  return (
    <div className={styles.stack}>
      {p.storedError && <NotRead what="Settings" error={p.storedError} onRetry={p.onRetry} />}
      {!groups && !p.storedError && <Loading />}
      {groups && (
        <section className={styles.section} aria-label="Works on">
          <h3 className={styles.h}>Works on</h3>
          <EntityPath items={scopePath(r)} linkAs={WorkspaceLink} label={`Where ${r.name} acts`} />
        </section>
      )}
      {groups && groups.map((g) => (
        <section key={g.id} className={styles.section} aria-label={g.title}>
          <h3 className={styles.h}>{g.title}</h3>
          <KeyValue dense columns={g.items.length > 2 ? 3 : 2} items={g.items.map((i) => ({ label: i.label, value: i.value }))} />
        </section>
      ))}
    </div>
  )
}

/** A stop-waste rule's own fields: edited here, reviewed by the view (PATCH /waste/rules/:id), Done with Undo. */
function StopWasteSettings(p: WasteRuleModalProps & { stored: StoredRule | null; storedError: string | null; onRetry(): void; currency: string }) {
  const r = p.row
  const test = r.test!
  const base = useMemo(() => fieldsOfSaved({ name: r.name, test }, p.stored?.actions), [r.name, test, p.stored])
  const [draft, setDraft] = useState<RuleFields>(base)
  // A re-read (after a save, or the stored rule arriving) starts the form from what is saved.
  const baseKey = JSON.stringify(base)
  const last = useRef(baseKey)
  useEffect(() => { if (last.current !== baseKey) { last.current = baseKey; setDraft(base) } }, [baseKey, base])
  const changed = Object.keys(fieldsPatch(r.kind, base, draft)).length
  const problems = Object.keys(fieldProblems(draft)).length
  const held = r.archived ? 'Archived: unarchive it first'
    : p.modeHeld ? p.modeHeld
      : !p.stored && !p.storedError ? 'Reading its settings…'
        : problems ? 'Fix the fields first'
          : !changed ? 'Nothing changed' : null
  return (
    <div className={styles.stack}>
      {p.storedError && <NotRead what="Its run time and verb" error={p.storedError} onRetry={p.onRetry} />}
      <div data-fields>
        <RuleFieldsForm kind={r.kind} value={draft} onChange={setDraft} currency={p.currency} idPrefix={`rule-${r.id}`} />
      </div>
      <div className={styles.lineBetween}>
        <span className={styles.chips}>{r.mode.set === 'AUTO' && <HintTag label="Back to Ask me" hint="A changed rule earns Auto again: it asks until you turn it back up" tone="warning" />}</span>
        <span className={styles.chips} data-return="fields">
          {changed > 0 && <Button size="sm" variant="quiet" onClick={() => setDraft(base)}>Discard</Button>}
          <Button size="sm" variant="primary" heldReason={held} onClick={() => p.onSaveFields(base, draft)}>{changed ? `Review ${plural(changed, 'change')}…` : 'Review…'}</Button>
        </span>
      </div>
    </div>
  )
}
