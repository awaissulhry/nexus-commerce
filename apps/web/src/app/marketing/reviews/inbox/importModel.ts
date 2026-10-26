/**
 * Reviews › Inbox › Import reviews — the window's rules: four steps (File · Match columns · Check · Done; a done step can
 * be opened again until the import ran), where a file comes from, Nexus's guess per field, the warnings in words, the
 * check's counts, the rows that cannot import as a CSV to download, and the words after the import.
 *
 * Nothing is written before "Import N reviews": the File and Match steps call `POST /api/reviews/import/preview`, which
 * reads and checks only; `…/apply` writes and answers with a `batchId` that "Undo this import" removes again. A buyer's
 * e-mail or IP address is never imported (the API drops those columns and says which). Pure, tested in
 * importModel.vitest.test.ts.
 */
import { count, plural } from './inboxTiles'

export const IMPORT_STEPS = ['File', 'Match columns', 'Check', 'Done'] as const
export type ImportStep = 0 | 1 | 2 | 3

export const IMPORT_ACCEPT = '.csv,.tsv,.xlsx,.json'
export const IMPORT_MAX_BYTES = 10 * 1024 * 1024

export type ImportSource = 'amazon' | 'shopify_app' | 'etsy' | 'other'

export const IMPORT_SOURCES: readonly { value: ImportSource; title: string; description: string }[] = [
  { value: 'amazon', title: 'Amazon review export', description: 'A file you made from Amazon. Amazon gives no review text by API.' },
  { value: 'shopify_app', title: 'Shopify review app', description: 'An export from Judge.me, Okendo, Loox or Yotpo.' },
  { value: 'etsy', title: 'Etsy reviews', description: 'The reviews file from Etsy Shop Manager.' },
  { value: 'other', title: 'Another file', description: 'You match the columns yourself in the next step.' },
]

/** The sources whose rows need a market (an Amazon export is per marketplace; another file may be anything). */
export function sourceNeedsMarket(source: ImportSource | null): boolean {
  return source === 'amazon' || source === 'other'
}

export type CanonicalField =
  | 'body' | 'rating' | 'title' | 'authorName' | 'postedAt' | 'externalReviewId' | 'sku' | 'asin' | 'marketplace' | 'verifiedPurchase' | 'helpfulVotes'

/** The Nexus fields, in the order the Match step lists them. Review text is the one a file must have. */
export const IMPORT_FIELDS: readonly { key: CanonicalField; label: string; required?: boolean; hint?: string }[] = [
  { key: 'body', label: 'Review text', required: true },
  { key: 'rating', label: 'Stars (1–5)' },
  { key: 'title', label: 'Title' },
  { key: 'authorName', label: 'Buyer name' },
  { key: 'postedAt', label: 'Date', hint: 'No date: imported with today’s date.' },
  { key: 'externalReviewId', label: 'Review ID', hint: 'Skips reviews already in Nexus.' },
  { key: 'sku', label: 'SKU', hint: 'Links the review to a product.' },
  { key: 'asin', label: 'ASIN', hint: 'Only for Amazon files.' },
  { key: 'marketplace', label: 'Market', hint: 'Else the market picked in step 1.' },
  { key: 'verifiedPurchase', label: 'Verified buyer' },
  { key: 'helpfulVotes', label: 'Helpful votes' },
]

export type Mapping = Partial<Record<CanonicalField, string>>

/** `POST /api/reviews/import/preview` → `preview` (review-import.service.ts `ImportPreview`). */
export interface ImportPreview {
  headers: string[]
  droppedColumns: string[]
  source: ImportSource | null
  unknownProductRows: number
  unknownProductExamples: string[]
  rejected: { line: number; reasons: string[] }[]
  detectedMapping: Mapping
  appliedMapping: Mapping
  channel: string
  totalRows: number
  validRows: number
  invalidRows: number
  duplicateExisting: number
  duplicateInBatch: number
  willInsert: number
  sample: {
    body: string | null; title: string | null; rating: number | null; authorName: string | null
    marketplace: string | null; postedAt: string | null; errors: string[]; warnings: string[]
  }[]
}

/** `POST /reviews/import/apply` → `result`. */
export interface ImportResult {
  batchId: string
  imported: number
  parsed: number
  valid: number
  skippedInvalid: number
  skippedUnlinked: number
  summary: { reviewsInserted: number; reviewsSkippedExisting: number }
}

export type FileKind = 'csv' | 'tsv' | 'xlsx' | 'json'

/** The file's kind from its name; null for a kind Nexus does not read. */
export function fileKindOf(name: string): FileKind | null {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return ext === 'csv' || ext === 'tsv' || ext === 'xlsx' || ext === 'json' ? ext : null
}

/** "48 KB", "1.2 MB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export interface ImportState {
  step: ImportStep
  fileName: string | null
  source: ImportSource | null
  market: string | null
  preview: ImportPreview | null
  busy: boolean
  canManage: boolean
}

const MANAGE_IMPORT = "You need 'Manage reviews' to import reviews."

/** The mapping the person sees: their own choice, else what Nexus applied. */
export function shownMapping(preview: ImportPreview | null, own: Mapping): Mapping {
  return { ...(preview?.appliedMapping ?? {}), ...own }
}

/** How many of the fields Nexus matched on its own: "Nexus guessed 9 of 11 columns." */
export function guessWords(preview: ImportPreview): string {
  const guessed = Object.values(preview.detectedMapping).filter(Boolean).length
  return `Nexus matched ${count(guessed)} of ${plural(preview.headers.length, 'column', 'columns')}. Change any guess.`
}

/** Why the footer's next button is held on this step, or null when it may go on. First that applies wins. */
export function nextHeld(s: ImportState, mapping: Mapping): string | null {
  if (!s.canManage) return MANAGE_IMPORT
  if (s.busy) return 'Nexus is reading the file. This takes a few seconds.'
  if (s.step === 0) {
    if (!s.fileName) return 'Pick a file first.'
    if (!s.source) return 'Say where the file is from first.'
    if (sourceNeedsMarket(s.source) && !s.market) return 'Pick the market these reviews are from first.'
    return null
  }
  if (s.step === 1) {
    if (!s.preview) return 'Nexus has not read the file yet.'
    if (!shownMapping(s.preview, mapping).body) return 'Match the review text first: Nexus cannot import a review without it.'
    return null
  }
  if (s.step === 2) {
    if (!s.preview) return 'Nexus has not checked the file yet.'
    const ready = readyCount(s.preview)
    if (ready === 0) return 'Nothing new to import: every row is already in Nexus or cannot import.'
    return null
  }
  return null
}

/**
 * The rows that import now: the API's own count, made with the person's choice about rows without a product link (the
 * preview is read again when that choice changes).
 */
export function readyCount(preview: ImportPreview): number {
  return preview.willInsert
}

/** The footer's next button. */
export function nextLabel(step: ImportStep, preview: ImportPreview | null): string {
  if (step === 0) return 'Next: match columns'
  if (step === 1) return preview ? `Next: check ${plural(preview.totalRows, 'row', 'rows')}` : 'Next: check the rows'
  if (step === 2) return preview ? `Import ${plural(readyCount(preview), 'review', 'reviews')}` : 'Import'
  return 'Close'
}

/** The footer's note on each step. */
export function footNote(step: ImportStep): string {
  if (step === 0) return 'Nothing is imported until the last step.'
  if (step === 1) return 'Each field shows the first two rows as Nexus reads them.'
  if (step === 2) return 'Imported reviews show as “Imported” in the Inbox.'
  return ''
}

/** A done step can be opened again, until the import ran. */
export function canOpenStep(index: number, current: ImportStep): boolean {
  return current < 3 && index < current
}

/** The Check step's counts. */
export function checkCounts(p: ImportPreview, includeUnlinked: boolean): { label: string; value: string; hint: string }[] {
  const already = p.duplicateExisting + p.duplicateInBatch
  return [
    { label: 'Rows in the file', value: count(p.totalRows), hint: plural(p.headers.length, 'column', 'columns') },
    {
      label: 'Ready',
      value: count(readyCount(p)),
      hint: p.unknownProductRows > 0 ? (includeUnlinked ? `${count(p.unknownProductRows)} without a product link` : `${count(p.unknownProductRows)} without a product link left out`) : 'linked to products',
    },
    { label: 'Already in Nexus', value: count(already), hint: 'same review ID, skipped' },
    { label: 'Cannot import', value: count(p.invalidRows), hint: p.invalidRows > 0 ? 'see below' : 'none' },
  ]
}

export interface ImportWarning { key: string; tone: 'warning' | 'info'; title: string; body: string }

/** The warnings in words: rows naming a product Nexus does not know; columns never imported (e-mail, IP). */
export function importWarnings(p: ImportPreview): ImportWarning[] {
  const out: ImportWarning[] = []
  if (p.unknownProductRows > 0) {
    const examples = p.unknownProductExamples.slice(0, 3).join(', ')
    out.push({
      key: 'unknown',
      tone: 'warning',
      title: `${plural(p.unknownProductRows, 'row names', 'rows name')} a product Nexus does not know.`,
      body: `Their SKU is not in your catalog${examples ? ` (for example ${examples})` : ''}. They import without a product link and do not count in Insights per product until they are linked.`,
    })
  }
  if (p.droppedColumns.length > 0) {
    out.push({
      key: 'private',
      tone: 'info',
      title: `Not imported: ${p.droppedColumns.join(', ')}.`,
      body: 'Nexus never keeps buyer e-mails or addresses from a file.',
    })
  }
  return out
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** The rows that cannot import, as a CSV a person can open ("Download these rows"). */
export function rejectsCsv(rejected: readonly { line: number; reasons: string[] }[]): string {
  const lines = ['Row,Why it cannot import', ...rejected.map((r) => `${r.line},${csvField(r.reasons.join('; '))}`)]
  return `${lines.join('\r\n')}\r\n`
}

/** "186 reviews imported" and what happened to the rest. */
export function doneWords(r: ImportResult): { title: string; body: string } {
  const already = r.summary.reviewsSkippedExisting
  const parts = [
    already > 0 ? `${plural(already, 'was', 'were')} already there` : null,
    r.skippedInvalid > 0 ? `${count(r.skippedInvalid)} could not import` : null,
    r.skippedUnlinked > 0 ? `${count(r.skippedUnlinked)} without a product link were left out` : null,
  ].filter(Boolean)
  return {
    title: `${plural(r.imported, 'review', 'reviews')} imported`,
    body: `They are in the Inbox now, marked “Imported”.${parts.length ? ` ${parts.join(', ')}.` : ''} A reply to an imported review is posted by hand on the channel.`,
  }
}

/** The toast after "Undo this import". */
export function undoWords(result: { removed: number; kept: readonly { reason: string }[] }): string {
  const removed = `Removed ${plural(result.removed, 'review', 'reviews')} of this import.`
  if (result.kept.length === 0) return removed
  return `${removed} Kept ${count(result.kept.length)} that someone already worked on: ${result.kept[0].reason.replace(/\.$/, '')}.`
}

/** The request body for preview and apply. */
export function importBody(input: {
  text: string | null
  bytesBase64: string | null
  fileKind: FileKind
  source: ImportSource
  market: string | null
  mapping: Mapping
  includeUnlinked: boolean
}): Record<string, unknown> {
  const columnMapping: Mapping = {}
  for (const [k, v] of Object.entries(input.mapping) as [CanonicalField, string | undefined][]) if (v) columnMapping[k] = v
  return {
    ...(input.bytesBase64 ? { bytesBase64: input.bytesBase64 } : { text: input.text ?? '' }),
    fileKind: input.fileKind,
    source: input.source,
    marketplace: input.market,
    columnMapping,
    includeUnlinked: input.includeUnlinked,
  }
}

/** What the Match step shows for a field in the first two rows (the values the API read for it), or "—". */
export function sampleValues(p: ImportPreview, field: CanonicalField): [string, string] {
  const pick = (i: number): string => {
    const row = p.sample[i]
    if (!row) return '—'
    const v = field === 'body' ? row.body : field === 'title' ? row.title : field === 'rating' ? row.rating : field === 'authorName' ? row.authorName
      : field === 'marketplace' ? row.marketplace : field === 'postedAt' ? row.postedAt?.slice(0, 10) ?? null : null
    if (v == null || v === '') return '—'
    const text = String(v)
    return text.length > 60 ? `${text.slice(0, 59)}…` : text
  }
  return [pick(0), pick(1)]
}
