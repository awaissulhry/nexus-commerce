import { normalizeLanguage } from '../../pim/content-language.js'
import { resolveContent, translationMissing } from '../../pim/content-resolver.js'
/**
 * PES.8 — the draft lifecycle: record, overlay, decide.
 *
 * The one invariant this file exists to hold: an AI value becomes a catalogue
 * value ONLY through `approveDrafts`, and `approveDrafts` never writes a
 * product itself. It replays each approved cell through `PATCH
 * /api/products/bulk` — the same route the sheet's own autosave uses — so the
 * value meets the same allowlist, the same per-field validation, and the same
 * audit row an operator's keystroke would.
 * A draft is stamped `approved` only for changes that route reported as
 * written; anything it refused stays `pending` with the refusal on the row.
 *
 * Staleness is checked against the value AT THE WRITE ADDRESS, not the resolved
 * value: the question an approval has to answer is "would this overwrite an
 * edit made since we drafted", and that is a question about the stored cell.
 *
 * ── What guards a concurrent write, and what does not ──────────────────────
 * (PES.5's finding, hub ruling #95. An earlier version of this comment claimed
 * "the same `expectedVersion` 409" — it was wrong: this path never sends one.)
 *
 * Not sending it is deliberate, and the alternative would not have helped.
 * `Product.version` only advances on the single-editor path — PES.5 confirmed
 * 124 other write sites (sync-drift, catalog-refresh, bulk, pricing) never bump
 * it — so a WINNING CAS proves "no other EDITOR touched this", not "the row is
 * unchanged". It would have read as protection while a sync job overwrote.
 *
 * What actually guards an approval is the staleness check above: it re-reads
 * the stored value and compares VALUES, not a counter. That makes it immune to
 * the same gap — a sync job rewriting a description without bumping `version`
 * trips it, where a CAS sails through.
 *
 * Residual, accepted: a TOCTOU window of milliseconds between that read and the
 * PATCH. Version CAS would not close it either. Acceptable HERE specifically
 * because a human has just reviewed this exact diff against on-screen data, the
 * write is one field, and the `ai-draft.approve` audit row carries before/after,
 * so a collision is traceable and reversible. If the Owner's architecture queue
 * lands a real version bump (a Prisma extension), this path should adopt
 * `expectedVersion` for single-product batches — but it must KEEP the value
 * check, which is the stronger of the two.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import prisma from '../../../db.js'
import { auditLogService } from '../../audit-log.service.js'
import { decodeCellKey, type CellAddress } from './cell-key.js'

export type DraftStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'superseded'
  | 'failed'

/** What the sheet overlay needs to tint and diff one cell. */
export interface DraftOverlayRow {
  id: string
  productId: string
  cellKey: string
  writeField: string
  columnKey: string
  channel: string | null
  marketplace: string | null
  aliasId: string | null
  locale: string | null
  draftValue: unknown
  baseValue: unknown
  baseSource: string | null
  status: DraftStatus
  confidence: string | null
  rationale: string | null
  violations: unknown
  capsUsed: unknown
  runId: string
  provider: string
  model: string
  createdAt: string
  /** True when the stored cell has moved since we drafted — approve overwrites. */
  stale: boolean
  /**
   * True when we could not resolve the draft's address to one stored row, so
   * `stale` is unknown rather than false. The review view must say so instead
   * of showing a clean cell; approval refuses these outright.
   */
  unverified: boolean
  /** The value the cell holds right now, when `stale`. */
  currentValue?: unknown
  lastApplyError: string | null
}

// The five channel fields `PATCH /api/products/bulk` actually wires today. Kept
// in step with CHANNEL_FIELD_MAP in products.routes.ts — a field missing here
// reads as "no current value", so the staleness check would pass a cell it
// cannot actually see. Drafting is refused for any field not in this map or on
// the master allowlist, so the two lists cannot silently diverge into a lie.
const CHANNEL_FIELD_TARGET: Record<string, 'title' | 'description' | 'variationTheme'> = {
  amazon_title: 'title',
  amazon_description: 'description',
  ebay_title: 'title',
  ebay_description: 'description',
  amazon_variationTheme: 'variationTheme',
  ebay_variationTheme: 'variationTheme',
}

/**
 * D7 — the four keys that live per-locale in `ProductTranslation`, not on `Product`.
 *
 * These do NOT go through `PATCH /api/products/bulk`: its allowlist has no `title` and no locale
 * dimension at all, so a translated value has no address there. They apply through
 * `PUT /api/products/:id/translations/:language`, which is a genuinely different write path — the
 * thing this lane assumed was shared and is not.
 */
const LOCALIZED_KEYS: Record<string, 'name' | 'description' | 'bulletPoints' | 'keywords'> = {
  title: 'name',
  name: 'name',
  description: 'description',
  bulletPoints: 'bulletPoints',
  keywords: 'keywords',
}

/** True when this draft is a per-locale translation rather than a master/channel cell. */
export function isTranslationDraft(addr: { locale: string | null; channel: string | null }): boolean {
  return addr.locale !== null && addr.channel === null
}

/** Master `Product` columns a draft may target. Mirrors the bulk PATCH allowlist. */
const MASTER_TEXT_FIELDS = new Set([
  'name',
  'description',
  'bulletPoints',
  'keywords',
  'brand',
  'manufacturer',
  'productType',
  'countryOfOrigin',
])

export function isDraftableField(writeField: string, locale?: string | null): boolean {
  // A locale-scoped draft can only target the four keys ProductTranslation actually stores.
  if (locale) return Object.prototype.hasOwnProperty.call(LOCALIZED_KEYS, writeField)
  return (
    writeField.startsWith('attr_') ||
    MASTER_TEXT_FIELDS.has(writeField) ||
    Object.prototype.hasOwnProperty.call(CHANNEL_FIELD_TARGET, writeField)
  )
}

// ────────────────────────────────────────────────────────────────────
// Reading the value that is actually stored at a draft's write address
// ────────────────────────────────────────────────────────────────────

export interface CurrentValueAnswer {
  /** True when we could read the cell. */
  found: boolean
  /**
   * True when the address does not resolve to exactly one stored row — a
   * channel scope naming an alias we cannot map to a `ChannelListing`. It is
   * NOT the same as `found: false`: unreadable means "no such cell", ambiguous
   * means "several, and we will not guess which one you meant". Approval
   * refuses on ambiguous, because a staleness check we could not actually run
   * is worse than one we skipped knowingly.
   */
  ambiguous: boolean
  value: unknown
}

interface CurrentValueLookup {
  get(productId: string, addr: CellAddress): CurrentValueAnswer
}

/**
 * One read per product + one per channel-listing set, then pure lookups. The
 * approve path handles tens of cells, not thousands, but it is called from a
 * request the operator is watching, so it stays three queries regardless of
 * how many drafts are in the batch.
 */
export async function loadCurrentValues(
  productIds: string[],
  addresses: CellAddress[],
): Promise<CurrentValueLookup> {
  const ids = [...new Set(productIds)]
  const needsChannel = addresses.some((a) => a.channel !== null)
  const localesNeeded = [...new Set(addresses.map((a) => a.locale).filter(Boolean))] as string[]

  const products = await prisma.product.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, workspaceId: true, parentId: true, translations: true, parent: { include: { translations: true } },
      name: true,
      description: true,
      bulletPoints: true,
      keywords: true,
      brand: true,
      manufacturer: true,
      productType: true,
      countryOfOrigin: true,
      categoryAttributes: true,
    },
  })
  const byProduct = new Map(products.map((p) => [p.id, p]))

  // PES.5's listing aliases mean a (product, channel, marketplace) coordinate
  // can carry SEVERAL ChannelListing rows — the primary (aliasId null) plus one
  // per alias. Keying the lookup on the coordinate alone would silently collapse
  // them and compare a draft against whichever row came back last.
  //
  // The alias is therefore part of the key, BY ID. An earlier cut of this keyed
  // on `ProductListingAlias.label`, which PES.5 (ruling #20) confirmed is not
  // unique per coordinate — the DB unique is on `position`. A duplicate label
  // would have resolved to the wrong listing and answered confidently, which is
  // worse than the ambiguity refusal it bypassed. An id cannot do that.
  const listings = needsChannel
    ? await prisma.channelListing.findMany({
        where: { productId: { in: ids } },
        select: {
          productId: true,
          channel: true,
          marketplace: true,
          aliasId: true,
          title: true,
          description: true,
          variationTheme: true,
        },
      })
    : []
  // Which alias ids still exist, so a draft naming a DELETED alias is refused
  // rather than read as "that cell is empty" — the two look identical from the
  // listing table alone, and only one of them is safe to approve over.
  const liveAliasIds = new Set(
    needsChannel
      ? (
          await prisma.productListingAlias.findMany({
            where: { productId: { in: ids } },
            select: { id: true },
          })
        ).map((a) => a.id)
      : [],
  )

  const PRIMARY = '\u0000primary'
  const coordKey = (productId: string, channel: string, marketplace: string | null) =>
    `${productId}:${channel}:${marketplace}`
  const byListing = new Map(
    listings.map((l) => [
      `${coordKey(l.productId, l.channel, l.marketplace)}:${l.aliasId ?? PRIMARY}`,
      l,
    ]),
  )

  return {
    get(productId, addr) {
      if (isTranslationDraft(addr)) {
        const target = LOCALIZED_KEYS[addr.writeField]
        if (!target) return { found: false, ambiguous: false, value: null }
        const product = byProduct.get(productId)
        if (!product) return { found: false, ambiguous: false, value: null }
        const requested = normalizeLanguage(addr.locale!)
        const resolved = resolveContent({ product: product as any, parent: product.parent as any, field: target, address: { requested } })
        return { found: true, ambiguous: false, value: translationMissing(resolved, requested) ? null : resolved.value }

      }
      if (addr.channel !== null) {
        const target = CHANNEL_FIELD_TARGET[addr.writeField]
        if (!target) return { found: false, ambiguous: false, value: null }
        const coord = coordKey(productId, addr.channel, addr.marketplace)
        let slot = PRIMARY
        if (addr.aliasId !== null) {
          if (!liveAliasIds.has(addr.aliasId)) {
            // The alias this draft was written against is gone. Not an empty
            // cell — an address that no longer means anything.
            return { found: false, ambiguous: true, value: null }
          }
          slot = addr.aliasId
        }
        const row = byListing.get(`${coord}:${slot}`)
        // No listing yet is a real answer: the cell is empty, not unknown.
        if (!row) return { found: true, ambiguous: false, value: null }
        return { found: true, ambiguous: false, value: row[target] ?? null }
      }
      const p = byProduct.get(productId)
      if (!p) return { found: false, ambiguous: false, value: null }
      if (addr.writeField.startsWith('attr_')) {
        const attrs = (p.categoryAttributes as Record<string, unknown> | null) ?? {}
        return {
          found: true,
          ambiguous: false,
          value: attrs[addr.writeField.slice('attr_'.length)] ?? null,
        }
      }
      if (!MASTER_TEXT_FIELDS.has(addr.writeField)) {
        return { found: false, ambiguous: false, value: null }
      }
      return {
        found: true,
        ambiguous: false,
        value: (p as Record<string, unknown>)[addr.writeField] ?? null,
      }
    },
  }
}

/**
 * Same-value test that treats the shapes a cell legitimately holds as equal:
 * null and '' are both "empty", and a list compares member-wise. Anything else
 * compares by canonical JSON — deliberately strict, because a false "unchanged"
 * lets an approval silently clobber an edit.
 */
export function sameStoredValue(a: unknown, b: unknown): boolean {
  const empty = (v: unknown) => v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)
  if (empty(a) && empty(b)) return true
  if (empty(a) !== empty(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => sameStoredValue(x, b[i]))
  }
  if (typeof a === 'string' || typeof b === 'string') return String(a) === String(b)
  return JSON.stringify(a) === JSON.stringify(b)
}

// ────────────────────────────────────────────────────────────────────
// Recording a run's drafts
// ────────────────────────────────────────────────────────────────────

export interface DraftInput {
  productId: string
  /** The market the run's caps came from. Required at approve time for `attr_*` fields. */
  market: string | null
  cellKey: string
  address: CellAddress
  columnKey: string
  draftValue: unknown
  baseValue: unknown
  baseSource: string | null
  status: 'pending' | 'failed'
  confidence: string | null
  rationale: string | null
  promptHash: string
  capsUsed: unknown
  violations: unknown
}

/**
 * Persist a run's drafts and retire what they replace.
 *
 * Supersession runs FIRST and in the same transaction: a cell must never show
 * two pending drafts, or the review view would ask the operator to approve a
 * value twice and the second approval would overwrite the first.
 */
export async function recordDrafts(
  runId: string,
  provider: string,
  model: string,
  rows: DraftInput[],
): Promise<{ created: number; superseded: number }> {
  if (rows.length === 0) return { created: 0, superseded: 0 }

  return prisma.$transaction(async (tx) => {
    const superseded = await tx.productAiDraft.updateMany({
      where: {
        status: 'pending',
        OR: rows.map((r) => ({ productId: r.productId, cellKey: r.cellKey })),
      },
      data: { status: 'superseded', decidedAt: new Date(), decidedBy: `run:${runId}` },
    })
    const created = await tx.productAiDraft.createMany({
      data: rows.map((r) => ({
        productId: r.productId,
        cellKey: r.cellKey,
        channel: r.address.channel,
        marketplace: r.address.marketplace,
        aliasId: r.address.aliasId,
        locale: r.address.locale ? normalizeLanguage(r.address.locale) : null,
        writeField: r.address.writeField,
        columnKey: r.columnKey,
        market: r.market,
        draftValue: r.draftValue as never,
        baseValue: (r.baseValue ?? null) as never,
        baseSource: r.baseSource,
        status: r.status,
        confidence: r.confidence,
        rationale: r.rationale,
        runId,
        provider,
        model,
        promptHash: r.promptHash,
        capsUsed: (r.capsUsed ?? null) as never,
        violations: (r.violations ?? null) as never,
      })),
      skipDuplicates: true,
    })
    return { created: created.count, superseded: superseded.count }
  })
}

// ────────────────────────────────────────────────────────────────────
// The overlay
// ────────────────────────────────────────────────────────────────────

export interface ListDraftsInput {
  productIds?: string[]
  runId?: string
  channel?: string | null
  marketplace?: string | null
  /**
   * The locale the caller is LOOKING AT. Absent/`null` returns only non-locale drafts — the
   * master's own values.
   *
   * Load-bearing: the sheet shows one locale at a time and the overlay indexes cells by
   * (row, column) with NO locale dimension, so an unfiltered read lets a German draft tint an
   * Italian cell — invisible on screen, and it writes the wrong language into the cell on approve.
   * Filtering here keeps the index 2-D, which is what the grid actually needs.
   */
  locale?: string | null
  status?: DraftStatus[]
  limit?: number
}

export async function listDrafts(input: ListDraftsInput): Promise<DraftOverlayRow[]> {
  const statuses = input.status && input.status.length > 0 ? input.status : ['pending', 'failed']
  const loadedRows = await prisma.productAiDraft.findMany({
    where: {
      ...(input.productIds && input.productIds.length > 0
        ? { productId: { in: input.productIds } }
        : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.channel !== undefined ? { channel: input.channel } : {}),
      ...(input.marketplace !== undefined ? { marketplace: input.marketplace } : {}),
      // Absent means "the master's own values", never "any locale".
      locale: input.locale ? { not: null } : null,
      status: { in: statuses },
    },
    orderBy: [{ productId: 'asc' }, { cellKey: 'asc' }],
    take: Math.min(input.limit ?? 2000, 5000),
  })
  const rows = loadedRows.filter(row => input.locale ? row.locale && normalizeLanguage(row.locale) === normalizeLanguage(input.locale) : row.locale === null)
  if (rows.length === 0) return []

  const addresses = rows.map((r) => decodeCellKey(r.cellKey))
  const current = await loadCurrentValues(
    rows.map((r) => r.productId),
    addresses,
  )

  return rows.map((r, i) => {
    const now = current.get(r.productId, addresses[i])
    // Unreadable address is NOT stale-by-default: claiming a cell moved when we
    // simply could not read it would push the operator to "approve anyway" on
    // a cell nobody actually checked. It is surfaced as `unverified` instead,
    // which is the truth, and which approval refuses on.
    const stale = now.found ? !sameStoredValue(now.value, r.baseValue) : false
    return {
      id: r.id,
      productId: r.productId,
      cellKey: r.cellKey,
      writeField: r.writeField,
      columnKey: r.columnKey,
      channel: r.channel,
      marketplace: r.marketplace,
      aliasId: r.aliasId,
      locale: r.locale ? normalizeLanguage(r.locale) : null,
      draftValue: r.draftValue,
      baseValue: r.baseValue,
      baseSource: r.baseSource,
      status: r.status as DraftStatus,
      confidence: r.confidence,
      rationale: r.rationale,
      violations: r.violations,
      capsUsed: r.capsUsed,
      runId: r.runId,
      provider: r.provider,
      model: r.model,
      createdAt: r.createdAt.toISOString(),
      stale,
      unverified: now.ambiguous || !now.found,
      ...(stale ? { currentValue: now.value } : {}),
      lastApplyError: r.lastApplyError,
    }
  })
}

// ────────────────────────────────────────────────────────────────────
// Deciding
// ────────────────────────────────────────────────────────────────────

export interface ApproveResult {
  approved: string[]
  refused: Array<{ id: string; reason: string }>
  /** What went to `PATCH /api/products/bulk`, for the operator's receipt. */
  changesSent: number
}

/**
 * Approve drafts by id.
 *
 * `allowStale` is required per-call and defaults to false: a cell that moved
 * under the draft is refused unless the operator said "approve anyway" on that
 * specific selection, having seen the current value in the diff.
 */
/**
 * D7 — apply approved translation drafts through `PUT /api/products/:id/translations/:language`.
 *
 * A separate path because there is no other: the bulk PATCH allowlist has no `title` and no locale
 * dimension, so a translated value has no address there at all. This lane assumed one shared apply
 * path and that assumption was wrong — found by reading the write path before building the
 * generator, rather than after (the `attr_*` lesson).
 *
 * 🔴 The provenance it writes is the whole point of routing translations through review at all.
 * `ProductTranslation` can already express both halves — `source` says a MODEL wrote the words,
 * `reviewedAt` says a HUMAN accepted them — but the existing `/ai-translate` endpoint writes
 * `source: 'ai-*'` with `reviewedAt: null`, i.e. it puts unreviewed machine copy straight into the
 * record, and the resolver does not filter on review state, so `apply-mapping.service.ts` will
 * publish it. An approval here is the one case where both halves are true, so it stamps both:
 * AI provenance kept, review genuinely earned.
 *
 * One product per request (the route is keyed by id and language), so a batch is N injects. That is
 * fine at review scale — an operator approves cells, not catalogues.
 */
async function applyTranslationGroup(
  app: FastifyInstance,
  request: FastifyRequest,
  locale: string,
  items: Array<{ row: { id: string; productId: string; writeField: string; draftValue: unknown; model: string }; addr: CellAddress }>,
): Promise<{ approved: string[]; refused: Array<{ id: string; reason: string }> }> {
  const approved: string[] = []
  const refused: Array<{ id: string; reason: string }> = []

  const byProduct = new Map<string, typeof items>()
  for (const it of items) {
    const list = byProduct.get(it.row.productId) ?? []
    list.push(it)
    byProduct.set(it.row.productId, list)
  }

  for (const [productId, group] of byProduct) {
    const body: Record<string, unknown> = {
      // A model wrote the words; a human just accepted them. Both are true, so record both.
      source: 'ai-anthropic',
      sourceModel: group[0]?.row.model ?? null,
      reviewedAt: new Date().toISOString(),
    }
    for (const it of group) {
      const target = LOCALIZED_KEYS[it.row.writeField]
      if (!target) {
        refused.push({ id: it.row.id, reason: `${it.row.writeField} has no translation field` })
        continue
      }
      body[target] = it.row.draftValue
    }

    const res = await app.inject({
      method: 'PUT',
      url: `/api/products/${productId}/translations/${encodeURIComponent(locale)}`,
      headers: {
        'content-type': 'application/json',
        ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
      },
      payload: body,
    })

    if (res.statusCode >= 400) {
      const reason = `PUT /translations/${locale} returned ${res.statusCode}: ${res.body.slice(0, 200)}`
      for (const it of group) refused.push({ id: it.row.id, reason })
      await prisma.productAiDraft.updateMany({
        where: { id: { in: group.map((g) => g.row.id) } },
        data: { lastApplyError: reason.slice(0, 500) },
      })
      continue
    }

    const decidedBy = request.authUser?.id ?? 'operator'
    await prisma.productAiDraft.updateMany({
      where: { id: { in: group.map((g) => g.row.id) } },
      data: { status: 'approved', decidedAt: new Date(), decidedBy, lastApplyError: null },
    })
    approved.push(...group.map((g) => g.row.id))

    await auditLogService.writeMany(
      group.map((it) => ({
        userId: request.authUser?.id ?? null,
        ip: request.ip ?? null,
        entityType: 'Product',
        entityId: productId,
        action: 'ai-draft.approve',
        before: { [`${locale}.${it.row.writeField}`]: null },
        after: { [`${locale}.${it.row.writeField}`]: it.row.draftValue },
        metadata: { draftId: it.row.id, locale, target: 'ProductTranslation', model: it.row.model },
      })),
    )
  }
  return { approved, refused }
}

export async function approveDrafts(
  app: FastifyInstance,
  request: FastifyRequest,
  draftIds: string[],
  opts: { allowStale?: boolean } = {},
): Promise<ApproveResult> {
  const refused: Array<{ id: string; reason: string }> = []
  if (draftIds.length === 0) return { approved: [], refused, changesSent: 0 }

  const rows = await prisma.productAiDraft.findMany({ where: { id: { in: draftIds } } })
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const id of draftIds) {
    if (!byId.has(id)) refused.push({ id, reason: 'not found' })
  }

  const candidates = rows.filter((r) => {
    if (r.status !== 'pending') {
      refused.push({ id: r.id, reason: `status is ${r.status}, only pending can be approved` })
      return false
    }
    if (!isDraftableField(r.writeField, r.locale)) {
      refused.push({ id: r.id, reason: `${r.writeField} is not a writable cell` })
      return false
    }
    // A channel-scope draft carrying a locale has no apply path yet: ChannelListing has its own
    // per-coordinate content and ProductTranslation is master-only. Refusing beats mis-routing it
    // into the master's translation row, which would silently overwrite a different cell.
    if (r.locale && r.channel !== null) {
      refused.push({
        id: r.id,
        reason: 'per-locale drafts on a channel scope are not applicable yet — regenerate on the master scope',
      })
      return false
    }
    return true
  })
  if (candidates.length === 0) return { approved: [], refused, changesSent: 0 }

  const addresses = candidates.map((r) => decodeCellKey(r.cellKey))
  const current = await loadCurrentValues(candidates.map((r) => r.productId), addresses)

  const applying: Array<{ row: (typeof candidates)[number]; addr: CellAddress }> = []
  candidates.forEach((row, i) => {
    const addr = addresses[i]
    const now = current.get(row.productId, addr)
    // An address we cannot resolve to one stored row is refused even with
    // `allowStale`. `allowStale` means "I have seen the current value and I
    // still want mine"; here there is no current value to have seen, so the
    // operator would be waiving a check that never ran.
    if (now.ambiguous) {
      refused.push({
        id: row.id,
        reason:
          'the listing alias this draft was written against no longer exists — regenerate it against the current alias set',
      })
      return
    }
    if (now.found && !sameStoredValue(now.value, row.baseValue) && !opts.allowStale) {
      refused.push({
        id: row.id,
        reason: 'the cell changed since this draft was generated — review the diff and approve again',
      })
      return
    }
    applying.push({ row, addr })
  })
  if (applying.length === 0) return { approved: [], refused, changesSent: 0 }

  // Group by write context: the bulk PATCH takes ONE marketplaceContexts list
  // per request, so master cells and each channel×market go as separate calls.
  const groups = new Map<string, typeof applying>()
  for (const item of applying) {
    const key = isTranslationDraft(item.addr)
      ? `locale:${item.addr.locale}`
      : item.addr.channel === null
        ? 'master'
        : `${item.addr.channel}:${item.addr.marketplace}`
    const list = groups.get(key) ?? []
    list.push(item)
    groups.set(key, list)
  }

  const approved: string[] = []
  let changesSent = 0

  for (const [key, items] of groups) {
    // ── D7: a translation batch takes a different route entirely ──────────────────────
    if (key.startsWith('locale:')) {
      const locale = key.slice('locale:'.length)
      const outcome = await applyTranslationGroup(app, request, locale, items)
      approved.push(...outcome.approved)
      refused.push(...outcome.refused)
      changesSent += items.length
      continue
    }

    const body: Record<string, unknown> = {
      changes: items.map((it) => ({
        id: it.row.productId,
        field: it.row.writeField,
        value: it.row.draftValue,
      })),
    }
    if (key !== 'master') {
      const [channel, marketplace] = key.split(':')
      body.marketplaceContexts = [{ channel, marketplace }]
    } else {
      /**
       * A MASTER-scope batch still needs a marketplace when it carries `attr_*` cells.
       *
       * The route resolves an attribute through `getFieldDefinition(field, { marketplace })`, which
       * falls back to that market's cached Amazon schema for anything outside its small static
       * list. With no context it refused every attribute draft — "Unknown or read-only category
       * attribute" — measured on the real IT catalogue. The context is for the SCHEMA LOOKUP only:
       * channel fan-out is keyed off CHANNEL_FIELD_MAP, which no `attr_*` or master column is in,
       * so nothing here becomes a channel write.
       */
      const market = items.find((it) => it.row.writeField.startsWith('attr_') && it.row.market)?.row
        .market
      if (market) body.marketplaceContexts = [{ channel: 'AMAZON', marketplace: market }]
    }
    changesSent += items.length

    // The SAME route the sheet autosaves through. `inject` keeps the whole
    // pipeline — the RBAC preHandler included — so an approval is authorised
    // exactly as a hand edit would be; the caller's cookie is what carries it.
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/products/bulk',
      headers: {
        'content-type': 'application/json',
        ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
      },
      payload: body,
    })

    if (res.statusCode >= 400) {
      const reason = `PATCH /api/products/bulk returned ${res.statusCode}: ${res.body.slice(0, 200)}`
      await prisma.productAiDraft.updateMany({
        where: { id: { in: items.map((i) => i.row.id) } },
        data: { lastApplyError: reason.slice(0, 500) },
      })
      for (const it of items) refused.push({ id: it.row.id, reason })
      continue
    }

    // The route's contract on success (products.routes.ts): `{ operationId,
    // updated, errors? }`, where `errors` is a per-(id, field) list of the
    // changes it REFUSED. There is no per-change success list — a change
    // absent from `errors` is a change that landed. Parsing this the other way
    // round (looking for an `ok: true`) would stamp every draft approved on a
    // response that never says so.
    let parsed: { errors?: Array<{ id?: string; field?: string; error?: string }> } | null = null
    try {
      parsed = res.json() as typeof parsed
    } catch {
      parsed = null
    }

    const failed = new Map<string, string>()
    for (const e of parsed?.errors ?? []) {
      if (e?.id && e?.field) failed.set(`${e.id}:${e.field}`, e.error ?? 'refused')
    }

    const landed: typeof items = []
    for (const it of items) {
      const err = failed.get(`${it.row.productId}:${it.row.writeField}`)
      if (err !== undefined) {
        refused.push({ id: it.row.id, reason: err })
        await prisma.productAiDraft.update({
          where: { id: it.row.id },
          data: { lastApplyError: err.slice(0, 500) },
        })
        continue
      }
      landed.push(it)
    }
    if (landed.length === 0) continue

    const decidedBy = request.authUser?.id ?? 'operator'
    await prisma.productAiDraft.updateMany({
      where: { id: { in: landed.map((i) => i.row.id) } },
      data: { status: 'approved', decidedAt: new Date(), decidedBy, lastApplyError: null },
    })
    approved.push(...landed.map((i) => i.row.id))

    // A second audit row beside the bulk PATCH's own: the PATCH records WHAT
    // changed, this records that an AI draft is what proposed it. Without it
    // the provenance is lost the moment the draft row is swept.
    await auditLogService.writeMany(
      landed.map((it) => ({
        userId: request.authUser?.id ?? null,
        ip: request.ip ?? null,
        entityType: 'Product',
        entityId: it.row.productId,
        action: 'ai-draft.approve',
        before: { [it.row.writeField]: it.row.baseValue },
        after: { [it.row.writeField]: it.row.draftValue },
        metadata: {
          draftId: it.row.id,
          cellKey: it.row.cellKey,
          runId: it.row.runId,
          provider: it.row.provider,
          model: it.row.model,
          confidence: it.row.confidence,
          approvedStale: opts.allowStale === true,
        },
      })),
    )
  }

  return { approved, refused, changesSent }
}

export async function rejectDrafts(
  request: FastifyRequest,
  draftIds: string[],
): Promise<{ rejected: number }> {
  if (draftIds.length === 0) return { rejected: 0 }
  const res = await prisma.productAiDraft.updateMany({
    where: { id: { in: draftIds }, status: { in: ['pending', 'failed'] } },
    data: {
      status: 'rejected',
      decidedAt: new Date(),
      decidedBy: request.authUser?.id ?? 'operator',
    },
  })
  return { rejected: res.count }
}
