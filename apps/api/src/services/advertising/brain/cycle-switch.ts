/**
 * ONE BRAIN AB-14 — the product cycle's switch, and what each lever's own cron leaves while it is on (design
 * 2026-10-08-ads-one-brain/DESIGN.md §4, §8 row AB-14). brain/cycle-run.ts runs the cycle; this leaf says who it runs, so
 * the module crons can skip them without importing it.
 *
 *   switch    NEXUS_ADS_BRAIN_CYCLE = off (the default) | on. Off: nothing here reads the database, every list comes back
 *             as it went in, and every lever's cron runs exactly as before the cycle existed. Anything unrecognised is
 *             off (never on by accident).
 *   on        the cycle runs every enrolled product × market (AdsBrainEnrollment) in the design's order, once per new
 *             settled data day, with the state step every hour. Each lever's own daily cron then leaves those products
 *             (no double run): the state cron (hourly), the term ledger's and the negatives' crons (through termsDue),
 *             the money shadow at the bid brain's full slots, the hours cron, and the bid brain's full run for the
 *             product's own campaigns. The bid brain's 15-minute ticks for the campaigns it owns and the money writer's
 *             15-minute ladder are the intraday layer the day's decisions are carried out by (design §4 "every 15
 *             minutes"): they run as before.
 */

/** The cycle's switch. */
export type CycleMode = 'off' | 'on'

export function cycleMode(env: string | undefined = process.env.NEXUS_ADS_BRAIN_CYCLE): CycleMode {
  const v = (env ?? '').trim().toLowerCase()
  return v === 'on' || v === '1' || v === 'true' || v === 'live' ? 'on' : 'off'
}

export const cycleOn = (): boolean => cycleMode() === 'on'

/** One product × market, as the cycle and the crons key it. */
export const cycleKey = (productId: string, market: string): string => `${market}|${productId}`

/** What a cron's line says about a product it leaves to the cycle. */
export const CYCLE_RUNS_IT = 'the product cycle runs it (NEXUS_ADS_BRAIN_CYCLE=on, AB-14): its own cron leaves it'

/** The product × markets the cycle runs: every enrolled one while it is on; none while it is off (no read). */
export async function orchestratedKeys(): Promise<Set<string>> {
  if (!cycleOn()) return new Set()
  const { default: prisma } = await import('../../../db.js')
  const rows = await prisma.adsBrainEnrollment.findMany({ select: { productId: true, marketplace: true } })
  return new Set(rows.map((r) => cycleKey(r.productId, r.marketplace)))
}

/**
 * A cron's products without the ones the cycle runs. Off: the list as it is (no read). `keys` lets a caller that read
 * the enrollments already pass them.
 */
export async function withoutOrchestrated<T extends { productId: string; market: string }>(list: readonly T[], keys?: ReadonlySet<string>): Promise<{ kept: T[]; skipped: T[] }> {
  if (!cycleOn() || !list.length) return { kept: [...list], skipped: [] }
  const orchestrated = keys ?? await orchestratedKeys()
  const kept: T[] = []
  const skipped: T[] = []
  for (const p of list) (orchestrated.has(cycleKey(p.productId, p.market)) ? skipped : kept).push(p)
  return { kept, skipped }
}

/**
 * The own campaigns (brain/ownership.ts: advertising only that product) of every product × market the cycle runs: the
 * bid brain's full run leaves them, the cycle's bids step decides them. Off: empty (no read). A shared campaign is no
 * product's (D2): the full run keeps deciding it in shadow, as before.
 */
export async function orchestratedCampaignIds(): Promise<Set<string>> {
  if (!cycleOn()) return new Set()
  const { default: prisma } = await import('../../../db.js')
  const { productCampaigns } = await import('./ownership.js')
  const rows = await prisma.adsBrainEnrollment.findMany({ select: { productId: true, marketplace: true } })
  const out = new Set<string>()
  for (const r of rows) for (const c of (await productCampaigns(r.productId, r.marketplace))?.owned ?? []) out.add(c.campaignId)
  return out
}
