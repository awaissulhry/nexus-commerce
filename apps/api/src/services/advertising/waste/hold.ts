/**
 * Negative Targeting page (2026-10-11, lane NWRITE; PLAN D2) — "kept paused": a real lock on one keyword or product
 * target.
 *
 * The Owner's job: a keyword of ours that spends with no sales is paused AND STAYS paused. Before this nothing held a
 * pause: a person's click, Claude's enable-ads, a rule's enable_target, a bulk-sheet rollback, a budget-manager commit or
 * a Seller Central edit could switch it back on, and nobody was told.
 *
 *   the hold   four columns on AdTarget (keptPausedAt, keptPausedBy, keptPausedUntil, keptPausedReason). It holds while
 *              keptPausedAt is set and keptPausedUntil is null (always) or later than now.
 *   the lock   ONE place: ads-mutation.service.ts updateAdTargetWithSync asks `keptPausedRefusal` before it judges or
 *              writes anything. A write that switches a held target on (PAUSED → ENABLED) is refused for every writer —
 *              a rule, an engine, the brain, Claude by rule, a playbook sync, a bulk-sheet rollback, a person's plain
 *              click — and recorded like a gate refusal (AdWriteRefusal, deniedAt `kept_paused`). Only a PERSON with an
 *              explicit release (`releaseKeptPaused`) passes: enable-ads with releaseKeepPaused approved by a person, the
 *              page's Turn on…, or the Undo of the very pause that set the hold. The release ends the hold.
 *   set by     pause-ads with keepPaused (Claude, and the page's Pause), the rule action pause_target, and the page.
 *              An already paused target gets the hold alone (Nexus only).
 *   Amazon     a held target Amazon reports ENABLED (switched on in Seller Central) keeps its hold columns; its status
 *              follows Amazon (it does spend), so "status ENABLED + hold" reads TURNED_ON_ELSEWHERE, and the sync opens an
 *              AdDrift EXTERNAL_CHANGE row and notifies (ads-keyword-list-sync.service.ts). Never a silent flip. A pause
 *              that never reached Amazon (refused at dispatch) ends its hold instead: there was nothing to keep.
 *
 * The history: every hold set or ended writes a Nexus-only AdvertisingActionLog row (`keep_paused`,
 * `release_kept_paused`, `kept_paused_ended`; amazonResponseStatus SKIPPED: nothing was sent), on the change set of the
 * request that did it. A refused turn-on is an AdWriteRefusal row.
 *
 * Pure helpers first (unit-tested in hold.vitest.test.ts); the database writes after. No import of ads-mutation.service
 * here: that file imports this one.
 */
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { logGateDeny, type GateDeniedAt } from '../ads-write-gate.js'

/** The refusal's mark in AdWriteRefusal.deniedAt (one of GateDeniedAt). */
export const KEPT_PAUSED_DENIED_AT: GateDeniedAt = 'kept_paused'

/** The Nexus-only action-log rows of the hold (history: kept · released · ended). */
export const HOLD_ACTIONS = { kept: 'keep_paused', released: 'release_kept_paused', ended: 'kept_paused_ended', refused: 'kept_paused_refused' } as const
export type HoldAction = (typeof HOLD_ACTIONS)[keyof typeof HOLD_ACTIONS]

/** The hold's columns, for a Prisma select. */
export const HOLD_SELECT = { keptPausedAt: true, keptPausedBy: true, keptPausedUntil: true, keptPausedReason: true } as const

export interface HoldColumns {
  keptPausedAt: Date | null
  keptPausedBy: string | null
  keptPausedUntil: Date | null
  keptPausedReason: string | null
}

/** The columns that end a hold. */
export const NO_HOLD: HoldColumns = { keptPausedAt: null, keptPausedBy: null, keptPausedUntil: null, keptPausedReason: null }

/** A hold as the reads and the page show it. */
export interface KeptPaused { at: Date; by: string; until: Date | null; reason: string | null }

/** What a writer asks for when it keeps a target paused: until when (null: always) and why. */
export interface KeepPausedAsk { until?: Date | null; reason?: string | null }

/** Rome times and days, as the Owner reads them ("5 Oct, 00:42", "10 Nov"). */
const ROME_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const ROME_DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', day: 'numeric', month: 'short' })
export const romeTime = (d: Date) => ROME_TIME.format(d)
export const romeDay = (d: Date) => ROME_DAY.format(d)
/** Plain names for actors (actorNames): a person's name, a rule's name, the Brain. Absent: the plain fallback. */
export type ActorNames = ReadonlyMap<string, string>

/** The hold, when it holds now (set, and not past its end); null otherwise. Pure. */
export function holdOf(h: Partial<HoldColumns> | null | undefined, now: Date = new Date()): KeptPaused | null {
  if (!h?.keptPausedAt) return null
  const until = h.keptPausedUntil ?? null
  if (until && until.getTime() <= now.getTime()) return null
  return { at: h.keptPausedAt, by: h.keptPausedBy ?? 'unknown', until, reason: h.keptPausedReason ?? null }
}

/** Does the hold hold now? Pure. */
export const holdActive = (h: Partial<HoldColumns> | null | undefined, now: Date = new Date()): boolean => holdOf(h, now) != null

/**
 * The state a target reads in (pure): KEPT_PAUSED (held, paused), TURNED_ON_ELSEWHERE (held, but Amazon serves it —
 * someone switched it on outside Nexus), PAUSED, RUNNING, ARCHIVED. A negative is never held.
 */
export function holdStateOf(row: Partial<HoldColumns> & { status: string; isNegative?: boolean | null }, now: Date = new Date()):
  'KEPT_PAUSED' | 'TURNED_ON_ELSEWHERE' | 'PAUSED' | 'RUNNING' | 'ARCHIVED' {
  const status = String(row.status)
  if (status === 'ARCHIVED') return 'ARCHIVED'
  const held = row.isNegative !== true && holdActive(row, now)
  if (held) return status === 'ENABLED' ? 'TURNED_ON_ELSEWHERE' : 'KEPT_PAUSED'
  return status === 'ENABLED' ? 'RUNNING' : 'PAUSED'
}

/**
 * Who holds it, in plain words (pure): "You" for the person asking, a person's or a rule's name when known (actorNames),
 * "the Brain"; else "a person" / "a rule" — never a raw id.
 */
export function holderWords(actor: string | null | undefined, names?: ActorNames, viewer?: string | null): string {
  const a = (actor ?? '').trim()
  if (!a || a === 'unknown') return 'someone Nexus did not record'
  if (viewer && a === viewer) return 'You'
  if (a.startsWith('automation:ads-brain')) return 'the Brain'
  const named = names?.get(a)
  if (named) return a.startsWith('automation:') ? `the rule "${named}"` : named
  if (a.startsWith('user:')) return 'a person'
  if (a.startsWith('automation:')) return 'a rule'
  return 'someone Nexus did not record'
}

/** "kept paused by You since 5 Oct, 00:42 (Always · why)". Pure. */
export function holdWords(h: KeptPaused, names?: ActorNames, viewer?: string | null): string {
  return `kept paused by ${holderWords(h.by, names, viewer)} since ${romeTime(h.at)} (${h.until ? `until ${romeDay(h.until)}` : 'Always'}${h.reason ? ` · ${h.reason}` : ''})`
}

/** Plain names for these actors: a person's name (UserProfile), a rule's name (AutomationRule). Never throws. */
export async function actorNames(actors: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const list = [...new Set(actors.filter((a): a is string => !!a))]
  const users = list.filter((a) => a.startsWith('user:')).map((a) => a.slice(5))
  const rules = list.filter((a) => a.startsWith('automation:') && !a.startsWith('automation:ads-brain')).map((a) => a.slice(11))
  try {
    if (users.length) for (const u of await prisma.userProfile.findMany({ where: { id: { in: users } }, select: { id: true, displayName: true, email: true } })) out.set(`user:${u.id}`, u.displayName?.trim() || u.email)
    if (rules.length) for (const r of await prisma.automationRule.findMany({ where: { id: { in: rules } }, select: { id: true, name: true } })) out.set(`automation:${r.id}`, r.name)
  } catch (error) {
    logger.warn('[kept-paused] names not read', { error: (error as Error).message })
  }
  return out
}

/**
 * THE LOCK (pure) — why a write that switches this target on is refused, or null when it may go. Only a turn-on is
 * judged (PAUSED → ENABLED): a pause, an archive, a bid and a negative's retire pass. A held target passes only for a
 * PERSON (the mutation layer's isPersonEdit: a `user:` actor with the route's or the approval's person mark) who
 * releases it in so many words. Everyone else — a rule, an engine, the brain, Claude by rule, a sync, a rollback, a
 * person's plain click — is refused, by name.
 */
export function keptPausedRefusal(args: {
  hold: Partial<HoldColumns> | null | undefined
  isNegative?: boolean | null
  fromStatus: string | null | undefined
  toStatus: string | null | undefined
  /** isPersonEdit(manual, actor): a person's own write, or a request a person approved. */
  person: boolean
  /** The explicit release (`releaseKeptPaused`): honoured for a person only. */
  release: boolean
  actor?: string | null
  /** Plain names for the holder and the writer (actorNames); absent: "a person", "a rule". */
  names?: ActorNames
  now?: Date
}): string | null {
  if (args.toStatus !== 'ENABLED' || String(args.fromStatus ?? '') === 'ENABLED' || args.isNegative === true) return null
  const h = holdOf(args.hold, args.now ?? new Date())
  if (!h) return null
  if (args.person && args.release) return null
  return keptPausedSentence(h, args, args.names)
}

/**
 * The lock's refusal in plain words (pure; review M8): "Kept paused by You since 5 Oct, 00:42 (Always · why).", then what
 * this writer may do — a person: turn it on from Negative Targeting, or confirm the release; anyone else: only a person
 * can. Names from actorNames (absent: "a person", "a rule"); Rome times; no ids, no tool names.
 */
export function keptPausedSentence(h: KeptPaused, args: { person: boolean; release: boolean; actor?: string | null }, names?: ActorNames): string {
  const head = `Kept paused by ${holderWords(h.by, names, args.person ? args.actor : null)} since ${romeTime(h.at)} (${h.until ? `until ${romeDay(h.until)}` : 'Always'}${h.reason ? ` · ${h.reason}` : ''}).`
  const writer = writerWords(args.actor, names)
  const why = args.person
    ? ' Turning it on lets it spend: turn it on from Negative Targeting, or confirm the release.'
    : args.release
      ? ` ${writer} cannot release it: only a person can.`
      : ` ${writer} may not turn it on: only a person can, from Negative Targeting.`
  return `${head}${why} Nothing was sent.`
}

/** The writer a refusal names, in plain words (pure). */
function writerWords(actor: string | null | undefined, names?: ActorNames): string {
  const a = (actor ?? '').trim()
  if (a.startsWith('automation:ads-brain')) return 'The Brain'
  const named = names?.get(a)
  if (named && a.startsWith('automation:')) return `The rule "${named}"`
  if (a.startsWith('automation:')) return 'An automatic change'
  return 'This change'
}

/** The columns a new hold writes. Pure. */
export function holdData(actor: string, ask: KeepPausedAsk, now: Date = new Date()): HoldColumns {
  const reason = ask.reason?.trim() ? ask.reason.trim().slice(0, 500) : null
  return { keptPausedAt: now, keptPausedBy: actor, keptPausedUntil: ask.until ?? null, keptPausedReason: reason }
}

/** A hold's `until` from a request: null = always; a past or unreadable date is refused. Pure. */
export function keepUntilOf(value: unknown, now: Date = new Date()): { until: Date | null } | { refusal: string } {
  if (value == null || value === '') return { until: null }
  const d = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(d.getTime())) return { refusal: `keepUntil "${String(value)}" is not a date (use an ISO date, e.g. 2026-12-31, or null for always)` }
  if (d.getTime() <= now.getTime()) return { refusal: `keepUntil ${d.toISOString().slice(0, 10)} is not in the future` }
  return { until: d }
}

const holdJson = (h: Partial<HoldColumns> | null | undefined) => (h?.keptPausedAt
  ? { keptPausedAt: h.keptPausedAt.toISOString(), keptPausedBy: h.keptPausedBy ?? null, keptPausedUntil: h.keptPausedUntil?.toISOString() ?? null, keptPausedReason: h.keptPausedReason ?? null }
  : { keptPausedAt: null })

// ── Writes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A refused turn-on, recorded like a gate refusal: the `[ADS-WRITE-GATE-DENY]` log line and an AdWriteRefusal row
 * (queueId null: refused before anything was queued). Never throws.
 */
export async function logKeptPausedRefusal(ctx: { marketplace: string | null | undefined; campaignId: string | null | undefined; targetId: string; actor?: string | null; changeSetId?: string | null }, reason: string): Promise<void> {
  try {
    logGateDeny(
      { queueId: null, marketplace: ctx.marketplace ?? null, payloadValueCents: 0, campaignId: ctx.campaignId ?? null, entityType: 'AD_TARGET', entityId: ctx.targetId },
      reason,
      KEPT_PAUSED_DENIED_AT,
    )
  } catch (error) {
    logger.warn('[kept-paused] refusal record failed', { targetId: ctx.targetId, error: (error as Error).message })
  }
  // Review S15 — who was refused: AdWriteRefusal names no actor, so the refusal is also a Nexus-only history row of the
  // writer (`kept_paused_refused`, SKIPPED): the History reads "refused · You" (or the rule, the Brain), never "Unknown".
  if (ctx.actor) await recordHoldChange({ targetId: ctx.targetId, action: HOLD_ACTIONS.refused, actor: ctx.actor, before: null, after: null, changeSetId: ctx.changeSetId ?? null, why: reason })
}

/**
 * The Nexus-only history row of a hold set, released or ended (nothing is sent to Amazon: SKIPPED), on the change set of
 * the request that did it. Returns its id; a failure is logged, never thrown (the hold itself is written already).
 */
export async function recordHoldChange(args: {
  targetId: string
  action: HoldAction
  actor: string
  before: Partial<HoldColumns> | null
  after: Partial<HoldColumns> | null
  changeSetId?: string | null
  why?: string | null
}): Promise<string | null> {
  try {
    const row = await prisma.advertisingActionLog.create({
      data: {
        executionId: args.changeSetId ?? null,
        userId: args.actor,
        actionType: args.action,
        entityType: 'AD_TARGET',
        entityId: args.targetId,
        payloadBefore: holdJson(args.before) as never,
        payloadAfter: holdJson(args.after) as never,
        amazonResponseStatus: 'SKIPPED',
        ...(args.why ? { evidence: { metric: 'keptPaused', note: args.why.slice(0, 1000) } as never } : {}),
      },
      select: { id: true },
    })
    return row.id
  } catch (error) {
    logger.warn('[kept-paused] history row failed', { targetId: args.targetId, action: args.action, error: (error as Error).message })
    return null
  }
}

/**
 * End a hold that should not stand (a pause that never reached Amazon), as Nexus: the columns cleared only if the hold
 * is still the one read (compare-and-set on keptPausedAt), with its history row. Returns whether it ended.
 */
export async function endHold(args: { targetId: string; hold: HoldColumns; actor: string; why: string }): Promise<boolean> {
  const done = await prisma.adTarget.updateMany({ where: { id: args.targetId, keptPausedAt: args.hold.keptPausedAt }, data: NO_HOLD })
  if (!done.count) return false
  await recordHoldChange({ targetId: args.targetId, action: HOLD_ACTIONS.ended, actor: args.actor, before: args.hold, after: null, why: args.why })
  return true
}

// ── Amazon reports a kept-paused target ENABLED (ads-keyword-list-sync.service.ts) ───────────────────────────────────

/** The audit outcomes of a write that never reached Amazon (the worker's refusal, a cancel, a newer write over it). */
const NEVER_LANDED = ['SKIPPED', 'FAILED', 'CANCELLED', 'SUPERSEDED']

/**
 * What it means that Amazon reports a held target ENABLED (pure, from the pause that set the hold — the latest status
 * write to PAUSED since the hold began, if any):
 *   pending        that pause is still on its way (queued): the sync holds the status back anyway; nothing to say
 *   refused_pause  that pause never reached Amazon (refused at dispatch, cancelled, superseded): there was nothing to keep —
 *                  the hold ends, the history says why (the refusal itself is an AdWriteRefusal row)
 *   turned_on      it was paused at Amazon (or Nexus kept one already paused) and someone switched it on outside Nexus
 *                  (Seller Central): TURNED_ON_ELSEWHERE — shown and alerted, never silently accepted
 */
export function amazonOnVerdict(pause: { amazonResponseStatus: string | null } | null): 'pending' | 'refused_pause' | 'turned_on' {
  const s = pause?.amazonResponseStatus ?? null
  if (s === 'PENDING') return 'pending'
  if (s && NEVER_LANDED.includes(s)) return 'refused_pause'
  return 'turned_on'
}

/** The pause that set the hold: the latest status write to PAUSED on this target since the hold began (a minute's margin). */
async function holdPause(targetId: string, since: Date): Promise<{ amazonResponseStatus: string | null } | null> {
  const logs = await prisma.advertisingActionLog.findMany({
    where: { entityType: 'AD_TARGET', entityId: targetId, actionType: 'AD_ENTITY_STATE_UPDATE', createdAt: { gte: new Date(since.getTime() - 60_000) } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { amazonResponseStatus: true, payloadAfter: true },
    take: 10,
  })
  return logs.find((l) => (l.payloadAfter as { status?: unknown } | null)?.status === 'PAUSED') ?? null
}

export interface AmazonOnOutcome { verdict: 'pending' | 'refused_pause' | 'turned_on'; alerted: boolean }

/**
 * Amazon (its keyword or target list, or the v1 export ingest — whichever reads it first) reports this kept-paused target
 * ENABLED. `pending`: nothing. `refused_pause`: the hold ends. `turned_on` (TURNED_ON_ELSEWHERE): an AdDrift EXTERNAL_CHANGE
 * row on its status (ours PAUSED, Amazon's ENABLED) and — when that row is NEW, or was resolved (review M3: decided from the
 * drift row, never from the local status, which the other sync may have mirrored already) — a warning to the business's
 * people. The sync then mirrors Amazon's status as it always does (it does spend); the hold's columns stay, so the row reads
 * TURNED_ON_ELSEWHERE until a person pauses it again or releases it (either resolves the drift row: resolveTurnedOn). Never
 * throws: a failure is logged and the sync goes on.
 */
export async function keptPausedSeenOn(t: {
  id: string; hold: HoldColumns; externalId: string | null; label: string; marketplace: string | null
}): Promise<AmazonOnOutcome> {
  try {
    const verdict = amazonOnVerdict(await holdPause(t.id, t.hold.keptPausedAt ?? new Date(0)))
    if (verdict === 'pending') return { verdict, alerted: false }
    if (verdict === 'refused_pause') {
      await endHold({ targetId: t.id, hold: t.hold, actor: 'automation:ads-keyword-list-sync', why: 'the pause that kept it paused never reached Amazon (refused or not sent), so there was nothing to keep: the hold ends' })
      return { verdict, alerted: false }
    }
    const now = new Date()
    const key = { entityType_entityId_field: workspaceKey({ entityType: 'AD_TARGET', entityId: t.id, field: 'status' }) }
    // Review M3 — "the first time" is the drift row's: new, or resolved since (a person paused it again or released it).
    const before = await prisma.adDrift.findUnique({ where: key, select: { resolvedAt: true } })
    await prisma.adDrift.upsert({
      where: key,
      create: { entityType: 'AD_TARGET', entityId: t.id, externalId: t.externalId, marketplace: t.marketplace, entityName: t.label, field: 'status', ourValue: 'PAUSED', amazonValue: 'ENABLED', classification: 'EXTERNAL_CHANGE' },
      update: { ourValue: 'PAUSED', amazonValue: 'ENABLED', classification: 'EXTERNAL_CHANGE', lastDetectedAt: now, occurrences: { increment: 1 }, resolvedAt: null },
    })
    if (before && before.resolvedAt == null) return { verdict, alerted: false }
    const { notifyAutomation } = await import('../ads-automation-notify.service.js')
    const names = await actorNames([t.hold.keptPausedBy])
    await notifyAutomation({
      type: 'ads_kept_paused_turned_on',
      severity: 'warn',
      title: 'A kept-paused keyword was switched on outside Nexus',
      body: `${t.label}${t.marketplace ? ` (${t.marketplace})` : ''} was ${holdWords(holdOf(t.hold, now) ?? { at: t.hold.keptPausedAt ?? now, by: t.hold.keptPausedBy ?? 'unknown', until: t.hold.keptPausedUntil, reason: t.hold.keptPausedReason }, names)}, and Amazon now serves it (switched on in Seller Central or another tool). It spends again. Pause it again, or release it, on the Negative Targeting page.`,
      href: '/marketing/ads/rules-automation/negative-targeting?view=stopped&show=turned-on',
    })
    return { verdict, alerted: true }
  } catch (error) {
    logger.warn('[kept-paused] Amazon turn-on not recorded', { targetId: t.id, error: (error as Error).message })
    return { verdict: 'turned_on', alerted: false }
  }
}

/**
 * Review M3 — both syncs (the keyword and target lists, ads-keyword-list-sync.service.ts; the v1 export ingest,
 * ads-v1-sync.service.ts) ask this for every row Amazon reports: a held target Amazon reports ENABLED goes to
 * keptPausedSeenOn; one Amazon reports paused again closes its open turn-on drift row. Returns 1 when it was turned on
 * elsewhere, else 0. Never throws.
 */
export async function keptPausedTurnedOn(
  row: { id: string; status: unknown; isNegative: boolean; externalTargetId: string | null; expressionValue: string } & HoldColumns,
  amazonState: string, marketplace: string | null,
): Promise<number> {
  if (row.isNegative || !holdActive(row)) return 0
  if (amazonState !== 'ENABLED') {
    if (amazonState === 'PAUSED') await resolveTurnedOn(row.id)
    return 0
  }
  const out = await keptPausedSeenOn({ id: row.id, hold: row, externalId: row.externalTargetId, label: `keyword "${row.expressionValue}"`, marketplace })
  return out.verdict === 'turned_on' ? 1 : 0
}

/**
 * Close a target's open turn-on drift row (its status agrees again, or a person decided: paused it again with a hold, or
 * released it), so the next turn-on at Amazon is alerted again. Never throws.
 */
export async function resolveTurnedOn(targetId: string): Promise<void> {
  try {
    await prisma.adDrift.updateMany({ where: { entityType: 'AD_TARGET', entityId: targetId, field: 'status', classification: 'EXTERNAL_CHANGE', resolvedAt: null }, data: { resolvedAt: new Date() } })
  } catch (error) {
    logger.warn('[kept-paused] turn-on drift not resolved', { targetId, error: (error as Error).message })
  }
}
