/**
 * ACR.1.5 — Foresight: what automation will do in the next 24 hours, before it does it.
 *
 * Today answers "what is wrong now". This answers the question that actually lets an operator
 * stop watching: **what is about to happen, and is any of it something I would want to stop?**
 *
 * Two sources, and they are treated very differently on purpose:
 *
 *   · **Rank & dayparting is predictable to the hour.** Its schedule is stored, so the hours it
 *     hands one target to another are known, and every one of those hand-overs is a bid write.
 *     This reuses `buildNext24` — the same function the arm-preview uses and built from the same
 *     `resolveActiveWindow`/`biasBand` the engine runs on — so the forecast cannot say one thing
 *     while the engine does another. That was the whole point of RDX/E1 and it holds account-wide.
 *
 *   · **Everything else is predictable in cadence only.** A bid optimiser tick will write
 *     *something* at 02:20, but what it writes depends on data that does not exist yet. So the
 *     engine section reports WHEN and WHETHER-IT-MAY-WRITE, and does not pretend to know what.
 *     Fire times come from `firesIn` over the same env-var expression the job reads, so an
 *     overridden schedule moves the forecast with it instead of silently going stale.
 *
 * The distinction is the honesty rule of this tab: a scheduled bid change is a commitment; a
 * scheduled evaluation is an opportunity. Rendering them as the same kind of thing would let an
 * operator believe the account is far more determined than it is.
 *
 * Read-only.
 */
import prisma from '../../db.js'
import { envEnabled } from '../../utils/env-flag.js'
import { getAutomationState } from './ads-automation-state.service.js'
import { buildNext24, type Next24Target } from './next24.js'
import { firesIn, describeCron } from './cron-window.js'

export interface ForesightHour {
  at: string
  /** Local hour in the account timezone, 0-23. */
  hour: number
  /** Rank schedules whose governing target changes at this hour — each is a bid write. */
  bidChanges: number
  /** Schedules holding a suppression target this hour (bids to ~2¢, delivery continues). */
  suppressed: number
  /**
   * Schedules running ALL-OUT with no CPC ceiling this hour — `next24`'s narrow definition,
   * kept exactly as the arm-preview and the rank engine use it.
   */
  unbounded: number
  /**
   * Schedules whose governing target has no CPC ceiling AT ALL this hour, all-out or not.
   *
   * The two are not the same and the difference is the whole point. `unbounded` is 0 on this
   * account because the one all-out mode carries a €2.00 ceiling — while three of the everyday
   * modes (Rest of Search, Defend Top, Own Top of Search) carry none. Reporting only the narrow
   * flag would have Foresight saying "0 unbounded hours" beside Today's "3 rank modes can bid
   * without a price ceiling", which is one fact described in two vocabularies that disagree.
   */
  noCpcCeiling: number
  /** Engine ticks scheduled inside this hour, by engine key. */
  engineRuns: { key: string; name: string; fires: number }[]
  /** The distinct rank targets governing any schedule this hour, most-used first. */
  targets: { key: string; name: string; schedules: number }[]
}

export interface ForesightEngine {
  key: string
  name: string
  cron: string
  cadence: string
  /** Fires inside the next 24h. */
  fires: number
  /** The first few, ISO. */
  nextFires: string[]
  /** Whether a write it produces can currently reach Amazon. */
  canWrite: boolean
  /** Why not, when it cannot. Always populated when canWrite is false. */
  blockedReason: string | null
}

export interface Foresight {
  generatedAt: string
  timezone: string
  /** Null when the account is stopped: nothing below will land, and saying "42 bid changes" would be a lie. */
  scheduledBidChanges: number | null
  accountStopped: boolean
  accountStoppedReason: string | null
  schedulesConsidered: { total: number; enabled: number }
  hours: ForesightHour[]
  engines: ForesightEngine[]
  /** Conditions in the window that an operator would want to see before they happen. */
  notes: string[]
}

/** Timezone whitelist, matching the rank next-24h route — the value reaches AT TIME ZONE. */
const TZ_OK = new Set([
  'Europe/Rome', 'Europe/London', 'Europe/Madrid', 'Europe/Paris',
  'Europe/Berlin', 'America/Los_Angeles', 'America/New_York', 'UTC',
])

/**
 * The engines worth forecasting, with the env var and default each job actually reads.
 *
 * Kept as a literal rather than derived because there is no registry to derive from — the jobs
 * call `cron.schedule` inline. The pairing is what matters: read the SAME env var with the SAME
 * default, so an override moves the forecast rather than leaving it confidently wrong.
 */
const ENGINE_CRONS: { key: string; name: string; env: string; fallback: string; flag?: string; flagOffReason?: string }[] = [
  { key: 'rank-defend', name: 'Rank & Dayparting', env: 'NEXUS_RANK_DEFEND_SCHEDULE', fallback: '*/15 * * * *', flag: 'NEXUS_ENABLE_RANK_DEFEND', flagOffReason: 'NEXUS_ENABLE_RANK_DEFEND is off' },
  { key: 'budget-enforce', name: 'Budget enforcement', env: 'NEXUS_BUDGET_ENFORCE_SCHEDULE', fallback: '*/30 * * * *', flag: 'NEXUS_BUDGET_ENFORCE_APPLY', flagOffReason: 'NEXUS_BUDGET_ENFORCE_APPLY is off — it computes but never applies' },
  { key: 'auto-bid', name: 'Bid optimiser', env: 'NEXUS_ADS_AUTO_BID_SCHEDULE', fallback: '20 */6 * * *' },
  { key: 'auto-harvest', name: 'Harvest & negate', env: 'NEXUS_ADS_AUTO_HARVEST_SCHEDULE', fallback: '30 6 * * *' },
  { key: 'anomaly-guard', name: 'Anomaly breaker', env: 'NEXUS_ADS_ANOMALY_GUARD_SCHEDULE', fallback: '*/10 * * * *' },
  { key: 'structural-reconcile', name: 'Account reconcile', env: 'NEXUS_ADS_STRUCTURAL_RECONCILE_SCHEDULE', fallback: '35 */6 * * *' },
  { key: 'settings-sync', name: 'Settings sync', env: 'NEXUS_ADS_SETTINGS_SYNC_SCHEDULE', fallback: '*/20 * * * *' },
  { key: 'true-profit-rollup', name: 'True profit roll-up', env: 'NEXUS_TRUE_PROFIT_ROLLUP_SCHEDULE', fallback: '0 3 * * *' },
]

export async function getForesight(): Promise<Foresight> {
  const now = new Date()

  const [state, schedules, targetRows] = await Promise.all([
    getAutomationState(),
    prisma.adSchedule.findMany({
      where: { enabled: true },
      select: { id: true, name: true, campaignId: true, windows: true, defaultTargetKey: true, timezone: true },
    }),
    prisma.rankTarget.findMany(),
  ])
  const totalSchedules = await prisma.adSchedule.count()

  // One timezone for the whole board: every live schedule uses Europe/Rome, and mixing zones in
  // a single 24-column strip would make two columns labelled "14:00" mean different instants.
  const rawTz = schedules[0]?.timezone ?? 'Europe/Rome'
  const tz = TZ_OK.has(rawTz) ? rawTz : 'Europe/Rome'

  // Slots come from the DATABASE clock, not the container's — Railway clocks have drifted, and a
  // forecast naming the wrong hours with total confidence is worse than none.
  const slots = await prisma.$queryRawUnsafe<Array<{ at: Date; dow: number; hour: number }>>(`
    SELECT gs AS at,
           EXTRACT(DOW  FROM gs AT TIME ZONE $1)::int AS dow,
           EXTRACT(HOUR FROM gs AT TIME ZONE $1)::int AS hour
    FROM generate_series(
      date_trunc('hour', now()),
      date_trunc('hour', now()) + interval '23 hours',
      interval '1 hour'
    ) gs
  `, tz)

  const lib = new Map<string, Next24Target>(
    targetRows.map((t) => [t.key, {
      key: t.key, name: t.name, color: t.color,
      biasPct: t.biasPct, maxBiasPct: t.maxBiasPct, maxCpcCents: t.maxCpcCents,
      acosCapPct: t.acosCapPct, allOut: t.allOut, pause: t.pause,
    }]),
  )

  const baseSlots = slots.map((s) => ({
    at: (s.at instanceof Date ? s.at : new Date(s.at)).toISOString(),
    dow: Number(s.dow),
    hour: Number(s.hour),
  }))

  // Per-hour accumulators across every enabled schedule.
  const perHour = baseSlots.map((s) => ({
    at: s.at,
    hour: s.hour,
    bidChanges: 0,
    suppressed: 0,
    unbounded: 0,
    noCpcCeiling: 0,
    targets: new Map<string, { name: string; schedules: number }>(),
  }))

  for (const sch of schedules) {
    const { hours } = buildNext24(
      baseSlots,
      sch.windows as Parameters<typeof buildNext24>[1],
      sch.defaultTargetKey,
      lib,
    )
    for (let i = 0; i < hours.length; i++) {
      const h = hours[i]
      const cell = perHour[i]
      if (!cell) continue
      // A change at index 0 is not knowable — there is no previous hour inside this window, and
      // guessing from the schedule's last-applied state would make hour 0 the least reliable
      // cell on a board whose first row is the one an operator checks against live behaviour.
      if (i > 0 && h.targetKey !== hours[i - 1].targetKey) cell.bidChanges += 1
      if (h.suppressed) cell.suppressed += 1
      if (h.unbounded) cell.unbounded += 1
      // A suppression hour drives bids down, so a missing ceiling cannot cost anything there.
      if (!h.suppressed && h.targetKey && h.maxCpcCents == null) cell.noCpcCeiling += 1
      if (h.targetKey) {
        const prev = cell.targets.get(h.targetKey)
        if (prev) prev.schedules += 1
        else cell.targets.set(h.targetKey, { name: h.targetName ?? h.targetKey, schedules: 1 })
      }
    }
  }

  const accountStopped = state.effectivelyStopped
  const accountStoppedReason = accountStopped
    ? (state.haltReason ?? (state.autonomy === 'OFF' ? 'Account autonomy is OFF' : 'Automation is stopped'))
    : null

  const engines: ForesightEngine[] = ENGINE_CRONS.map((e) => {
    const expr = process.env[e.env] ?? e.fallback
    const r = firesIn(expr, now, 24)
    const flagOff = e.flag ? !envEnabled(e.flag) : false
    const masterOff = !envEnabled('NEXUS_ENABLE_AMAZON_ADS_CRON')
    const blockedReason = masterOff
      ? 'NEXUS_ENABLE_AMAZON_ADS_CRON is off — the whole ads fleet is dormant'
      : accountStopped
        ? accountStoppedReason
        : flagOff
          ? (e.flagOffReason ?? `${e.flag} is off`)
          : null
    return {
      key: e.key,
      name: e.name,
      cron: expr,
      cadence: describeCron(expr),
      fires: r.count,
      nextFires: r.fires,
      canWrite: blockedReason == null,
      blockedReason,
    }
  })

  const totalBidChanges = perHour.reduce((a, h) => a + h.bidChanges, 0)
  const unboundedHours = perHour.filter((h) => h.unbounded > 0).length
  const noCeilingHours = perHour.filter((h) => h.noCpcCeiling > 0).length
  const suppressedHours = perHour.filter((h) => h.suppressed > 0).length

  const notes: string[] = []
  if (accountStopped) {
    notes.push(
      `Automation is stopped, so none of the ${totalBidChanges} scheduled bid changes below will reach Amazon. ` +
      'They are what the schedules would do if it resumed — a rehearsal, not a forecast.',
    )
  }
  if (unboundedHours > 0) {
    notes.push(
      `${unboundedHours} of the next 24 hours run at least one schedule all-out with no CPC ceiling. ` +
      'In those hours nothing bounds the bid but Amazon\'s own 900% cap.',
    )
  }
  if (noCeilingHours > 0) {
    notes.push(
      `${noCeilingHours} of the next 24 hours are governed by a rank mode with no CPC ceiling of any kind. ` +
      'Those modes carry an ACOS cap instead, which bounds efficiency after the spend rather than the price of a click.',
    )
  }
  if (suppressedHours > 0) {
    notes.push(
      `${suppressedHours} hours hold a suppression target. That floors bids to about 2¢ and leaves the campaign ENABLED — ` +
      'delivery continues at a low bid; nothing pauses.',
    )
  }
  if (schedules.length === 0) {
    notes.push('No schedule is enabled, so no bid change is scheduled. The engines below still tick.')
  }
  const dormant = engines.filter((e) => !e.canWrite && e.fires > 0)
  if (dormant.length > 0 && !accountStopped) {
    notes.push(
      `${dormant.length} engine${dormant.length === 1 ? '' : 's'} will run but cannot write: ` +
      dormant.map((d) => `${d.name} (${d.blockedReason})`).join(' · ') + '.',
    )
  }

  return {
    generatedAt: now.toISOString(),
    timezone: tz,
    // Null rather than a number when nothing can land — see the note above; a count here would
    // read as "this WILL happen" on an account where nothing will.
    scheduledBidChanges: accountStopped ? null : totalBidChanges,
    accountStopped,
    accountStoppedReason,
    schedulesConsidered: { total: totalSchedules, enabled: schedules.length },
    hours: perHour.map((h) => ({
      at: h.at,
      hour: h.hour,
      bidChanges: h.bidChanges,
      suppressed: h.suppressed,
      unbounded: h.unbounded,
      noCpcCeiling: h.noCpcCeiling,
      engineRuns: engines
        .map((e) => ({
          key: e.key,
          name: e.name,
          fires: firesIn(e.cron, new Date(h.at), 1, 0).count,
        }))
        .filter((r) => r.fires > 0),
      targets: [...h.targets.entries()]
        .map(([key, v]) => ({ key, name: v.name, schedules: v.schedules }))
        .sort((a, b) => b.schedules - a.schedules),
    })),
    engines,
    notes,
  }
}
