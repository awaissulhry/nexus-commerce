/**
 * CR rebuild 6 — History in words: what automation did this week and change by change (was Activity), and what is
 * planned for the next 24 hours (was Foresight). Pure: the two views render these with the design system, and the
 * tests drive them directly.
 *
 * Two facts stay apart on purpose: what automation INTENDED (the field change) and whether Amazon TOOK it (delivery).
 * Rank hand-overs are commitments (the hour is known, each one is a bid write), so they get the timeline; engine runs
 * are opportunities (what they write depends on data that does not exist yet), so they get a cadence list only.
 */
import type { ActionImpact } from '@/design-system/grid/actions/registry'
import type { ChangeLine } from '@/design-system/grid'
import type { Tone } from '@/design-system/primitives'
import { LEVEL_WORD, isLevel, withoutServerNames } from './levelWords'

// ── the week (GET /api/advertising/digest/weekly?mode=current) ─────────────────────────────────────────

export interface DigestRule {
  ruleId: string; name: string; level: string
  acted: number; proposed: number; denied: number; applied: number; declined: number; failed: number
}
export interface Digest {
  window: { from: string; to: string; label: string; complete: boolean }
  gates: {
    cronFlag: string; cronEnabled: boolean; outboundFlag: string; outboundEnabled: boolean; state: 'off' | 'dry-run' | 'live'; explanation: string
    /** How many addresses a send goes to (absent from an older API). */
    recipientCount?: number
  }
  totals: { acted: number; proposed: number; denied: number; applied: number; declined: number; failed: number }
  rules: DigestRule[]
  effect: { budgetDeltaCents: number; budgetMoves: number; bidMoves: number; placementMoves: number; note: string }
  proposals: { pending: number; priced: number; spendAtStakeCents: number; recoverableCents: number }
  graduation: { ready: number; unseen: number; unreviewed: number; readyNames: string[]; unseenNames: string[] }
  breaker: {
    tripsThisWeek: Array<{ at: string; reason: string }>
    maxActionsPerHour: number
    maxHourlySpendCents: number
    spendThresholdIsDefault: boolean
    peakHourSpendCents: number
    peakHoursSampled: number
    tripNote: string
    spendNote: string
  }
  coverage: { marketplace: string; week: string | null; priorWeek: string | null; share: number | null; priorShare: number | null; deltaPct: number | null; terms: number; measured: boolean; note: string } | null
  delivery: { failedWrites: number; deadLetters: number }
}

export const eur = (cents: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100)
/** "€500" for a whole amount, "€18.90" otherwise — as Limits › Account brakes says the same limit. */
const eurShort = (cents: number) =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(cents / 100)
const count = (n: number) => n.toLocaleString('en-IE')

/** One tile of the week: words only, so the tests can read them. `tone` picks the tile's dot. */
export interface WeekTile { key: string; label: string; value: string; hint: string; tone: Tone }

/** The week's tiles, in the order a weekly reviewer reads them. Coverage and Failed show only when there is one. */
export function weekTiles(d: Digest): WeekTile[] {
  const t = d.totals
  const tiles: WeekTile[] = [
    { key: 'acted', label: 'Acted', value: count(t.acted), hint: `${count(t.proposed)} asked you first`, tone: 'info' },
    { key: 'decided', label: 'You decided', value: count(t.applied + t.denied), hint: `${count(t.applied)} applied · ${count(t.denied)} declined`, tone: 'neutral' },
    {
      key: 'budget', label: 'Daily budget moved',
      value: `${d.effect.budgetDeltaCents >= 0 ? '+' : '−'}${eur(Math.abs(d.effect.budgetDeltaCents))}`,
      hint: `over ${count(d.effect.budgetMoves)} ${d.effect.budgetMoves === 1 ? 'change' : 'changes'}`,
      tone: d.effect.budgetDeltaCents < 0 ? 'success' : 'neutral',
    },
    {
      key: 'suggestions', label: 'Rule suggestions waiting', value: count(d.proposals.pending),
      // What the number is: rule changes that wait for a person. The money is said only when there is some.
      hint: d.proposals.recoverableCents > 0
        ? `rule changes that wait for you · ${eur(d.proposals.recoverableCents)} spent with no sale on their keywords`
        : 'rule changes that wait for you',
      tone: d.proposals.recoverableCents > 0 ? 'warning' : 'neutral',
    },
  ]
  const c = d.coverage
  if (c && c.share != null) {
    tiles.push({
      key: 'coverage', label: `Coverage ${c.marketplace}`, value: `${(c.share * 100).toFixed(2)}%`,
      hint: c.deltaPct != null ? `${c.deltaPct >= 0 ? '+' : ''}${c.deltaPct.toFixed(2)} points against ${c.priorWeek}` : 'no week before it yet',
      tone: 'neutral',
    })
  }
  if (t.failed > 0) tiles.push({ key: 'failed', label: 'Failed', value: count(t.failed), hint: 'changes that did not go through', tone: 'danger' })
  return tiles
}

/** The engine refusing itself is not a failure and not the person's decision; said once, without a stale date. */
export function declinedNote(declined: number): string | null {
  if (declined <= 0) return null
  return `${count(declined)} ${declined === 1 ? 'run was' : 'runs were'} stopped by the engine’s own daily limit. That is the engine holding itself back — not a failure, and not your decision.`
}

/**
 * CR review (words #6) — the hourly spend limit the breaker uses, said as the number it is. The old banner said "Ad spend
 * has no hourly limit you set" while a default limit applies (Limits › Account brakes shows it in force). Null when the
 * person set their own limit: then there is nothing to point out.
 */
export function spendLimitWords(b: Digest['breaker']): { title: string; text: string } | null {
  if (!b.spendThresholdIsDefault) return null
  const peak = b.peakHoursSampled > 0 ? ` The highest hour this week was ${eurShort(b.peakHourSpendCents)}.` : ''
  return {
    title: `Ad spend limit: ${eurShort(b.maxHourlySpendCents)} an hour (the default)`,
    text: `You have not set your own. Change it in Limits › Account brakes.${peak}`,
  }
}

/** A rule's level from the digest, in the Control Room's one scale; an unknown value is shown as it came. */
export const ruleLevelWord = (level: string) => (isLevel(level) ? LEVEL_WORD[level] : level)

/**
 * The weekly e-mail, in words: its state, one sentence on what that means, and what Send now does in that state. One
 * name for it everywhere — "the weekly e-mail" (the server calls it the digest; that word stays under Technical details).
 */
export function digestState(g: Digest['gates']): { title: string; text: string; tone: Tone; sendWords: string } {
  if (g.state === 'live') {
    return { title: 'Weekly e-mail — on, sent every Monday', text: 'It goes every Monday to the recipients set on the server.', tone: 'success', sendWords: 'Send last week’s e-mail now…' }
  }
  if (g.state === 'dry-run') {
    return { title: 'Weekly e-mail — on, but nothing leaves Nexus', text: 'It is built every Monday, but outbound e-mail is off on the server, so nothing is mailed.', tone: 'warning', sendWords: 'Build last week’s e-mail now…' }
  }
  return {
    title: 'Weekly e-mail — not scheduled',
    text: 'Nothing is sent by itself. You can still preview last week’s e-mail, or build it now.',
    tone: 'neutral',
    sendWords: g.outboundEnabled ? 'Send last week’s e-mail now…' : 'Build last week’s e-mail now…',
  }
}

/**
 * The confirmation before Send now. With outbound e-mail on, it e-mails every recipient and an e-mail cannot be called
 * back, so it asks with the tick (the design system's rule for a change outside Nexus that cannot be fully put back).
 * With outbound e-mail off it only builds and logs the e-mail: a plain question. Before, it sent on the first click.
 */
export function digestSendImpact(g: Digest['gates']): ActionImpact {
  if (!g.outboundEnabled) {
    return {
      level: 'confirm',
      title: 'Build last week’s e-mail now?',
      confirmLabel: 'Build the e-mail',
      consequences: [
        'Outbound e-mail is off on the server, so nothing is mailed.',
        'Nexus builds the e-mail and keeps a record of it.',
      ],
    }
  }
  const n = g.recipientCount
  // No address on the server's list: nothing can be mailed, so it is a plain question about a send that will be refused.
  if (n === 0) {
    return {
      level: 'confirm',
      title: 'Send last week’s e-mail now?',
      confirmLabel: 'Try to send',
      consequences: ['No recipients are set on the server, so nothing is mailed. Nexus says why.'],
    }
  }
  const who = n == null ? 'every recipient on the server’s list' : n === 1 ? '1 person on the server’s list' : `${n} people on the server’s list`
  return {
    level: 'confirm',
    title: n == null ? 'Send last week’s e-mail to every recipient now?' : `Send last week’s e-mail to ${n === 1 ? '1 person' : `${n} people`} now?`,
    confirmLabel: 'Send the e-mail now',
    consequences: [
      `It e-mails last week’s ads summary to ${who}, now.`,
      'An e-mail cannot be called back.',
    ],
    reach: 'channel',
    reversal: { verb: 'Send a correction', fidelity: 'lossy' },
    acknowledge: `I understand it e-mails ${n == null ? 'every recipient' : who.replace(' on the server’s list', '')} now, and an e-mail cannot be called back.`,
  }
}

/** One row of "Changes to the controls" (GET /api/advertising/control-room/control-changes). */
export interface ControlChange {
  id: string
  at: string
  userId: string | null
  by: string
  kind: 'account-level' | 'stop' | 'start' | 'brakes' | 'rule-level' | 'automation-level' | 'engine-level' | 'campaign-allowed' | 'other'
  what: string
  from: string | null
  to: string | null
}

/** "Ask me → Auto", or only the new value when the old one was not recorded (a rule's level). */
export const controlChangeWords = (c: Pick<ControlChange, 'from' | 'to'>): string =>
  c.from && c.to ? `${c.from} → ${c.to}` : c.to ? `now ${c.to}` : '—'

/** What Send now did. A dry run is not a failure, and never reported as sent either. */
export function digestSendResult(body: { status?: string; reason?: string; recipients?: string[] } | null, httpStatus: number): { ok: boolean; text: string } {
  if (body?.status === 'SENT') return { ok: true, text: `Sent to ${(body.recipients ?? []).join(', ') || 'the recipients'}.` }
  if (body?.status === 'DRY_RUN') return { ok: true, text: 'Built and logged. Nothing was mailed, because outbound e-mail is off.' }
  return { ok: false, text: body?.reason ?? body?.status ?? `It could not be sent (${httpStatus}).` }
}

// ── what automation did (GET /api/advertising/changes?source=automation) ───────────────────────────────

export interface Change {
  id: string
  at: string
  actor: string | null
  source: string
  origin: { kind: string; id: string | null; name: string | null }
  entity: { type: string; id: string; name: string | null }
  campaign: { id: string; name: string | null } | null
  field: string
  oldValue: string | null
  newValue: string | null
  reason: string | null
  evidence: Record<string, unknown> | null
  delivery: { state: string; attempts: number; lastError: string | null } | null
  undoable: boolean
  undoActionLogId: string | null
  undoBlockedReason?: string
}

/** "dailyBudget" / "daily_budget" → "Daily budget". */
export function fieldWords(field: string): string {
  const s = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : field
}

/** Who or what made the change: the rule or engine's name, else the actor in words. */
export function whoMade(c: Change): string {
  if (c.origin.name) return c.origin.name
  const a = c.actor ?? ''
  if (a.startsWith('user:')) return 'A person'
  if (a.startsWith('automation:')) return fieldWords(a.slice('automation:'.length))
  return a ? fieldWords(a) : 'Nexus'
}

/** What the change was made on: its campaign, else the thing itself. */
export const changedOn = (c: Change) => c.campaign?.name ?? c.entity.name ?? fieldWords(c.entity.type)

/** The change as one before → after line for the design system's ChangeValue. */
export const changeLine = (c: Change): ChangeLine => ({ label: fieldWords(c.field), from: c.oldValue, to: c.newValue })

/** Whether Amazon took it. The state is the server's word; only its colour and case are decided here. */
export function deliveryWords(d: Change['delivery']): { label: string; tone: Tone } | null {
  if (!d) return null
  const s = d.state.toUpperCase()
  // The real states (OutboundSyncStatus and the change log): applied · success · pending · in_flight · failed ·
  // cancelled · superseded · skipped. A cancelled or superseded change never reached Amazon.
  const tone: Tone = /FAIL|DEAD|ERROR|REJECT/.test(s) ? 'danger'
    : /GATED|HELD|BLOCK|REFUS|SKIP|CANCEL|SUPERSED/.test(s) ? 'warning'
      : /PEND|QUEUE|RETRY|WAIT|SENDING|IN_FLIGHT|IN_PROGRESS/.test(s) ? 'info'
        : /SUCC|APPLIED|DONE|DELIVER|SENT|OK/.test(s) ? 'success' : 'neutral'
  return { label: fieldWords(d.state), tone }
}

/** The numbers behind the reason, in one line; a decision resting on under 7 days of data is marked thin. */
export function evidenceWords(e: Record<string, unknown> | null): { text: string; thin: boolean } | null {
  if (!e) return null
  const metric = typeof e.metric === 'string' ? e.metric : null
  const observed = typeof e.observed === 'number' ? e.observed : null
  const threshold = typeof e.threshold === 'number' ? e.threshold : null
  const sample = typeof e.sampleSize === 'number' ? e.sampleSize : null
  const unit = typeof e.sampleUnit === 'string' ? e.sampleUnit : 'rows'
  const target = typeof e.targetKey === 'string' ? e.targetKey : null
  if (!metric && observed == null && !target) return null
  const thin = sample != null && sample < 7 && unit === 'days'
  const parts = [
    target,
    metric ? `${metric}${observed != null ? ` ${observed}` : ''}${threshold != null ? ` against ${threshold}` : ''}` : null,
    sample != null ? `${sample} ${unit}${thin ? ' — thin' : ''}` : null,
  ].filter(Boolean)
  return { text: parts.join(' · '), thin }
}

export interface ChangeFilter { search: string; who: string }
export const ALL_MAKERS = 'all'

/** The makers in the list, for the "Made by" filter, sorted. */
export const makersOf = (rows: readonly Change[]) => [...new Set(rows.map(whoMade))].sort((a, b) => a.localeCompare(b))

/** Search reads the words the row shows. */
export function changeMatches(c: Change, f: ChangeFilter): boolean {
  if (f.who !== ALL_MAKERS && whoMade(c) !== f.who) return false
  const q = f.search.trim().toLowerCase()
  if (!q) return true
  return [whoMade(c), changedOn(c), fieldWords(c.field), c.oldValue ?? '', c.newValue ?? '', c.reason ?? '', c.delivery?.state ?? '']
    .some((t) => t.toLowerCase().includes(q))
}

/**
 * The confirmation before Undo. It writes to Amazon and runs as the person's own edit. The value it puts back is named,
 * so the decision is made on the number, not the verb. Before, the row asked with an inline Yes / Cancel.
 */
export function undoImpact(c: Change): ActionImpact {
  const where = changedOn(c)
  return {
    level: 'confirm',
    title: `Undo this change to ${fieldWords(c.field).toLowerCase()}?`,
    confirmLabel: 'Undo this change',
    consequences: [
      `${fieldWords(c.field)} on ${where} goes back to ${c.oldValue ?? 'its earlier value'}${c.newValue != null ? ` (now ${c.newValue})` : ''}.`,
      'This writes to Amazon. It runs as your own edit, like a change you make by hand.',
    ],
    reach: 'channel',
    reversal: { verb: 'Set the value again by hand', fidelity: 'exact' },
  }
}

/** What the undo did. "Nothing to undo" is the server's answer for a change that left nothing to put back. */
export function undoResult(httpOk: boolean, httpStatus: number, body: { ok?: boolean; reversed?: number; nothingToUndo?: boolean; reason?: string } | null): { ok: boolean; text: string } {
  const ok = httpOk && body?.ok !== false && (body?.reversed ?? 0) > 0
  if (ok) return { ok, text: 'Undone. The earlier value is on its way back to Amazon.' }
  return { ok, text: body?.reason ?? (body?.nothingToUndo ? 'Nothing to undo.' : `It could not be undone (${httpStatus}).`) }
}

// ── the next 24 hours (GET /api/advertising/control-room/foresight) ───────────────────────────────────

export interface ForesightHour {
  at: string
  hour: number
  bidChanges: number
  suppressed: number
  unbounded: number
  noCpcCeiling: number
  engineRuns: { key: string; name: string; fires: number }[]
  targets: { key: string; name: string; schedules: number }[]
}
export interface ForesightEngine {
  key: string; name: string; cron: string; cadence: string
  fires: number; nextFires: string[]; canWrite: boolean; blockedReason: string | null
}
export interface Foresight {
  generatedAt: string
  timezone: string
  scheduledBidChanges: number | null
  accountStopped: boolean
  accountStoppedReason: string | null
  schedulesConsidered: { total: number; enabled: number }
  hours: ForesightHour[]
  engines: ForesightEngine[]
  notes: string[]
}

export function hhmm(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz })
  } catch {
    return new Date(iso).toISOString().slice(11, 16)
  }
}

/**
 * The cadence in the SAME clock as the times beside it. The server says daily and weekly schedules in UTC; the next
 * times are in the account's time zone. For those the clock is taken from the first real run instead; an interval
 * ("every 15 min") carries no clock and stays as it is.
 */
export function cadenceIn(e: Pick<ForesightEngine, 'cadence' | 'nextFires'>, tz: string): string {
  const m = /^(daily|weekly, )(.*) UTC$/.exec(e.cadence)
  if (!m || e.nextFires.length === 0) return e.cadence
  return m[1] === 'daily' ? `daily ${hhmm(e.nextFires[0], tz)}` : `weekly, ${hhmm(e.nextFires[0], tz)}`
}

/** "Rome time" for Europe/Rome; "UTC" stays "UTC". The time zone's city, never a code a person has to read. */
export function zoneWords(tz: string): string {
  if (!tz || /^(UTC|Etc\/UTC|GMT)$/i.test(tz)) return 'UTC'
  const city = tz.split('/').pop()?.replace(/_/g, ' ')
  return city ? `${city} time` : tz
}

/** "from 2 of 5 schedules" / "No schedule is on". */
export function schedulesWords(c: Foresight['schedulesConsidered']): string {
  if (c.enabled === 0) return c.total === 0 ? 'No schedule is set up' : `No schedule is on (${c.total} set up)`
  return `from ${c.enabled} of ${c.total} ${c.total === 1 ? 'schedule' : 'schedules'}, the ones that are on`
}

/** The account facts Next 24 hours needs (the levers endpoint's `global`, passed from the page). */
export interface AccountHold { autonomy: string; halted: boolean; envKill: boolean }

/**
 * CR review (code #9) — whether the account holds automation, so nothing below changes the ads by itself: stopped, the
 * server's emergency switch, the level at Off — or the level at Ask me, where engines only record what they would
 * change. The server's `canWrite` reads the stop and Off but not Ask me; the top tile ("changes your ads by itself")
 * does, so this view says the same. Null when nothing holds it, or when the account could not be read.
 */
export function accountHoldWords(a: AccountHold | null | undefined, serverStopped: boolean): { title: string; text: string } | null {
  if (a?.envKill) return { title: 'The server stops all ads automation', text: 'Nothing below changes your ads. This is what the plans would do, not what will happen.' }
  if (a?.halted || serverStopped) return { title: 'Automation is stopped', text: 'Nothing below changes your ads until you press Start again. This is what the plans would do, not what will happen.' }
  if (a?.autonomy === 'OFF') return { title: 'The account level is Off', text: 'Nothing below changes your ads by itself. This is what the plans would do at Auto.' }
  if (a?.autonomy === 'SUGGEST') return { title: 'The account level is Ask me', text: 'Engines only record what they would change. Nothing below changes your ads by itself. This is what would happen at Auto.' }
  return null
}

/** Only the hours that hold a planned bid change; the first hour of the list is the hour running now. */
export const busyHours = (hours: readonly ForesightHour[]) => hours.filter((h) => h.bidChanges > 0)

/** What an hour's flags mean, in words; only the ones it has. */
export function hourFlags(h: ForesightHour): Array<{ label: string; tone: Tone; title: string }> {
  return [
    h.noCpcCeiling > 0 ? { label: `${h.noCpcCeiling} with no bid ceiling`, tone: 'warning' as Tone, title: `${h.noCpcCeiling} schedules run a mode with no bid ceiling in this hour` } : null,
    h.unbounded > 0 ? { label: `${h.unbounded} with no limit but Amazon’s`, tone: 'danger' as Tone, title: 'All-out with no bid ceiling: only Amazon’s own cap applies' } : null,
    h.suppressed > 0 ? { label: `${h.suppressed} at the lowest bid`, tone: 'neutral' as Tone, title: 'Bids held at about 2 cents. Ads keep serving; nothing pauses.' } : null,
  ].filter((f): f is { label: string; tone: Tone; title: string } => f !== null)
}

/**
 * One server note in plain words (ads-foresight.service.ts writes them for engineers: "tick", "suppression target",
 * "CPC ceiling", variable names). Known notes are said again; any other one loses its variable names. Null drops a
 * note this view already says in its own banner (the account stopped).
 */
export function plainNote(note: string): string | null {
  let m: RegExpExecArray | null
  if (/^Automation is stopped, so none of/.test(note)) return null
  if ((m = /^(\d+) of the next 24 hours run at least one schedule all-out with no CPC ceiling/.exec(note))) {
    return `In ${m[1]} of the next 24 hours, at least one schedule bids with no limit but Amazon’s own.`
  }
  if ((m = /^(\d+) of the next 24 hours are governed by a rank mode with no CPC ceiling/.exec(note))) {
    return `In ${m[1]} of the next 24 hours, a schedule has no bid ceiling. It keeps a target ACoS instead, so it limits the cost after the spend, not the price of a click.`
  }
  if ((m = /^(\d+) hours hold a suppression target/.exec(note))) {
    return `In ${m[1]} ${m[1] === '1' ? 'hour' : 'hours'}, a schedule holds bids at about 2 cents. The ads keep running; nothing pauses.`
  }
  if (/^No schedule is enabled/.test(note)) return 'No schedule is on, so no bid change is planned. The engines below still run on their own clock.'
  if ((m = /^(\d+) engines? will run but cannot write/.exec(note))) {
    return `${m[1]} ${m[1] === '1' ? 'engine runs' : 'engines run'} but cannot change your ads. The Engines list says why.`
  }
  return withoutServerNames(note, 'Some engines are held back by a server setting, so they cannot change your ads. See Technical details.')
}

/** The server's notes in plain words (deduplicated), and the raw sentences for Technical details. */
export function plainNotes(notes: readonly string[]): { plain: string[]; technical: string[] } {
  const plain = [...new Set(notes.map(plainNote).filter((n): n is string => !!n))]
  // Every raw note the plain list rewrote or left out is kept, word for word, for whoever needs it.
  const technical = [...new Set(notes.filter((n) => plainNote(n) !== n))]
  return { plain, technical }
}

/**
 * Whether an engine can change the ads by itself now, in plain words — the server's `canWrite`, held by the account
 * level too (`accountHoldWords`), so this and the top tile never disagree.
 */
export function engineCanWords(e: ForesightEngine, account?: AccountHold | null): { label: string; tone: Tone; why: string | null } {
  if (!e.canWrite) return { label: 'No', tone: 'neutral', why: withoutServerNames(e.blockedReason, 'The server keeps it off.') }
  if (account?.envKill || account?.halted) return { label: 'No', tone: 'neutral', why: 'Automation is stopped.' }
  if (account?.autonomy === 'OFF') return { label: 'No', tone: 'neutral', why: 'The account level is Off.' }
  if (account?.autonomy === 'SUGGEST') return { label: 'Only records', tone: 'neutral', why: 'The account level is Ask me, so it only records what it would change.' }
  return { label: 'Yes', tone: 'success', why: null }
}

/** How many engines can change the ads by themselves now (the same test as `engineCanWords`). */
export const enginesThatCan = (engines: readonly ForesightEngine[], account?: AccountHold | null) =>
  engines.filter((e) => engineCanWords(e, account).label === 'Yes').length
