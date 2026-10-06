/**
 * CR rebuild 3 (= ADS AUTONOMY AA-W2-5) — Claude's kinds of Amazon ad change as rows of Who acts, beside the engines and
 * rules, with the watch level and its report. Pure: the grid and the side panel render these; the tests drive them.
 *
 * A row is one Claude tool (the level is set per tool, GET /api/claude/trust); the tools are the ones the ads strategy
 * narrows (api ads-strategy/fields.ts CLAUDE_ACTION_TOOLS), in its order. The level words are the Control Room's one
 * scale, with Claude's two ways of asking kept apart: "Ask me" (a person approves in Nexus) and "Ask me + code" (the
 * person who asked types their authenticator code in Claude). Watch: Nexus checks the request as Auto would and records
 * what it would have done; a person still decides.
 */
import type { ActionImpact } from '@/design-system/grid/actions/registry'
import type { Autonomy, ClaudeRule, ClaudeRules, ClaudeTrust } from '@/app/settings/ai/claude/claudeWords'
import type { WatchKind, WatchSummary } from '@nexus/shared/approval-queue'
import type { ActorRow, NowBucket } from './whoActs'
import type { Level } from './levelWords'

/**
 * The Amazon ad tools Claude may use, in the strategy's kind order: the name the Control Room shows (the server's titles
 * carry jargon — "Allow live writes to a campaign", "Restore a suppressed campaign") and the kind each belongs to.
 * "Let automation change a campaign" is the same switch the Campaigns tab calls "Automation may change it".
 */
export const CLAUDE_AD_TOOLS: ReadonlyArray<{ tool: string; name: string; kind: string }> = [
  { tool: 'set-target-bid', name: 'Change one bid', kind: 'Bids' },
  { tool: 'bulk-ad-bid-change', name: 'Change many bids', kind: 'Bids' },
  { tool: 'create-negative-keyword', name: 'Block a search term', kind: 'Negative keywords' },
  { tool: 'graduate-keyword', name: 'Add a search term as a keyword', kind: 'New keywords from search terms' },
  { tool: 'set-placement-multipliers', name: 'Change placement adjustments', kind: 'Placement adjustments' },
  { tool: 'set-campaign-budget', name: 'Change a campaign budget', kind: 'Budgets' },
  { tool: 'set-campaign-target-acos', name: 'Set a campaign’s target ACoS', kind: 'Campaign target ACoS' },
  { tool: 'decide-automation-suggestions', name: 'Accept or decline rule suggestions', kind: 'Rule suggestions' },
  { tool: 'suppress-campaign', name: 'Stop a campaign with low bids', kind: 'Stopping a campaign (low bids)' },
  { tool: 'restore-campaign', name: 'Restart a stopped campaign', kind: 'Restoring a campaign’s bids' },
  { tool: 'create-ad-campaign', name: 'Create a campaign', kind: 'New campaigns' },
  { tool: 'set-campaign-live-writes', name: 'Let automation change a campaign', kind: 'Letting automation change its own new campaigns' },
  { tool: 'save-ad-rule', name: 'Save an ads rule', kind: 'Ads rules' },
  { tool: 'turn-up-automation', name: 'Raise an automation’s level', kind: 'Raising or tuning an automation' },
  { tool: 'tune-ad-engine', name: 'Tune an engine setting', kind: 'Raising or tuning an automation' },
  { tool: 'undo-ad-change', name: 'Undo an ad change', kind: 'Undoing ad changes' },
  // AA-W2-12 / AA-W2-13 — a real pause (a restart takes about an hour; a temporary stop is low bids) and archive (for good).
  { tool: 'pause-ads', name: 'Pause ads', kind: 'Pausing ads' },
  { tool: 'enable-ads', name: 'Turn paused ads back on', kind: 'Turning paused ads back on' },
  { tool: 'archive-ads', name: 'Archive ads (for good)', kind: 'Archiving ads (for good)' },
]
const ORDER = new Map(CLAUDE_AD_TOOLS.map((t, i) => [t.tool, i]))
const KIND = new Map(CLAUDE_AD_TOOLS.map((t) => [t.tool, t.kind]))
const NAME = new Map(CLAUDE_AD_TOOLS.map((t) => [t.tool, t.name]))
/** The name the Control Room shows for a Claude tool; the server's title for a tool it does not know. */
export const claudeName = (rule: Pick<ClaudeRule, 'name' | 'title'>) => NAME.get(rule.name) ?? rule.title

/**
 * Claude's levels on the Control Room's scale. Claude's "watch" is NOT the Watch of engines and rules (they record and
 * change nothing, and nobody is asked): Claude asked for a change, so a person still decides it — and Nexus also records
 * whether Auto would have run it. So it is a kind of Ask me: "Ask me + watch".
 */
export const CLAUDE_WORD: Record<ClaudeTrust, string> = { off: 'Off', ask: 'Ask me', confirm: 'Ask me + code', watch: 'Ask me + watch', auto: 'Auto' }

export const CLAUDE_MEANS: Record<ClaudeTrust, string> = {
  off: 'Not offered to Claude.',
  ask: 'A person approves each change in Nexus.',
  confirm: 'The person who asked types their authenticator code in Claude.',
  watch: 'A person approves each change. Nexus also records whether Auto would have run it.',
  auto: 'Runs by your rule, inside its limits and the ads strategy.',
}

/** A Claude level on the one scale: which top tile counts it. Every level that asks a person is "Ask me". */
const SCALE: Record<ClaudeTrust, { inForce: Level; bucket: NowBucket }> = {
  off: { inForce: 'OFF', bucket: 'quiet' },
  ask: { inForce: 'PROPOSE', bucket: 'asks' },
  confirm: { inForce: 'PROPOSE', bucket: 'asks' },
  watch: { inForce: 'PROPOSE', bucket: 'asks' },
  auto: { inForce: 'AUTO', bucket: 'alone' },
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The watch week in one line: "12 would run alone · 2 outside your limits". */
export function watchWeek(kind: WatchKind | undefined): string | null {
  if (!kind) return null
  const total = kind.wouldRun.changes + kind.outside.changes
  if (total === 0) return 'Nothing asked while watched'
  return `${kind.wouldRun.changes} would run alone · ${kind.outside.changes} outside your limits`
}

/** The account's own brakes, as far as they hold Claude's changes by rule (the write gate refuses a change that is not a person's own while stopped; at Off it lets only lowering through). */
export interface ClaudeAccount { autonomy: string; halted: boolean; envKill: boolean }

/** Why Claude's changes by rule cannot run now, or null when they can. */
function heldBy(paused: boolean, g: ClaudeAccount | null): string | null {
  if (g?.envKill) return 'The server stops all ads automation, so a person decides each change'
  if (g?.halted) return 'Ads automation is stopped, so a person decides each change'
  if (g?.autonomy === 'OFF') return 'The account level is Off, so a person decides each change (only lowering bids may run alone)'
  if (paused) return 'Claude’s changes by rule are paused, so a person decides each change'
  return null
}

export function claudeRow(rule: ClaudeRule, autonomy: Autonomy | boolean, watch: WatchKind | undefined, g: ClaudeAccount | null = null): ActorRow {
  const level = rule.level
  const paused = typeof autonomy === 'boolean' ? autonomy : autonomy.paused
  const held = level === 'auto' ? heldBy(paused, g) : null
  const scale = held ? { inForce: 'PROPOSE' as const, bucket: 'asks' as const } : SCALE[level]
  return {
    id: `claude:${rule.name}`,
    kind: 'claude',
    name: claudeName(rule),
    what: KIND.get(rule.name) ?? rule.title,
    market: null,
    setTo: CLAUDE_WORD[level],
    inForce: scale.inForce,
    inForceWord: held ? 'Ask me' : CLAUDE_WORD[level],
    why: held ?? CLAUDE_MEANS[level].replace(/\.$/, ''),
    bucket: scale.bucket,
    lastRunAt: null,
    week: watchWeek(watch) ?? '—',
    problem: rule.limitsInvalid ? `Its limits cannot be read: ${rule.limitsInvalid}` : null,
    order: { alone: 0, asks: 1, quiet: 2 }[scale.bucket],
    claude: { rule, watch, ...(typeof autonomy === 'boolean' ? {} : { autonomy }) },
  }
}

/** Claude's ad tools from the business's rules, in the strategy's order; tools the server does not list are left out. */
export function claudeRows(rules: ClaudeRules | null, watch: WatchSummary | null, g: ClaudeAccount | null = null): ActorRow[] {
  if (!rules) return []
  const byTool = new Map((watch?.kinds ?? []).map((k) => [k.tool, k]))
  return rules.tools
    .filter((t) => ORDER.has(t.name))
    .sort((a, b) => (ORDER.get(a.name) ?? 0) - (ORDER.get(b.name) ?? 0))
    .map((t) => claudeRow(t, rules.autonomy, byTool.get(t.name), g))
}

/** The code dialog's title and sentence for a raise, in the Control Room's words (Settings › AI › Claude has its own). */
export function claudeRaiseText(rule: Pick<ClaudeRule, 'name' | 'title'>, to: ClaudeTrust): { title: string; sentence: string; confirmLabel: string } {
  const name = `“${claudeName(rule)}”`
  const sentence = to === 'auto'
    ? `Claude may then make ${name} changes by your rule, inside their limits and the ads strategy, without a person approving each one. Each one can still be stopped in its undo time.`
    : to === 'watch'
      ? `A person still approves each ${name} change. Nexus also records whether Auto would have run it, so you can compare before you choose Auto.`
      : to === 'confirm'
        ? `The person who asks Claude for a ${name} change approves it with their authenticator code in Claude.`
        : `Claude may then ask for ${name} changes. A person approves each one in Nexus.`
  return { title: `Raise ${name} to ${CLAUDE_WORD[to]}`, sentence, confirmLabel: `Raise to ${CLAUDE_WORD[to]}` }
}

/** What a tool can reach, and whether it can be undone, in plain words (Settings' `toolReach` says it in one phrase). */
export function claudeReachWords(rule: Pick<ClaudeRule, 'openWorld' | 'readOnly' | 'reversibility'>): { reach: string; undo: string } {
  return {
    reach: rule.readOnly ? 'Nothing — it only reads' : rule.openWorld ? 'Your Amazon ads' : 'Nexus only',
    undo: rule.reversibility === 'full' ? 'Yes' : rule.reversibility === 'partial' ? 'In part' : rule.reversibility === 'none' ? 'No' : '—',
  }
}

/** A tool's limits at Auto as labelled rows: the first clause of each limit's description, its number, the rest as a hint. */
export function claudeLimitRows(fields: ReadonlyArray<{ label: string; value: string }>): Array<{ label: string; value: string; hint?: string }> {
  return fields.map((f) => {
    const [head, ...rest] = f.label.split(/;\s*/)
    const label = head.trim().replace(/^./, (c) => c.toUpperCase()).replace(/\bclaude\b/g, 'Claude')
    return { label, value: f.value === '' ? 'Not set' : f.value, ...(rest.length ? { hint: rest.join('; ').replace(/^./, (c) => c.toUpperCase()) } : {}) }
  })
}

/** The levels this tool may take, lowest first, in the one scale's words; the server's `levels` are the allowed ones. */
export function claudeLevelOptions(rule: ClaudeRule): Array<{ value: ClaudeTrust; label: string }> {
  return rule.levels.map((level) => ({ value: level, label: CLAUDE_WORD[level] }))
}

const RANK: readonly ClaudeTrust[] = ['off', 'ask', 'confirm', 'watch', 'auto']
/** A raise lets Claude do more without a person: it needs a fresh authenticator code (the server checks it too). */
export const claudeRaises = (from: ClaudeTrust, to: ClaudeTrust) => RANK.indexOf(to) > RANK.indexOf(from)

/** The watch report of one kind, as the side panel says it. Null when the kind was never watched in the window. */
export function watchReport(kind: WatchKind | undefined, now = Date.now()): {
  since: string | null
  lines: Array<{ label: string; value: string }>
  reasons: Array<{ why: string; count: number }>
} | null {
  if (!kind) return null
  const w = kind.wouldRun
  const o = kind.outside
  const days = kind.watchingSince ? Math.max(0, Math.floor((now - new Date(kind.watchingSince).getTime()) / 86_400_000)) : null
  const decided = (t: typeof w) => [
    t.approved ? `${t.approved} approved` : null,
    t.rejected ? `${t.rejected} rejected` : null,
    t.expired ? `${t.expired} expired` : null,
    t.replaced ? `${t.replaced} edited` : null,
    t.waiting ? `${t.waiting} waiting` : null,
  ].filter(Boolean).join(' · ') || 'none decided yet'
  return {
    since: kind.watchingSince
      ? `Watching since ${new Date(kind.watchingSince).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}${days != null ? ` (${plural(days, 'day')})` : ''}`
      : null,
    lines: [
      { label: 'Requests watched', value: String(w.changes + o.changes) },
      { label: 'Would have run alone', value: `${w.changes} — of those: ${decided(w)}` },
      { label: 'Outside your limits', value: `${o.changes} — of those: ${decided(o)}` },
    ],
    reasons: o.topReasons,
  }
}

/** The plain question before a lower level (no code: a brake is easy). */
export function claudeLowerImpact(title: string, from: ClaudeTrust, to: ClaudeTrust): ActionImpact {
  return {
    level: 'confirm',
    title: `Lower “${title}” to ${CLAUDE_WORD[to]}?`,
    consequences: [
      `Claude’s “${title}” changes go from ${CLAUDE_WORD[from]} to ${CLAUDE_WORD[to]}, for new requests.`,
      CLAUDE_MEANS[to],
    ],
    reach: 'local',
    reversal: { verb: 'Raise it again (with your code)', fidelity: 'exact' },
    confirmLabel: `Lower to ${CLAUDE_WORD[to]}`,
  }
}

/** The plain question before Pause: a brake, so no code (Resume asks for one). */
export function claudePauseImpact(): ActionImpact {
  return {
    level: 'confirm',
    title: 'Pause Claude’s changes by rule?',
    consequences: [
      'Every change Claude asks for waits for a person — in ads and in every other part of Nexus.',
      'Changes that wait for their undo time go back to a person.',
    ],
    reach: 'local',
    reversal: { verb: 'Resume (with your code)', fidelity: 'exact' },
    confirmLabel: 'Pause',
  }
}
