/**
 * Ads brain page A3 — the switchboard: "what is on" in one answer, for the Owner's page (GET …/brain/switchboard).
 *
 *   server   the server switches that bound the brain and the ads engines, by name only (never the environment as a
 *            whole): the value set, what its own reader makes of it now, the default, what it means and which code reads
 *            it. New switches plug in at ONE place below (MORE_SERVER_SWITCHES).
 *   account  the account dial, the halt (who, when, why), the server kill, whether the state could be read, and the
 *            posture every engine reads (ads-engine-guard.ts readEnginePosture)
 *   engines  the Control Room's engine board as it reads it (getEngineLevers): each engine's mode, group, why and this
 *            business's switch — the brain's own writers among them (family 'brain', A4)
 *   brain    the Owner's kill switches in the scope, and each enrolled product's levers: the level, its source, his lock,
 *            and whether the brain really acts, asks, watches or does nothing there now, and why (lever-state.ts)
 *
 * Read only. No money of its own: a lock's value (a budget, a cap) is under a money key, hidden without the ad-spend
 * permission by the route (BRAIN_VIEW_MONEY).
 */
import { strategyMarket } from '../ads-strategy/bids.js'
import { BRAIN_LEVERS } from './levers.js'
import { loadProductLevers } from './lever-state.js'

/** One server switch the switchboard shows. `read` is its own reader's answer now; `default` what it reads when unset. */
export interface SwitchDef {
  name: string
  /** The code that reads it (file and function), so a person knows what it moves. */
  reader: string
  meaning: string
  read: () => string
  default: string
}

export interface ServerSwitch { name: string; value: string | null; effective: string; default: string; meaning: string; reader: string }

/** The brain's and the ads engines' own switches, each read by its own reader (lazy: several pull in the database layer). */
async function coreSwitches(): Promise<SwitchDef[]> {
  const [
    { bidBrainMode }, { cycleMode }, { harvestCeiling }, { structureCeiling }, { retireAskMode }, { brainHoursEnabled },
    { nowcastMode }, { intradayMode }, { exploreMode }, { hourFactorMode }, { probeMode }, { responseMode }, { envEnabled }, { adsMode },
  ] = await Promise.all([
    import('../bid-brain/shadow.js'), import('./cycle-switch.js'), import('./harvest-load.js'), import('./structure-load.js'), import('./retire-run.js'),
    import('../../../jobs/ads-brain-hours.job.js'), import('../bid-brain/nowcast.js'), import('../bid-brain/intraday.js'), import('../bid-brain/explore.js'),
    import('../bid-brain/hour-factors.js'), import('../bid-brain/probe.js'), import('../bid-brain/response.js'), import('../../../utils/env-flag.js'), import('../ads-api-client.js'),
  ])
  const ceiling = (c: { live: boolean }) => (c.live ? 'live' : 'shadow')
  return [
    { name: 'NEXUS_BID_BRAIN_MODE', reader: 'bid-brain/shadow.ts bidBrainMode', read: () => bidBrainMode(), default: bidBrainMode(''), meaning: 'the brain\'s server switch: live lets its writers write and ask (bids of LIVE campaigns, money, state, negatives, the bidding strategy after N4); shadow decides and logs only; off stops the bid brain\'s run' },
    { name: 'NEXUS_ADS_BRAIN_CYCLE', reader: 'brain/cycle-switch.ts cycleMode', read: () => cycleMode(), default: cycleMode(''), meaning: 'on: the product cycle runs every enrolled product\'s levers in order once a settled data day (the bidding strategy runs only there); off: each lever\'s own cron' },
    { name: 'NEXUS_ADS_BRAIN_HARVEST_MODE', reader: 'brain/harvest-load.ts harvestCeiling', read: () => ceiling(harvestCeiling()), default: ceiling(harvestCeiling({ ...process.env, NEXUS_ADS_BRAIN_HARVEST_MODE: '' })), meaning: 'live (with NEXUS_BID_BRAIN_MODE live): the harvest lever asks at PROPOSE and writes at AUTO; otherwise it logs each harvest in shadow' },
    { name: 'NEXUS_ADS_BRAIN_STRUCTURE_MODE', reader: 'brain/structure-load.ts structureCeiling', read: () => ceiling(structureCeiling()), default: ceiling(structureCeiling({ ...process.env, NEXUS_ADS_BRAIN_STRUCTURE_MODE: '' })), meaning: 'live (with NEXUS_BID_BRAIN_MODE live): the structure lever asks a person for each build, go-live and move; otherwise its proposals are logged in shadow' },
    { name: 'NEXUS_ADS_BRAIN_RETIRE', reader: 'brain/retire-run.ts retireAskMode', read: () => retireAskMode(), default: retireAskMode(''), meaning: 'ask: the brain asks a person to retire the duplicate writers of a ready product; off: only a person or Claude asks (retire-ads-writers)' },
    { name: 'NEXUS_ADS_BRAIN_HOURS', reader: 'jobs/ads-brain-hours.job.ts brainHoursEnabled', read: () => (brainHoursEnabled() ? 'on' : 'off'), default: 'on', meaning: '0 stops the daily hours research and painting (the product cycle still paints when it is on)' },
    { name: 'NEXUS_BID_BRAIN_NOWCAST', reader: 'bid-brain/nowcast.ts nowcastMode', read: () => nowcastMode(), default: nowcastMode(''), meaning: 'the bid brain weights young days by the attribution lag curve: on uses it, shadow names the difference in the why, off computes nothing' },
    { name: 'NEXUS_BID_BRAIN_INTRADAY', reader: 'bid-brain/intraday.ts intradayMode', read: () => intradayMode(), default: intradayMode(''), meaning: 'the intraday brakes (today\'s spend, a lane\'s CPC spike, a budget running out early): on acts, shadow names what it would do' },
    { name: 'NEXUS_BID_BRAIN_EXPLORE', reader: 'bid-brain/explore.ts exploreMode', read: () => exploreMode(), default: exploreMode(''), meaning: 'the bid brain\'s exploration of keywords with too little data: on acts, shadow names it' },
    { name: 'NEXUS_BID_BRAIN_HOUR_FACTORS', reader: 'bid-brain/hour-factors.ts hourFactorMode', read: () => hourFactorMode(), default: hourFactorMode(''), meaning: 'the learned hour factors inside each approved hourly cell: on applies them, shadow names the move' },
    { name: 'NEXUS_BID_BRAIN_PROBES', reader: 'bid-brain/probe.ts probeMode', read: () => probeMode(), default: probeMode(''), meaning: 'the switchback probes that measure a keyword\'s bid elasticity: on moves the bids of owned campaigns, shadow plans and measures a placebo' },
    { name: 'NEXUS_BID_BRAIN_RESPONSE', reader: 'bid-brain/response.ts responseMode', read: () => responseMode(), default: responseMode(''), meaning: 'the bid response curve the brain fits: shadow fits and names it, off does not' },
    { name: 'NEXUS_ENABLE_AMAZON_ADS_CRON', reader: 'utils/env-flag.ts envEnabled', read: () => (envEnabled('NEXUS_ENABLE_AMAZON_ADS_CRON') ? 'on' : 'off'), default: 'off', meaning: 'the whole ads fleet\'s crons: off keeps every ads engine dormant' },
    // As ads-automation-state.service.ts and the Control Room read it.
    { name: 'NEXUS_ADS_AUTOMATION_KILL', reader: 'ads-automation-state.service.ts envKill', read: () => (process.env.NEXUS_ADS_AUTOMATION_KILL === '1' ? 'on' : 'off'), default: 'off', meaning: '1 stops every automatic ads write at the gate (a server kill, beside the account halt)' },
    { name: 'NEXUS_AMAZON_ADS_MODE', reader: 'ads-api-client.ts adsMode', read: () => adsMode(), default: 'sandbox', meaning: 'live sends ads writes to Amazon\'s production API; sandbox to its sandbox' },
  ]
}

/**
 * ── PLUG-IN PLACE: more server switches ──────────────────────────────────────────────────────────────────────────────
 * Lane B1 (brain/lever-ceilings.ts) adds the switches of the levers it widens HERE: import its list of SwitchDef and
 * return it below (`return [...LEVER_CEILING_SWITCHES]`). Each is read by its own reader; nothing else changes. A name
 * already in the core list is shown once (the core entry wins).
 */
async function moreServerSwitches(): Promise<readonly SwitchDef[]> {
  return []
}

/** Every server switch the switchboard shows, read now (allowlisted names only: the environment is never dumped). */
export async function serverSwitches(): Promise<ServerSwitch[]> {
  const [core, more] = await Promise.all([coreSwitches(), moreServerSwitches()])
  const names = new Set(core.map((d) => d.name))
  return [...core, ...more.filter((d) => !names.has(d.name))].map((d) => ({
    name: d.name, value: process.env[d.name]?.trim() || null, effective: d.read(), default: d.default, meaning: d.meaning, reader: d.reader,
  }))
}

/** View switchboard. `market` (optional) and `productId` (optional; any member of its family) narrow the brain part. */
export async function brainSwitchboard(args: { market?: string; productId?: string }, opts: { now?: Date } = {}): Promise<{ data: unknown } | { error: string }> {
  const now = opts.now ?? new Date()
  const market = args.market ? strategyMarket(args.market) : null
  if (args.market && (!market || !/^[A-Z]{2}$/.test(market))) return { error: `${args.market} is not a market code` }
  let productId: string | null = null
  if (args.productId) {
    const { productFamily } = await import('./ownership.js')
    const family = await productFamily(args.productId)
    if (!family) return { error: 'Product not found' }
    productId = family.root
  }
  const [{ getAutomationState }, { readEnginePosture }, { getEngineLevers }, { killOut }] = await Promise.all([
    import('../ads-automation-state.service.js'), import('../ads-engine-guard.js'), import('../ads-control-room.service.js'), import('./read-map.js'),
  ])
  const [server, state, posture, board, brain] = await Promise.all([
    serverSwitches(), getAutomationState(), readEnginePosture(), getEngineLevers(), loadProductLevers({ market, productId }, now),
  ])
  const kills = brain.kills.filter((k) => (!market || !k.market || k.market === market) && (!productId || !k.productId || k.productId === productId))
  return {
    data: {
      view: 'switchboard', scope: { market: market ?? 'every market', ...(productId ? { productId } : {}) }, at: now.toISOString(),
      server,
      account: {
        autonomy: state.autonomy, halted: state.halted, haltedBy: state.haltedBy, haltedAt: state.haltedAt, haltReason: state.haltReason,
        envKill: process.env.NEXUS_ADS_AUTOMATION_KILL === '1', degraded: state.degraded, posture: posture.posture, postureWhy: posture.why,
      },
      engines: board.levers.map((l) => ({
        key: l.key, name: l.name, family: l.family ?? 'engine', mode: l.mode, group: l.exposure.group, why: l.modeReason, writesOnOwn: l.writesOnOwn,
        haltBehaviour: l.haltBehaviour, switch: l.control.switch, switchable: l.control.switchable, ...(l.warning ? { warning: l.warning } : {}),
      })),
      brain: {
        ceiling: brain.runtime.ceiling, cycle: brain.runtime.cycleOn ? 'on' : 'off',
        kills: kills.map(killOut),
        products: brain.products.map((p) => ({
          productId: p.productId, market: p.market, enrolledAt: p.enrolledAt?.toISOString() ?? null,
          excluded: p.settings.excluded.value ? { by: p.settings.excluded.by, at: p.settings.excluded.at, reason: p.settings.excluded.reason } : null,
          levers: Object.fromEntries(BRAIN_LEVERS.map((lever) => {
            const l = p.settings.levers[lever]
            return [lever, {
              level: l.level.value, effective: l.effective, source: l.level.source, by: l.level.by, at: l.level.at,
              ...(l.lock ? { lock: { value: l.lock.value ?? null, source: l.lock.source, by: l.lock.by, at: l.lock.at } } : {}),
              ...(p.killed[lever] ? { killed: killOut(p.killed[lever]!) } : {}),
              acting: p.states[lever],
            }]
          })),
        })),
        ...(brain.products.length ? {} : { note: `No product is enrolled in the brain${market ? ` in ${market}` : ''}${productId ? ' for this product' : ''}: every lever is today's engines'.` }),
      },
      note: 'Read only: what each switch is and what really acts now. Server switches are the Owner\'s (Railway); the dial and the halt are on the Control Room; the brain\'s levels, locks and kills are set through set-ads-brain and set-brain-kill-switch.',
    },
  }
}
