import { createHash } from 'node:crypto'
import type { CatalogTranslateInput, CatalogTranslatePreview } from '@nexus/shared/products-grid'
import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { GEMINI_DEFAULT_MODEL, ANTHROPIC_DEFAULT_MODEL, rateInfoFor } from '../ai/rate-cards.js'
import { gridRequestToListQuery, resolveGridLookups } from '../products/products-grid.contract.js'
import { resolveProductsScope } from '../products/list-products.service.js'
import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import { contentField, resolveContent } from './content-resolver.js'
import { normalizeLanguage } from './content-language.js'
import { marketLanguages } from './market-languages.js'
import { writeContent } from './content-write.js'
import { produceReadiness } from './readiness-index.service.js'
import { writeTranslation } from './translation-write.js'

const BATCH_SIZE = 100
// JSONB returns object keys in storage order, which must not invalidate an unchanged draft.
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))
export const TRANSLATION_GATE = 'AI generation is disabled. You can preview the scope and estimate; drafts can be generated when the owner enables AI.'
export function requireTranslationGeneration(): never { throw Object.assign(new Error(TRANSLATION_GATE), { statusCode: 409, code: 'translation_generation_disabled' }) }
const present = (value: unknown) => value != null && value !== '' && (!Array.isArray(value) || value.length > 0)

/** The same persisted filter used by the page, with no selection or 200-row cap. */
export async function translationProductIds(input: CatalogTranslateInput, userId: string | null = null): Promise<string[]> {
  if (input.scope?.kind === 'readiness') {
    const { listingReadinessWhere } = await import('./listing-readiness.service.js')
    const where = await listingReadinessWhere(input.scope.query, userId)
    const rows = await prisma.readinessIndex.findMany({ where, select: { productId: true }, distinct: ['productId'], orderBy: { productId: 'asc' } })
    return rows.map(row => row.productId)
  }
  if (input.scope?.kind !== 'grid') throw new Error('Translate needs the catalogue or readiness page filter.')
  const grid = input.scope.grid
  const { query, unsupported } = gridRequestToListQuery(grid, await resolveGridLookups(grid))
  if (unsupported.length) throw new Error(`Translate cannot apply unsupported filters: ${unsupported.join(', ')}`)
  const { where } = await resolveProductsScope(query)
  return (await prisma.product.findMany({ where, select: { id: true }, orderBy: { id: 'asc' } })).map(row => row.id)
}

export function translationCandidate(product: any, language: string, fields: string[]) {
  const missing = fields.filter(field => {
    const resolved = resolveContent({ product, parent: product.parent, field, address: { requested: language } })
    return resolved.language !== language || !present(resolved.value)
  })
  const source = Object.fromEntries(missing.map(field => [field, resolveContent({ product, parent: product.parent, field, address: { requested: PRIMARY_CONTENT_LOCALE } }).value]).filter(([, value]) => present(value)))
  return { fields: Object.keys(source), source, status: language === PRIMARY_CONTENT_LOCALE ? 'skipped' : !missing.length ? 'alreadyHave' : Object.keys(source).length ? 'getDraft' : 'skipped' } as const
}

async function translationPlan(input: CatalogTranslateInput, userId: string | null = null) {
  const language = normalizeLanguage(input.language)
  if (!Array.isArray(input.fields) || !input.fields.length || input.fields.some(field => typeof field !== 'string' || !['title', 'name', 'description', 'bulletPoints', 'keywords'].includes(field))) throw new Error('Choose title, description, bullet points or keywords to translate.')
  const fields = [...new Set(input.fields.map(contentField))]
  const ids = await translationProductIds(input, userId), entries: Array<{ productId: string; version: number; source: Record<string, unknown>; fields: string[]; before: any }> = []
  let alreadyHave = 0, skipped = 0, inputTokens = 0, outputTokens = 0
  for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
    const products = await prisma.product.findMany({ where: { id: { in: ids.slice(offset, offset + BATCH_SIZE) }, deletedAt: null }, include: { translations: true, parent: { include: { translations: true } } }, orderBy: { id: 'asc' } })
    for (const product of products) {
      const candidate = translationCandidate(product, language, fields)
      if (candidate.status === 'alreadyHave') { alreadyHave++; continue }
      if (candidate.status === 'skipped') { skipped++; continue }
      const tokens = Math.ceil(JSON.stringify(candidate.source).length / 4)
      inputTokens += tokens + 180; outputTokens += Math.ceil(tokens * 1.3)
      entries.push({ productId: product.id, version: product.version, source: candidate.source, fields: candidate.fields,
        before: json(product.translations.find(row => normalizeLanguage(row.language) === language) ?? null) })
    }
  }
  const markets = await prisma.marketplace.findMany({ where: { isActive: true }, select: { channel: true, code: true, languages: true, language: true } })
  if (!markets.some(row => marketLanguages(row.channel, row.code, [row]).includes(language)) && language !== PRIMARY_CONTENT_LOCALE) throw new Error('Choose a language configured on an active marketplace.')
  const destinations = markets.filter(row => marketLanguages(row.channel, row.code, [row]).includes(language)).map(row => `${row.channel} · ${row.code} (${language})`)
  const label = new Intl.DisplayNames(['en'], { type: 'language' }).of(language)
  const preview: CatalogTranslatePreview = { token: hash({ ids, language, fields, entries }), language, fields, total: ids.length, getDraft: entries.length, alreadyHave, skipped: ids.length - entries.length - alreadyHave,
    reach: `Lands on the shared ${label} text. Every listing that follows it inherits on approval.`, destinations,
    estimates: ([['gemini', GEMINI_DEFAULT_MODEL], ['anthropic', ANTHROPIC_DEFAULT_MODEL]] as const).map(([provider, model]) => {
      const rate = rateInfoFor(provider, model)
      return { provider, model, usd: (inputTokens * rate.inputPer1M + outputTokens * rate.outputPer1M) / 1_000_000, inputTokens, outputTokens }
    }), generationEnabled: false, gate: TRANSLATION_GATE }
  return { preview, entries }
}
export async function previewCatalogTranslation(input: CatalogTranslateInput, userId: string | null = null) { return (await translationPlan(input, userId)).preview }

/** Internal draft landing boundary. No HTTP path supplies drafts or invokes a model.
 * Synthetic fixtures exercise exactly this future generated-draft boundary. */
export async function applyCatalogTranslationDrafts(input: CatalogTranslateInput, token: string, drafts: Record<string, Record<string, unknown>>, userId: string | null) {
  const { preview, entries } = await translationPlan(input, userId)
  if (token !== preview.token) throw Object.assign(new Error('The translation scope or source changed. Preview again.'), { statusCode: 409 })
  if (entries.some(entry => !drafts[entry.productId] || entry.fields.some(field => !present(drafts[entry.productId][field])))) throw new Error('Every previewed field needs a draft before this run can start.')
  const job = await prisma.bulkOperation.create({ data: { userId, productCount: entries.length, changeCount: entries.reduce((n, entry) => n + entry.fields.length, 0),
    status: 'RUNNING', expiresAt: new Date(Date.now() + 120_000), processed: 0, total: entries.length, changes: { kind: 'catalog-translate', language: preview.language, token, entries: json(entries), applied: [] } as any } })
  const applied: any[] = [], errors: Array<{ productId: string; error: string }> = []
  for (const [index, entry] of entries.entries()) {
    try {
      const result = await inDatabaseTransaction(prisma, async () => {
        const current = await prisma.product.findUniqueOrThrow({ where: { id: entry.productId }, include: { translations: true, parent: { include: { translations: true } } } })
        const candidate = translationCandidate(current, preview.language, preview.fields)
        if (current.deletedAt || current.version !== entry.version || hash(candidate.source) !== hash(entry.source) || hash(candidate.fields) !== hash(entry.fields)) throw new Error('The translation source changed. Preview again.')
        await writeContent({ productId: entry.productId, address: { tier: 'language', language: preview.language },
          values: Object.fromEntries(entry.fields.map(field => [field, drafts[entry.productId][field]])), label: 'Translation draft', state: 'draft',
          expectedVersion: entry.version, expectedContentVersion: entry.before?.version ?? 0, userId })
        const after = await prisma.productTranslation.findFirstOrThrow({ where: { productId: entry.productId, language: preview.language } })
        const owner = await prisma.product.findUniqueOrThrow({ where: { id: entry.productId }, select: { version: true } })
        const result = { ...entry, after: json(after), productVersion: owner.version }
        await prisma.bulkOperation.update({ where: { id: job.id }, data: { processed: index + 1, expiresAt: new Date(Date.now() + 120_000), changes: { kind: 'catalog-translate', language: preview.language, token, entries: json(entries), applied: [...applied, result] } as any } })
        return result
      })
      applied.push(result)
    } catch (error) { errors.push({ productId: entry.productId, error: error instanceof Error ? error.message : String(error) }) }
  }
  return prisma.bulkOperation.update({ where: { id: job.id }, data: { status: errors.length ? applied.length ? 'PARTIAL' : 'FAILED' : 'COMPLETED', processed: entries.length, errors, expiresAt: null, completedAt: new Date() } })
}

export async function catalogTranslationRuns(language: string, userId: string | null) {
  const rows = await prisma.bulkOperation.findMany({ where: { userId, AND: [{ changes: { path: ['kind'], equals: 'catalog-translate' } }, { changes: { path: ['language'], equals: normalizeLanguage(language) } }] }, orderBy: { createdAt: 'desc' }, take: 10,
    select: { id: true, status: true, productCount: true, changeCount: true, createdAt: true, completedAt: true } })
  return rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null }))
}

/** One run, bounded per-product transactions; newer edits are preserved and reported. */
export async function revertCatalogTranslation(jobId: string, userId: string | null) {
  const job = await prisma.bulkOperation.findFirstOrThrow({ where: { id: jobId, userId } })
  const payload = job.changes as any
  const recoverable = ['RUNNING', 'REVERTING'].includes(job.status) && job.expiresAt && job.expiresAt.getTime() < Date.now()
  if (payload?.kind !== 'catalog-translate' || !['COMPLETED', 'PARTIAL', 'REVERT_PARTIAL'].includes(job.status) && !recoverable) throw new Error('This translation run cannot be reverted.')
  const claimed = await prisma.bulkOperation.updateMany({ where: { id: job.id, status: job.status, expiresAt: job.expiresAt }, data: { status: 'REVERTING', expiresAt: new Date(Date.now() + 120_000) } })
  if (claimed.count !== 1) throw Object.assign(new Error('This run is already being reverted.'), { statusCode: 409 })
  const reverted = new Set<string>(payload.reverted ?? []), errors: Array<{ productId: string; error: string }> = []
  for (const entry of payload.applied) {
    if (reverted.has(entry.productId)) continue
    try {
      await inDatabaseTransaction(prisma, async () => {
        const [current, product] = await Promise.all([
          prisma.productTranslation.findFirst({ where: { productId: entry.productId, language: payload.language } }),
          prisma.product.findUniqueOrThrow({ where: { id: entry.productId }, select: { version: true } }),
        ])
        if (hash(json(current)) !== hash(entry.after) || product.version !== entry.productVersion) throw new Error('Edited after this run; newer work preserved.')
        if (!entry.before) await writeTranslation({ productId: entry.productId, locale: payload.language, address: { tier: 'language', language: payload.language }, values: {}, remove: true, state: 'draft', expectedVersion: product.version, expectedTranslationVersion: current!.version, userId })
        else {
          const prior = entry.before
          await writeContent({ productId: entry.productId, address: { tier: 'language', language: payload.language }, values: Object.fromEntries(entry.fields.map((field: string) => [field, prior.attributes?.[field] ?? prior[field === 'title' ? 'name' : field] ?? null])), state: 'draft', label: 'Revert translation', expectedVersion: product.version, expectedContentVersion: current!.version, userId })
          const { id, workspaceId, productId, language, createdAt, updatedAt, version, ...values } = prior
          await prisma.productTranslation.update({ where: { id: current!.id }, data: { ...values, reviewedAt: prior.reviewedAt ? new Date(prior.reviewedAt) : null, authoredAt: prior.authoredAt ? new Date(prior.authoredAt) : null } })
        }
        // LX.F F7 — the REVERT must restore the readiness index too, not just the
        // translation. The routed writers above do produce it, but this transaction then
        // restores the prior row (fingerprint, `reviewedAt`, `authoredAt`) with a raw
        // update, so the index kept the INTERMEDIATE verdict: LX.7V measured the
        // catalogue going 0 → 34 rows on apply and staying at 34 after the revert, i.e.
        // `Not computed` → `Blocked` → `Blocked` for a run that had been undone.
        // `produceReadiness` defers to `beforeDatabaseCommit`, so this re-materialises the
        // family from the FINAL state of this transaction and rolls back with it.
        await produceReadiness(entry.productId)
        await prisma.bulkOperation.update({ where: { id: job.id }, data: { changes: { ...payload, reverted: [...reverted, entry.productId] }, expiresAt: new Date(Date.now() + 120_000) } })
      })
      reverted.add(entry.productId)
    } catch (error) { errors.push({ productId: entry.productId, error: error instanceof Error ? error.message : String(error) }) }
  }
  return prisma.bulkOperation.update({ where: { id: job.id }, data: { status: errors.length ? 'REVERT_PARTIAL' : 'REVERTED', errors, expiresAt: null, completedAt: new Date() } })
}
