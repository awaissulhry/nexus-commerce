/**
 * RX.1a — Operator review import.
 *
 * Amazon exposes no official review-text API and eBay/Shopify review
 * bodies often live in third-party apps. The pragmatic, ToS-safe path
 * is letting operators import what they can already export (Seller
 * Central Voice-of-the-Customer, eBay feedback CSV, Judge.me/Loox
 * exports) and funnelling it through the exact same dedup → sentiment →
 * category-rate pipeline the cron uses.
 *
 * This module turns a pasted/uploaded CSV/JSON/XLSX into validated
 * RawReview rows: it auto-detects the column mapping, validates each
 * row, flags duplicates (already in DB or repeated in the batch), and
 * — on apply — hands the clean batch to ingestRawReviews().
 *
 * Reviews Inbox (2026-10-26): the file says where it is from (`source`: Amazon export, Shopify review app, Etsy or
 * another file), .tsv is read too, a buyer's e-mail address or IP address is NEVER imported (those columns are dropped
 * before anything else, from the mapping and from the stored row), every row the file cannot give is refused with its
 * reason in words, and one import is one batch (`batchId`) that "Undo this import" removes again — except the rows a
 * person already worked on (a reply, a triage change, an edited mood).
 */

import { createHash, randomUUID } from 'node:crypto'
import prisma from '../../db.js'
import { parseCsv, parseFile, type FileKind } from '../import/parsers.js'
import { ingestRawReviews, removeFromCategoryRates } from './review-ingest.service.js'
import type { IngestSummary } from './review-ingest.service.js'
import { visibleReviewWhere } from './review-visibility.js'

export type CanonicalField =
  | 'externalReviewId'
  | 'rating'
  | 'title'
  | 'body'
  | 'authorName'
  | 'postedAt'
  | 'asin'
  | 'sku'
  | 'verifiedPurchase'
  | 'helpfulVotes'
  | 'marketplace'

/** Where an imported file comes from (the Import pop-up's first step). */
export type ImportSource = 'amazon' | 'shopify_app' | 'etsy' | 'other'
export const IMPORT_SOURCES: readonly ImportSource[] = ['amazon', 'shopify_app', 'etsy', 'other']
export type ImportFileKind = FileKind | 'tsv'

/** The channel an import's rows belong to. "Another file" keeps the channel the person named (default Amazon, as before). */
export function importChannel(source: ImportSource | undefined, channel: string | undefined): string {
  if (source === 'amazon') return 'AMAZON'
  if (source === 'shopify_app') return 'SHOPIFY'
  if (source === 'etsy') return 'ETSY'
  return (channel || 'AMAZON').toUpperCase()
}

/**
 * A column that holds a buyer's e-mail address or IP address. Never imported: dropped from the mapping and from the
 * stored row, whatever the person mapped.
 */
export function isPrivateColumn(header: string): boolean {
  const n = normHeader(header)
  if (n.includes('email') || n === 'mail' || n === 'mailaddress') return true
  return n === 'ip' || n.includes('ipaddress') || n.endsWith('ipaddr') || /^(remote|client|user|reviewer|customer|buyer)ip$/.test(n)
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/

/** A cell that is an e-mail address or an IP address is never kept, whatever its column is called. */
function scrubCell(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const t = v.trim()
  return EMAIL_RE.test(t) || IPV4_RE.test(t) ? '' : v
}

interface RawReview {
  externalReviewId: string
  channel: string
  marketplace?: string
  asin?: string
  sku?: string
  rating?: number
  title?: string
  body: string
  authorName?: string
  verifiedPurchase?: boolean
  helpfulVotes?: number
  postedAt: string
  rawPayload?: unknown
}

// Header synonyms used for auto-mapping. Compared after normalisation
// (lowercase, alphanumerics only) so "Review Body", "review_body" and
// "reviewBody" all collapse to the same token.
const FIELD_SYNONYMS: Record<CanonicalField, string[]> = {
  body: ['body', 'review', 'reviewbody', 'comment', 'commenttext', 'text', 'content', 'reviewtext', 'recensione', 'reviewcontent', 'feedback'],
  title: ['title', 'reviewtitle', 'heading', 'subject', 'titolo', 'headline'],
  rating: ['rating', 'stars', 'star', 'score', 'rate', 'valutazione', 'overall', 'starrating'],
  authorName: ['author', 'authorname', 'reviewer', 'reviewername', 'name', 'customer', 'customername', 'buyer', 'nickname', 'utente', 'commentinguser', 'username'],
  postedAt: ['postedat', 'date', 'reviewdate', 'created', 'createdat', 'time', 'datetime', 'data', 'submittedat', 'commenttime'],
  externalReviewId: ['externalreviewid', 'reviewid', 'id', 'feedbackid', 'recordid'],
  asin: ['asin', 'amazonasin'],
  sku: ['sku', 'sellersku', 'msku', 'merchantsku'],
  verifiedPurchase: ['verified', 'verifiedpurchase', 'isverified', 'vp'],
  helpfulVotes: ['helpful', 'helpfulvotes', 'votes', 'helpfulcount', 'upvotes'],
  marketplace: ['marketplace', 'market', 'country', 'mkt', 'countrycode', 'site'],
}

const CANONICAL_FIELDS = Object.keys(FIELD_SYNONYMS) as CanonicalField[]

function normHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function autodetectMapping(headers: string[]): Partial<Record<CanonicalField, string>> {
  const normToOriginal = new Map<string, string>()
  for (const h of headers) {
    const n = normHeader(h)
    if (!normToOriginal.has(n)) normToOriginal.set(n, h)
  }
  const mapping: Partial<Record<CanonicalField, string>> = {}
  for (const field of CANONICAL_FIELDS) {
    for (const syn of FIELD_SYNONYMS[field]) {
      const hit = normToOriginal.get(syn)
      if (hit) {
        mapping[field] = hit
        break
      }
    }
  }
  return mapping
}

/**
 * Stars from a cell: a whole number 1–5 ("5", "5.0 out of 5 stars"), or eBay's Positive / Neutral / Negative (5 / 3 / 1).
 * `undefined` = empty cell; `null` = a value that is not a whole number from 1 to 5.
 */
export function parseRating(v: unknown): number | null | undefined {
  if (v == null || String(v).trim() === '') return undefined
  const s = String(v).trim()
  const word = s.toLowerCase()
  if (word === 'positive' || word === 'positivo' || word === 'positiv') return 5
  if (word === 'neutral' || word === 'neutro' || word === 'neutrale') return 3
  if (word === 'negative' || word === 'negativo' || word === 'negativ') return 1
  // The first number of strings like "5.0 out of 5 stars".
  const m = s.match(/(\d+(?:[.,]\d+)?)/)
  if (!m) return null
  const n = Number(m[1].replace(',', '.'))
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 5) return null
  return n
}

/**
 * A review date from a cell: ISO (2026-10-24, with or without a time), or day-first 24/10/2026 · 24.10.2026 ·
 * 24-10-2026 (EU files; month-first only when the first number cannot be a month). Null when the date does not exist.
 */
export function parseReviewDate(v: string): Date | null {
  const s = v.trim()
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (dmy) {
    let day = Number(dmy[1])
    let month = Number(dmy[2])
    if (month > 12 && day <= 12) [day, month] = [month, day]
    const year = Number(dmy[3])
    const d = new Date(Date.UTC(year, month - 1, day, Number(dmy[4] ?? 0), Number(dmy[5] ?? 0), Number(dmy[6] ?? 0)))
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : null
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    const check = new Date(Date.UTC(year, month - 1, day))
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  }
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

function parseBool(v: unknown): boolean | undefined {
  if (v == null || v === '') return undefined
  const s = String(v).trim().toLowerCase()
  if (['true', 'yes', 'y', '1', 'verified', 'si', 'sì'].includes(s)) return true
  if (['false', 'no', 'n', '0', ''].includes(s)) return false
  return undefined
}

function parseInt0(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = Number(String(v).replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : undefined
}

function cell(
  row: Record<string, unknown>,
  mapping: Partial<Record<CanonicalField, string>>,
  field: CanonicalField,
): unknown {
  const header = mapping[field]
  if (!header) return undefined
  return row[header]
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined
  const s = String(v).trim()
  return s.length > 0 ? s : undefined
}

export interface MappedRow {
  ok: boolean
  raw: RawReview | null
  errors: string[]
  warnings: string[]
  dedupKey: string
  /** The line in the file (the header is line 1). */
  line: number
  /** Names a SKU/ASIN the catalog does not know: imported without a product link. */
  unknownProduct: string | null
}

export interface ImportOptions {
  text?: string
  bytesBase64?: string
  fileKind?: ImportFileKind
  /** Where the file is from; sets the channel (`other` keeps `channel`). */
  source?: ImportSource
  channel?: string
  marketplace?: string | null
  columnMapping?: Partial<Record<CanonicalField, string>>
  force?: boolean
  /** Import rows whose SKU is not in the catalog too, without a product link (default true). */
  includeUnlinked?: boolean
}

export const UNKNOWN_PRODUCT_WARNING = 'The SKU is not in your catalog: imported without a product link.'

async function parseImportFile(opts: ImportOptions) {
  const bytes = opts.bytesBase64 ? Buffer.from(opts.bytesBase64, 'base64') : undefined
  if (opts.fileKind === 'tsv') {
    const text = opts.text ?? (bytes ? bytes.toString('utf8') : undefined)
    if (text == null) throw new Error('tsv parser needs text payload')
    return parseCsv(text, '\t')
  }
  return parseFile(opts.fileKind ?? 'csv', { text: opts.text, bytes })
}

/** Parse + map + validate, without touching the DB beyond a dedup lookup. */
/** The mapping without any column that holds an e-mail or IP address. */
export function withoutPrivateColumns(mapping: Partial<Record<CanonicalField, string>>): Partial<Record<CanonicalField, string>> {
  const out: Partial<Record<CanonicalField, string>> = {}
  for (const [field, header] of Object.entries(mapping) as [CanonicalField, string | undefined][]) {
    if (header && !isPrivateColumn(header)) out[field] = header
  }
  return out
}

async function buildRows(opts: ImportOptions): Promise<{
  headers: string[]
  droppedColumns: string[]
  detectedMapping: Partial<Record<CanonicalField, string>>
  mapping: Partial<Record<CanonicalField, string>>
  rows: MappedRow[]
  duplicateExisting: number
  duplicateInBatch: number
}> {
  const channel = importChannel(opts.source, opts.channel)
  const parsed = await parseImportFile(opts)
  // E-mail and IP columns go first, before mapping or storing anything.
  const droppedColumns = parsed.headers.filter(isPrivateColumn)
  const headers = parsed.headers.filter((h) => !isPrivateColumn(h))
  const detectedMapping = autodetectMapping(headers)
  // A hand-made mapping to an e-mail or IP column is ignored (Nexus's own guess stands).
  const mapping = withoutPrivateColumns({ ...detectedMapping, ...withoutPrivateColumns(opts.columnMapping ?? {}) })

  const mapped: MappedRow[] = []
  const batchKeys = new Set<string>()
  let duplicateInBatch = 0

  for (const [index, fullRow] of parsed.rows.entries()) {
    const errors: string[] = []
    const warnings: string[] = []
    const row: Record<string, unknown> = {}
    let scrubbed = false
    for (const h of headers) {
      row[h] = scrubCell(fullRow[h])
      if (row[h] !== fullRow[h]) scrubbed = true
    }

    const body = str(cell(row, mapping, 'body'))
    const title = str(cell(row, mapping, 'title'))
    if (!body) errors.push('No review text')

    let rating: number | undefined
    if (mapping.rating) {
      const rawStars = cell(row, mapping, 'rating')
      const stars = parseRating(rawStars)
      if (stars === undefined) errors.push('Stars is empty')
      else if (stars === null) errors.push(`Stars is “${String(rawStars).trim()}”: use a whole number from 1 to 5`)
      else rating = stars
    }
    const authorName = str(cell(row, mapping, 'authorName'))
    if (scrubbed) warnings.push('An e-mail or IP address in this row was not imported.')
    const asin = str(cell(row, mapping, 'asin'))
    const sku = str(cell(row, mapping, 'sku'))
    const rowMarketplace =
      (str(cell(row, mapping, 'marketplace')) ?? (opts.marketplace ? String(opts.marketplace) : undefined))?.toUpperCase()
    const verifiedPurchase = parseBool(cell(row, mapping, 'verifiedPurchase'))
    const helpfulVotes = parseInt0(cell(row, mapping, 'helpfulVotes'))

    // postedAt: a date that does not exist refuses the row; a file without dates imports with today's date.
    let postedAtIso = new Date().toISOString()
    const rawDate = str(cell(row, mapping, 'postedAt'))
    if (rawDate) {
      const d = parseReviewDate(rawDate)
      if (d) postedAtIso = d.toISOString()
      else errors.push(`Date “${rawDate}” does not exist`)
    } else {
      warnings.push('No date: imported with today’s date.')
    }

    // externalReviewId: use provided, else derive a stable hash so the
    // (channel, externalReviewId) dedup key is deterministic across
    // re-imports of the same export.
    let externalReviewId = str(cell(row, mapping, 'externalReviewId'))
    if (!externalReviewId) {
      const basis = `${channel}|${rowMarketplace ?? ''}|${authorName ?? ''}|${postedAtIso}|${body ?? ''}`
      externalReviewId = `import:${createHash('sha1').update(basis).digest('hex').slice(0, 20)}`
    }

    const dedupKey = `${channel}::${externalReviewId}`
    if (batchKeys.has(dedupKey)) {
      duplicateInBatch += 1
      warnings.push(DUPLICATE_IN_FILE)
    } else {
      batchKeys.add(dedupKey)
    }

    const ok = errors.length === 0
    mapped.push({
      ok,
      dedupKey,
      errors,
      warnings,
      line: index + 2,
      unknownProduct: null,
      raw: ok && body
        ? {
            externalReviewId,
            channel,
            marketplace: rowMarketplace,
            asin,
            sku,
            rating,
            title,
            body,
            authorName,
            verifiedPurchase,
            helpfulVotes,
            postedAt: postedAtIso,
            // The row as the file had it, minus the e-mail and IP columns.
            rawPayload: { importedRow: row, importSource: opts.source ?? 'other' },
          }
        : null,
    })
  }

  // Rows naming a SKU/ASIN the catalog does not know import without a product link (one query each way).
  const skus = [...new Set(mapped.map((m) => m.raw?.sku).filter((v): v is string => !!v))]
  const asins = [...new Set(mapped.map((m) => m.raw?.asin).filter((v): v is string => !!v))]
  if (skus.length > 0 || asins.length > 0) {
    const [bySku, byAsin] = await Promise.all([
      skus.length > 0 ? prisma.product.findMany({ where: { sku: { in: skus } }, select: { sku: true } }) : Promise.resolve([]),
      asins.length > 0 ? prisma.product.findMany({ where: { amazonAsin: { in: asins } }, select: { amazonAsin: true } }) : Promise.resolve([]),
    ])
    const knownSkus = new Set(bySku.map((p) => p.sku))
    const knownAsins = new Set(byAsin.map((p) => p.amazonAsin))
    for (const m of mapped) {
      if (!m.raw || (!m.raw.sku && !m.raw.asin)) continue
      const known = (m.raw.asin && knownAsins.has(m.raw.asin)) || (m.raw.sku && knownSkus.has(m.raw.sku))
      if (!known) {
        m.unknownProduct = m.raw.sku ?? m.raw.asin ?? null
        m.warnings.push(UNKNOWN_PRODUCT_WARNING)
      }
    }
  }

  // Dedup against the DB in one query.
  const candidateIds = mapped
    .filter((m) => m.raw)
    .map((m) => m.raw!.externalReviewId)
  let duplicateExisting = 0
  if (candidateIds.length > 0) {
    const existing = await prisma.review.findMany({
      where: { channel, externalReviewId: { in: candidateIds } },
      select: { externalReviewId: true },
    })
    const existingSet = new Set(existing.map((e) => e.externalReviewId))
    for (const m of mapped) {
      if (m.raw && existingSet.has(m.raw.externalReviewId)) {
        duplicateExisting += 1
        m.warnings.push(ALREADY_IN_NEXUS)
      }
    }
  }

  return {
    headers,
    droppedColumns,
    detectedMapping,
    mapping,
    rows: mapped,
    duplicateExisting,
    duplicateInBatch,
  }
}

export const ALREADY_IN_NEXUS = 'Already in Nexus (same review ID): skipped.'
export const DUPLICATE_IN_FILE = 'The same review appears earlier in this file: skipped.'

export interface ImportPreview {
  /** The file's columns Nexus may read (e-mail and IP columns are not among them). */
  headers: string[]
  /** Columns never imported: a buyer's e-mail or IP address. */
  droppedColumns: string[]
  source: ImportSource | null
  /** Rows that import without a product link, and up to 5 of the SKUs they name. */
  unknownProductRows: number
  unknownProductExamples: string[]
  /** Every row that cannot import, with its reasons in words. */
  rejected: { line: number; reasons: string[] }[]
  detectedMapping: Partial<Record<CanonicalField, string>>
  appliedMapping: Partial<Record<CanonicalField, string>>
  channel: string
  totalRows: number
  validRows: number
  invalidRows: number
  duplicateExisting: number
  duplicateInBatch: number
  willInsert: number
  sample: {
    body: string | null
    title: string | null
    rating: number | null
    authorName: string | null
    marketplace: string | null
    postedAt: string | null
    errors: string[]
    warnings: string[]
  }[]
}

export async function previewReviewImport(opts: ImportOptions): Promise<ImportPreview> {
  const built = await buildRows(opts)
  const validRows = built.rows.filter((r) => r.ok).length
  const includeUnlinked = opts.includeUnlinked !== false
  const willInsert = built.rows.filter(
    (r) => r.ok && !r.warnings.includes(ALREADY_IN_NEXUS) && !r.warnings.includes(DUPLICATE_IN_FILE) && (includeUnlinked || !r.unknownProduct),
  ).length
  const unknown = built.rows.filter((r) => r.ok && r.unknownProduct)
  return {
    headers: built.headers,
    droppedColumns: built.droppedColumns,
    source: opts.source ?? null,
    unknownProductRows: unknown.length,
    unknownProductExamples: [...new Set(unknown.map((r) => r.unknownProduct as string))].slice(0, 5),
    rejected: built.rows.filter((r) => !r.ok).map((r) => ({ line: r.line, reasons: r.errors })),
    detectedMapping: built.detectedMapping,
    appliedMapping: built.mapping,
    channel: importChannel(opts.source, opts.channel),
    totalRows: built.rows.length,
    validRows,
    invalidRows: built.rows.length - validRows,
    duplicateExisting: built.duplicateExisting,
    duplicateInBatch: built.duplicateInBatch,
    willInsert,
    sample: built.rows.slice(0, 20).map((r) => ({
      body: r.raw?.body ?? null,
      title: r.raw?.title ?? null,
      rating: r.raw?.rating ?? null,
      authorName: r.raw?.authorName ?? null,
      marketplace: r.raw?.marketplace ?? null,
      postedAt: r.raw?.postedAt ?? null,
      errors: r.errors,
      warnings: r.warnings,
    })),
  }
}

export interface ImportResult {
  ok: boolean
  /** This import's batch: "Undo this import" (POST /reviews/import/:batchId/undo) removes its rows. */
  batchId: string
  /** New reviews stored by this import. */
  imported: number
  parsed: number
  valid: number
  skippedInvalid: number
  /** Rows left out because their SKU is not in the catalog and the person chose not to import those. */
  skippedUnlinked: number
  summary: IngestSummary
}

export async function applyReviewImport(opts: ImportOptions): Promise<ImportResult> {
  const built = await buildRows(opts)
  const includeUnlinked = opts.includeUnlinked !== false
  // Only feed valid, non-batch-duplicate rows. DB-duplicates are caught
  // again (and counted as skippedExisting) by the idempotent ingest.
  const seen = new Set<string>()
  const raws: RawReview[] = []
  let skippedUnlinked = 0
  for (const m of built.rows) {
    if (!m.raw) continue
    if (seen.has(m.dedupKey)) continue
    seen.add(m.dedupKey)
    if (!includeUnlinked && m.unknownProduct) {
      skippedUnlinked += 1
      continue
    }
    raws.push(m.raw)
  }
  const batchId = `import_${randomUUID()}`
  const summary = await ingestRawReviews(raws, {
    ingestSource: 'IMPORT_CSV',
    force: opts.force,
    importBatchId: batchId,
  })
  const valid = built.rows.filter((r) => r.ok).length
  return {
    ok: true,
    batchId,
    imported: summary.reviewsInserted,
    parsed: built.rows.length,
    valid,
    skippedInvalid: built.rows.length - valid,
    skippedUnlinked,
    summary,
  }
}

// ── Undo this import ────────────────────────────────────────────────────────────────────────────────────────────

/** What undo needs to know about one imported row. */
export interface UndoCandidate {
  id: string
  triageStatus: string | null
  assignee: string | null
  triageTags: string[]
  triageNote: string | null
  triageUpdatedAt: Date | null
  sentimentEditedAt: Date | null
  replyStatuses: string[]
}

/** Which rows of the batch undo removes, and which it keeps because a person already worked on them (and why). */
export function planImportUndo(rows: UndoCandidate[]): { remove: string[]; kept: { id: string; reason: string }[] } {
  const remove: string[] = []
  const kept: { id: string; reason: string }[] = []
  for (const r of rows) {
    let reason: string | null = null
    if (r.replyStatuses.includes('SENT')) reason = 'A reply was sent.'
    else if (r.replyStatuses.includes('DRAFT')) reason = 'A reply draft is saved.'
    else if (r.triageUpdatedAt || r.triageStatus || r.assignee || r.triageTags.length > 0 || r.triageNote) {
      reason = 'Its status, owner, tags or note were changed.'
    } else if (r.sentimentEditedAt) reason = 'Its mood or themes were changed by a person.'
    if (reason) kept.push({ id: r.id, reason })
    else remove.push(r.id)
  }
  return { remove, kept }
}

/** POST /reviews/import/:batchId/undo. 'not_found' when nothing of the batch is left in this business. */
export async function undoReviewImport(batchId: string): Promise<{ error: 'not_found' } | { removed: number; kept: { id: string; reason: string }[] }> {
  const rows = await prisma.review.findMany({
    where: visibleReviewWhere({ importBatchId: batchId }),
    select: {
      id: true, triageStatus: true, assignee: true, triageTags: true, triageNote: true, triageUpdatedAt: true,
      productId: true, marketplace: true, postedAt: true,
      sentiment: { select: { label: true, categories: true, editedAt: true } },
      responses: { select: { status: true } },
    },
  })
  if (rows.length === 0) return { error: 'not_found' }
  const plan = planImportUndo(rows.map((r) => ({
    id: r.id,
    triageStatus: r.triageStatus,
    assignee: r.assignee,
    triageTags: r.triageTags,
    triageNote: r.triageNote,
    triageUpdatedAt: r.triageUpdatedAt,
    sentimentEditedAt: r.sentiment?.editedAt ?? null,
    replyStatuses: r.responses.map((x) => x.status),
  })))
  if (plan.remove.length > 0) {
    const removing = new Set(plan.remove)
    await removeFromCategoryRates(rows.filter((r) => removing.has(r.id)).map((r) => ({
      productId: r.productId,
      marketplace: r.marketplace,
      postedAt: r.postedAt,
      label: r.sentiment?.label ?? null,
      categories: r.sentiment?.categories ?? [],
    })))
    await prisma.review.deleteMany({ where: { id: { in: plan.remove }, importBatchId: batchId } })
  }
  return { removed: plan.remove.length, kept: plan.kept }
}
