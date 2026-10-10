/**
 * Ads brain page A4 — the brain on the Control Room's engine board: one row per brain writer (family 'brain'), so the
 * board, the switchboard and the Levers drawer show the brain beside the engines it replaces.
 *
 *   rows       bid-brain, brain-money, brain-state, brain-negatives, brain-harvest, brain-strategy write by themselves; their
 *              keys are ads-engine-actors.ts ENGINE_ACTORS keys, so each row's 7-day writes and activity come from the one
 *              actor map. brain-hours, brain-structure and brain-cycle write nothing by themselves (every plan, build or
 *              move they make is a request a person approves; the cycle runs the other writers in order).
 *   env        the server ceiling of each writer, from its own reader (lever-state.ts loadLeverRuntime)
 *   mode       the highest the brain really does with the writer's levers across the enrolled products (lever-state.ts:
 *              acts → AUTO, asks → PROPOSE, watches → OBSERVE, off → OFF), bounded by the env; the bid brain's from the
 *              campaigns it owns (BidBrainEnrollment LIVE / HELD under a live ceiling, not archived, not killed)
 *   rows       { total, auto }: the enrolled products (the bid brain: its LIVE / HELD campaigns) and those where it acts now
 *   halt       measured, pinned by ads-control-room-brain.vitest.test.ts: a writer that reads the posture
 *              (readEnginePosture / openEngineGuard) honours the dial; the others are gated at the write gate; the three
 *              that never write by themselves are exempt (nothing of theirs runs without a person's approval)
 *
 * Recursion trap: brain/read-map.ts brainSetup reads getEngineLevers, which reads this file — so this file never imports
 * read-map.ts. Read only.
 */
import type { BrainLever } from './levers.js'
import { loadProductLevers, type LeverActing, type LeverRuntime } from './lever-state.js'

type Mode = 'OFF' | 'OBSERVE' | 'PROPOSE' | 'AUTO'
export type BrainHalt = 'honours' | 'gated' | 'exempt'

export interface BrainWriterDef {
  key: string
  name: string
  what: string
  levers: readonly BrainLever[]
  /** The cron run whose health the row shows (none of them is in CRON_REGISTRY: no Run now). */
  cron: string
  schedule: string
  writesOnOwn: boolean
  haltBehaviour: BrainHalt
  /** The files that run its writes: the pin test reads them for the posture check (measured, not assumed). */
  runs: readonly string[]
}

export const BRAIN_WRITERS: readonly BrainWriterDef[] = [
  { key: 'bid-brain', name: 'Bid brain', what: 'Sets the keyword bids of the campaigns enrolled LIVE (and, with their hourly plan, placements and Min-bid hours); decides every allowlisted campaign in shadow', levers: ['bids'], cron: 'ads-bid-brain-shadow', schedule: 'every 6 h; its own campaigns every 15 min', writesOnOwn: true, haltBehaviour: 'honours', runs: ['bid-brain/shadow.ts', 'bid-brain/load.ts'] },
  { key: 'brain-money', name: 'Brain budgets', what: 'Sets the campaign budgets of enrolled products inside the month\'s pace, and their Amazon portfolio caps', levers: ['budgets', 'portfolioCap'], cron: 'ads-brain-money-shadow', schedule: 'with the bid brain; budgets every 15 min', writesOnOwn: true, haltBehaviour: 'honours', runs: ['brain/budget-shadow.ts'] },
  { key: 'brain-state', name: 'Brain pauses', what: 'Pauses a campaign for a stop of 3 days or more and resumes it when the stop ends; it never archives', levers: ['state'], cron: 'ads-brain-state', schedule: 'hourly at :50', writesOnOwn: true, haltBehaviour: 'honours', runs: ['brain/state-run.ts'] },
  { key: 'brain-negatives', name: 'Brain negatives', what: 'Adds, retires and revives the negatives of enrolled products, after their shadow days', levers: ['negatives'], cron: 'ads-brain-negatives', schedule: 'daily 05:25 UTC', writesOnOwn: true, haltBehaviour: 'gated', runs: ['brain/negatives-run.ts'] },
  { key: 'brain-harvest', name: 'Brain harvest', what: 'Graduates converting search terms to exact keywords and negates their sources, as one change set', levers: ['harvest'], cron: 'ads-brain-harvest', schedule: 'daily 05:25 UTC', writesOnOwn: true, haltBehaviour: 'gated', runs: ['brain/harvest-run.ts', 'brain/harvest-write.ts'] },
  { key: 'brain-strategy', name: 'Brain bidding strategy', what: 'Switches each campaign\'s Amazon bidding strategy, tested and kept or switched back; asks a person for the first 30 days (N4)', levers: ['biddingStrategy'], cron: 'ads-brain-cycle', schedule: 'weekly, in the product cycle', writesOnOwn: true, haltBehaviour: 'honours', runs: ['brain/bidding-mode-run.ts'] },
  { key: 'brain-hours', name: 'Brain hourly plan', what: 'Researches the market\'s hours and paints the hourly plan; every painted plan is a request a person approves', levers: ['hours'], cron: 'ads-brain-hours', schedule: 'daily 04:50 UTC', writesOnOwn: false, haltBehaviour: 'exempt', runs: ['brain/hours-proposal.ts'] },
  { key: 'brain-structure', name: 'Brain structure', what: 'Proposes single-keyword campaigns, splits of shared campaigns and the move into one portfolio; each is a request a person approves', levers: ['structure'], cron: 'ads-brain-structure', schedule: 'daily 05:35 UTC', writesOnOwn: false, haltBehaviour: 'exempt', runs: ['brain/structure-run.ts'] },
  { key: 'brain-cycle', name: 'Brain product cycle', what: 'Runs each enrolled product\'s levers in order once a settled data day (the writers above, each under its own row)', levers: [], cron: 'ads-brain-cycle', schedule: 'hourly at :55', writesOnOwn: false, haltBehaviour: 'exempt', runs: ['brain/cycle-run.ts'] },
]

export interface BrainEngineFact {
  def: BrainWriterDef
  env: { mode: Mode; why: string }
  effective: { mode: Mode; why: string }
  rows: { total: number; auto: number }
}

const RANK: Record<Mode, number> = { OFF: 0, OBSERVE: 1, PROPOSE: 2, AUTO: 3 }
const MODE_OF: Record<LeverActing, Mode> = { acts: 'AUTO', asks: 'PROPOSE', watches: 'OBSERVE', off: 'OFF' }
const lower = (a: Mode, b: Mode): Mode => (RANK[a] <= RANK[b] ? a : b)

/** Each writer's server ceiling, from its own reader (lever-state.ts runtime). Pure. */
export function brainWriterEnv(key: string, rt: LeverRuntime): { mode: Mode; why: string } {
  const brain = `NEXUS_BID_BRAIN_MODE is ${rt.ceiling}`
  switch (key) {
    case 'bid-brain':
      return rt.ceiling === 'live' ? { mode: 'AUTO', why: `${brain}: it writes the campaigns enrolled LIVE` } : rt.ceiling === 'off' ? { mode: 'OFF', why: `${brain}: the bid brain does not run` } : { mode: 'OBSERVE', why: `${brain}: it decides in shadow and writes nothing` }
    case 'brain-money': case 'brain-state': case 'brain-negatives':
      return rt.ceilingLive ? { mode: 'AUTO', why: `${brain}: it may write at AUTO and ask at PROPOSE` } : { mode: 'OBSERVE', why: `${brain}: it decides and logs, and writes nothing` }
    case 'brain-harvest':
      return rt.harvest.live ? { mode: 'AUTO', why: rt.harvest.why } : { mode: 'OBSERVE', why: `${rt.harvest.why}: it logs each harvest, and writes and asks nothing` }
    case 'brain-strategy':
      if (!rt.cycleOn) return { mode: 'OFF', why: 'it runs only in the product cycle, and NEXUS_ADS_BRAIN_CYCLE is off' }
      return rt.ceilingLive ? { mode: 'AUTO', why: `NEXUS_ADS_BRAIN_CYCLE is on and ${brain}` } : { mode: 'PROPOSE', why: `${brain}: a switch only ever asks a person` }
    case 'brain-hours':
      return rt.hoursOn || rt.cycleOn ? { mode: 'PROPOSE', why: 'it paints and asks: a plan never changes without a person' } : { mode: 'OFF', why: 'NEXUS_ADS_BRAIN_HOURS=0 and the product cycle is off: nothing paints the plan' }
    case 'brain-structure':
      return rt.structure.live ? { mode: 'PROPOSE', why: rt.structure.why } : { mode: 'OBSERVE', why: `${rt.structure.why}: its proposals are logged, nothing asked` }
    case 'brain-cycle':
      return rt.cycleOn ? { mode: 'AUTO', why: 'NEXUS_ADS_BRAIN_CYCLE is on: it runs each enrolled product\'s levers in order' } : { mode: 'OFF', why: 'NEXUS_ADS_BRAIN_CYCLE is off: each lever runs on its own cron' }
    default:
      return { mode: 'OFF', why: 'not a brain writer' }
  }
}

/** One row of the board per brain writer, read now (a fixed number of reads; never read-map.ts). */
export async function brainEngineFacts(now: Date = new Date()): Promise<BrainEngineFact[]> {
  const [{ default: prisma }, { brainOwnedCampaignIds }, { campaignKills }, product] = await Promise.all([
    import('../../../db.js'), import('../bid-brain/live.js'), import('./kill-switch.js'), loadProductLevers({}, now),
  ])
  const rt = product.runtime
  // The bid brain owns campaigns, not products: its LIVE / HELD enrollments under a live ceiling, archived ones left out.
  const [enrolledCampaigns, ownedIds] = await Promise.all([
    prisma.bidBrainEnrollment.count({ where: { mode: { in: ['LIVE', 'HELD'] } } }),
    brainOwnedCampaignIds(),
  ])
  const archived = ownedIds.size ? new Set((await prisma.campaign.findMany({ where: { id: { in: [...ownedIds] }, status: 'ARCHIVED' }, select: { id: true } })).map((c) => c.id)) : new Set<string>()
  const owned = [...ownedIds].filter((id) => !archived.has(id))
  const killedBids = owned.length ? await campaignKills(owned, ['bids']) : new Map()
  const acting = owned.filter((id) => !killedBids.get(id)?.bids)

  return BRAIN_WRITERS.map((def) => {
    const env = brainWriterEnv(def.key, rt)
    let effective: { mode: Mode; why: string }
    let rows: { total: number; auto: number }
    if (def.key === 'bid-brain') {
      rows = { total: enrolledCampaigns, auto: acting.length }
      effective = acting.length
        ? { mode: 'AUTO', why: `it writes the bids of ${acting.length} campaign${acting.length === 1 ? '' : 's'} it owns${owned.length > acting.length ? ` (${owned.length - acting.length} stopped by the Owner's kill switch)` : ''}` }
        : { mode: rt.ceiling === 'off' ? 'OFF' : 'OBSERVE', why: owned.length ? `the Owner's kill switch stops the bids of every campaign it owns: it decides in shadow` : 'it owns no campaign now: it decides every allowlisted campaign in shadow' }
    } else if (def.key === 'brain-cycle') {
      rows = { total: product.products.length, auto: rt.cycleOn ? product.products.length : 0 }
      effective = product.products.length ? { mode: 'AUTO', why: `it runs ${product.products.length} enrolled product${product.products.length === 1 ? '' : 's'}` } : { mode: 'OFF', why: 'no product is enrolled in the brain' }
    } else {
      let best: { mode: Mode; why: string } = { mode: 'OFF', why: product.products.length ? 'no enrolled product gives the brain this lever' : 'no product is enrolled in the brain' }
      let auto = 0
      for (const p of product.products) {
        let actsHere = false
        for (const lever of def.levers) {
          const s = p.states[lever]
          if (s.state === 'acts') actsHere = true
          const mode = MODE_OF[s.state]
          if (RANK[mode] > RANK[best.mode]) best = { mode, why: `${p.productId} in ${p.market} (${lever}): ${s.why}` }
        }
        if (actsHere) auto++
      }
      rows = { total: product.products.length, auto }
      effective = best
    }
    const bounded = lower(env.mode, effective.mode)
    return {
      def, env, rows,
      effective: bounded === effective.mode ? effective : { mode: bounded, why: `${env.why} (${effective.why})` },
    }
  })
}
