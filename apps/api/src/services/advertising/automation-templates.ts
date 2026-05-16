/**
 * AD.3 — Five Italian advertising automation rule templates.
 *
 * Seeded on operator demand via POST /api/advertising/automation-rules/seed-templates.
 * Idempotent — keyed on (name, domain='advertising') so re-running is safe.
 * All seed with enabled=false + dryRun=true; operator must explicitly opt
 * in to live writes.
 *
 * Conditions DSL fields these templates reference are populated by the
 * trigger context builders in advertising-rule-evaluator.job.ts.
 */

import prisma from '../../db.js'

export interface AdvertisingRuleTemplate {
  name: string
  description: string
  trigger: string
  conditions: object[]
  actions: object[]
  maxExecutionsPerDay: number | null
  maxValueCentsEur: number | null
  maxDailyAdSpendCentsEur: number | null
  scopeMarketplace: string | null
}

export const ADVERTISING_TEMPLATES: AdvertisingRuleTemplate[] = [
  {
    name: 'Pausa pubblicità per stock invecchiato',
    description:
      'Quando uno SKU ha unità FBA che entreranno nella fascia LTS entro 14 giorni, mette in pausa l\'ad-group che pubblicizza prodotti NUOVI dello stesso productType e crea un coupon-promo del 15% per 14 giorni. Riduce la spesa pubblicitaria sul fresco e accelera la liquidazione del vecchio.',
    trigger: 'FBA_AGE_THRESHOLD_REACHED',
    conditions: [
      { field: 'fbaAge.daysToLtsThreshold', op: 'lte', value: 14 },
    ],
    actions: [
      { type: 'pause_ad_group', reason: 'Aged stock liquidation — fresh-product ad-group paused' },
      {
        type: 'create_amazon_promotion',
        discountPct: 15,
        durationDays: 14,
        reason: 'Auto-promo per liquidare stock invecchiato',
      },
      { type: 'notify', target: 'operator', message: 'Pausa ad-group + promo 15% per SKU sotto soglia LTS' },
    ],
    maxExecutionsPerDay: 20,
    maxValueCentsEur: 50000,
    maxDailyAdSpendCentsEur: 10000,
    scopeMarketplace: null,
  },
  {
    name: 'Riduci bid su ACOS spike',
    description:
      'Quando l\'ACOS di una campagna supera 1.0 (= spesa ≥ vendite, break-even o peggio) con spesa ≥ €100, abbassa il bid di default dell\'ad-group del 20% (con floor €0.05). Difensivo: previene emorragie di budget su keyword diventate non redditizie.',
    trigger: 'CAC_SPIKE',
    conditions: [
      { field: 'campaign.acos', op: 'gte', value: 1.0 },
    ],
    actions: [
      { type: 'bid_down', target: 'ad_group', percent: 20, reason: 'ACOS spike — bid -20%' },
      { type: 'notify', target: 'operator', message: 'Bid ridotto del 20% per ACOS > 1.0' },
    ],
    maxExecutionsPerDay: 30,
    maxValueCentsEur: 0,
    maxDailyAdSpendCentsEur: null,
    scopeMarketplace: null,
  },
  {
    name: 'Pausa target non redditizio',
    description:
      'Quando un target (keyword o ASIN) ha speso ≥ €20 senza generare vendite, mette in pausa l\'ad-group che lo contiene. Trade-off: l\'azione è grossolana (pause dell\'intero ad-group, non solo del target) perché Amazon Ads non espone bid-zero affidabile. Operatore può perfezionare manualmente.',
    trigger: 'AD_TARGET_UNDERPERFORMING',
    conditions: [
      { field: 'adTarget.spendCents', op: 'gte', value: 2000 },
      { field: 'adTarget.salesCents', op: 'eq', value: 0 },
    ],
    actions: [
      { type: 'pause_ad_group', reason: 'Target non redditizio — ad-group pausato' },
      { type: 'notify', target: 'operator', message: 'Ad-group pausato per target senza vendite' },
    ],
    maxExecutionsPerDay: 30,
    maxValueCentsEur: 0,
    maxDailyAdSpendCentsEur: null,
    scopeMarketplace: null,
  },
  {
    name: 'Allerta margine pubblicitario negativo',
    description:
      'Notifica l\'operatore quando la spesa pubblicitaria di una campagna nelle ultime 30 giornate supera il profitto reale dei prodotti che pubblicizza. Solo notify — l\'operatore decide l\'azione correttiva (riduzione budget, pausa, cambio creatività).',
    trigger: 'AD_SPEND_PROFITABILITY_BREACH',
    conditions: [
      { field: 'profit.netCents', op: 'lt', value: 0 },
    ],
    actions: [
      {
        type: 'notify',
        target: 'operator',
        message: 'Spesa pubblicitaria > profitto reale negli ultimi 30g — rivedi la campagna',
      },
    ],
    maxExecutionsPerDay: 10,
    maxValueCentsEur: null,
    maxDailyAdSpendCentsEur: null,
    scopeMarketplace: null,
  },
  {
    name: 'Aumenta budget su campagne redditizie',
    description:
      'Quando l\'ACOS è basso (< 0.20) e impressioni > 5000, suggerisce un +15% al budget giornaliero della campagna (rispettando maxDailyAdSpendCentsEur). Dry-run di default — l\'operatore approva l\'auto-up per ciascuna campagna.',
    trigger: 'AD_TARGET_UNDERPERFORMING', // inverse-signal proxy until a dedicated trigger lands in AD.5
    conditions: [
      { field: 'campaign.acos', op: 'lte', value: 0.2 },
      { field: 'adTarget.spendCents', op: 'gte', value: 5000 },
    ],
    actions: [
      {
        type: 'adjust_ad_budget',
        percent: 15,
        reason: 'Campagna redditizia (ACOS < 0.20) — budget +15%',
      },
      { type: 'notify', target: 'operator', message: 'Budget aumentato del 15% su campagna ad alto ROAS' },
    ],
    maxExecutionsPerDay: 10,
    maxValueCentsEur: 50000,
    maxDailyAdSpendCentsEur: 20000,
    scopeMarketplace: null,
  },
]

export interface SeedAdvertisingTemplatesResult {
  created: string[]
  skippedExisting: string[]
}

export async function seedAdvertisingTemplates(): Promise<SeedAdvertisingTemplatesResult> {
  const created: string[] = []
  const skippedExisting: string[] = []
  for (const tmpl of ADVERTISING_TEMPLATES) {
    const existing = await prisma.automationRule.findFirst({
      where: { name: tmpl.name, domain: 'advertising' },
      select: { id: true },
    })
    if (existing) {
      skippedExisting.push(tmpl.name)
      continue
    }
    await prisma.automationRule.create({
      data: {
        name: tmpl.name,
        description: tmpl.description,
        domain: 'advertising',
        trigger: tmpl.trigger,
        conditions: tmpl.conditions as object,
        actions: tmpl.actions as object,
        enabled: false,
        dryRun: true,
        maxExecutionsPerDay: tmpl.maxExecutionsPerDay ?? 10,
        maxValueCentsEur: tmpl.maxValueCentsEur,
        maxDailyAdSpendCentsEur: tmpl.maxDailyAdSpendCentsEur ?? 10000,
        scopeMarketplace: tmpl.scopeMarketplace,
        createdBy: 'template-seeder:advertising',
      },
    })
    created.push(tmpl.name)
  }
  return { created, skippedExisting }
}
