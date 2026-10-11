/**
 * Bid page (2026-10-10) — the pure half of the bid-rules API (routes/advertising-bid-rules.routes.ts): which rules are
 * bid rules, the honest mode (what the Owner set against what really acts, and what holds it), the one-line sentence,
 * the next run, and the effect arithmetic. No database, no clock of its own: every function takes what it reads.
 *
 * The words are the page's (Off · Watch · Ask me · Auto; Brain; Rule): short labels, never sentences.
 */
import type { AutonomyLevel } from '../ads-autonomy.js'
import { scheduleIsDue, type StoredRuleSchedule } from '../ads-rule-schedule.js'

// ── which rules are bid rules ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The action types that put a rule on the Bid page, plus the builder slug `bid` (a builder rule stores its slug as its
 * action type). The same list the Bid tab has used since C2 (web rules-automation/_shared/tabs.tsx, RULE_TAB_ACTION_TYPES
 * `bid`): any action of the rule counts, not only the first.
 */
export const BID_RULE_ACTION_TYPES: ReadonlySet<string> = new Set([
  'bid_to_target_acos', 'bid_up', 'bid_down', 'lower_bid_to_floor', 'raise_bids_for_rank_defense', 'bid_apply',
  'pause_target', 'enable_target', 'bid',
])

export function isBidRule(actions: unknown): boolean {
  return (Array.isArray(actions) ? actions : []).some((a) => BID_RULE_ACTION_TYPES.has(String((a as { type?: unknown } | null)?.type ?? '')))
}

/**
 * An archived ads rule keeps its row, its runs, its action log and its suggestions, under this domain instead of
 * `advertising`. Every reader of ads rules (the evaluator, the boards, the level dial, the gate, delete, test) selects
 * `domain: 'advertising'`, so an archived rule is inert and out of every list without a schema change; restoring it sets
 * the domain back. Only the bid-rules service writes or reads it.
 */
export const ARCHIVED_ADS_DOMAIN = 'advertising-archived'

// ── the honest mode ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The page's four steps. */
export type BidMode = 'OFF' | 'WATCH' | 'ASK' | 'AUTO'
const RANK: Record<BidMode, number> = { OFF: 0, WATCH: 1, ASK: 2, AUTO: 3 }
export const MODE_OF_LEVEL: Readonly<Record<AutonomyLevel, BidMode>> = { OFF: 'OFF', OBSERVE: 'WATCH', PROPOSE: 'ASK', AUTO: 'AUTO' }

export type HoldKind = 'stopped' | 'server' | 'dial' | 'cap' | 'graduation' | 'manual' | 'gate' | 'allowlist' | 'scope' | 'brain'
/** One thing that holds a mode: a short `label` for the chip (at most 3 words) and a one-line `reason` for its tooltip. */
export interface Hold { kind: HoldKind; label: string; reason: string }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
/** ": Italy exact, UK exact +2" — the campaigns a hold covers, for its reason (the first three by name, then how many more). */
const named = (names: readonly string[] | undefined, total = names?.length ?? 0) =>
  names?.length ? `: ${names.slice(0, 3).join(', ')}${total > 3 ? ` +${total - 3}` : ''}` : ''
/** The actions that keep a rule at Ask me whatever it has shown (ads-graduation.ts STRUCTURAL_ACTIONS, for a bid rule). */
const PAUSING = new Set(['pause_target', 'enable_target'])

/**
 * Every hold the bid rules say, in one place: `label` for the chip (at most three plain words; "Market not set up" is the
 * page's own word for a market Nexus has no Amazon bid limits for), `reason` one plain line for its tooltip that says why
 * and, where it can, which campaigns or which limit. The page's words only (Off · Watch · Ask me · Auto; Brain; Rule);
 * never shadow, sandbox, graduation, allowlist, lever, observe, propose or cycle (pure.vitest.test.ts checks every one).
 */
export const HOLDS = {
  serverKill: (): Hold => ({ kind: 'stopped', label: 'Ads stopped', reason: 'The server\'s stop switch blocks every automatic ads change.' }),
  halted: (): Hold => ({ kind: 'stopped', label: 'Ads halted', reason: 'Ads automation is halted for this business, so nothing automatic runs.' }),
  stateUnread: (): Hold => ({ kind: 'stopped', label: 'Ads state unread', reason: 'The ads safety settings could not be read, so nothing automatic runs.' }),
  accountOff: (): Hold => ({ kind: 'dial', label: 'Account: Off', reason: 'The account\'s ads mode is Off, so no rule runs.' }),
  accountAsk: (): Hold => ({ kind: 'dial', label: 'Account: Ask me', reason: 'The account\'s ads mode is Ask me, so every change waits for you.' }),
  dailyCap: (n?: number | null): Hold => ({ kind: 'cap', label: 'Daily limit reached', reason: `It reached its ${n != null ? plural(n, 'keyword') : 'keywords'} a day; it runs again tomorrow (UTC).` }),
  changeCap: (n?: number | null): Hold => ({ kind: 'cap', label: 'Change limit reached', reason: `It made its ${n != null ? plural(n, 'change') : 'changes'} a day; until tomorrow (UTC) it asks you instead.` }),
  valueCapZero: (): Hold => ({ kind: 'cap', label: 'Run limit 0', reason: 'Its "Most per run" is 0, so every change is refused before it runs.' }),
  noCampaigns: (): Hold => ({ kind: 'scope', label: 'No campaigns', reason: 'Its market, portfolio, campaigns or product reach no campaign today, so it never acts.' }),
  alwaysAsks: (blockedBy?: readonly string[]): Hold => ({
    kind: 'graduation', label: 'Always asks',
    reason: !blockedBy?.length || blockedBy.some((t) => PAUSING.has(t))
      ? 'Pausing or unpausing a keyword always waits for your yes.'
      : 'One of its actions always waits for your yes.',
  }),
  ruleAsks: (): Hold => ({ kind: 'manual', label: 'Rule asks first', reason: 'The rule itself is set to ask, so every change waits for you.' }),
  testMode: (): Hold => ({ kind: 'gate', label: 'Amazon test mode', reason: 'The server sends ads changes to Amazon\'s test account, not the live one.' }),
  brainDecides: (names?: string[], total?: number): Hold => ({ kind: 'brain', label: 'Brain decides', reason: `The brain sets the bids there, so this rule's change goes to the brain for 7 days${named(names, total)}.` }),
  brainCampaigns: (n: number, names?: string[]): Hold => ({ kind: 'brain', label: plural(n, 'brain campaign'), reason: `The brain sets the bids there, so this rule's change goes to the brain${named(names, n)}.` }),
  brainOff: (names?: string[], total?: number): Hold => ({ kind: 'stopped', label: 'Brain off', reason: `You stopped the brain's bids there, so nothing changes${named(names, total)}.` }),
  stoppedCampaigns: (n: number, names?: string[]): Hold => ({ kind: 'stopped', label: plural(n, 'stopped campaign'), reason: `You stopped the brain's bids there, so nothing changes${named(names, n)}.` }),
  locked: (names?: string[], total?: number): Hold => ({ kind: 'allowlist', label: 'Campaigns locked', reason: `Not on the live-change list, bids held by hand, or the account takes no changes${named(names, total)}.` }),
  lockedCampaigns: (n: number, names?: string[]): Hold => ({ kind: 'allowlist', label: `${plural(n, 'campaign')} locked`, reason: `Not on the live-change list, bids held by hand, or the account takes no changes${named(names, n)}.` }),
  unsupported: (names?: string[], total?: number): Hold => ({ kind: 'gate', label: 'Market not set up', reason: `Nexus does not know Amazon's bid limits in this market yet, so it changes nothing there${named(names, total)}.` }),
  unsupportedCampaigns: (n: number, names?: string[]): Hold => ({ kind: 'gate', label: `${plural(n, 'campaign')} not set up`, reason: `Their market has no Amazon bid limits in Nexus yet, so nothing changes there${named(names, n)}.` }),
  serverOff: (): Hold => ({ kind: 'server', label: 'Brain off (server)', reason: 'The server switch turns the brain off: it decides nothing.' }),
  serverNoWrites: (): Hold => ({ kind: 'server', label: 'Server: no changes', reason: 'The server switch lets the brain decide and record, but not change bids.' }),
  brainAsk: (): Hold => ({ kind: 'dial', label: 'Account: Ask me', reason: 'The account\'s ads mode is Ask me: the brain changes no bid and asks nothing.' }),
  autoOffServer: (): Hold => ({ kind: 'server', label: 'Auto off (server)', reason: 'The server switch must allow bid changes before the brain can run on Auto.' }),
  // Why Auto cannot be picked (the level dial's own answer, adsRuleLevelRefusal).
  autoFrom: (day: string, days: number, runs: number): Hold => ({ kind: 'graduation', label: `Auto from ${day}`, reason: `A new rule first runs ${days} days, at least ${runs} times and matches a keyword once.` }),
  autoAfterRuns: (n: number, runs: number): Hold => ({ kind: 'graduation', label: plural(n, 'more run'), reason: `Auto needs at least ${runs} runs of this rule first.` }),
  autoNoMatch: (): Hold => ({ kind: 'graduation', label: 'No match yet', reason: 'Auto needs this rule to have matched a keyword at least once.' }),
  autoTurnOn: (): Hold => ({ kind: 'graduation', label: 'Turn on first', reason: 'Auto is for a rule that runs: pick Watch or Ask me first.' }),
  autoHourlyPlan: (): Hold => ({ kind: 'gate', label: 'Hourly plan', reason: 'The hourly plan sets these bids, so a rule may only ask.' }),
  autoMarketNotLive: (): Hold => ({ kind: 'gate', label: 'Market not live', reason: 'The market\'s Amazon Ads account is not live, or bid changes are not switched on for it.' }),
  autoNotAllowed: (): Hold => ({ kind: 'graduation', label: 'Not allowed', reason: 'Nexus refused Auto for this rule: one of its checks did not pass.' }),
  // What would stop ONE change of a preview (preview.ts), by the campaign it lands on — audit §2: Brain decides · Brain off
  // · Locked · Market not set up.
  previewBrain: (): Hold => ({ kind: 'brain', label: 'Brain decides', reason: 'The brain sets the bids on this campaign, so this change would go to the brain.' }),
  previewBrainOff: (): Hold => ({ kind: 'stopped', label: 'Brain off', reason: 'You stopped the brain\'s bids on this campaign, so nothing would change.' }),
  previewLocked: (): Hold => ({ kind: 'allowlist', label: 'Locked', reason: 'This campaign takes no automatic change: not on the live-change list, bids held by hand, or its account takes no changes.' }),
  previewMarket: (): Hold => ({ kind: 'gate', label: 'Market not set up', reason: 'Nexus does not know Amazon\'s bid limits in this campaign\'s market yet, so nothing would change.' }),
} as const

export interface BidRuleMode {
  /** What the Owner set (the rule's level). */
  set: BidMode
  /** What it really does now. */
  acts: BidMode
  /** The first thing that makes `acts` differ from `set` (or turns its bid writes into brain inputs); null when nothing does. */
  heldBy: Hold | null
  /**
   * Every other hold, in the engine's order: behind the first one (the dial holds it, and its campaigns are locked too), or
   * on part of its campaigns only ("2 campaigns locked", "1 brain campaign": it still acts on the rest).
   */
  also: Hold[]
  /** Why Auto cannot be picked now (the rule's age and runs, an ask-only action); null when it can, it is Auto already, Off or archived. */
  autoLocked: Hold | null
}

/** The account's posture as the evaluator reads it (ads-automation-state.service.ts). */
export interface AccountPosture {
  autonomy: 'OFF' | 'SUGGEST' | 'AUTO'
  halted: boolean
  /** NEXUS_ADS_AUTOMATION_KILL=1. */
  killed: boolean
  /** The state row could not be read: the evaluator skips the tick (fails closed). */
  degraded: boolean
}

/** The campaigns a rule's scope reaches (not archived), split by what the write gate does with a rule's bid write. */
export interface CampaignSplit {
  total: number
  /** The rule's write goes through: on the live-write allowlist, bids not pinned, a market that takes writes, not the brain's. */
  open: number
  /** Off the allowlist, bids pinned, or a market whose Amazon Ads connection is not production with writes on: the gate
   *  refuses an automatic write. */
  locked: number
  /** A market without a checked row of Amazon's bid limits (only IT, DE, FR and ES have one): the gate refuses every write. */
  market: number
  /** The bid brain owns it: a rule's bid action becomes a brain input there (BB-9). */
  brain: number
  /** The bid brain owns it but the Owner's kill switch stops its bids: a rule's input there moves nothing. */
  brainStopped: number
  /** The campaigns' names per part (sorted), for the holds' reasons: which campaigns. */
  names?: Partial<Record<'locked' | 'market' | 'brain' | 'brainStopped', string[]>>
}

export interface RuleModeFacts {
  level: AutonomyLevel
  archived: boolean
  account: AccountPosture
  /** NEXUS_AMAZON_ADS_MODE is live (otherwise writes go to Amazon's sandbox). */
  adsLive: boolean
  /** The graduation ceiling of the actions the rule produces (ads-graduation.ts). */
  ceiling: AutonomyLevel
  /** The action types that set that ceiling (its `blockedBy`), for the reason. */
  ceilingBlockedBy?: string[]
  /** A builder rule whose control is Manual (`actions[0].control`): every run is a dry run that asks. */
  manualBelt: boolean
  /** Its daily match cap (maxExecutionsPerDay) is used for today (UTC): further matches are refused until tomorrow. */
  matchesCapHit: boolean
  /** Its daily write cap (maxWritesPerDay) is used for today (UTC): it asks instead of writing until tomorrow. */
  writeCapHit: boolean
  /** Its per-run value cap (maxValueCentsEur) is 0: every action is refused on its first step (it asks and writes nothing). */
  valueCapZero: boolean
  /** The two daily caps' numbers (maxExecutionsPerDay, maxWritesPerDay), for the reasons. */
  caps?: { matchesPerDay?: number | null; writesPerDay?: number | null }
  campaigns: CampaignSplit
  /** For a rule not on Auto: why Auto cannot be picked (adsRuleLevelRefusal), null when it can. */
  autoGate: Hold | null
}

/**
 * What a rule really does, in the engine's own order (automation-rule.service.ts evaluateRule and the evaluator's tick):
 * the account stop → the daily match cap → the account dial (Ask me turns Auto into Ask) → the graduation ceiling → the
 * Manual belt (asks at Watch and Auto) → the daily write cap → the write gate (test mode, the allowlist and pins) → the
 * bid brain (on its campaigns a bid action becomes its input). The first that changes it is `heldBy`.
 */
export function ruleMode(f: RuleModeFacts): BidRuleMode {
  const set = MODE_OF_LEVEL[f.level]
  // Archived: Off, and the row says archived — no hold and no Auto lock to show.
  if (f.archived) return { set: 'OFF', acts: 'OFF', heldBy: null, also: [], autoLocked: null }
  let acts: BidMode = set
  let heldBy: Hold | null = null
  const also: Hold[] = []
  /** A hold: the first is `heldBy`, the rest `also`. With a mode, it lowers `acts` to it (never raises, but the belt). */
  const hold = (h: Hold, mode?: BidMode) => {
    if (mode !== undefined && mode !== acts) acts = mode
    if (!heldBy) heldBy = h
    else if (!also.some((x) => x.kind === h.kind && x.label === h.label)) also.push(h)
  }
  // R15 — no Auto lock on a rule that is Off (or on Auto already): the mode list offers Auto only to a rule that runs, so
  // a "Turn on first" chip would repeat what the list already says.
  const done = () => ({ set, acts, heldBy, also, autoLocked: set === 'AUTO' || set === 'OFF' ? null : f.autoGate })
  if (set === 'OFF') return done()

  if (f.account.killed) hold(HOLDS.serverKill(), 'OFF')
  else if (f.account.halted) hold(HOLDS.halted(), 'OFF')
  else if (f.account.degraded) hold(HOLDS.stateUnread(), 'OFF')
  else if (f.account.autonomy === 'OFF') hold(HOLDS.accountOff(), 'OFF')
  if (acts === 'OFF') return done()
  if (f.matchesCapHit) {
    hold(HOLDS.dailyCap(f.caps?.matchesPerDay), 'OFF')
    return done()
  }
  if (f.campaigns.total === 0) {
    hold(HOLDS.noCampaigns(), 'OFF')
    return done()
  }

  if (acts === 'AUTO' && f.account.autonomy === 'SUGGEST') hold(HOLDS.accountAsk(), 'ASK')
  if (set === 'AUTO' && f.ceiling !== 'AUTO') hold(HOLDS.alwaysAsks(f.ceilingBlockedBy), acts === 'AUTO' ? MODE_OF_LEVEL[f.ceiling] : undefined)
  // The Manual belt makes every run a dry run that asks — Watch included (evaluateRule proposes whenever it is Manual).
  if (f.manualBelt && (acts === 'AUTO' || acts === 'WATCH')) hold(HOLDS.ruleAsks(), 'ASK')
  if (acts === 'AUTO' && f.writeCapHit) hold(HOLDS.changeCap(f.caps?.writesPerDay), 'ASK')
  // A value cap of 0 refuses every action before it runs (evaluateRule: 0 ≥ 0): nothing is asked or written, only recorded.
  if (f.valueCapZero && (acts === 'AUTO' || acts === 'ASK')) hold(HOLDS.valueCapZero(), 'WATCH')
  if (set === 'AUTO' && !f.adsLive) hold(HOLDS.testMode(), acts === 'AUTO' ? 'WATCH' : undefined)

  const c = f.campaigns
  if (acts === 'AUTO' || acts === 'ASK') {
    // Where its writes (Auto) or its approved asks (Ask: they carry the rule's actor) would land. When none is open, the
    // first of these names it: on the brain's campaigns its bid action is an input to the brain (BB-9); on a stopped
    // brain's, a locked campaign's or a market Nexus has no limits for, nothing moves — Auto then only watches.
    const n = c.names ?? {}
    const parts: Array<[number, Hold, Hold]> = [
      [c.brain, HOLDS.brainDecides(n.brain, c.brain), HOLDS.brainCampaigns(c.brain, n.brain)],
      [c.brainStopped, HOLDS.brainOff(n.brainStopped, c.brainStopped), HOLDS.stoppedCampaigns(c.brainStopped, n.brainStopped)],
      [c.locked, HOLDS.locked(n.locked, c.locked), HOLDS.lockedCampaigns(c.locked, n.locked)],
      [c.market, HOLDS.unsupported(n.market, c.market), HOLDS.unsupportedCampaigns(c.market, n.market)],
    ]
    const main = c.open === 0 ? parts.findIndex(([count]) => count > 0) : -1
    if (main >= 0) hold(parts[main][1], main === 0 || acts !== 'AUTO' ? undefined : 'WATCH')
    parts.forEach(([count, , part], i) => {
      if (count > 0 && i !== main && !also.some((x) => x.label === part.label)) also.push(part)
    })
  }
  return done()
}

/** The bid brain's mode: set = an enrollment LIVE or HELD (the Owner's choice per campaign), else Watch (it decides, writes nothing). */
export function brainMode(f: { serverMode: 'off' | 'shadow' | 'live'; enrolledLive: number; account: AccountPosture; adsLive: boolean; /** Of its live campaigns, those whose bids the Owner's kill switch stops. */ killed?: number }): BidRuleMode {
  const set = (f.enrolledLive > 0 ? 'AUTO' : 'WATCH') as BidMode
  let acts = set as BidMode
  let heldBy: Hold | null = null
  const also: Hold[] = []
  const hold = (h: Hold, mode?: BidMode) => {
    if (mode !== undefined && mode !== acts) acts = mode
    if (!heldBy) heldBy = h
    else also.push(h)
  }
  if (f.serverMode === 'off') hold(HOLDS.serverOff(), 'OFF')
  else if (f.account.killed) hold(HOLDS.serverKill(), 'OFF')
  else if (f.account.halted) hold(HOLDS.halted(), 'OFF')
  else if (f.account.degraded) hold(HOLDS.stateUnread(), 'OFF')
  else if (f.account.autonomy === 'OFF') hold(HOLDS.accountOff(), 'OFF')
  const killed = f.killed ?? 0
  if (acts !== 'OFF' && set === 'AUTO' && killed > 0) {
    // The Owner's kill switch on the bids lever (brain/kill-switch.ts): the brain's own bid writes are refused there.
    if (killed >= f.enrolledLive) hold(HOLDS.brainOff(), 'OFF')
    else also.push(HOLDS.stoppedCampaigns(killed))
  }
  if (acts !== 'OFF' && set === 'AUTO') {
    if (f.serverMode !== 'live') hold(HOLDS.serverNoWrites(), 'WATCH')
    // Under Ask me the brain's live writer writes nothing and asks nothing (bid-brain/live-writer.ts): it watches.
    if (f.account.autonomy === 'SUGGEST') hold(HOLDS.brainAsk(), 'WATCH')
    if (!f.adsLive) hold(HOLDS.testMode(), 'WATCH')
  }
  // Going live is a request with the approver's code (set-bid-brain-enrollment); only the server switch can forbid it.
  const autoLocked: Hold | null = set === 'AUTO' || f.serverMode === 'live' ? null : HOLDS.autoOffServer()
  return { set, acts, heldBy, also, autoLocked }
}

/** True when the mode can do anything at all now (counted as "on"). */
export const modeActs = (m: BidRuleMode) => RANK[m.acts] > RANK.OFF

/** "24 Oct" — a day as the page says it, in the business's time zone (Rome). Pure. */
export const shortDay = (d: Date) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/Rome' }).format(d)

/** The graduation gate's numbers (ads-rule-crud.service.ts GRADUATION_GATE) and how many runs the rule has. */
export interface AutoGateFacts { observationDays: number; evaluations: { have: number; need: number } }

/**
 * The level dial's refusal of Auto (adsRuleLevelRefusal) as a hold, read by its first failing check in the gate's own order.
 * `createdAt` + the gate's days is the first moment the rule's age allows Auto, said as its day in Rome ("Auto from 24
 * Oct"). Pure.
 */
export function autoGateHold(refusal: { error?: unknown; failures?: unknown; blockedBy?: unknown } | null, createdAt: Date, gate: AutoGateFacts): Hold | null {
  if (!refusal) return null
  const error = String(refusal.error ?? '')
  if (error === 'above_ceiling') return HOLDS.alwaysAsks(Array.isArray(refusal.blockedBy) ? refusal.blockedBy.map(String) : undefined)
  if (error === 'contested_by_rank_engine') return HOLDS.autoHourlyPlan()
  if (error === 'not_found') return null
  const failures = (Array.isArray(refusal.failures) ? refusal.failures : []).map(String)
  const failed = (id: string) => failures.some((f) => f === id || f.startsWith(`${id} `))
  const { need, have } = gate.evaluations
  if (failed('RULE_ENABLED')) return HOLDS.autoTurnOn()
  if (failed('OBSERVATION_WINDOW')) return HOLDS.autoFrom(shortDay(new Date(createdAt.getTime() + gate.observationDays * 86_400_000)), gate.observationDays, need)
  if (failed('HAS_EVALUATIONS')) return HOLDS.autoAfterRuns(Math.max(1, need - have), need)
  if (failed('HAS_MATCHES')) return HOLDS.autoNoMatch()
  if (failed('CONNECTION_PRODUCTION') || failed('WRITES_ENABLED')) return HOLDS.autoMarketNotLive()
  if (failed('LIVE_MODE_ENV')) return HOLDS.testMode()
  return HOLDS.autoNotAllowed()
}

// ── the sentence ────────────────────────────────────────────────────────────────────────────────────────────────────

const OP_WORD: Readonly<Record<string, string>> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' }
const PCT_METRICS = new Set(['ACOS', 'CTR', 'CVR'])
const MONEY_METRICS = new Set(['Spend', 'Sales', 'CPC', 'Current Bid'])
const METRIC_WORD: Readonly<Record<string, string>> = { ACOS: 'ACoS', ROAS: 'ROAS', 'PPC Orders': 'orders', 'Current Bid': 'bid' }

const plainNumber = (v: unknown) => String(v ?? '').trim().replace(',', '.')

function builderClause(c: { metric?: unknown; op?: unknown; value?: unknown }): string {
  const metric = String(c.metric ?? '')
  const word = METRIC_WORD[metric] ?? metric.toLowerCase()
  const value = plainNumber(c.value)
  const shown = PCT_METRICS.has(metric) ? `${value} %` : MONEY_METRICS.has(metric) ? `€${value}` : value
  return `${word} ${OP_WORD[String(c.op ?? '')] ?? String(c.op ?? '')} ${shown}`
}

function builderThen(a: { op?: unknown; value?: unknown } | undefined): string {
  const op = String(a?.op ?? '')
  const v = plainNumber(a?.value)
  switch (op) {
    case 'set': return `bid €${v}`
    case 'incPct': return `bid +${v} %`
    case 'decPct': return `bid −${v} %`
    case 'incAbs': case 'inc': return `bid +€${v}`
    case 'decAbs': case 'dec': return `bid −€${v}`
    case 'targetAcos': return `bid toward ${v} %`
    case 'curBidTargetAcos': return `bid toward ${v} %`
    case 'setCpc': return 'bid = CPC'
    case 'revPerClick': return 'bid = sales per click'
    case 'pauseTarget': return 'pause'
    case 'enableTarget': return 'unpause'
    default: return op ? `bid ${op} ${v}`.trim() : 'no action'
  }
}

const TRIGGER_WORD: Readonly<Record<string, string>> = {
  KEYWORD_HIGH_ACOS: 'ACoS ≥ 20 %',
  AD_TARGET_UNDERPERFORMING: 'keyword underperforms',
  KEYWORD_LOW_CTR: 'low CTR',
  KEYWORD_WASTED_SPEND: 'spend, no sales',
  KEYWORD_ZERO_IMPRESSIONS: 'no impressions',
  KEYWORD_SCALE_OPPORTUNITY: 'room to scale',
  KEYWORD_RISING_STAR: 'rising keyword',
  CVR_DROP: 'CVR drop',
  CAC_SPIKE: 'CAC spike',
  NEW_TO_BRAND_WINNER: 'new-to-brand winner',
  SOV_BID: 'share of voice',
  KEYWORD_RANK_BID: 'rank',
  SCHEDULE: 'on schedule',
  TARGET_PERFORMANCE: 'any clicked keyword',
}

const ENGINE_FIELD_WORD: Readonly<Record<string, string>> = {
  'adTarget.acos': 'ACoS', 'adTarget.clicks': 'clicks', 'adTarget.orders': 'orders', 'adTarget.spendCents': 'spend',
  'adTarget.salesCents': 'sales', 'adTarget.ctr': 'CTR', 'adTarget.cvr': 'CVR', 'adTarget.impressions': 'impressions',
}

function engineClause(c: { field?: unknown; op?: unknown; value?: unknown }): string {
  const field = String(c.field ?? '')
  const word = ENGINE_FIELD_WORD[field] ?? field.split('.').pop() ?? field
  const n = Number(c.value)
  const value = /acos|ctr|cvr/i.test(field) && Number.isFinite(n) && Math.abs(n) <= 5 ? `${Math.round(n * 1000) / 10} %`
    : /Cents$/.test(field) && Number.isFinite(n) ? `€${(n / 100).toFixed(2)}`
      : String(c.value ?? '')
  return `${word} ${OP_WORD[String(c.op ?? '')] ?? String(c.op ?? '')} ${value}`
}

function engineThen(a: Record<string, unknown> | undefined): string {
  const type = String(a?.type ?? '')
  const n = (key: string) => (a && a[key] != null && Number.isFinite(Number(a[key])) ? Number(a[key]) : null)
  switch (type) {
    case 'bid_down': return `bid −${Math.abs(n('percent') ?? n('bidDownPct') ?? 20)} %`
    case 'bid_up': return `bid +${Math.abs(n('percent') ?? n('bidUpPct') ?? 15)} %`
    case 'lower_bid_to_floor': return 'bid to floor'
    case 'raise_bids_for_rank_defense': return 'raise bids for rank'
    case 'bid_to_target_acos': {
      const t = n('targetAcos')
      return t == null ? 'bid toward goal' : `bid toward ${t <= 5 ? Math.round(t * 1000) / 10 : t} %`
    }
    case 'pause_target': return 'pause'
    case 'enable_target': return 'unpause'
    case 'bid_apply': return builderThen({ op: a?.op, value: a?.value })
    default: return type.replace(/_/g, ' ')
  }
}

/**
 * The rule in one line: "If ACoS > 20 % and clicks ≥ 10 over 14 d → bid −15 %". A builder rule reads its first block
 * (the engine checks blocks in order) and says "+N" for the others; an engine rule reads its conditions or, with none,
 * its trigger. Pure.
 */
export function ruleSentence(rule: { trigger?: string | null; conditions?: unknown; actions?: unknown }): string {
  const actions = (Array.isArray(rule.actions) ? rule.actions : []) as Array<Record<string, unknown>>
  const conds = Array.isArray(rule.conditions) ? rule.conditions as Array<Record<string, unknown>> : []
  const a0 = actions.find((a) => BID_RULE_ACTION_TYPES.has(String(a?.type ?? ''))) ?? actions[0]
  const builder = conds.length > 0 && !!conds[0] && typeof conds[0] === 'object' && 'conditions' in conds[0]
  if (builder) {
    const g = conds[0] as { conditions?: Array<Record<string, unknown>>; action?: { op?: unknown; value?: unknown } }
    const ifs = (g.conditions ?? []).map(builderClause).join(' and ')
    const days = typeof a0?.windowDays === 'number' ? a0.windowDays : 14
    const more = conds.length > 1 ? ` (+${conds.length - 1})` : ''
    return `${ifs ? `If ${ifs} over ${days} d` : `Every keyword, ${days} d`} → ${builderThen(g.action)}${more}`
  }
  const ifs = conds.map(engineClause).filter(Boolean).join(' and ')
  const when = ifs || TRIGGER_WORD[String(rule.trigger ?? '')] || String(rule.trigger ?? '').toLowerCase().replace(/_/g, ' ')
  return `If ${when} → ${engineThen(a0)}`
}

// ── the next run ────────────────────────────────────────────────────────────────────────────────────────────────────

const QUARTER = 15 * 60_000

/** The evaluator's next tick after `now` (cron `*\/15`). Pure. */
export function nextQuarter(now: Date): Date {
  return new Date((Math.floor(now.getTime() / QUARTER) + 1) * QUARTER)
}

/**
 * When the rule is next evaluated: the first 15-minute tick at which its stored schedule is due (ads-rule-schedule.ts,
 * the evaluator's own gate), searched up to 32 days ahead; an engine rule (no schedule) at the next tick. Pure.
 */
export function ruleNextRun(schedule: StoredRuleSchedule | null, lastEvaluatedAt: Date | null, now: Date): Date | null {
  let at = nextQuarter(now)
  if (!schedule) return at
  const end = now.getTime() + 32 * 86_400_000
  for (; at.getTime() <= end; at = new Date(at.getTime() + QUARTER)) {
    if (scheduleIsDue(schedule, lastEvaluatedAt, at)) return at
  }
  return null
}

/**
 * NEXT RUN — what the row says about when a rule runs, so the Overview and the Settings never disagree (audit S6):
 *
 *   nextRunAt   the true next run: the first 15-minute tick at which the evaluator's own gate (scheduleIsDue) lets it run
 *   firstRunAt  set only when that next run is the rule's FIRST (it has never run): the evaluator runs a new rule on the
 *               next tick whatever its schedule (ads-rule-schedule.ts), so the page says "First run 23:00", not a run
 *               at the schedule's time; the same instant as nextRunAt
 *   thenRunAt   with firstRunAt and a schedule: the run after the first, by the same gate (its half-day slack can put it
 *               later than the schedule's time on the day after: first 23:00 → then 11:00 → then daily 06:00)
 *   schedule    the schedule in words, in the zone the evaluator uses: "Daily · 06:00 · Rome", "Hourly", "Every 15 min"
 */
export interface RunTimes { nextRunAt: Date | null; firstRunAt: Date | null; thenRunAt: Date | null }

export function ruleRunTimes(schedule: StoredRuleSchedule | null, lastEvaluatedAt: Date | null, now: Date): RunTimes {
  const nextRunAt = ruleNextRun(schedule, lastEvaluatedAt, now)
  const firstRunAt = lastEvaluatedAt == null ? nextRunAt : null
  const thenRunAt = firstRunAt && schedule && scheduleIsTimed(schedule) ? ruleNextRun(schedule, firstRunAt, firstRunAt) : null
  return { nextRunAt, firstRunAt, thenRunAt }
}

/** Frequencies the evaluator runs at a time of day (ads-rule-schedule.ts intervalDays); Hourly and unknown ones are not. */
const TIMED = new Set(['Daily', 'Weekly', 'Monthly', 'Custom'])
const scheduleIsTimed = (s: StoredRuleSchedule) => TIMED.has(String(s.frequency ?? ''))
/**
 * The zone the evaluator reads a schedule's time in (ads-rule-schedule.ts TZ, unexported: keep the two in step; any other
 * key falls back to Rome there, so it says Rome here). pure.vitest.test.ts pins each against scheduleIsDue.
 */
const ZONE_WORD: Readonly<Record<string, string>> = { cet: 'Rome', utc: 'UTC', pst: 'Los Angeles', est: 'New York' }
export const EVERY_TICK_WORDS = 'Every 15 min'

/** The schedule in the page's words, as the evaluator runs it. Pure. */
export function scheduleWords(s: StoredRuleSchedule | null): string {
  if (!s) return EVERY_TICK_WORDS
  const f = String(s.frequency ?? '')
  if (f === 'Hourly') return 'Hourly'
  // An unknown frequency runs on every tick (the evaluator never stalls a rule).
  if (!scheduleIsTimed(s)) return EVERY_TICK_WORDS
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s.time ?? '00:00'))
  const time = m ? `${m[1].padStart(2, '0')}:${m[2]}` : '00:00'
  const zone = ZONE_WORD[String(s.timezone ?? '')] ?? 'Rome'
  let head = f
  if (f === 'Custom') {
    const n = Math.max(1, Math.round(Number(s.everyN)) || 1)
    const unit = String(s.interval ?? 'Days')
    const word = unit === 'Weeks' ? 'week' : unit === 'Months' ? 'month' : 'day'
    head = n === 1 ? `Every ${word}` : `Every ${n} ${word}s`
    // Only a Custom schedule in weeks honours its day (a Weekly one runs 7 days after the last run, whatever the day).
    if (unit === 'Weeks' && s.onDay) head = `${head} · ${String(s.onDay)}`
  }
  return [head, time, zone].join(' · ')
}

/** The bid brain's cadence in words: every tick while it runs campaigns live, else its four full runs a day. Pure. */
export const brainScheduleWords = (everyTick: boolean) => (everyTick ? EVERY_TICK_WORDS : 'Every 6 h')

/** The bid brain's next full run: the :45 tick of 00, 06, 12 and 18 UTC (jobs/ads-bid-brain.job.ts isFullSlot). Pure. */
export function brainNextFullRun(now: Date): Date {
  for (let at = nextQuarter(now); ; at = new Date(at.getTime() + QUARTER)) {
    if (at.getUTCMinutes() === 45 && at.getUTCHours() % 6 === 0) return at
  }
}

// ── the effect ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * EFFECT — before vs after, over the keywords a writer changed. The window method:
 *
 *   · the keywords: every target whose bid or state the writer changed (a write that landed or is still in flight) in the
 *     last EFFECT_LOOKBACK_DAYS days;
 *   · per keyword, its anchor is the UTC day of the writer's FIRST change in that span; the anchor day is in neither side
 *     (the bid changed during it);
 *   · after = the days from the anchor's next day through the newest settled day (today minus the attribution lag, 7
 *     days for Sponsored Products: ads-settled-window.ts), at most EFFECT_MAX_DAYS;
 *   · before = the same number of days right before the anchor day, so each keyword compares equal lengths;
 *   · a keyword with fewer than EFFECT_MIN_DAYS settled days after its anchor is left out and counted in `tooEarly`;
 *   · each side sums clicks, orders (7-day), spend and sales (7-day) over the kept keywords; ACoS = spend ÷ sales.
 *
 * Money (spend, sales, ACoS) is in the money keys (`spendCents`, `salesCents`, `acosPct`): hidden whole without the ad-spend
 * permission. One currency only: keywords in two currencies give no effect.
 *
 * No effect (null) when nothing changed: the same ACoS, spend and orders before and after at the precision the page shows
 * them (ACoS to 0.1 %, spend to the cent, whole orders) — "ACoS 5 → 5 %" is noise, not an effect (audit S8). Every keyword
 * too early is still an effect with `keywords: 0` and its `tooEarly` count (no sides to compare yet).
 */
export const EFFECT_LOOKBACK_DAYS = 30
const EFFECT_MAX_DAYS = 14
const EFFECT_MIN_DAYS = 3
const DAY = 86_400_000

export const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
export const dayKey = (d: Date) => d.toISOString().slice(0, 10)

export interface EffectWindow { targetId: string; beforeFrom: Date; beforeTo: Date; afterFrom: Date; afterTo: Date; days: number }

/** Each keyword's two equal windows, or null when its after side has too few settled days. Pure. */
export function effectWindows(firstChange: ReadonlyMap<string, Date>, settledThrough: Date): { windows: EffectWindow[]; tooEarly: number } {
  const windows: EffectWindow[] = []
  let tooEarly = 0
  const last = utcDay(settledThrough)
  for (const [targetId, at] of firstChange) {
    const anchor = utcDay(at)
    const afterFrom = new Date(anchor.getTime() + DAY)
    const days = Math.min(EFFECT_MAX_DAYS, Math.floor((last.getTime() - afterFrom.getTime()) / DAY) + 1)
    if (days < EFFECT_MIN_DAYS) { tooEarly++; continue }
    const afterTo = new Date(afterFrom.getTime() + (days - 1) * DAY)
    const beforeTo = new Date(anchor.getTime() - DAY)
    const beforeFrom = new Date(beforeTo.getTime() - (days - 1) * DAY)
    windows.push({ targetId, beforeFrom, beforeTo, afterFrom, afterTo, days })
  }
  return { windows, tooEarly }
}

export interface PerfDay { targetId: string; date: Date; clicks: number; orders: number; spendCents: number; salesCents: number; currency: string }
export interface EffectSide { clicks: number; orders: number; spendCents: number; salesCents: number; acosPct: number | null }
export interface Effect {
  /** The newest settled day the after side reaches (the method: EFFECT above). */
  window: { settledThrough: string }
  keywords: number
  tooEarly: number
  /** Keyword-days on each side (equal by construction). */
  days: number
  currency: string | null
  before: EffectSide
  after: EffectSide
}

const side = (): EffectSide => ({ clicks: 0, orders: 0, spendCents: 0, salesCents: 0, acosPct: null })
const acosOf = (s: EffectSide) => (s.salesCents > 0 ? Math.round((s.spendCents / s.salesCents) * 1000) / 10 : null)

/** True when the two sides read the same on the page: ACoS (0.1 %), spend (cents) and orders. Pure. */
export function effectUnchanged(before: EffectSide, after: EffectSide): boolean {
  return before.acosPct === after.acosPct && before.spendCents === after.spendCents && before.orders === after.orders
}

/** The effect over the kept keywords; null when it changed nothing in the lookback, the currencies differ, or both sides read the same. Pure. */
export function effectOf(windows: readonly EffectWindow[], tooEarly: number, perf: readonly PerfDay[], settledThrough: Date): Effect | null {
  const head = { settledThrough: dayKey(utcDay(settledThrough)) }
  // Every keyword it changed is too early to compare: no sides yet, but how many wait is said.
  if (!windows.length) return tooEarly > 0 ? { window: head, keywords: 0, tooEarly, days: 0, currency: null, before: side(), after: side() } : null
  const byTarget = new Map(windows.map((w) => [w.targetId, w]))
  const before = side()
  const after = side()
  const currencies = new Set<string>()
  for (const p of perf) {
    const w = byTarget.get(p.targetId)
    if (!w) continue
    const t = utcDay(p.date).getTime()
    const s = t >= w.beforeFrom.getTime() && t <= w.beforeTo.getTime() ? before : t >= w.afterFrom.getTime() && t <= w.afterTo.getTime() ? after : null
    if (!s) continue
    currencies.add(p.currency)
    s.clicks += p.clicks
    s.orders += p.orders
    s.spendCents += p.spendCents
    s.salesCents += p.salesCents
  }
  if (currencies.size > 1) return null
  before.acosPct = acosOf(before)
  after.acosPct = acosOf(after)
  if (effectUnchanged(before, after)) return null
  return { window: head, keywords: windows.length, tooEarly, days: windows.reduce((n, w) => n + w.days, 0), currency: [...currencies][0] ?? null, before, after }
}

// ── what one action's dry run would change ──────────────────────────────────────────────────────────────────────────

/** One change a dry run would make: a keyword's (or an ad group's default) bid, or a keyword's state. */
export interface PreviewMove {
  targetId: string | null
  adGroupId: string | null
  field: 'bid' | 'state'
  /** Bids in cents; null when the handler did not say the bid now (filled from the keyword by the caller). */
  fromCents?: number | null
  toCents?: number | null
  from?: string | null
  to?: string | null
}

/** What one action result of a dry run says it would do. */
export interface ActionOutcome {
  moves: PreviewMove[]
  /** Changes the handler counted without listing them (rank defense's targets, target ACoS beyond its sample). */
  counted: number
  /** Changes left to the bid brain (an input to it on its campaign, or a keyword the optimiser leaves to it). */
  brain: number
  refused: number
  /** Answers that do not depend on the context (an account-wide target ACoS run): counted once, whatever repeats it. */
  onceKey: string | null
}

/** "45¢ → 60¢" (bid_apply), "45→36 cents" (bid_down / bid_up). */
const MOVED = /(-?\d+(?:\.\d+)?)\s*(?:¢|cents)?\s*→\s*(-?\d+(?:\.\d+)?)/

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * One action result of a dry run, read by its own handler's shape (automation-action-handlers.ts, ads-bid-optimizer.service.ts,
 * bid-brain/rule-directives.ts). Every bid action type has its own:
 *
 *   bid_apply                   { adTargetId, wouldChange: '45¢ → 60¢' } · { skipped } · { noChange }
 *   bid_down / bid_up           { target: 'ad_target' | 'ad_group', id, wouldChange: '45→36 cents' }
 *   lower_bid_to_floor          { adTargetId, bidCents }                       (from = the keyword's bid now)
 *   raise_bids_for_rank_defense { targets, raisePct }                           (counted: no list)
 *   bid_to_target_acos          { wouldChange: n, sample: [{ targetId, currentBidCents, proposedBidCents }], brainOwned? }
 *   pause_target / enable_target{ adTargetId, wouldSet, from } · { noChange, status } · { skipped }
 *   any, on a brain campaign    { bidBrain: { directives, sample } }           (an input to the brain, BB-9)
 * Pure.
 */
export function actionOutcome(a: { type?: string; ok?: boolean; error?: string; output?: unknown }): ActionOutcome {
  const out: ActionOutcome = { moves: [], counted: 0, brain: 0, refused: 0, onceKey: null }
  const o = (a.output && typeof a.output === 'object' ? a.output : {}) as Record<string, unknown>
  if (a.ok === false) { out.refused = 1; return out }
  if (o.bidBrain != null && typeof o.bidBrain === 'object') { out.brain = 1; return out }
  if (o.skipped || o.noChange) {
    // Left to the brain: the bid brain's goal already in force (`bidBrain` words), an action it carries (rule-directives.ts
    // CARRIED_ACTIONS), or a lever a product's brain owns (brain/rule-skips.ts `brainSkip`).
    if (typeof o.bidBrain === 'string' || o.brainSkip != null || /bid brain/.test(String(o.skipped ?? ''))) out.brain = 1
    return out
  }
  const type = String(a.type ?? '')
  switch (type) {
    case 'bid_to_target_acos': {
      const sample = (Array.isArray(o.sample) ? o.sample : []) as Array<Record<string, unknown>>
      for (const p of sample) {
        const targetId = str(p.targetId)
        if (targetId) out.moves.push({ targetId, adGroupId: null, field: 'bid', fromCents: num(p.currentBidCents), toCents: num(p.proposedBidCents) })
      }
      const n = num(o.wouldChange) ?? sample.length
      out.counted = Math.max(0, n - out.moves.length)
      out.brain = num(o.brainOwned) ?? 0
      out.onceKey = `${type}:${n}:${sample.map((p) => String(p.targetId)).join(',')}`
      return out
    }
    case 'raise_bids_for_rank_defense': {
      out.counted = num(o.targets) ?? 0
      return out
    }
    case 'lower_bid_to_floor': {
      const targetId = str(o.adTargetId)
      if (targetId && num(o.bidCents) != null) out.moves.push({ targetId, adGroupId: null, field: 'bid', fromCents: null, toCents: num(o.bidCents) })
      return out
    }
    case 'pause_target':
    case 'enable_target': {
      const targetId = str(o.adTargetId)
      if (targetId && str(o.wouldSet)) out.moves.push({ targetId, adGroupId: null, field: 'state', from: str(o.from), to: str(o.wouldSet) })
      return out
    }
    default: {
      const m = MOVED.exec(String(o.wouldChange ?? ''))
      const adGroup = o.target === 'ad_group'
      const targetId = str(o.adTargetId) ?? (!adGroup ? str(o.id) : null)
      const adGroupId = adGroup ? str(o.id) : null
      if (!m || (!targetId && !adGroupId)) return out
      out.moves.push({ targetId, adGroupId, field: 'bid', fromCents: Math.round(Number(m[1])), toCents: Math.round(Number(m[2])) })
      return out
    }
  }
}
