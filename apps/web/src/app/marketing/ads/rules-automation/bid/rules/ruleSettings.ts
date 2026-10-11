/**
 * Bid page, a rule's Settings and Runs (2026-10-10) — every stored setting of one rule, grouped, as labels and values;
 * and its runs (GET /api/advertising/automation-rule-executions) with the whole-run roll back of today's History drawer.
 * Pure, tested in Node. Read only: "Edit all" opens the bid builder for the rule (the one place a bid rule is made and
 * edited, Owner 2026-10-10).
 *
 * The words of a rule's sentence live here too (the bid builder's metrics and THEN actions, short), so Settings reads the
 * rule the way the table's line does: "If ACoS > 35 % and clicks ≥ 10 → bid −15 %".
 */
import { MODE_OF_LEVEL, MODE_WORD, plural, type RuleLevel } from './bidRulesModel'
import { currencySymbol, dayWords, money, periodWord } from '../_shared/format'

// ── the words of a rule ─────────────────────────────────────────────────────────────────────────────────────────────

/** The bid builder's metrics (PerformanceCriteria `PC_METRICS_BID`), with the page's words. */
export const METRICS: ReadonlyArray<{ value: string; label: string; unit: 'money' | 'pct' | '' }> = [
  { value: 'ACOS', label: 'ACoS', unit: 'pct' },
  { value: 'Clicks', label: 'clicks', unit: '' },
  { value: 'Orders', label: 'orders', unit: '' },
  { value: 'Spend', label: 'spend', unit: 'money' },
  { value: 'Sales', label: 'sales', unit: 'money' },
  { value: 'CPC', label: 'CPC', unit: 'money' },
  { value: 'ROAS', label: 'ROAS', unit: '' },
  { value: 'CTR', label: 'CTR', unit: 'pct' },
  { value: 'CVR', label: 'CVR', unit: 'pct' },
  { value: 'Impressions', label: 'impressions', unit: '' },
  { value: 'PPC Orders', label: 'PPC orders', unit: '' },
  { value: 'Current Bid', label: 'bid', unit: 'money' },
]
export const OPS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'gt', label: '>' }, { value: 'gte', label: '≥' }, { value: 'lt', label: '<' }, { value: 'lte', label: '≤' },
  { value: 'eq', label: '=' }, { value: 'ne', label: '≠' },
]

export const metricOf = (v: string) => METRICS.find((m) => m.value === v)

/** The builder's THEN actions as the sentence says them; `{v}` is the value, `{c}` the currency mark. */
const THEN: Readonly<Record<string, string>> = {
  targetAcos: 'bid toward {v} %',
  curBidTargetAcos: 'step to {v} % ACoS',
  decPct: 'bid −{v} %',
  incPct: 'bid +{v} %',
  decAbs: 'bid −{c}{v}',
  incAbs: 'bid +{c}{v}',
  set: 'bid {c}{v}',
  setCpc: 'bid = CPC',
  revPerClick: 'bid = sales/click',
  pauseTarget: 'pause',
  enableTarget: 'unpause',
}

const str = (v: unknown) => (v == null ? '' : String(v).trim())
/** An empty limit, in the builder's words. */
const NO_MAX = 'No max'

/** One condition: "ACoS > 35 %", "clicks ≥ 10", "spend > €5". */
export function clauseWords(c: { metric?: unknown; field?: unknown; op?: unknown; value?: unknown }, currency = 'EUR'): string {
  const metric = str(c.metric) || str(c.field).split('.').pop() || '?'
  const m = metricOf(metric)
  const v = str(c.value) || '…'
  const shown = m?.unit === 'pct' ? `${v} %` : m?.unit === 'money' ? `${currencySymbol(currency)}${v}` : v
  return `${m?.label ?? metric} ${OPS.find((o) => o.value === str(c.op))?.label ?? str(c.op)} ${shown}`
}

/** The THEN part: "bid −15 %", "bid toward 25 %", "bid = CPC"; an action the page does not know reads as stored. */
export function thenWords(a: { op?: unknown; value?: unknown }, currency = 'EUR'): string {
  const op = str(a.op)
  const shape = THEN[op]
  if (!shape) return op || '—'
  return shape.replace('{v}', str(a.value) || '…').replace('{c}', currencySymbol(currency))
}

// ── settings ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The stored rule (GET /api/advertising/automation-rules/:id → `rule`), the fields Settings reads. */
export interface StoredRule {
  id: string
  name: string
  description?: string | null
  trigger?: string | null
  conditions?: unknown
  actions?: unknown
  enabled?: boolean
  dryRun?: boolean
  autonomyLevel?: string | null
  priority?: number | null
  maxExecutionsPerDay?: number | null
  maxWritesPerDay?: number | null
  maxValueCentsEur?: number | null
  maxDailyAdSpendCentsEur?: number | null
  scopeMarketplace?: string | null
  scopePortfolioId?: string | null
  scopeCampaignId?: string | null
  scopeProductId?: string | null
  createdAt?: string
  createdBy?: string | null
  evaluationCount?: number | null
  lastEvaluatedAt?: string | null
}

export interface SettingItem { label: string; value: string }
export interface SettingGroup { id: string; title: string; items: SettingItem[] }

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
/** A stored decimal in the market's money ("0.05") as "€0.05"; a dash when it is not a number. */
const amount = (v: unknown, currency: string) => {
  const n = Number(str(v).replace(',', '.'))
  return str(v) === '' || !Number.isFinite(n) ? '—' : money(Math.round(n * 100), currency)
}
/** A limit in euro cents; an empty limit says "No max", as the builder does (audit R16). */
const euroCents = (v: number | null | undefined) => (v == null ? NO_MAX : money(v, 'EUR'))

const TIMEZONE_WORD: Readonly<Record<string, string>> = { cet: 'Rome', utc: 'UTC', pst: 'Los Angeles', est: 'New York', gmt: 'London' }

/** The stored schedule read plainly — only when the list's own words (`ctx.schedule`) are missing on an older answer. */
function scheduleWords(s: Obj): string {
  const freq = str(s.frequency) || 'Daily'
  const time = str(s.time)
  const tz = TIMEZONE_WORD[str(s.timezone).toLowerCase()] ?? str(s.timezone)
  const every = str(s.everyN)
  const head = freq === 'Custom' && every ? `Every ${every} ${str(s.interval).toLowerCase()}` : freq === 'Weekly' ? `Weekly, ${str(s.onDay)}` : freq
  return [head, time, tz].filter(Boolean).join(' · ')
}

const whoMade = (by: string | null | undefined): string => {
  const b = str(by)
  if (!b) return ''
  if (b === 'user' || b.startsWith('user:')) return 'You'
  if (/^claude/i.test(b)) return 'Claude'
  return b
}

export interface SettingsContext {
  /** The table's line for the rule (the server's sentence): a one-block rule reads the same in Settings. */
  sentence?: string | null
  /** The money its bids are in (the rule's market); default euros. */
  currency?: string
  /** Its schedule in the engine's own words (the list's `schedule`): the truth over the stored fields' reading. */
  schedule?: string | null
}

/** Every setting, grouped. A builder rule reads its blocks and its first action; an engine rule its conditions and action. */
export function settingGroups(rule: StoredRule, ctx: SettingsContext = {}): SettingGroup[] {
  const currency = ctx.currency ?? 'EUR'
  const actions = Array.isArray(rule.actions) ? (rule.actions as Obj[]) : []
  const conds = Array.isArray(rule.conditions) ? (rule.conditions as Obj[]) : []
  const a0 = obj(actions[0])
  const builder = a0.type === 'bid'
  const groups: SettingGroup[] = []

  if (builder) {
    const block = (g: Obj) => {
      const ifs = (Array.isArray(g.conditions) ? (g.conditions as Obj[]) : []).map((c) => clauseWords(c, currency)).join(' and ')
      return `${ifs ? `If ${ifs}` : 'Every keyword'} → ${thenWords(obj(g.action), currency)}`
    }
    // One block: its line is the detail's own subtitle, so Settings does not say it again (audit R16). Several: each.
    if (!(conds.length === 1 && ctx.sentence)) {
      groups.push({
        id: 'when',
        title: 'Blocks',
        items: conds.map((g, i) => ({ label: conds.length > 1 ? `Block ${i + 1}` : 'If → then', value: block(g) })),
      })
    }
    groups.push({
      id: 'bids',
      title: 'Bids',
      items: [
        { label: 'Lowest', value: amount(a0.bidFloor, currency) },
        { label: 'Highest', value: a0.bidCeiling == null || str(a0.bidCeiling) === '' ? NO_MAX : amount(a0.bidCeiling, currency) },
        { label: 'Over', value: periodWord(Number(a0.windowDays) || 14) },
      ],
    })
    const campaigns = Array.isArray(a0.campaigns) ? (a0.campaigns as Obj[]) : Array.isArray(a0.campaignIds) ? (a0.campaignIds as unknown[]).map((id) => ({ id })) : []
    groups.push({
      id: 'scope',
      title: 'Works on',
      items: [
        { label: 'Market', value: rule.scopeMarketplace || 'Every market' },
        { label: 'Campaigns', value: campaigns.length ? plural(campaigns.length, 'campaign') : 'Whole market' },
        ...(rule.scopePortfolioId ? [{ label: 'Portfolio', value: rule.scopePortfolioId }] : []),
        ...(rule.scopeProductId ? [{ label: 'Product', value: rule.scopeProductId }] : []),
      ],
    })
    const filters = obj(a0.filters)
    const brands = Array.isArray(filters.brandExclude) ? (filters.brandExclude as unknown[]).length : 0
    const terms = Array.isArray(a0.searchTerms) ? (a0.searchTerms as unknown[]).length : 0
    groups.push({
      id: 'runs',
      title: 'Runs',
      items: [
        { label: 'When', value: ctx.schedule || scheduleWords(obj(a0.schedule)) },
        // No "Once a day" row: a bid rule's stored `dedupe` is never read by the engine (the bid translation in
        // ads-rule-adapter.service.ts carries no dedupe; only the harvest/negative wire reads it), so showing it would
        // promise something that does not happen.
        ...(brands ? [{ label: 'Brands left out', value: String(brands) }] : []),
        ...(terms ? [{ label: 'Search-term filters', value: String(terms) }] : []),
      ],
    })
  } else {
    groups.push({
      id: 'when',
      title: 'When → then',
      items: [
        { label: 'Trigger', value: str(rule.trigger).toLowerCase().replace(/_/g, ' ') || '—' },
        ...conds.map((c, i) => ({ label: `If ${i + 1}`, value: clauseWords(c, currency) })),
        ...actions.map((a, i) => ({ label: actions.length > 1 ? `Then ${i + 1}` : 'Then', value: str(a.type).replace(/_/g, ' ') + (a.percent != null ? ` ${str(a.percent)} %` : '') })),
      ],
    })
    groups.push({ id: 'scope', title: 'Works on', items: [
      { label: 'Market', value: rule.scopeMarketplace || 'Every market' },
      ...(rule.scopePortfolioId ? [{ label: 'Portfolio', value: rule.scopePortfolioId }] : []),
      ...(rule.scopeCampaignId ? [{ label: 'Campaign', value: rule.scopeCampaignId }] : []),
      ...(rule.scopeProductId ? [{ label: 'Product', value: rule.scopeProductId }] : []),
    ] })
    groups.push({ id: 'runs', title: 'Runs', items: [{ label: 'When', value: ctx.schedule || 'Every 15 min' }] })
  }

  groups.push({
    id: 'caps',
    title: 'Limits',
    items: [
      { label: 'Keywords a day', value: rule.maxExecutionsPerDay == null ? NO_MAX : String(rule.maxExecutionsPerDay) },
      { label: 'Changes a day', value: rule.maxWritesPerDay == null ? NO_MAX : String(rule.maxWritesPerDay) },
      { label: 'Most per run', value: euroCents(rule.maxValueCentsEur) },
      { label: 'Ad spend a day', value: euroCents(rule.maxDailyAdSpendCentsEur) },
    ],
  })

  const level = (rule.enabled === false ? 'OFF' : (['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'].includes(str(rule.autonomyLevel)) ? str(rule.autonomyLevel) : rule.dryRun === false ? 'AUTO' : 'PROPOSE')) as RuleLevel
  // Mode, order and making in one group whose heading repeats none of its labels (audit R16: "Mode / MODE").
  const who = whoMade(rule.createdBy)
  groups.push({
    id: 'mode',
    title: 'Status',
    items: [
      { label: 'Mode', value: MODE_WORD[MODE_OF_LEVEL[level]] },
      ...(rule.priority != null ? [{ label: 'Order', value: String(rule.priority) }] : []),
      // "10 Oct · You": a person is "You" on the whole page (audit R10), Claude by its name.
      { label: 'Created', value: [rule.createdAt ? dayWords(rule.createdAt) : null, who || null].filter(Boolean).join(' · ') || '—' },
      { label: 'Runs', value: String(rule.evaluationCount ?? 0) },
    ],
  })
  return groups
}

// ── runs ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RunRow {
  id: string
  status: string
  dryRun: boolean
  startedAt: string
  errorMessage: string | null
  actionResults?: Array<{ type: string; ok?: boolean; output?: { wouldChange?: string; newDailyBudget?: number; skipped?: string } | null; error?: string }> | null
}

/** The whole-run roll back closes after a day (rollback.service.ts rollbackByExecutionId: the flat 24 h window). */
export const RUN_ROLLBACK_MS = 24 * 3_600_000

export function runWord(r: RunRow): { text: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' } {
  if (r.status === 'NO_MATCH') return { text: 'No match', tone: 'neutral' }
  if (r.dryRun) return { text: r.status === 'CAP_EXCEEDED' ? 'Capped' : 'Asked', tone: r.status === 'CAP_EXCEEDED' ? 'warning' : 'info' }
  if (r.status === 'SUCCESS') return { text: 'Applied', tone: 'success' }
  if (r.status === 'PARTIAL') return { text: 'Part applied', tone: 'warning' }
  if (r.status === 'FAILED') return { text: 'Failed', tone: 'danger' }
  if (r.status === 'CAP_EXCEEDED') return { text: 'Capped', tone: 'warning' }
  return { text: r.status.toLowerCase().replace(/_/g, ' '), tone: 'neutral' }
}

/** What a run did, short: "38¢ → 30¢, 20¢ → 17¢" or its error. */
export function runSummary(r: RunRow): string {
  if (r.errorMessage) return r.errorMessage
  const acted = (r.actionResults ?? []).filter((a) => a.ok && a.output && !a.output.skipped)
  if (!acted.length) return '—'
  const words = acted.map((a) => a.output?.wouldChange ?? a.type.replace(/_/g, ' '))
  return words.length > 3 ? `${words.slice(0, 3).join(', ')} +${words.length - 3}` : words.join(', ')
}

export const runRollbackable = (r: RunRow, now = Date.now()): boolean =>
  !r.dryRun && (r.status === 'SUCCESS' || r.status === 'PARTIAL') && now - new Date(r.startedAt).getTime() < RUN_ROLLBACK_MS
