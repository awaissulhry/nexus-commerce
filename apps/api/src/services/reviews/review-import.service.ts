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
 */

import { createHash } from 'node:crypto'
import prisma from '../../db.js'
import { parseFile, type FileKind } from '../import/parsers.js'
import { ingestRawReviews } from './review-ingest.service.js'
import type { IngestSummary } from './review-ingest.service.js'

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

function parseRating(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  // Pull the first number out of strings like "5.0 out of 5 stars".
  const m = String(v).match(/(\d+(?:[.,]\d+)?)/)
  if (!m) return undefined
  const n = Number(m[1].replace(',', '.'))
  if (!Number.isFinite(n)) return undefined
  return Math.min(5, Math.max(1, Math.round(n)))
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
}

export interface ImportOptions {
  text?: string
  bytesBase64?: string
  fileKind?: FileKind
  channel: string
  marketplace?: string | null
  columnMapping?: Partial<Record<CanonicalField, string>>
  force?: boolean
}

/** Parse + map + validate, without touching the DB beyond a dedup lookup. */
async function buildRows(opts: ImportOptions): Promise<{
  headers: string[]
  detectedMapping: Partial<Record<CanonicalField, string>>
  mapping: Partial<Record<CanonicalField, string>>
  rows: MappedRow[]
  duplicateExisting: number
  duplicateInBatch: number
}> {
  const channel = (opts.channel || 'AMAZON').toUpperCase()
  const fileKind: FileKind = opts.fileKind ?? 'csv'
  const bytes = opts.bytesBase64 ? Buffer.from(opts.bytesBase64, 'base64') : undefined
  const parsed = await parseFile(fileKind, { text: opts.text, bytes })
  const detectedMapping = autodetectMapping(parsed.headers)
  const mapping = { ...detectedMapping, ...(opts.columnMapping ?? {}) }

  const mapped: MappedRow[] = []
  const batchKeys = new Set<string>()
  let duplicateInBatch = 0

  for (const row of parsed.rows) {
    const errors: string[] = []
    const warnings: string[] = []

    const body = str(cell(row, mapping, 'body'))
    const title = str(cell(row, mapping, 'title'))
    if (!body) errors.push('missing review body')

    const rating = parseRating(cell(row, mapping, 'rating'))
    const authorName = str(cell(row, mapping, 'authorName'))
    const asin = str(cell(row, mapping, 'asin'))
    const sku = str(cell(row, mapping, 'sku'))
    const rowMarketplace =
      str(cell(row, mapping, 'marketplace')) ?? (opts.marketplace ? String(opts.marketplace) : undefined)
    const verifiedPurchase = parseBool(cell(row, mapping, 'verifiedPurchase'))
    const helpfulVotes = parseInt0(cell(row, mapping, 'helpfulVotes'))

    // postedAt: parse; fall back to now with a warning so a missing
    // date never blocks an otherwise-good import.
    let postedAtIso = new Date().toISOString()
    const rawDate = str(cell(row, mapping, 'postedAt'))
    if (rawDate) {
      const d = new Date(rawDate)
      if (!Number.isNaN(d.getTime())) {
        postedAtIso = d.toISOString()
      } else {
        warnings.push(`unparseable date "${rawDate}" — defaulted to today`)
      }
    } else {
      warnings.push('no date column — defaulted to today')
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
      warnings.push('duplicate of an earlier row in this file')
    } else {
      batchKeys.add(dedupKey)
    }

    const ok = errors.length === 0
    mapped.push({
      ok,
      dedupKey,
      errors,
      warnings,
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
            rawPayload: { importedRow: row },
          }
        : null,
    })
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
        m.warnings.push('already imported')
      }
    }
  }

  return {
    headers: parsed.headers,
    detectedMapping,
    mapping,
    rows: mapped,
    duplicateExisting,
    duplicateInBatch,
  }
}

export interface ImportPreview {
  headers: string[]
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
  const willInsert = built.rows.filter(
    (r) => r.ok && !r.warnings.includes('already imported') && !r.warnings.includes('duplicate of an earlier row in this file'),
  ).length
  return {
    headers: built.headers,
    detectedMapping: built.detectedMapping,
    appliedMapping: built.mapping,
    channel: (opts.channel || 'AMAZON').toUpperCase(),
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
  parsed: number
  valid: number
  skippedInvalid: number
  summary: IngestSummary
}

export async function applyReviewImport(opts: ImportOptions): Promise<ImportResult> {
  const built = await buildRows(opts)
  // Only feed valid, non-batch-duplicate rows. DB-duplicates are caught
  // again (and counted as skippedExisting) by the idempotent ingest.
  const seen = new Set<string>()
  const raws: RawReview[] = []
  for (const m of built.rows) {
    if (!m.raw) continue
    if (seen.has(m.dedupKey)) continue
    seen.add(m.dedupKey)
    raws.push(m.raw)
  }
  const summary = await ingestRawReviews(raws, {
    ingestSource: 'IMPORT_CSV',
    force: opts.force,
  })
  const valid = built.rows.filter((r) => r.ok).length
  return {
    ok: true,
    parsed: built.rows.length,
    valid,
    skippedInvalid: built.rows.length - valid,
    summary,
  }
}
