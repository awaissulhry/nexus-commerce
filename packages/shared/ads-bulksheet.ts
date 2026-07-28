/**
 * Amazon Ads bulksheet — the single schema (AX-IE.2).
 *
 * ONE object drives all four consumers, which is the whole point:
 *   1. the server exporter  — column order, cell type, number format
 *   2. the Dictionary sheet — generated, never hand-maintained
 *   3. server-side validation — the only real gate
 *   4. the client-side pre-validation on /marketing/ads-console/bulk
 *
 * Before this file there were TWO grammars and they had already drifted: the
 * browser knew about 8 entities and per-entity required fields but validated no
 * VALUES, while the server validated values strictly but understood 4
 * entity×operation combinations. A row could pass in the browser and be rejected
 * by the server, or vice versa. Anything that needs the bulksheet grammar imports
 * it from here; adding it anywhere else is a bug.
 *
 * Lives in @nexus/shared precisely so apps/web and apps/api cannot diverge.
 *
 * ── Scope note ───────────────────────────────────────────────────────────────
 * COLUMNS below is Amazon's Sponsored Products layout as far as we have been able
 * to verify it. Amazon publishes no machine-readable bulksheet schema and
 * advertising.amazon.com/API/docs is a client-rendered SPA that returns an empty
 * shell to fetchers, so the complete SP column list — and the SB/SD sets under
 * bulksheets 2.0 — need one real Seller Central bulksheet download to confirm.
 * That is why the column set is DATA: completing it is editing this array, not
 * rewriting the exporter. See docs/AX-IE-0-1-PLAN.md §5.
 */

// ── Cell types ────────────────────────────────────────────────────────
// Drives the exporter's cell coercion and number formats, and the importer's
// parsing. 'id' is deliberately distinct from 'text': ids are pinned to a text
// format so a spreadsheet can never re-read a 19-digit Amazon id as a float.
export type BulksheetCellType = 'id' | 'text' | 'money' | 'int' | 'percent' | 'date' | 'enum'

export const NUM_FMT: Record<BulksheetCellType, string | undefined> = {
  id: '@',
  text: undefined,
  money: '#,##0.00',
  int: '#,##0',
  percent: '#,##0',
  date: 'yyyy-mm-dd',
  enum: undefined,
}

export interface BulksheetColumn {
  /** Exact header text written to, and matched from, the sheet. */
  header: string
  type: BulksheetCellType
  /** False = informational/read-only. Surfaced in the Dictionary and README. */
  editable: boolean
  /** One-line meaning. Becomes the Dictionary definition AND the header comment. */
  definition: string
  /** Shown in the Dictionary so the expected shape is unambiguous. */
  example?: string
  /** Alternate headers accepted on import (localised or legacy). Never emitted. */
  aliases?: readonly string[]
  /** Enum vocabulary key — backs both the dropdown and server validation. */
  vocabulary?: keyof typeof VOCABULARIES
  unit?: string
}

// ── Enum vocabularies ─────────────────────────────────────────────────
// `values` is what we EMIT (and what dropdowns offer). `accept` maps normalised
// input onto a canonical value, so an it-IT sheet or a differently-cased export
// still imports. Anything not in `accept` is a row error — never a silent
// fallback. That mattered most for match type, which is immutable on Amazon:
// correcting a wrong one means archive + recreate, which resets the target id and
// destroys its performance history.
export const VOCABULARIES = {
  product: {
    values: ['Sponsored Products', 'Sponsored Brands', 'Sponsored Display'],
    accept: {
      SPONSOREDPRODUCTS: 'Sponsored Products', SP: 'Sponsored Products',
      SPONSOREDBRANDS: 'Sponsored Brands', SB: 'Sponsored Brands',
      SPONSOREDDISPLAY: 'Sponsored Display', SD: 'Sponsored Display',
    } as Record<string, string>,
  },
  entity: {
    values: [
      'Campaign', 'Ad group', 'Product ad', 'Keyword', 'Negative keyword',
      'Campaign negative keyword', 'Product targeting', 'Negative product targeting',
      'Bidding adjustment', 'Portfolio',
    ],
    accept: {
      CAMPAIGN: 'Campaign', ADGROUP: 'Ad group', PRODUCTAD: 'Product ad',
      KEYWORD: 'Keyword', NEGATIVEKEYWORD: 'Negative keyword',
      CAMPAIGNNEGATIVEKEYWORD: 'Campaign negative keyword',
      PRODUCTTARGETING: 'Product targeting',
      NEGATIVEPRODUCTTARGETING: 'Negative product targeting',
      BIDDINGADJUSTMENT: 'Bidding adjustment', PORTFOLIO: 'Portfolio',
    } as Record<string, string>,
  },
  operation: {
    values: ['Create', 'Update', 'Archive'],
    accept: { CREATE: 'Create', UPDATE: 'Update', ARCHIVE: 'Archive' } as Record<string, string>,
  },
  state: {
    values: ['enabled', 'paused', 'archived'],
    accept: {
      ENABLED: 'enabled', PAUSED: 'paused', ARCHIVED: 'archived',
      ATTIVO: 'enabled', INPAUSA: 'paused', ARCHIVIATO: 'archived', // it-IT
    } as Record<string, string>,
  },
  matchType: {
    values: ['Broad', 'Phrase', 'Exact', 'Negative exact', 'Negative phrase'],
    accept: {
      BROAD: 'Broad', PHRASE: 'Phrase', EXACT: 'Exact',
      NEGATIVEEXACT: 'Negative exact', NEGATIVEPHRASE: 'Negative phrase',
      CAMPAIGNNEGATIVEEXACT: 'Negative exact', CAMPAIGNNEGATIVEPHRASE: 'Negative phrase',
      GENERICA: 'Broad', FRASE: 'Phrase', ESATTA: 'Exact', // it-IT
    } as Record<string, string>,
  },
  targetingType: {
    values: ['auto', 'manual'],
    accept: { AUTO: 'auto', MANUAL: 'manual', AUTOMATICO: 'auto', MANUALE: 'manual' } as Record<string, string>,
  },
  biddingStrategy: {
    values: ['Dynamic bids - down only', 'Dynamic bids - up and down', 'Fixed bid'],
    accept: {
      DYNAMICBIDSDOWNONLY: 'Dynamic bids - down only', LEGACYFORSALES: 'Dynamic bids - down only',
      DYNAMICBIDSUPANDDOWN: 'Dynamic bids - up and down', AUTOFORSALES: 'Dynamic bids - up and down',
      FIXEDBID: 'Fixed bid', MANUAL: 'Fixed bid',
    } as Record<string, string>,
  },
  placement: {
    values: ['Top of search (page 1)', 'Rest of search', 'Product pages', 'Amazon Business'],
    accept: {
      TOPOFSEARCHPAGE1: 'Top of search (page 1)', PLACEMENTTOP: 'Top of search (page 1)',
      RESTOFSEARCH: 'Rest of search', PLACEMENTRESTOFSEARCH: 'Rest of search',
      PRODUCTPAGES: 'Product pages', PLACEMENTPRODUCTPAGE: 'Product pages',
      AMAZONBUSINESS: 'Amazon Business',
    } as Record<string, string>,
  },
} as const

/** Normalise an enum token for lookup: case, spaces, underscores and hyphens all collapse. */
export function normEnum(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s_\-()]+/g, '')
}

/** Canonical value, or null when unrecognised. Null is ALWAYS an error, never a default. */
export function parseVocabulary(vocab: keyof typeof VOCABULARIES, raw: string): string | null {
  const v = VOCABULARIES[vocab]
  const key = normEnum(raw)
  if (!key) return null
  const direct = (v.accept as Record<string, string>)[key]
  if (direct) return direct
  // Exact-value match (already canonical, e.g. round-tripped from our own export).
  const hit = (v.values as readonly string[]).find((x) => normEnum(x) === key)
  return hit ?? null
}

// ── Columns ───────────────────────────────────────────────────────────
// Order IS the sheet's column order. The first three are the structural invariant
// Amazon's own bulksheets rely on and every consumer keys off.
export const COLUMNS: readonly BulksheetColumn[] = [
  { header: 'Product', type: 'enum', vocabulary: 'product', editable: true, definition: 'Which ad product this row belongs to.', example: 'Sponsored Products' },
  { header: 'Entity', type: 'enum', vocabulary: 'entity', editable: true, definition: 'What kind of object this row describes.', example: 'Keyword' },
  { header: 'Operation', type: 'enum', vocabulary: 'operation', editable: true, definition: 'Leave blank to change nothing. Create, Update or Archive to act. Archive is irreversible on Amazon.', example: 'Update' },

  { header: 'Campaign ID', type: 'id', editable: false, definition: "Amazon's campaign id. Identity — never edit.", example: '490412835561617' },
  { header: 'Ad group ID', type: 'id', editable: false, definition: "Amazon's ad group id. Identity — never edit.", example: '422025536245292' },
  { header: 'Portfolio ID', type: 'id', editable: true, definition: 'Portfolio this campaign belongs to.', example: '13579246801' },
  { header: 'Ad ID', type: 'id', editable: false, definition: "Amazon's product ad id. Identity — never edit.", example: '11223344556677' },
  { header: 'Keyword ID', type: 'id', editable: false, definition: "Amazon's keyword id. Identity — never edit.", example: '29599531751472', aliases: ['Keyword Id'] },
  { header: 'Product Targeting ID', type: 'id', editable: false, definition: "Amazon's product-targeting id. Identity — never edit.", example: '98765432101234', aliases: ['Targeting ID', 'Product targeting Id'] },

  { header: 'Campaign name', type: 'text', editable: true, definition: 'Campaign name. Unique per profile per ad product — the best natural key Amazon offers.', example: 'AIR MESH BROAD', aliases: ['Campaign Name'] },
  { header: 'Ad group name', type: 'text', editable: true, definition: 'Ad group name.', example: 'Giacche Broad', aliases: ['Ad Group Name'] },
  { header: 'Start date', type: 'date', editable: true, definition: 'Campaign start date. ISO only (yyyy-mm-dd) — ambiguous dd/mm vs mm/dd is rejected, not guessed.', example: '2026-07-28' },
  { header: 'End date', type: 'date', editable: true, definition: 'Campaign end date. Blank means no end date.', example: '2026-12-31' },
  { header: 'Targeting type', type: 'enum', vocabulary: 'targetingType', editable: false, definition: "Auto or manual targeting, as Amazon reports it. Blank means Amazon has not told us — a blank cell is inert, a wrong one corrupts on re-upload.", example: 'manual' },
  { header: 'State', type: 'enum', vocabulary: 'state', editable: true, definition: 'enabled, paused or archived. Archived is terminal on Amazon — there is no unarchive.', example: 'enabled' },

  { header: 'Daily budget', type: 'money', editable: true, definition: 'Campaign daily budget in the campaign currency.', example: '20.00', unit: 'currency', aliases: ['Budget'] },
  { header: 'SKU', type: 'id', editable: false, definition: 'Seller SKU advertised by a product ad. Text — leading zeros are preserved.', example: '0012345' },
  { header: 'ASIN', type: 'id', editable: false, definition: 'ASIN advertised by a product ad.', example: 'B0CXXXXXXX' },
  { header: 'Ad Group Default Bid', type: 'money', editable: true, definition: 'Fallback bid for targets in this ad group that have no bid of their own.', example: '0.50', unit: 'currency', aliases: ['Ad group default bid'] },
  { header: 'Bid', type: 'money', editable: true, definition: `Bid for this keyword or target. Minimum ${'€'}0.02.`, example: '0.31', unit: 'currency' },

  { header: 'Keyword text', type: 'text', editable: true, definition: 'The keyword. Immutable once created — changing it is archive + create.', example: 'giacca moto', aliases: ['Keyword Text'] },
  { header: 'Native language keyword', type: 'text', editable: true, definition: 'Keyword in the marketplace language, where Amazon supplies one.' },
  { header: 'Native language locale', type: 'text', editable: true, definition: 'Locale of the native-language keyword.', example: 'it_IT' },
  { header: 'Match type', type: 'enum', vocabulary: 'matchType', editable: true, definition: 'Broad, Phrase or Exact (or the negative forms). IMMUTABLE on Amazon: changing it is archive + create and loses all performance history.', example: 'Broad' },
  { header: 'Bidding strategy', type: 'enum', vocabulary: 'biddingStrategy', editable: true, definition: 'How Amazon may flex your bid in the auction.', example: 'Dynamic bids - down only' },
  { header: 'Placement', type: 'enum', vocabulary: 'placement', editable: true, definition: 'Which placement a bidding adjustment applies to.', example: 'Top of search (page 1)' },
  { header: 'Percentage', type: 'percent', editable: true, definition: 'Placement bid adjustment, 0–900. A whole number, not a fraction.', example: '50', unit: '%' },
  { header: 'Product targeting expression', type: 'text', editable: true, definition: 'Targeting expression, e.g. asin="B0..." or category="...".', aliases: ['Targeting expression'] },

  { header: 'Portfolio name', type: 'text', editable: true, definition: 'Portfolio name.', example: 'Moto — Core' },
  { header: 'Audience ID', type: 'id', editable: false, definition: 'Sponsored Display audience id.' },
  { header: 'Shopper Cohort Percentage', type: 'percent', editable: true, definition: 'Sponsored Display shopper-cohort bid adjustment.', unit: '%' },
  { header: 'Shopper Cohort Type', type: 'text', editable: true, definition: 'Sponsored Display shopper-cohort type.' },
  { header: 'Sites', type: 'text', editable: true, definition: 'Sponsored Display placement sites.' },
] as const

export const HEADERS: readonly string[] = COLUMNS.map((c) => c.header)

const COLUMN_BY_HEADER = new Map<string, BulksheetColumn>()
for (const c of COLUMNS) {
  COLUMN_BY_HEADER.set(normHeader(c.header), c)
  for (const a of c.aliases ?? []) COLUMN_BY_HEADER.set(normHeader(a), c)
}

/**
 * Header slug. Import matches by NAME, never by position — analysts reorder and
 * add scratch columns, and punishing that makes the file hostile to work in.
 */
export function normHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_\-]+/g, '')
}

/** Resolve a sheet header (canonical, aliased, or differently cased) to its column. */
export function resolveColumn(header: string): BulksheetColumn | null {
  return COLUMN_BY_HEADER.get(normHeader(header)) ?? null
}

// ── Value parsing ─────────────────────────────────────────────────────
export type Parsed<T> = { value: T } | { error: string }

export const AMAZON_BID_FLOOR_EUR = 0.02
export const PLACEMENT_PCT_MAX = 900

/**
 * Money. XLSX stores numbers locale-invariantly, so a well-formed sheet never
 * reaches the string branches — those exist for CSV and for cells an operator
 * retyped as text.
 *
 * `1,234` is genuinely ambiguous (it-IT 1.234 vs en-US 1234) and is REJECTED
 * rather than guessed. Guessing here is what produced the original bug: an
 * unparseable bid silently became €0.50.
 */
export function parseMoney(raw: string): Parsed<number> {
  const s = raw.replace(/[\s €$£]/g, '')
  if (!s) return { error: 'value is empty' }
  let t = s
  if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(t)) t = t.replace(/\./g, '').replace(',', '.')      // 1.234,56 it-IT
  else if (/^-?\d{1,3}(,\d{3})+\.\d+$/.test(t)) t = t.replace(/,/g, '')                    // 1,234.56 en-US
  else if (/^-?\d+,\d{3}$/.test(t)) {
    return { error: `"${raw}" is ambiguous — "," could be a decimal comma or a thousands separator. Write it as ${t.replace(',', '.')} or ${t.replace(',', '')}.` }
  } else if (/^-?\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.')                             // 1,25 it-IT
  const n = Number(t)
  if (!Number.isFinite(n)) return { error: `"${raw}" is not a number` }
  return { value: n }
}

export function parseBid(raw: string): Parsed<number> {
  const m = parseMoney(raw)
  if ('error' in m) return { error: `Bid: ${m.error}` }
  if (m.value < AMAZON_BID_FLOOR_EUR) {
    return { error: `Bid ${m.value.toFixed(2)} is below Amazon's floor of ${AMAZON_BID_FLOOR_EUR.toFixed(2)}` }
  }
  return m
}

/** Placement adjustment: whole number 0–900, never a fraction. */
export function parsePercent(raw: string): Parsed<number> {
  const m = parseMoney(raw)
  if ('error' in m) return { error: `Percentage: ${m.error}` }
  if (m.value < 0 || m.value > PLACEMENT_PCT_MAX) {
    return { error: `Percentage ${m.value} is outside Amazon's 0–${PLACEMENT_PCT_MAX} range` }
  }
  return { value: Math.round(m.value) }
}

/** ISO dates only. dd/mm vs mm/dd is unresolvable from the value alone, so it errors. */
export function parseDate(raw: string): Parsed<string> {
  const s = raw.trim()
  if (!s) return { error: 'value is empty' }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00Z`)
    if (Number.isNaN(d.getTime())) return { error: `"${raw}" is not a real date` }
    return { value: s }
  }
  if (/^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/.test(s)) {
    return { error: `"${raw}" is ambiguous — 03/04/2026 is March 4th in the US and April 3rd in Italy. Use yyyy-mm-dd.` }
  }
  return { error: `"${raw}" is not a date. Use yyyy-mm-dd.` }
}

// ── Per-entity grammar ────────────────────────────────────────────────
/** One required field, or a set of alternatives ("Campaign ID or Ad group ID"). */
export type RequiredRule = string | readonly string[]

export interface EntityRule {
  entity: string
  /** Required on Create. */
  create: readonly RequiredRule[]
  /** Required on Update/Archive — normally the entity's own id. */
  mutate: readonly RequiredRule[]
  /** False = we can validate and preview it, but applying is not wired up yet. */
  applySupported: boolean
}

export const ENTITY_RULES: readonly EntityRule[] = [
  { entity: 'Campaign', create: ['Campaign name', ['Daily budget', 'Budget']], mutate: ['Campaign ID'], applySupported: true },
  { entity: 'Ad group', create: ['Ad group name', 'Campaign ID'], mutate: ['Ad group ID'], applySupported: true },
  { entity: 'Keyword', create: ['Keyword text', 'Match type', ['Campaign ID', 'Ad group ID']], mutate: ['Keyword ID'], applySupported: true },
  { entity: 'Negative keyword', create: ['Keyword text', 'Match type', ['Campaign ID', 'Ad group ID']], mutate: ['Keyword ID'], applySupported: true },
  { entity: 'Campaign negative keyword', create: ['Keyword text', 'Match type', 'Campaign ID'], mutate: ['Keyword ID'], applySupported: false },
  { entity: 'Product targeting', create: [['Product targeting expression', 'Targeting expression'], 'Ad group ID'], mutate: [['Product Targeting ID', 'Targeting ID']], applySupported: false },
  { entity: 'Negative product targeting', create: [['Product targeting expression', 'Targeting expression'], 'Ad group ID'], mutate: [['Product Targeting ID', 'Targeting ID']], applySupported: false },
  { entity: 'Product ad', create: [['SKU', 'ASIN'], 'Ad group ID'], mutate: ['Ad ID'], applySupported: false },
  { entity: 'Bidding adjustment', create: ['Campaign ID', 'Placement', 'Percentage'], mutate: ['Campaign ID', 'Placement'], applySupported: false },
  { entity: 'Portfolio', create: ['Portfolio name'], mutate: ['Portfolio ID'], applySupported: false },
]

const RULE_BY_ENTITY = new Map(ENTITY_RULES.map((r) => [normEnum(r.entity), r]))
export function entityRule(entity: string): EntityRule | null {
  const canonical = parseVocabulary('entity', entity)
  return canonical ? RULE_BY_ENTITY.get(normEnum(canonical)) ?? null : null
}

// ── Row validation ────────────────────────────────────────────────────
export interface RowIssue {
  /** Column the problem belongs to, when it is about one specific cell. */
  column?: string
  message: string
}

export interface RowVerdict {
  entity: string | null
  operation: string | null
  /** True when the row is a no-op read (blank Operation). */
  readOnly: boolean
  ok: boolean
  issues: RowIssue[]
  /** True when the row is valid but this build cannot apply it yet. */
  previewOnly: boolean
}

/**
 * Validate one row against the grammar. Pure — no I/O — so the browser and the
 * server reach the identical verdict.
 *
 * `get` receives the CANONICAL header; callers resolve aliases via resolveColumn
 * when building their accessor, or just index the raw row (aliases are checked
 * here too).
 */
export function validateRow(get: (header: string) => string): RowVerdict {
  const raw = (h: string) => (get(h) ?? '').toString().trim()
  const issues: RowIssue[] = []

  const entityRaw = raw('Entity')
  if (!entityRaw) return { entity: null, operation: null, readOnly: false, ok: false, previewOnly: false, issues: [{ column: 'Entity', message: 'Entity is required' }] }
  const entity = parseVocabulary('entity', entityRaw)
  if (!entity) {
    return { entity: null, operation: null, readOnly: false, ok: false, previewOnly: false, issues: [{ column: 'Entity', message: `Entity "${entityRaw}" not recognised — expected one of ${VOCABULARIES.entity.values.join(', ')}` }] }
  }

  const opRaw = raw('Operation')
  if (!opRaw) return { entity, operation: null, readOnly: true, ok: true, previewOnly: false, issues: [] }
  const operation = parseVocabulary('operation', opRaw)
  if (!operation) {
    return { entity, operation: null, readOnly: false, ok: false, previewOnly: false, issues: [{ column: 'Operation', message: `Operation "${opRaw}" not recognised — expected Create, Update or Archive` }] }
  }

  // Required fields for this entity × operation.
  const rule = entityRule(entity)
  if (rule) {
    const need = operation === 'Create' ? rule.create : rule.mutate
    for (const req of need) {
      const alts = typeof req === 'string' ? [req] : req
      if (!alts.some((h) => raw(h))) {
        issues.push({ column: alts[0], message: alts.length === 1 ? `${alts[0]} is required to ${operation} a ${entity}` : `${alts.join(' or ')} is required to ${operation} a ${entity}` })
      }
    }
  }

  // Value-level checks on whatever the row actually supplies. Only ever reject —
  // never coerce a bad value into a plausible one.
  for (const col of COLUMNS) {
    const v = raw(col.header)
    if (!v) continue
    if (col.vocabulary) {
      if (!parseVocabulary(col.vocabulary, v)) {
        issues.push({ column: col.header, message: `${col.header} "${v}" not recognised — expected one of ${VOCABULARIES[col.vocabulary].values.join(', ')}` })
      }
      continue
    }
    if (col.type === 'money') {
      const p = col.header === 'Bid' ? parseBid(v) : parseMoney(v)
      if ('error' in p) issues.push({ column: col.header, message: col.header === 'Bid' ? p.error : `${col.header}: ${p.error}` })
      else if (p.value <= 0 && col.header !== 'Bid') issues.push({ column: col.header, message: `${col.header} must be greater than 0 (received "${v}")` })
    } else if (col.type === 'percent') {
      const p = parsePercent(v)
      if ('error' in p) issues.push({ column: col.header, message: p.error })
    } else if (col.type === 'date') {
      const p = parseDate(v)
      if ('error' in p) issues.push({ column: col.header, message: `${col.header}: ${p.error}` })
    }
  }

  return { entity, operation, readOnly: false, ok: issues.length === 0, previewOnly: issues.length === 0 && !(rule?.applySupported ?? false), issues }
}

// ── Dictionary ────────────────────────────────────────────────────────
export const DICTIONARY_HEADERS = ['Column', 'Type', 'Unit', 'Editable', 'Allowed values', 'Example', 'Definition'] as const

/**
 * The Dictionary sheet, generated from COLUMNS. Never hand-maintained: a
 * hand-written dictionary is a second source of truth that goes stale silently,
 * which is the exact failure this file exists to prevent.
 */
export function buildDictionaryRows(): string[][] {
  return COLUMNS.map((c) => [
    c.header,
    c.type,
    c.unit ?? '',
    c.editable ? 'yes' : 'read-only',
    c.vocabulary ? VOCABULARIES[c.vocabulary].values.join(' · ') : '',
    c.example ?? '',
    c.definition,
  ])
}

/** Schema version stamped into `_meta` so an uploaded file can be matched to its generation. */
export const BULKSHEET_SCHEMA_VERSION = '2026-07-28.1'
