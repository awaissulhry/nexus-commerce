/**
 * Reviews › Settings › Automations — the list, and one review automation in the rules builder (read and save). The
 * rules of what the builder shows and stores are pure, in review-automation-builder.ts; this file reads and writes.
 *
 *   GET /api/reviews/automation-rules        the review automations, each with what it does in words
 *   GET /api/reviews/automation-rules/:id    one, as the builder shows it, with the themes, markets and products to pick
 *   PUT /api/reviews/automation-rules/:id    a person's save from the builder: only what changed is written, never the
 *                                            on / off switch or trial run; an audit row names the person and the change
 */
import prisma from '../../db.js'
import { auditLogService } from '../audit-log.service.js'
import { COMPLAINT_SPIKE_RULE } from './complaint-spike-math.js'
import { marketWords, themeWords } from './overviewMath.js'
import {
  REVIEW_AUTOMATION_THEMES, buildReviewRuleWrite, listedWords, readReviewRule, validateReviewAutomation,
  type ChangedPart, type ReviewAutomationView,
} from './review-automation-builder.js'

const NOT_FOUND = 'Nexus could not find this review automation.'

const RULE_SELECT = {
  id: true, name: true, description: true, trigger: true, conditions: true, actions: true, scopeMarketplace: true,
  maxExecutionsPerDay: true, enabled: true, dryRun: true, lastEvaluatedAt: true, updatedAt: true,
} as const

/** The review automations, newest first, each with what it does in words (null: an unchanged template's own words). */
export async function listReviewAutomations(limit: number) {
  const rows = await prisma.automationRule.findMany({ where: { domain: 'reviews' }, orderBy: { createdAt: 'desc' }, take: limit })
  const items = rows.map((row) => ({ ...row, words: listedWords(row) }))
  return { items, count: items.length }
}

export interface PickOption { value: string; label: string }
export interface ProductPick extends PickOption { sku: string | null; gone?: true }

export interface ReviewAutomationRead {
  rule: { id: string; name: string; enabled: boolean; dryRun: boolean; lastEvaluatedAt: Date | null; updatedAt: Date }
  view: ReviewAutomationView
  kept: string[]
  whenHeld: string | null
  thenHeld: string | null
  /** The hourly spike check's own bar: an alert is raised only at this many times the usual share or more. */
  spikeCheck: { multiplier: number; minNegative: number; recentDays: number; baselineDays: number }
  options: { themes: PickOption[]; markets: PickOption[]; products: ProductPick[] }
}

/** The markets reviews are counted in, as stored (the evaluator compares them as they are). */
async function marketCodes(): Promise<Set<string>> {
  const [rates, spikes] = await Promise.all([
    prisma.reviewCategoryRate.findMany({ distinct: ['marketplace'], select: { marketplace: true } }),
    prisma.reviewSpike.findMany({ distinct: ['marketplace'], select: { marketplace: true } }),
  ])
  return new Set([...rates, ...spikes].map((r) => r.marketplace).filter((m) => !!m && m.trim() !== ''))
}

/**
 * The products a review automation can name: every whole product (a parent, or a product with no sizes or colours)
 * with a review counted for it, plus the ones the rule names already — a removed one stays listed, marked gone.
 */
async function productPicks(named: readonly string[]): Promise<ProductPick[]> {
  const rated = await prisma.reviewCategoryRate.findMany({ distinct: ['productId'], select: { productId: true }, take: 5000 })
  const ids = rated.map((r) => r.productId)
  const products = ids.length ? await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, parentId: true } }) : []
  const families = new Set([...products.map((p) => p.parentId ?? p.id), ...named])
  const heads = families.size
    ? await prisma.product.findMany({ where: { id: { in: [...families] }, deletedAt: null, parentId: null }, select: { id: true, sku: true, name: true } })
    : []
  const found = new Set(heads.map((h) => h.id))
  const picks: ProductPick[] = heads
    .map((h) => ({ value: h.id, label: h.name?.trim() || h.sku, sku: h.sku }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value))
  for (const id of named) if (!found.has(id)) picks.push({ value: id, label: 'A product no longer in Nexus', sku: null, gone: true })
  return picks
}

/** One review automation as the builder shows it; null when there is none with this id. */
export async function readReviewAutomation(id: string): Promise<ReviewAutomationRead | null> {
  const rule = await prisma.automationRule.findFirst({ where: { id, domain: 'reviews' }, select: RULE_SELECT })
  if (!rule) return null
  const reading = readReviewRule(rule)
  const [codes, products] = await Promise.all([marketCodes(), productPicks(reading.view.families)])
  if (reading.view.market) codes.add(reading.view.market)
  const check = COMPLAINT_SPIKE_RULE
  return {
    rule: { id: rule.id, name: rule.name, enabled: rule.enabled, dryRun: rule.dryRun, lastEvaluatedAt: rule.lastEvaluatedAt, updatedAt: rule.updatedAt },
    ...reading,
    spikeCheck: { multiplier: check.multiplier, minNegative: check.minNegative, recentDays: check.recentDays, baselineDays: check.baselineDays },
    options: {
      themes: REVIEW_AUTOMATION_THEMES.map((t) => ({ value: t, label: themeWords(t) })),
      markets: [...codes].sort().map((code) => ({ value: code, label: marketWords(code) ?? code })),
      products,
    },
  }
}

export type SaveReviewAutomationResult =
  | { ok: true; changed: ChangedPart[]; rule: { id: string; name: string; enabled: boolean; dryRun: boolean; updatedAt: Date }; words: string | null }
  | { ok: false; code: 400 | 404 | 409; words: string }

const AUDIT_KEYS = ['name', 'description', 'conditions', 'actions', 'scopeMarketplace', 'maxExecutionsPerDay'] as const

/**
 * A person's save from the builder. Only what changed is written (nothing at all when nothing changed); on / off and
 * trial run are never touched. `updatedAt`, when sent, is the version the builder read: a rule changed since is refused.
 */
export async function saveReviewAutomation(id: string, body: unknown, actor: string): Promise<SaveReviewAutomationResult> {
  const rule = await prisma.automationRule.findFirst({ where: { id, domain: 'reviews' }, select: RULE_SELECT })
  if (!rule) return { ok: false, code: 404, words: NOT_FOUND }
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (typeof b.updatedAt === 'string' && new Date(b.updatedAt).getTime() !== rule.updatedAt.getTime()) {
    return { ok: false, code: 409, words: 'This automation changed while you were editing it. Reload, then make your change again.' }
  }
  const reading = readReviewRule(rule)
  const asked = Array.isArray(b.families) ? b.families.filter((x): x is string => typeof x === 'string') : []
  const [pickable, markets] = await Promise.all([
    asked.length
      ? prisma.product.findMany({ where: { id: { in: asked }, deletedAt: null, parentId: null }, select: { id: true } }).then((rows) => new Set(rows.map((r) => r.id)))
      : Promise.resolve(new Set<string>()),
    marketCodes(),
  ])
  const check = validateReviewAutomation(body, { stored: reading.view, pickable, markets })
  if (check.ok === false) return { ok: false, code: 400, words: check.words }

  const { data, changed } = buildReviewRuleWrite(rule, reading, check.view)
  const summary = (r: typeof rule) => ({ id: r.id, name: r.name, enabled: r.enabled, dryRun: r.dryRun, updatedAt: r.updatedAt })
  if (!changed.length) return { ok: true, changed, rule: summary(rule), words: listedWords(rule) }

  const saved = await prisma.automationRule.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.conditions !== undefined ? { conditions: data.conditions as object } : {}),
      ...(data.actions !== undefined ? { actions: data.actions as object } : {}),
      ...(data.scopeMarketplace !== undefined ? { scopeMarketplace: data.scopeMarketplace } : {}),
      ...(data.maxExecutionsPerDay !== undefined ? { maxExecutionsPerDay: data.maxExecutionsPerDay } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
    },
    select: RULE_SELECT,
  })
  const slim = (r: typeof rule) => Object.fromEntries(AUDIT_KEYS.filter((k) => k in data).map((k) => [k, r[k] ?? null]))
  await auditLogService.write({
    userId: actor, entityType: 'AutomationRule', entityId: id, action: 'update',
    before: slim(rule), after: slim(saved), metadata: { domain: 'reviews', via: 'rules builder', changed },
  })
  return { ok: true, changed, rule: summary(saved), words: listedWords(saved) }
}
