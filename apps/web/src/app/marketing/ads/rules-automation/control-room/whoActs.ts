/**
 * CR rebuild 2 — Who acts: every engine and rule that can change the Amazon ads, as ONE list with the same columns.
 * Pure: the grid renders these rows, the tests drive them directly.
 *
 * Every row answers the same questions in the same order — what it is · where it acts · what it is set to · what it
 * may do NOW and why, in plain words · what it has been doing · whether something is wrong. The level words are the
 * Control Room's one scale (levelWords.ts). The server's variable names never appear here; the drawer keeps them under
 * Technical details.
 */
import type { ActionImpact } from '@/design-system/grid/actions/registry'
import type { Autonomy, ClaudeRule } from '@/app/settings/ai/claude/claudeWords'
import type { WatchKind } from '@nexus/shared/approval-queue'
import type { ExposureFields } from '../automations/exposure'
import { actsOnItsOwn } from '../automations/exposure'
import { effectiveSwitch, type LeverControl } from './lever-control'
import { LEVEL_MEANS, LEVEL_WORD, levelRank, withoutServerNames, type Level } from './levelWords'
import { ruleInForce, type AccountLevel } from './roomCounts'

type HaltBehaviour = 'honours' | 'gated' | 'exempt'

/** One engine, as GET /api/advertising/control-room/levers returns it. */
export interface Engine extends ExposureFields {
  key: string; name: string; what: string
  mode: Level; modeReason: string
  scope: string | null; cron: string | null; schedule: string | null
  lastRunAt: string | null; lastRunStatus: string | null; lastRunSummary: string | null
  runs7d: number; failures7d: number
  warning: string | null; haltBehaviour: HaltBehaviour
  /** R16 — the server setting and this business's own switch (absent from an older API). */
  control?: LeverControl
}

/** One rule, as GET /api/advertising/autonomy/rules returns it (ads-rule-list.service.ts). */
export interface Rule {
  id: string; name: string; description?: string | null; marketplace: string | null
  level: Level
  /** 7b — the level it runs at; lower than `level` for a builder rule whose control is Manual. */
  runsAs?: Level; runsAsReason?: string | null
  ceiling: Level; ceilingReason: string
  actionTypes: string[]
  writes?: boolean
  caps: { perDay: number | null; perExecutionCents: number | null; perDayCents: number | null }
  week: { acted: number; proposed: number; failed: number }
  lastExecutedAt: string | null
  categoryLabel?: string
  scope?: { kind: 'campaign' | 'portfolio' | 'picked' | 'account'; name: string | null }
  reach?: { campaigns: number; enabledCampaigns: number; total: number } | null
}

/** ACR.4.1 — the graduation verdict for a rule (GET /api/advertising/autonomy/graduation). */
export type Verdict = 'ready' | 'unreviewed' | 'unseen' | 'building' | 'failing' | 'capped'
export interface Readiness { ruleId: string; verdict: Verdict; summary: string; canGraduate: boolean }

export type ActorKind = 'engine' | 'rule' | 'claude'
/** What a row may do to the ads now — the three top tiles. */
export type NowBucket = 'alone' | 'asks' | 'quiet'

export interface ActorRow {
  id: string
  kind: ActorKind
  name: string
  what: string
  /** A market code, or null for every market. */
  market: string | null
  setTo: string
  inForce: Level
  /** The pill's word when the one scale's word would hide a difference (Claude's "Ask me + code"). */
  inForceWord?: string
  why: string
  bucket: NowBucket
  lastRunAt: string | null
  week: string
  problem: string | null
  /** Low sorts first: what changes the ads by itself, then what asks, then the rest. */
  order: number
  engine?: Engine
  rule?: Rule
  /** CR rebuild 3 — one kind of ad change Claude may make (claudeKinds.ts), with its watch week. */
  claude?: { rule: ClaudeRule; watch?: WatchKind; autonomy?: Autonomy }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The rule actions people meet most, in plain words; any other code reads as its words ("bid_to_target_acos" → "Bid to target acos"). */
const ACTION_WORD: Record<string, string> = {
  create_keyword: 'Add keywords', add_keyword: 'Add keywords', graduate_keyword: 'Add keywords',
  create_negative: 'Block search terms', add_negative: 'Block search terms', negate_search_term: 'Block search terms', negative_keyword: 'Block search terms',
  lower_bid: 'Lower bids', raise_bid: 'Raise bids', set_bid: 'Set bids', bid_to_target_acos: 'Move bids toward the target ACoS',
  set_budget: 'Set budgets', raise_budget: 'Raise budgets', lower_budget: 'Lower budgets',
  suppress_campaign: 'Stop a campaign with low bids', restore_campaign: 'Restart a stopped campaign',
}
export const actionWords = (types: readonly string[]): string =>
  types.length
    ? [...new Set(types.map((t) => ACTION_WORD[t] ?? t.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())))].join(' · ')
    : 'Alerts only'

/**
 * Why a rule may go no higher, in plain words. The server's sentences (ads-graduation.ts) name code files and use
 * "negate" / "entities"; the known ones are said plainly, any other is said without its developer words.
 */
export function ceilingWords(reason: string): string {
  if (/^Unclassified action/i.test(reason)) return 'Nexus has not yet rated this kind of change safe to run alone.'
  if (/no protected terms are configured/i.test(reason)) return 'It blocks search terms, and no protected terms are set. Protect your brand terms first (Limits › Protected terms).'
  if (/^Creates negatives/i.test(reason)) return 'It blocks search terms. A blocked term is hard to notice later, so a person decides each one.'
  if (/^Creates or destroys entities/i.test(reason)) return 'It creates or removes campaigns, ad groups or keywords, so a person decides each one.'
  if (/^Lowers bids for a time window/i.test(reason)) return 'It lowers bids for a time window. Nothing gives them back if the rule is removed, so a person decides each one.'
  return withoutServerNames(reason, 'Nexus allows no higher level for this rule.')
}

/** Why the account holds automation where it is, or null when it does not hold it. */
function accountHold(g: AccountLevel): string | null {
  if (g.envKill) return 'Stopped by the server'
  if (g.halted) return 'Stopped — press Start again'
  if (g.autonomy === 'OFF') return 'The account level is Off'
  return null
}

/** An engine's state in plain words, from the group the API puts it in (ads-control-room.service.ts `engineExposure`). */
export function engineWhy(e: Engine, g: AccountLevel): string {
  switch (e.exposure?.group) {
    case 'acts': return 'Changes your ads by itself'
    case 'server-off': return 'The server keeps it off'
    case 'held': return accountHold(g) ?? (g.autonomy === 'SUGGEST' ? 'The account level is Ask me, so it only records what it would change' : 'Lowered for this business')
    case 'ready': return withoutServerNames(e.exposure.start, 'On, with nothing set up for it to change')
    case 'never': return 'Never changes your ads by itself'
    case 'unknown': return 'Its settings could not be read'
    default: return LEVEL_MEANS[e.mode].replace(/\.$/, '')
  }
}

/** A rule's state in plain words: the account first, then its own setting. */
export function ruleWhy(r: Rule, g: AccountLevel): string {
  const hold = accountHold(g)
  if (hold) return hold
  const runs = r.runsAs ?? r.level
  if (g.autonomy === 'SUGGEST' && runs === 'AUTO') return 'The account level holds it at Ask me'
  if (r.writes === false) return 'It only sends alerts. It changes nothing'
  if (runs !== r.level) return 'The rule itself is set to ask first'
  return LEVEL_MEANS[runs].replace(/\.$/, '')
}

const BUCKET_ORDER: Record<NowBucket, number> = { alone: 0, asks: 1, quiet: 2 }

export function engineRow(e: Engine, g: AccountLevel): ActorRow {
  // An engine never queues a suggestion for a person: at PROPOSE (the account level at Ask me holds it there) it only
  // counts what it would change (api ads-control-room.service.ts) — so it is Watch, and it changes nothing.
  const bucket: NowBucket = actsOnItsOwn(e) ? 'alone' : 'quiet'
  const inForce: Level = e.mode === 'PROPOSE' ? 'OBSERVE' : e.mode
  const setTo = !e.control ? '—' : e.control.switchable ? LEVEL_WORD[effectiveSwitch(e.control)] : 'Set on the server'
  const week = [
    plural(e.runs7d, 'run'),
    e.writes7d != null ? plural(e.writes7d, 'change') : null,
    e.failures7d > 0 ? `${e.failures7d} failed` : null,
  ].filter(Boolean).join(' · ')
  return {
    id: `engine:${e.key}`,
    kind: 'engine',
    name: e.name,
    what: e.what,
    market: null,
    setTo,
    inForce,
    why: engineWhy(e, g),
    bucket,
    lastRunAt: e.lastRunAt,
    week,
    problem: e.warning
      ? withoutServerNames(e.warning, 'Needs a look — see Technical details')
      : e.failures7d > 0 ? `${plural(e.failures7d, 'run')} failed in 7 days` : null,
    order: BUCKET_ORDER[bucket],
    engine: e,
  }
}

export function ruleRow(r: Rule, g: AccountLevel, readiness?: Readiness): ActorRow {
  const inForce = ruleInForce(r.runsAs ?? r.level, g)
  // A rule that only alerts (api ads-rule-list.service.ts `writes`) changes nothing, whatever its level.
  const bucket: NowBucket = r.writes === false ? 'quiet' : inForce === 'AUTO' ? 'alone' : inForce === 'PROPOSE' ? 'asks' : 'quiet'
  const week = [
    `${r.week.acted} acted`,
    `${r.week.proposed} asked`,
    r.week.failed > 0 ? `${r.week.failed} failed` : null,
  ].filter(Boolean).join(' · ')
  const problem = r.week.failed > 0
    ? `${plural(r.week.failed, 'change')} failed this week`
    : readiness?.verdict === 'failing' ? readiness.summary : null
  return {
    id: `rule:${r.id}`,
    kind: 'rule',
    name: r.name,
    what: r.description?.trim() || actionWords(r.actionTypes),
    market: r.marketplace,
    setTo: LEVEL_WORD[r.level],
    inForce,
    why: ruleWhy(r, g),
    bucket,
    lastRunAt: r.lastExecutedAt,
    week,
    problem,
    order: BUCKET_ORDER[bucket],
    rule: r,
  }
}

/**
 * Every engine, rule and Claude kind as one list: what changes the ads by itself first, then what asks, then the rest.
 * Engines and rules sort by name inside each group; Claude's kinds keep the strategy's order after them.
 */
export function actorRows(
  engines: readonly Engine[], rules: readonly Rule[], g: AccountLevel, readiness: ReadonlyMap<string, Readiness>,
  claude: readonly ActorRow[] = [],
): ActorRow[] {
  const own = [
    ...engines.map((e) => engineRow(e, g)),
    ...rules.map((r) => ruleRow(r, g, readiness.get(r.id))),
  ]
  const kindOrder = (r: ActorRow) => (r.kind === 'claude' ? 1 : 0)
  const claudeIndex = new Map(claude.map((r, i) => [r.id, i]))
  return [...own, ...claude].sort((a, b) =>
    a.order - b.order || kindOrder(a) - kindOrder(b)
    || (a.kind === 'claude' && b.kind === 'claude' ? (claudeIndex.get(a.id) ?? 0) - (claudeIndex.get(b.id) ?? 0) : a.name.localeCompare(b.name)))
}

/** The three automation tiles from the list itself, so the tiles and Who acts can never disagree. */
export function rowCounts(rows: readonly ActorRow[]): { total: number; runsAlone: number; asksFirst: number; quiet: number; quietSplit: { watch: number; off: number; idle: number } } {
  const quiet = rows.filter((r) => r.bucket === 'quiet')
  return {
    total: rows.length,
    runsAlone: rows.filter((r) => r.bucket === 'alone').length,
    asksFirst: rows.filter((r) => r.bucket === 'asks').length,
    quiet: quiet.length,
    quietSplit: {
      watch: quiet.filter((r) => r.inForce === 'OBSERVE').length,
      off: quiet.filter((r) => r.inForce === 'OFF').length,
      idle: quiet.filter((r) => r.inForce !== 'OBSERVE' && r.inForce !== 'OFF').length,
    },
  }
}

// ── filters ─────────────────────────────────────────────────────────────────────────────────────────────

export type ShowFilter = 'all' | NowBucket | 'problems'
export type KindFilter = 'all' | ActorKind

/** The filters' words carry their own label ("Show: …"), so a closed filter still says what it filters. */
export const SHOW_LABEL: Record<ShowFilter, string> = {
  all: 'Show: everything',
  alone: 'Show: Auto',
  asks: 'Show: Ask me',
  quiet: 'Show: Off or Watch',
  problems: 'Show: problems',
}
export const KIND_LABEL: Record<KindFilter, string> = { all: 'Type: all', engine: 'Type: engines', rule: 'Type: rules', claude: 'Type: Claude' }

export const isShowFilter = (v: unknown): v is ShowFilter => typeof v === 'string' && Object.prototype.hasOwnProperty.call(SHOW_LABEL, v)
export const isKindFilter = (v: unknown): v is KindFilter => typeof v === 'string' && Object.prototype.hasOwnProperty.call(KIND_LABEL, v)

export interface WhoFilter { search: string; kind: KindFilter; market: string; show: ShowFilter }
export const NO_FILTER: WhoFilter = { search: '', kind: 'all', market: 'all', show: 'all' }

/** The markets the rules name, sorted; engines act on every market. */
export function marketsOf(rows: readonly ActorRow[]): string[] {
  return [...new Set(rows.flatMap((r) => (r.market ? [r.market] : [])))].sort()
}

/** A market keeps its own rows AND the ones that act on every market: both can change that market's ads. */
export function rowMatches(row: ActorRow, f: WhoFilter): boolean {
  if (f.kind !== 'all' && row.kind !== f.kind) return false
  if (f.market !== 'all' && row.market !== null && row.market !== f.market) return false
  if (f.show === 'problems' ? !row.problem : f.show !== 'all' && row.bucket !== f.show) return false
  const q = f.search.trim().toLowerCase()
  if (!q) return true
  return [row.name, row.what, row.why, row.setTo, row.market ?? 'all markets', row.problem ?? '', row.kind]
    .some((t) => t.toLowerCase().includes(q))
}

export const isFiltered = (f: WhoFilter) => f.kind !== 'all' || f.market !== 'all' || f.show !== 'all' || f.search.trim() !== ''

/** "13 automations" / "Showing 4 of 13 automations". */
export function countWords(shown: number, total: number, filtered: boolean): string {
  const noun = total === 1 ? 'automation' : 'automations'
  return filtered ? `Showing ${shown} of ${total} ${noun}` : `${total} ${noun}`
}

// ── a rule's level ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The confirmation before a rule's level moves, or a refusal in words when the level is above the rule's ceiling (the
 * server would refuse it too, 409). Up needs the tick; down is a plain question. Before, every notch wrote at once,
 * Auto included, one row below a dial that asked first (report 7 §5).
 */
export function ruleMove(r: Rule, to: Level): { impact: ActionImpact } | { refused: string } | null {
  if (to === r.level) return null
  if (levelRank(to) > levelRank(r.ceiling)) return { refused: `“${r.name}” cannot be set to ${LEVEL_WORD[to]}: ${r.ceilingReason}` }
  const up = levelRank(to) > levelRank(r.level)
  const consequences = [
    `“${r.name}” goes from ${LEVEL_WORD[r.level]} to ${LEVEL_WORD[to]} from its next run.`,
    LEVEL_MEANS[to],
  ]
  if (up && to === 'AUTO' && r.runsAs && r.runsAs !== 'AUTO') consequences.push('The rule itself is set to ask first, so it still asks until that is changed in the rule.')
  const back = `Set it back to ${LEVEL_WORD[r.level]}`
  return {
    impact: up && to === 'AUTO'
      // Only Auto changes the ads by itself: the one raise that needs the tick.
      ? {
        level: 'confirm',
        title: `Raise “${r.name}” to Auto?`,
        consequences,
        reach: 'channel',
        reversal: { verb: back, fidelity: 'lossy' },
        acknowledge: 'I understand it changes my ads by itself from its next run, and what it changes stays changed.',
        confirmLabel: 'Raise to Auto',
      }
      : up
        // Watch and Ask me change nothing by themselves: a plain question.
        ? { level: 'confirm', title: `Raise “${r.name}” to ${LEVEL_WORD[to]}?`, consequences, reach: 'local', reversal: { verb: back, fidelity: 'exact' }, confirmLabel: `Raise to ${LEVEL_WORD[to]}` }
        : {
          level: 'confirm',
          title: `Lower “${r.name}” to ${LEVEL_WORD[to]}?`,
          consequences: [...consequences, 'What it changed before stays as it is.'],
          reach: 'local',
          reversal: { verb: back, fidelity: 'exact' },
          confirmLabel: `Lower to ${LEVEL_WORD[to]}`,
        },
  }
}

/** The rule's levels for its level control: every level is listed; one above the ceiling says why it is held. */
export function ruleLevelOptions(r: Rule): Array<{ value: Level; label: string; disabled: boolean }> {
  return (['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'] as const).map((level) => levelRank(level) > levelRank(r.ceiling)
    ? { value: level, label: `${LEVEL_WORD[level]} — not allowed for this rule`, disabled: true }
    : { value: level, label: LEVEL_WORD[level], disabled: false })
}
