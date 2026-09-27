/**
 * "Fill other eBay sites" (Categories workspace, the Owner's D1 = A, 2026-09-27) — the WRITE half: save the eBay
 * category the operator confirmed for each site, and undo exactly what one such save created.
 *
 * Nothing here writes a mapping itself. Each site goes through the workspace's own assignment path — a category
 * impact review (`createMappingImpact` with a `categoryChange`), its scan, then `activateMappingImpact` — so every
 * existing guard (current rules cached, taxonomy snapshot, resolution inputs unchanged, no introduced invalid output),
 * the mapping revision and the category cascade run exactly as they do for a single assignment. Nothing is sent to eBay.
 *
 * Order matters. A review's input token hashes EVERY eBay `CategorySchema` row (`review-inputs.ts`), so a rules
 * download for one site after another site's review started would make that review stale. Hence two phases: first
 * every site's checks and rules download, then one review + activation per site, one site at a time. A site that
 * fails never stops the others.
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { readTaxonomyRequirements } from '../../taxonomy/repository.js'
import { TaxonomyError } from '../../taxonomy/model.js'
import { getMappingForMarketplace, InvalidMappingError } from '../schema-mapping.service.js'
import { fillSchemaTargets } from '../../categories/schema-coverage.service.js'
import { createMappingImpact, activateMappingImpact } from './impact.service.js'
import { mappingToken, MappingConflict } from './revision-token.js'
import { categoryName } from './category-mapping.service.js'
import { ebaySiteState } from './ebay-site-suggestions.service.js'

export interface SiteAssignmentInput { market: string; channelCategoryId: string }
export interface SiteAssignmentResult {
  market: string
  channelCategoryId: string
  outcome: 'assigned' | 'failed'
  reason?: string
  /** `assigned` only: when the mapping was saved. Undo removes the row only while it still carries this stamp. */
  assignedAt?: string
}
export interface SiteUndoInput { market: string; channelCategoryId: string; assignedAt: string }
export interface SiteUndoResult { market: string; channelCategoryId: string; outcome: 'removed' | 'unchanged' | 'failed'; reason?: string }

const MARKET = /^[A-Z]{2,3}$/
const EBAY_LEAF = /^[1-9]\d{0,18}$/
const MAX_SITES = 20
const where = (market: string) => `eBay · ${market}`

export interface ReviewOptions { pollMs?: number; timeoutMs?: number }

function readCategoryId(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 300) throw new TaxonomyError('Choose a category.')
  return value
}

function readSites<T extends { market: string; channelCategoryId: string }>(value: unknown, extra?: (row: Record<string, unknown>) => Partial<T>): T[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_SITES) throw new TaxonomyError(`Choose between 1 and ${MAX_SITES} eBay sites.`)
  const seen = new Set<string>()
  return value.map(raw => {
    const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const market = typeof row.market === 'string' ? row.market.trim().toUpperCase() : ''
    const channelCategoryId = typeof row.channelCategoryId === 'string' ? row.channelCategoryId.trim() : ''
    // '*' is never a site: an all-sites eBay default would apply one site's leaf id to every other tree.
    if (!MARKET.test(market)) throw new TaxonomyError('Name each eBay site by its code, for example DE. An all-sites assignment is not allowed here.')
    if (!EBAY_LEAF.test(channelCategoryId)) throw new TaxonomyError(`Choose an eBay category number for ${where(market)}.`)
    if (seen.has(market)) throw new TaxonomyError(`${where(market)} is listed twice.`)
    seen.add(market)
    return { market, channelCategoryId, ...(extra?.(row) ?? {}) } as T
  })
}

function reasonOf(error: unknown): string {
  if (error instanceof InvalidMappingError) return error.errors.join(' ')
  if (error instanceof Error && error.message) return error.message
  return 'The assignment could not be completed.'
}

type ReviewEnd = { state: 'MAPPING_REVIEW'; introducedInvalid: number } | { state: 'MAPPING_STALE' | 'MAPPING_FAILED' | 'TIMEOUT'; error?: string }

/** Wait for a review's scan to end: `createMappingImpact` starts it in the background. */
async function waitForReview(jobId: string, options: ReviewOptions): Promise<ReviewEnd> {
  const pollMs = options.pollMs ?? 500
  const deadline = Date.now() + (options.timeoutMs ?? 120_000)
  while (true) {
    const job = await prisma.bulkOperation.findUnique({ where: { id: jobId }, select: { status: true, changes: true, errors: true } })
    const status = job?.status
    if (status === 'MAPPING_REVIEW') {
      const counts = (job!.changes as { counts?: { introducedInvalid?: number } } | null)?.counts
      return { state: 'MAPPING_REVIEW', introducedInvalid: counts?.introducedInvalid ?? 0 }
    }
    if (status === 'MAPPING_STALE' || status === 'MAPPING_FAILED') {
      const first = Array.isArray(job!.errors) ? (job!.errors[0] as { message?: unknown } | undefined) : undefined
      return { state: status, error: typeof first?.message === 'string' ? first.message : undefined }
    }
    if (!job || Date.now() >= deadline) return { state: 'TIMEOUT' }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
}

/**
 * One category change for one site through the workspace's review → activation path. Returns null when it was
 * activated, else the reason in the operator's words.
 */
async function reviewAndActivate(input: { market: string; categoryId: string; channelCategoryId: string | null; actor: string | null; removing: boolean }, options: ReviewOptions): Promise<string | null> {
  const expectedToken = mappingToken(await getMappingForMarketplace('EBAY', input.market))
  const { jobId } = await createMappingImpact({ channel: 'EBAY', market: input.market, expectedToken, userId: input.actor,
    categoryChange: { categoryId: input.categoryId, channelCategoryId: input.channelCategoryId } })
  const review = await waitForReview(jobId, options)
  if (review.state === 'MAPPING_STALE') return `Products, categories or rules changed while ${where(input.market)} was being checked. Nothing was ${input.removing ? 'removed' : 'assigned'}. Try again.`
  if (review.state === 'MAPPING_FAILED') return `The check for ${where(input.market)} failed${review.error ? `: ${review.error}` : ''}. Nothing was ${input.removing ? 'removed' : 'assigned'}.`
  if (review.state === 'TIMEOUT') return `The check for ${where(input.market)} is taking longer than two minutes. Nothing was ${input.removing ? 'removed' : 'assigned'}. Try again later.`
  const invalid = review.state === 'MAPPING_REVIEW' ? review.introducedInvalid : 0
  try {
    await activateMappingImpact(jobId, input.actor)
    return null
  } catch (error) {
    if (error instanceof MappingConflict && invalid > 0) {
      const fields = `${invalid} product ${invalid === 1 ? 'field' : 'fields'} on ${where(input.market)}`
      return input.removing
        ? `Removing it would leave ${fields} without a valid value, for example products with no eBay category. The existing check refused it, so nothing was removed.`
        : `With this category, ${fields} would have no valid value, for example a required item specific with no value. The existing check refused it, so nothing was assigned. Assign it in Channel assignments to see the fields.`
    }
    throw error
  }
}

async function mappingRow(categoryId: string, market: string) {
  return prisma.categoryChannelMapping.findFirst({ where: { categoryId, channel: 'EBAY', marketplace: market }, select: { id: true, channelCategoryId: true, reviewedAt: true } })
}

/**
 * POST /pim/category-workspace/EBAY/site-assignments — `{ categoryId, assignments: [{ market, channelCategoryId }] }`.
 * For each site: refuse a site that is not active or already has a category (its own, a '*' default or inherited);
 * check the leaf is in that site's tree and assignable; download its rules when they are missing or expired; then save
 * through the review → activation path. Idempotent through `COMMAND_SCOPES` (one Idempotency-Key, one run).
 */
export async function applyEbaySiteAssignments(body: { categoryId?: unknown; assignments?: unknown }, actor: string | null, options: ReviewOptions = {}) {
  const categoryId = readCategoryId(body?.categoryId)
  const assignments = readSites<SiteAssignmentInput>(body?.assignments)
  const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true, name: true, slug: true } })
  if (!category) throw new TaxonomyError('Category no longer exists.', 404)
  const name = categoryName(category.name) ?? category.slug
  const state = await ebaySiteState()
  const missing = new Set(state.missing.get(categoryId) ?? [])

  const results = new Map<string, SiteAssignmentResult>()
  const fail = (site: SiteAssignmentInput, reason: string) => results.set(site.market, { ...site, outcome: 'failed', reason })
  const ready: SiteAssignmentInput[] = []
  let rulesChanged = false

  // Phase 1 — checks and rules downloads for every site, before any review starts.
  for (const site of assignments) {
    try {
      if (!state.sites.includes(site.market)) { fail(site, `${where(site.market)} is not an active eBay site.`); continue }
      if (!missing.has(site.market)) { fail(site, `${name} already has a category on ${where(site.market)}. Change it in Channel assignments.`); continue }
      const requirements = await readTaxonomyRequirements('EBAY', site.market, site.channelCategoryId)
      if (requirements.state === 'notAssignable') { fail(site, `${site.channelCategoryId} is not a leaf category on ${where(site.market)}. Choose a leaf category.`); continue }
      if (requirements.state === 'missing' || requirements.state === 'stale') {
        const { results: [download] } = await fillSchemaTargets([{ channel: 'EBAY', marketplace: site.market, productType: site.channelCategoryId, status: requirements.state, fetchedAt: null, expiresAt: null }],
          { service: await schemaService(), refreshCached: true, throttleMs: 0, label: 'category-workspace/ebay-site-assignments' })
        if (download?.outcome !== 'added' && download?.outcome !== 'refreshed') { fail(site, `eBay's rules for ${site.channelCategoryId} on ${where(site.market)} could not be downloaded${download?.error ? `: ${download.error}` : ''}. Nothing was assigned.`); continue }
        rulesChanged = true
      }
      ready.push(site)
    } catch (error) {
      fail(site, reasonOf(error))
    }
  }
  if (rulesChanged) await clearColumnCaches()

  // Phase 2 — one review and activation per site, one at a time.
  for (const site of ready) {
    try {
      const refused = await reviewAndActivate({ market: site.market, categoryId, channelCategoryId: site.channelCategoryId, actor, removing: false }, options)
      if (refused) { fail(site, refused); continue }
      const row = await mappingRow(categoryId, site.market)
      results.set(site.market, { ...site, outcome: 'assigned', ...(row?.reviewedAt ? { assignedAt: row.reviewedAt.toISOString() } : {}) })
    } catch (error) {
      logger.warn('category-workspace: eBay site assignment failed', { categoryId, market: site.market, error: reasonOf(error) })
      fail(site, reasonOf(error))
    }
  }

  const ordered = assignments.map(site => results.get(site.market)!)
  return { categoryId, results: ordered, counts: { assigned: ordered.filter(r => r.outcome === 'assigned').length, failed: ordered.filter(r => r.outcome === 'failed').length } }
}

/**
 * DELETE /pim/category-workspace/EBAY/site-assignments — `{ categoryId, assignments: [{ market, channelCategoryId,
 * assignedAt }] }`, the `assigned` rows one apply returned. Removes a site's mapping only while it is still exactly
 * the one that apply saved (same category number and the same saved-at stamp), through the workspace's own unassign
 * path (a category review with no category, then activation). A site changed since then is left as it is.
 */
export async function undoEbaySiteAssignments(body: { categoryId?: unknown; assignments?: unknown }, actor: string | null, options: ReviewOptions = {}) {
  const categoryId = readCategoryId(body?.categoryId)
  const assignments = readSites<SiteUndoInput>(body?.assignments, row => ({ assignedAt: typeof row.assignedAt === 'string' ? row.assignedAt : '' }))
  const results: SiteUndoResult[] = []
  for (const site of assignments) {
    const base = { market: site.market, channelCategoryId: site.channelCategoryId }
    try {
      const row = await mappingRow(categoryId, site.market)
      if (!row) { results.push({ ...base, outcome: 'unchanged', reason: `${where(site.market)} has no category of its own any more.` }); continue }
      if (row.channelCategoryId !== site.channelCategoryId || !site.assignedAt || row.reviewedAt?.toISOString() !== site.assignedAt) {
        results.push({ ...base, outcome: 'unchanged', reason: `${where(site.market)} was changed after this assignment, so it was left as it is.` }); continue
      }
      const refused = await reviewAndActivate({ market: site.market, categoryId, channelCategoryId: null, actor, removing: true }, options)
      results.push(refused ? { ...base, outcome: 'failed', reason: refused } : { ...base, outcome: 'removed' })
    } catch (error) {
      logger.warn('category-workspace: eBay site undo failed', { categoryId, market: site.market, error: reasonOf(error) })
      results.push({ ...base, outcome: 'failed', reason: reasonOf(error) })
    }
  }
  return { categoryId, results, counts: { removed: results.filter(r => r.outcome === 'removed').length, unchanged: results.filter(r => r.outcome === 'unchanged').length, failed: results.filter(r => r.outcome === 'failed').length } }
}

/** The ordinary rules cache path (`CategorySchemaService.getSchema` / `refreshSchema`), built on first use. */
let cachedService: Parameters<typeof fillSchemaTargets>[1]['service'] | null = null
async function schemaService() {
  if (cachedService) return cachedService
  const [{ CategorySchemaService }, { AmazonService }] = await Promise.all([import('../../categories/schema-sync.service.js'), import('../../marketplaces/amazon.service.js')])
  cachedService = new CategorySchemaService(prisma as never, new AmazonService())
  return cachedService
}

/** The sheet's in-memory column caches, as `POST /categories/schema/download` clears them after a download. */
async function clearColumnCaches() {
  const [{ clearSheetColumnCache }, { clearStudioColumnCache }] = await Promise.all([import('../sheet-columns.service.js'), import('../studio-columns.js')])
  clearSheetColumnCache(); clearStudioColumnCache()
}
