/**
 * ADS PLAYBOOK PB-2 — the sections a template gets by default from its slots (design report 9 §3.4, §3.5, §3.7), pure:
 *
 *   harvest    Broad and Phrase of an intent → the Exact slot of that intent (negative exact in the source); Auto →
 *              the intent router (brand / competitor / category Exact); the research slots → the product-targeting
 *              slot for ASIN search terms (negative product target in the source)
 *   isolation  exact keywords negated in Auto, Broad and Phrase; brand terms negated (phrase) in the category and
 *              competitor slots; phrase keywords NOT negated in Broad and Auto (Broad keeps discovering long tails)
 *   phases     LAUNCH → GROW → PROFIT, CLEAR_STOCK and DEFEND: the design's starting table, every number editable
 *
 * They are where a captured or hand-made template starts, never a rule an engine follows: a template is compiled only by
 * an approved apply, and every threshold an engine obeys is the strategy's.
 */
import type { z } from 'zod'
import type { HARVEST_EDGE, PHASES_SECTION, Slot, TemplateDoc } from './doc.js'

type Edge = z.input<typeof HARVEST_EDGE>

const exactOf = (slots: readonly Slot[], intent: string) =>
  slots.find((s) => s.targeting === 'KEYWORD' && s.match === 'EXACT' && s.intent === intent)?.key
const researchMatch = (s: Slot) => s.targeting === 'AUTO' || (s.targeting === 'KEYWORD' && s.match !== 'EXACT')

export function defaultHarvest(slots: readonly Slot[]): TemplateDoc['harvest'] {
  const edges: Edge[] = []
  for (const intent of ['BRAND', 'COMPETITOR', 'CATEGORY'] as const) {
    const exact = exactOf(slots, intent)
    const from = slots.filter((s) => s.targeting === 'KEYWORD' && s.intent === intent && s.match !== 'EXACT').map((s) => s.key)
    if (exact && from.length) edges.push({ from, to: exact, what: 'KEYWORD_EXACT', startBid: { mode: 'cpc' }, negateSource: true })
  }
  const category = exactOf(slots, 'CATEGORY') ?? slots.find((s) => s.targeting === 'KEYWORD' && s.match === 'EXACT')?.key
  const autos = slots.filter((s) => s.targeting === 'AUTO').map((s) => s.key)
  if (category && autos.length) {
    edges.push({
      from: autos,
      to: { router: 'intent', brand: exactOf(slots, 'BRAND') ?? category, competitor: exactOf(slots, 'COMPETITOR') ?? category, category },
      what: 'KEYWORD_EXACT',
      startBid: { mode: 'cpc' },
      negateSource: true,
    })
  }
  const pat = slots.find((s) => s.targeting === 'PRODUCT')?.key
  const research = slots.filter(researchMatch).map((s) => s.key)
  if (pat && research.length) edges.push({ from: research, to: pat, what: 'ASIN_PRODUCT', startBid: { mode: 'cpc' }, negateSource: true })
  return { edges: edges as TemplateDoc['harvest']['edges'] }
}

export const DEFAULT_ISOLATION: TemplateDoc['isolation'] = {
  exactIntoResearch: true,
  brandPhraseIntoCategoryAndCompetitor: true,
  phraseIntoBroadAndAuto: false,
}

/**
 * The design's starting phase table (§3.7). Every number is a factor or a count, never money; all editable. `weights`:
 * the budget section's, for the one phase with its own split (CLEAR_STOCK: the Auto slots' share doubled).
 */
export function defaultPhases(slots: readonly Slot[], weights: Readonly<Record<string, number>>): TemplateDoc['phases'] {
  const research = Object.fromEntries(slots.filter((s) => s.rankRole === 'research').map((s) => [s.key, 'floor' as const]))
  const autos = new Set(slots.filter((s) => s.targeting === 'AUTO').map((s) => s.key))
  const clearWeights = Object.fromEntries(Object.entries(weights).map(([key, w]) => [key, autos.has(key) ? Math.min(w * 2, 1000) : w]))
  const lenient = { minClicks: 25, maxOrders: 0, windowDays: 30 }
  const normal = { minClicks: 15, maxOrders: 0, windowDays: 30 }
  const phases: z.input<typeof PHASES_SECTION> = {
    LAUNCH: {
      recipe: { targetAcos: { from: 'breakEven', factor: 1.3, fallbackFactor: 1.5 }, harvest: { minOrders: 1, minClicks: 0, windowDays: 30 }, negate: lenient },
      rank: { performance: 'on', research: 'on' },
      harvestCadence: 'daily',
      claude: { budget: 'ask' },
      exit: [
        { to: 'GROW', when: [{ metric: 'daysInPhase', op: 'gte', value: 21 }, { metric: 'adOrders', op: 'gte', value: 10, windowDays: 14 }] },
        { to: 'GROW', when: [{ metric: 'daysInPhase', op: 'gte', value: 35 }] },
      ],
    },
    GROW: {
      recipe: { targetAcos: { from: 'marketTarget', factor: 1 }, harvest: { minOrders: 2, minClicks: 0, windowDays: 30 }, negate: normal },
      rank: { performance: 'on', research: 'on' },
      harvestCadence: 'daily',
      exit: [{ to: 'PROFIT', when: [
        { metric: 'daysInPhase', op: 'gte', value: 14 },
        { metric: 'acosToTargetPct', op: 'lte', value: 100, windowDays: 14 },
        { metric: 'ordersChangePct', op: 'gte', value: -10, windowDays: 14 },
      ] }],
    },
    PROFIT: {
      recipe: { targetAcos: { from: 'breakEven', factor: 0.8, fallbackFactor: 1 }, harvest: { minOrders: 3, minClicks: 0, maxAcosFactor: 1, windowDays: 60 }, negate: { minClicks: 10, maxOrders: 0, windowDays: 30 } },
      rank: { performance: 'off', research: 'on' },
      harvestCadence: 'weekly',
      exit: [{ to: 'GROW', when: [
        { metric: 'daysInPhase', op: 'gte', value: 14 },
        { metric: 'ordersChangePct', op: 'lte', value: -25, windowDays: 14 },
        { metric: 'acosToTargetPct', op: 'lte', value: 80, windowDays: 14 },
      ] }],
    },
    CLEAR_STOCK: {
      recipe: { targetAcos: { from: 'breakEven', factor: 2, fallbackFactor: 1.5 }, negate: normal },
      ...(autos.size && Object.keys(weights).length ? { weights: clearWeights } : {}),
      rank: { performance: 'off', research: 'off' },
      harvestCadence: 'off',
      claude: { harvest: 'ask' },
      exit: [{ to: 'ASK_OWNER', when: [{ metric: 'sellableUnits', op: 'lte', value: 5 }] }],
    },
    DEFEND: {
      recipe: { targetAcos: { from: 'marketTarget', factor: 1 }, harvest: { minOrders: 2, minClicks: 0, windowDays: 30 }, negate: normal },
      slots: research,
      rank: { performance: 'on', research: 'off' },
      harvestCadence: 'weekly',
    },
  }
  return phases as TemplateDoc['phases']
}
