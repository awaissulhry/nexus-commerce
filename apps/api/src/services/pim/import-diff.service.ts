import type { ContentAddress } from '@nexus/shared/content-language'
import { normalizeLanguage } from './content-language.js'
import { contentHeaderKey, type ContentHeaderForm } from '@nexus/shared/content-header'
import { availableContentLanguages } from './market-languages.js'
/**
 * PES.5 / D15 — the import DIFF: parse a file, say what would change, write nothing.
 *
 * Preflight-first and dry-run by default (GDS-4's rule): upload → parse → DIFF →
 * apply, and nothing writes until the operator applies the diff they saw. This
 * module is the middle step and is deliberately **pure of writes** — it reads the
 * studio sheet and returns verdicts, so the whole acceptance for D15.1 ("export a
 * view, re-import it unmodified, zero changes") runs without touching a row.
 *
 * ⚠ This is NOT the legacy import-wizard and must never be confused with it.
 * `ImportJob` / `ImportJobRow` back `/bulk-operations/imports`, which the Owner
 * validated on 2026-07-06 under a standing rule — *"do NOT make functional
 * changes to it"*. Nothing here touches those tables, endpoints or services, and
 * nothing here carries the name `ImportJob` (D15.14).
 */

import type { StudioScopeKind } from './studio-sheet.service.js'

/** D15.13.1 — three verdicts; `pins` is a FLAG on a changed cell, not a fourth. */
export type CellVerdict = 'unchanged' | 'changed' | 'refused'

export interface DiffCell {
  restoreIntent?: 'set' | 'reset'
  contentAddress?: ContentAddress
  rowId: string
  /** D15.13.3 — components, never a composed id; the client composes. */
  aliasKey: string
  aliasResolved: boolean
  /** The SHEET key — names the cell in the file and in the sheet's `values` (`skip_offer`). */
  fieldKey: string
  /**
   * The WRITE field — what the bulk write path is told (`attr_skip_offer`), from the column contract's
   * `writeField`; the sheet key when the contract states none. Measured 2026-09-05 on the first
   * round trip over the full AM.1 contract: 63 cells refused "Field not editable" because the diff
   * handed the write path the SHEET key, which it only recognises for the core fields — every
   * category attribute an import ever changed would have been refused at preview AND at apply.
   */
  writeField: string
  /** The coordinate this column writes to, from its own header (D15.3). */
  scope: { kind: StudioScopeKind; channel: string | null; marketplace: string | null; locale: string | null }
  verdict: CellVerdict
  /** True when writing this pins a cell that follows master today. */
  pins: boolean
  /** RAW values. Labels are rendered by the CLIENT with the grid's own
   *  formatter (D15.14.3) — the server sending its own would make the sheet and
   *  the diff two renderers of one value. */
  before: unknown
  after: unknown
  /** Present only on `refused`. */
  reason?: string
}

export interface DiffCounts {
  /** Server-stated and authoritative — never derived from `rows.length` (#357). */
  unchanged: number
  changed: number
  refused: number
  /** A SUBSET of `changed`, never added to it. */
  wouldPin: number
}

export interface ImportDiff {
  cells: DiffCell[]
  counts: DiffCounts
  /** Columns in the file that no scope declares — reported, never applied. */
  unknownColumns: string[]
  /**
   * Columns whose KEY cell is empty — informational columns the export writes for
   * humans (the identity band, the readiness verdicts; D15.2 + design V.5). Skipped
   * silently, named here (by their label row) so the drawer can say how many and
   * which, and a re-import of an unmodified export produces ZERO noise (D15.1).
   */
  ignoredColumns: string[]
  /** Rows whose key matched no product in the family. */
  unmatchedRows: { rowIndex: number; key: string }[]
  blankPolicy: 'ignore' | 'clear'
  /** Only ever present if the server truncates; absent means these ARE all. */
  truncated?: { shown: number; total: number }
}

/**
 * D15.2 — row 2 is the machine header: `key` on master,
 * `key@channel:market:locale` on a channel scope.
 *
 * Pure and exported so the parse is testable without a file, a sheet or a
 * database. Returns `null` for a header it cannot read rather than guessing a
 * coordinate — a guessed scope writes to the wrong place silently.
 */
/**
 * The declared FORM of a non-scalar column (AM.1 shapes): `key[]` = a list whose items are joined by
 * ` | `; `key[measure]` = a `value unit` pair. Declared by the exporter, read here — a separator is a
 * rendering claim the file must state, never something the import guesses from commas (the eBay
 * fixture holds a comma-joined phrase INSIDE one list item).
 */
export type FileCellForm = 'list' | 'measure'
export const LIST_SEPARATOR = ' | '

/**
 * LX.F P2-13 / F3 — ONE grammar, in `@nexus/shared/content-header`, because the web
 * export had a second writer that disagreed on three things (see that module). This
 * spelling is unchanged: it is the live producer, so no existing file changes meaning.
 */
export function languageHeader(field: string, scope: { channel?: string | null; marketplace?: string | null; locale?: string | null }, form?: ContentHeaderForm): string {
  return contentHeaderKey(field, scope, form)
}

export function parseHeader(raw: string): {
  fieldKey: string
  scope: DiffCell['scope']
  isFormulaColumn: boolean
  form: FileCellForm | null
} | null {
  const h = String(raw ?? '').trim()
  if (!h) return null
  if (h.split('@').length > 2) return null
  const [keyPart, coordPart] = h.split('@')
  let fieldKey = keyPart.trim()
  if (!fieldKey) return null

  // D15.8 — `key.formula` is a sibling column carrying the expression.
  const isFormulaColumn = fieldKey.endsWith('.formula')
  if (isFormulaColumn) fieldKey = fieldKey.slice(0, -'.formula'.length)
  if (!fieldKey) return null

  // The declared form, stripped from the key so `fieldKey` names the column.
  let form: FileCellForm | null = null
  if (fieldKey.endsWith('[]')) { form = 'list'; fieldKey = fieldKey.slice(0, -2) }
  else if (fieldKey.endsWith('[measure]')) { form = 'measure'; fieldKey = fieldKey.slice(0, -'[measure]'.length) }
  if (!fieldKey) return null

  if (coordPart === undefined) {
    return { fieldKey, scope: { kind: 'master', channel: null, marketplace: null, locale: null }, isFormulaColumn, form }
  }
  // LX.F P2-18 — ONE accept-and-normalise rule in both locale positions. The master
  // position used `/^[a-z]{2,3}$/` while the channel position below accepts
  // `[a-zA-Z]{2,3}([-_]…)*` and normalises, so `title@de-DE` and `title@DE` parsed on a
  // channel coordinate and returned null (an unrecognised column) on a master one.
  // Nothing emits a regional master tag today, so the asymmetry was consistent only
  // by accident. Match the permissive shape, normalise, and let the throw be the
  // rejection — the same rule the channel position already follows.
  if (/^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8})*$/.test(coordPart) && !coordPart.includes(':')) {
    try { return { fieldKey, scope: { kind: 'master', channel: null, marketplace: null, locale: normalizeLanguage(coordPart) }, isFormulaColumn, form } }
    catch { return null }
  }
  const parts = coordPart.split(':')
  // channel:market:locale — locale may be omitted, channel and market may not.
  if (parts.length < 2 || parts.length > 3) return null
  const [channel, marketplace, locale] = parts
  if (!channel?.trim() || !marketplace?.trim()) return null
  if (locale?.trim() && !/^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8})*$/.test(locale.trim())) return null
  return {
    fieldKey,
    scope: {
      kind: 'channel',
      channel: channel.trim().toUpperCase(),
      marketplace: marketplace.trim().toUpperCase(),
      locale: locale?.trim() ? normalizeLanguage(locale.trim()) : null,
    },
    isFormulaColumn,
    form,
  }
}

/**
 * A file cell back into the value the sheet stores, by DECLARED form. A list splits on the declared
 * separator (trimmed, empties dropped); a measure parses `value unit` into `{ value, unit }` and
 * refuses nothing here — an unparseable measure passes through as the string and the write path
 * refuses it with the real reason. Blank stays blank (the blank-cell policy decides). Pure, tested.
 */
export function fromFileForm(form: FileCellForm | null, incoming: unknown): unknown {
  if (!form || typeof incoming !== 'string') return incoming
  const s = incoming.trim()
  if (!s) return incoming
  if (form === 'list') return s.split(LIST_SEPARATOR).map((x) => x.trim()).filter((x) => x.length > 0)
  const m = /^(-?\d+(?:[.,]\d+)?)(?:\s+(\S+))?$/.exec(s)
  if (!m) return incoming
  const value = Number(m[1].replace(',', '.'))
  return m[2] ? { value, unit: m[2] } : { value }
}

/** One canonical string per value, so `["a"]` equals `["a"]` and `{unit,value}` equals `{value,unit}`. */
export function canonical(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return JSON.stringify(v.map((x) => canonical(x)))
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    return JSON.stringify(Object.keys(o).sort().map((k) => [k, canonical(o[k])]))
  }
  return String(v)
}

/**
 * D15.2, the half that was unbuilt — a closed-list cell may arrive as its LABEL (what the sheet's
 * own export writes: `Pakistan`, `Non applicabile`, `No`) or as its CODE (`PK`, `not_applicable`,
 * `false`); both mean the code. Measured 2026-09-04 on D15.1's own acceptance: an unmodified
 * "all attributes" export re-imported with **168 refusals** — 8 select columns × 21 rows — every
 * one a label the comparison held against a code. Resolved here, before the diff, so the sheet,
 * the diff and the write agree on ONE value.
 *
 * The match is exact on a code first, then a case-folded label, then a case-folded code; anything
 * else passes through untouched and the write path refuses it with the real reason. The code is
 * returned in the TYPE the contract stores it (`false`, not `'false'`) when the options carry it.
 */
export function optionCodeFor(
  col: { options?: unknown[]; optionLabels?: Record<string, string> } | undefined,
  incoming: unknown,
): unknown {
  if (!col || typeof incoming !== 'string') return incoming
  const s = incoming.trim()
  if (!s) return incoming
  const codes = col.options ?? []
  if (codes.some((c) => String(c) === s)) return codes.find((c) => String(c) === s)
  const fold = (x: unknown) => String(x).trim().toLowerCase()
  const byLabel = Object.entries(col.optionLabels ?? {}).find(([, label]) => fold(label) === fold(s))
  const codeStr = byLabel?.[0] ?? (codes.map(String).find((c) => fold(c) === fold(s)) ?? null)
  if (codeStr === null) return incoming
  return codes.find((c) => String(c) === codeStr) ?? codeStr
}

/**
 * A BOOLEAN column's cell arrives as the word the sheet rendered — the export writes what the grid
 * shows (`Yes` / `No`), and a spreadsheet may hand back `TRUE`, `1`, `y`. All of them mean the
 * stored boolean; anything else passes through and the write path refuses it with the real reason.
 * Measured 2026-09-05: three boolean columns × 21 rows re-imported as "changed", because `"No"`
 * was held against `false` (a boolean column carries no option list for `optionCodeFor` to use).
 */
export function coerceByKind(col: { kind?: string } | undefined, incoming: unknown): unknown {
  if (col?.kind !== 'boolean' || typeof incoming !== 'string') return incoming
  const s = incoming.trim().toLowerCase()
  if (s === 'yes' || s === 'y' || s === 'true' || s === '1') return true
  if (s === 'no' || s === 'n' || s === 'false' || s === '0') return false
  return incoming
}

/** Blank means "no value in the file cell", not the string "blank". */
const isBlankCell = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

/**
 * Compare one incoming cell against what the sheet holds.
 *
 * Pure: the caller supplies the current cell, so this is unit-testable and
 * cannot accidentally read or write. `refused` carries the sheet's own reason —
 * one validator, three surfaces (D15.4).
 */
export function diffCell(input: {
  incoming: unknown
  current: { value: unknown; writable: boolean; writeBlockedReason?: string | null; follows?: boolean | null } | undefined
  blankPolicy: 'ignore' | 'clear'
  validate?: (value: unknown) => string | null
}): { verdict: CellVerdict; pins: boolean; after: unknown; reason?: string } {
  const { incoming, current, blankPolicy, validate } = input
  const before = current?.value ?? null

  if (isBlankCell(incoming)) {
    // D15.5 — an omitted or blank cell is IGNORED unless the operator chose
    // `clear`, and the choice is echoed in the summary so it is never implicit.
    if (blankPolicy === 'ignore') return { verdict: 'unchanged', pins: false, after: before }
    if (before === null || before === undefined) return { verdict: 'unchanged', pins: false, after: before }
    if (current && !current.writable) {
      return { verdict: 'refused', pins: false, after: null, reason: current.writeBlockedReason ?? 'This cell is not writable' }
    }
    return { verdict: 'changed', pins: false, after: null }
  }

  // SAME-VALUE FIRST, before writability or validation.
  //
  // A cell that is not changing needs no write, so it cannot be refused for one.
  // Measured by D15.1's own acceptance: re-importing an unmodified export
  // produced `changed: 0` — correct — but **42 spurious `refused`**, because
  // every read-only cell in the file was judged on writability before anyone
  // asked whether it differed. An operator re-importing their own export would
  // have been told 42 things failed, which is the fastest way to teach them the
  // diff is noise.
  //
  // Compared as strings: a file carries text, and `"10"` from a spreadsheet is
  // not a change to a stored `10`. Anything else reports every numeric cell as
  // changed on a re-import, breaking the same acceptance for a reason that has
  // nothing to do with the data.
  // Non-scalars (a list, a measure) compare CANONICALLY — `String(["a"])` is `a`, which would read
  // a one-item list as its item and a two-item list as a comma-joined string; the file declares the
  // form and `fromFileForm` has already rebuilt the value, so the comparison is value to value.
  if (canonical(before) === canonical(incoming)) {
    return { verdict: 'unchanged', pins: false, after: before }
  }

  if (current && !current.writable) {
    return { verdict: 'refused', pins: false, after: incoming, reason: current.writeBlockedReason ?? 'This cell is not writable' }
  }
  const invalid = validate?.(incoming) ?? null
  if (invalid) return { verdict: 'refused', pins: false, after: incoming, reason: invalid }

  // Compared as strings: a file carries text, and `"10"` from a spreadsheet is
  // not a change to a stored `10`. Anything else reports every numeric cell in
  // the file as changed on a re-import, which would break D15.1's zero-change
  // acceptance for a reason that has nothing to do with the data.
  // D15.13.1 — writing a cell that FOLLOWS master today pins it. A flag on a
  // changed cell, so `wouldPin` stays a subset of `changed`.
  return { verdict: 'changed', pins: current?.follows === true, after: incoming }
}

/** Fold cells into the authoritative counts (D15.13.4). */
export function countDiff(cells: DiffCell[]): DiffCounts {
  const counts: DiffCounts = { unchanged: 0, changed: 0, refused: 0, wouldPin: 0 }
  for (const c of cells) {
    counts[c.verdict]++
    if (c.verdict === 'changed' && c.pins) counts.wouldPin++
  }
  return counts
}

/**
 * Compute a diff for one family from parsed file rows.
 *
 * Reads the studio sheet for each coordinate the file's headers name, and
 * compares. Writes NOTHING — the whole of D15.1's acceptance ("export a view,
 * re-import it unmodified, zero changes") runs through here without touching a
 * row.
 *
 * Row identity: the file's `sku` column matches a product in the family. A row
 * that matches nothing is reported in `unmatchedRows` and never guessed at — a
 * silently unmatched row is an import that quietly did less than it said.
 */
export async function computeImportDiff(input: {
  productId: string
  market: string
  headerRow: string[]
  /** Row 1 of a two-row file, for naming an informational column; absent on a key-only file. */
  labelRow?: string[]
  rows: Record<string, string>[]
  blankPolicy: 'ignore' | 'clear'
  /**
   * Item 8 — the WRITE PATH's verdict for a batch of candidate cells.
   *
   * Supplied by the route (which can reach the bulk PATCH in-process) so this
   * service still cannot call a route, and so there is exactly ONE validator:
   * a diff that decided for itself which values are acceptable would be a
   * mirror of the write path, correct on the day it was written and wrong the
   * first time either side changed. Returns a message per refused cell, keyed
   * `productId:<field as sent>` — the write field (what the write path was told), or the sheet key.
   */
  validateBatch?: (
    cells: { productId: string; fieldKey: string; writeField: string; value: unknown; scope: DiffCell['scope']; contentAddress?: ContentAddress }[],
  ) => Promise<Map<string, string>>
}): Promise<ImportDiff> {
  const { getStudioSheet } = await import('./studio-sheet.service.js')

  const parsed = input.headerRow.map((h) => ({ raw: h, parsed: parseHeader(h) }))
  const unknownColumns: string[] = []
  const ignoredColumns: string[] = []

  /**
   * LX.F F5 — ONE language-validity rule, derived from `Marketplace.languages`.
   *
   * `parseHeader` validates the SHAPE of a locale, not its existence, so `name@zz`
   * parsed as `{tier:'language', language:'zz'}` and a write would have created a
   * `ProductTranslation` row in a language nothing sells in — while
   * `catalog-translate.ts:68` refuses exactly that value on the catalogue path. The
   * authority answers here too, and an unsellable language is reported as an UNKNOWN
   * COLUMN (the file's own vocabulary for "this header names nothing"), never written.
   */
  const available = new Set(await availableContentLanguages())
  for (const p of parsed) {
    if (!p.parsed?.scope.locale || available.has(p.parsed.scope.locale)) continue
    unknownColumns.push(p.raw)
    p.parsed = null
  }

  // One sheet read per distinct coordinate the headers name — never per cell.
  const coordKey = (sc: DiffCell['scope']) => `${sc.kind}:${sc.channel ?? ''}:${sc.marketplace ?? ''}:${sc.locale ?? ''}`
  const needed = new Map<string, DiffCell['scope']>()
  for (const p of parsed) if (p.parsed) needed.set(coordKey(p.parsed.scope), p.parsed.scope)

  const sheets = new Map<string, any>()
  for (const [k, sc] of needed) {
    const sheet = await getStudioSheet({
      productId: input.productId,
      scope: sc.kind,
      ...(sc.locale ? { locale: sc.locale } : {}),
      market: sc.kind === 'channel' ? (sc.marketplace ?? input.market) : input.market,
      ...(sc.kind === 'channel' && sc.channel ? { channel: sc.channel } : {}),
    } as never)
    sheets.set(k, sheet)
  }

  // A column no scope declares is REPORTED, never applied. A column with an EMPTY key
  // is informational (the export writes one for the identity band and each readiness
  // verdict) and is IGNORED, named by its label so the count on screen is honest.
  parsed.forEach((p, i) => {
    if (!p.parsed) {
      if (p.raw.trim()) unknownColumns.push(p.raw)
      else ignoredColumns.push(input.labelRow?.[i]?.trim() || `column ${i + 1}`)
      return
    }
    const sheet = sheets.get(coordKey(p.parsed.scope))
    if (!sheet?.columns?.some((c: any) => c.key === p.parsed!.fieldKey)) unknownColumns.push(p.raw)
  })

  const bySku = new Map<string, any>()
  for (const sheet of sheets.values()) for (const r of sheet.rows) if (r.sku) bySku.set(String(r.sku), r)

  const cells: DiffCell[] = []
  const unmatchedRows: { rowIndex: number; key: string }[] = []
  input.rows.forEach((fileRow, i) => {
    const sku = String(fileRow.sku ?? '').trim()
    const row = bySku.get(sku)
    if (!row) { unmatchedRows.push({ rowIndex: i + 1, key: sku }); return }
    for (const p of parsed) {
      if (!p.parsed || p.parsed.isFormulaColumn) continue
      const sheet = sheets.get(coordKey(p.parsed.scope))
      if (!sheet?.columns?.some((c: any) => c.key === p.parsed!.fieldKey)) continue
      const sheetRow = sheet.rows.find((r: any) => String(r.sku) === sku)
      const current = sheetRow?.values?.[p.parsed.fieldKey]
      const column = sheet.columns.find((c: any) => c.key === p.parsed!.fieldKey)
      // Form first (the file's declaration), then the closed-list code for a scalar select.
      const shaped = fromFileForm(p.parsed.form, fileRow[p.raw])
      const incoming = p.parsed.form === 'list' && Array.isArray(shaped)
        ? shaped.map((item) => optionCodeFor(column, item))
        : p.parsed.form ? shaped : coerceByKind(column, optionCodeFor(column, shaped))
      const d = diffCell({ incoming, current, blankPolicy: input.blankPolicy })
      cells.push({
        rowId: sheetRow?.id ?? row.id,
        aliasKey: sheetRow?.aliasId ? String(sheetRow.aliasId) : '',
        aliasResolved: true,
        writeField: String(column?.writeField ?? p.parsed.fieldKey),
        fieldKey: p.parsed.fieldKey,
        scope: p.parsed.scope,
        ...(current?.contentAddress ? { contentAddress: current.contentAddress } : {}),
        verdict: d.verdict, pins: d.pins,
        before: current?.value ?? null, after: d.after,
        ...(d.reason ? { reason: d.reason } : {}),
      })
    }
  })

  // Item 8 — every cell that would CHANGE goes to the write path for its
  // verdict, and a refusal there becomes a refusal here with the write path's
  // own sentence.
  //
  // Measured before this: `status=NOT_A_STATUS` previewed as `changed`, was
  // applied, and was refused only at write time. The safe direction — nothing
  // bad was stored — but **a preview that promises a change which cannot happen
  // is the one thing a preview exists to prevent**, and D15.4 says one
  // validator, three surfaces.
  if (input.validateBatch) {
    const candidates = cells
      .filter((c) => c.verdict === 'changed')
      .map((c) => ({ productId: c.rowId, fieldKey: c.fieldKey, writeField: c.writeField, value: c.after, scope: c.scope, contentAddress: c.contentAddress }))
    if (candidates.length > 0) {
      const refusals = await input.validateBatch(candidates)
      for (const c of cells) {
        if (c.verdict !== 'changed') continue
        // The write path answers with the field it was TOLD (the write field; a slot write answers as
        // its base field), so a refusal is looked up by every name this cell could have answered to.
        const reason = refusals.get(`${c.rowId}:${c.writeField}@${c.scope.locale ?? ''}`)
          ?? refusals.get(`${c.rowId}:${c.writeField.replace(/\[\d+\]$/, '')}@${c.scope.locale ?? ''}`)
          ?? refusals.get(`${c.rowId}:${c.fieldKey}@${c.scope.locale ?? ''}`)
          ?? refusals.get(`${c.rowId}:${c.writeField}`)
          ?? refusals.get(`${c.rowId}:${c.writeField.replace(/\[\d+\]$/, '')}`)
          ?? refusals.get(`${c.rowId}:${c.fieldKey}`)
        if (reason) {
          c.verdict = 'refused'
          // `pins` is a property of a change that will happen; a refused cell
          // pins nothing, and leaving it set would keep the cell inside
          // `wouldPin` while it sits in `refused`.
          c.pins = false
          c.reason = reason
        }
      }
    }
  }

  return { cells, counts: countDiff(cells), unknownColumns, ignoredColumns, unmatchedRows, blankPolicy: input.blankPolicy }
}
