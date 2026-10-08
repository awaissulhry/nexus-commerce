/**
 * The Matrix Case column and its pop-up (Step 3 part D, Owner 2026-10-07; several case sizes per SKU, Owner
 * 2026-10-08) — the pure part: what a cell shows, its tooltip, the pop-up's starting values and checks, the writes a
 * Save sends, and the route's client.
 *
 *   Case           ← Shared group: Base price · Stock · Case · FBA qty
 *   12 / case      ← a variant with one case size; `12 · 6 / case` with two; blank without one
 *   Mixed          ← the parent, when its variants' sizes differ (else their one list)
 *
 * The values are `MatrixRowRead.pack`: the case sizes (units per case, case size in cm, case weight in kg) and who preps
 * and labels for FBA. A Save writes through `PUT /api/stock/case-packs`: `sizes` replaces a SKU's whole list (matched
 * by units per case; absent = keep), an owner absent = keep. On the parent one Save serves every variant: sizes left as
 * they were, and an owner left as it was, keep each variant's own; the writes are grouped by the values they set.
 * The rule and the words are `@nexus/shared/stock-cases` (the API's too).
 */
import { amazonBoxWarning, CASE_COPY, MAX_CASE_SIZES, sizeProblem, type CaseOwner, type CaseSizeValues } from '@nexus/shared/stock-cases'
import { getBackendUrl } from '@/lib/backend-url'

import type { MatrixCasePack, MatrixRowRead } from './contract'

export const CASE_LABEL = 'Case'
export const CASE_HEADER_TIP = 'Case sizes (units per case, size, weight), FBA prep and labels. Enter opens it.'
export const CASE_EDIT_COPY = { label: 'Case', detail: 'Enter or F2 opens the case.' } as const
export const CASE_MIXED = 'Mixed'
/** The pop-up's words. */
export const CASE_DIALOG_COPY = {
  sizes: 'Case sizes',
  units: 'Units per case',
  size: 'Case size (L × W × H)',
  weight: 'Weight',
  add: 'Add case size',
  remove: 'Remove this case size',
  max: `At most ${MAX_CASE_SIZES} case sizes`,
  mixed: 'Variants differ. Each keeps its own.',
  replace: 'Replace for all variants',
  needUnits: 'Enter units per case',
} as const

/* ── the values ───────────────────────────────────────────────────────────────────────────── */

type PackRow = Pick<MatrixRowRead, 'role' | 'pack'>

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const owner = (v: unknown): CaseOwner | null => (v === 'AMAZON' || v === 'SELLER' ? v : null)
const ownerWord = (v: CaseOwner | null): string | null => (v === 'AMAZON' ? 'Amazon' : v === 'SELLER' ? 'Seller' : null)

/** One SKU's case pack as absolute values: its case sizes (biggest first) and its FBA owners. */
export interface PackValues {
  sizes: CaseSizeValues[]
  fbaPrepOwner: CaseOwner | null
  fbaLabelOwner: CaseOwner | null
}

/** A read pack as absolute values (a Decimal that arrived as a string reads as its number; a size without whole units is dropped). */
export function packValues(pack: MatrixCasePack | null | undefined): PackValues {
  const sizes = (pack?.sizes ?? []).flatMap((s): CaseSizeValues[] => {
    const units = num(s?.unitsPerCase)
    return units !== null && Number.isInteger(units) && units >= 1
      ? [{ unitsPerCase: units, caseLengthCm: num(s.caseLengthCm), caseWidthCm: num(s.caseWidthCm), caseHeightCm: num(s.caseHeightCm), caseWeightKg: num(s.caseWeightKg) }]
      : []
  }).sort((a, b) => b.unitsPerCase - a.unitsPerCase)
  return { sizes, fbaPrepOwner: owner(pack?.fbaPrepOwner), fbaLabelOwner: owner(pack?.fbaLabelOwner) }
}

const unitsOf = (pack: MatrixCasePack | null | undefined): number[] => packValues(pack).sizes.map((s) => s.unitsPerCase)
const fmt = (n: number): string => String(Math.round(n * 100) / 100)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/* ── the cell ─────────────────────────────────────────────────────────────────────────────── */

export interface CaseCellView {
  /** What the cell shows: `12 / case`, `12 · 6 / case`, `Mixed`, or '' (no case size). */
  text: string
  /** What a sort, a copy and an export read: the biggest units per case; null when none, or mixed. */
  value: number | null
  look: 'set' | 'none' | 'mixed'
  /** The pop-up may open: the server reads case packs (`pack` present), and a parent has variants. */
  door: boolean
  tooltip: string | undefined
}

/** One line per case size, then the owners: `12 per case · 60 × 40 × 35 cm · 14.5 kg` … `Prep: Seller · Labels: Seller`. */
export function caseTooltip(pack: MatrixCasePack | null | undefined): string | undefined {
  const v = packValues(pack)
  const lines = v.sizes.map((s) => {
    const parts = [`${s.unitsPerCase} per case`]
    const sides = [s.caseLengthCm, s.caseWidthCm, s.caseHeightCm]
    if (sides.some((x) => x !== null)) parts.push(`${sides.map((x) => (x === null ? '?' : fmt(x))).join(' × ')} cm`)
    if (s.caseWeightKg !== null) parts.push(`${fmt(s.caseWeightKg)} kg`)
    return parts.join(' · ')
  })
  const owners: string[] = []
  const prep = ownerWord(v.fbaPrepOwner)
  const labels = ownerWord(v.fbaLabelOwner)
  if (prep) owners.push(`Prep: ${prep}`)
  if (labels) owners.push(`Labels: ${labels}`)
  if (owners.length) lines.push(owners.join(' · '))
  return lines.length ? lines.join('\n') : 'No case size'
}

/** The parent's tooltip when its variants differ: each list of sizes and how many variants use it. */
function mixedTooltip(family: readonly PackRow[]): string {
  const counts = new Map<string, { units: number[]; n: number }>()
  for (const r of family) {
    const units = unitsOf(r.pack)
    const key = units.join(',')
    const at = counts.get(key)
    if (at) at.n += 1
    else counts.set(key, { units, n: 1 })
  }
  const lines = [...counts.values()]
    .sort((a, b) => (a.units.length === 0 ? 1 : b.units.length === 0 ? -1 : a.units[0] - b.units[0] || a.units.length - b.units.length))
    .map(({ units, n }) => `${units.length ? CASE_COPY.sizes(units) : 'Not set'} · ${n} ${n === 1 ? 'variant' : 'variants'}`)
  return [CASE_MIXED, ...lines].join('\n')
}

/** `All 6 variants` — the parent's pop-up title and tooltip. */
export const allVariants = (n: number): string => `All ${n} ${n === 1 ? 'variant' : 'variants'}`

/**
 * What a Case cell shows. A variant: its own case sizes. The parent (`family` = its variants): their one list, `Mixed`
 * when they differ, blank when none has one. Absent `pack` (an older server) shows blank and opens nothing.
 */
export function caseCellView(row: PackRow | null | undefined, family: readonly PackRow[] = []): CaseCellView {
  if (!row) return { text: '', value: null, look: 'none', door: false, tooltip: undefined }
  if (row.role !== 'parent' || family.length === 0) {
    const units = unitsOf(row.pack)
    const door = row.pack !== undefined && row.role !== 'parent'
    return { text: CASE_COPY.sizes(units), value: units[0] ?? null, look: units.length ? 'set' : 'none', door, tooltip: row.pack === undefined ? undefined : caseTooltip(row.pack) }
  }
  const door = family.some((r) => r.pack !== undefined)
  const lists = new Set(family.map((r) => unitsOf(r.pack).join(',')))
  if (lists.size > 1) return { text: CASE_MIXED, value: null, look: 'mixed', door, tooltip: mixedTooltip(family) }
  const units = unitsOf(family[0]?.pack)
  const first = packValues(family[0]?.pack)
  const allSame = family.every((r) => same(packValues(r.pack), first))
  const tooltip = !door ? undefined : allSame ? caseTooltip(family[0]?.pack) : units.length === 0 ? 'No case size' : `${allVariants(family.length)}: ${CASE_COPY.sizes(units)}`
  return { text: CASE_COPY.sizes(units), value: units[0] ?? null, look: units.length ? 'set' : 'none', door, tooltip }
}

/* ── the pop-up ───────────────────────────────────────────────────────────────────────────── */

/** One SKU the pop-up writes: a variant, or every variant of the parent. */
export interface CaseMember { id: string; sku: string; pack: MatrixCasePack | null | undefined }

export type CaseSizeField = 'unitsPerCase' | 'caseLengthCm' | 'caseWidthCm' | 'caseHeightCm' | 'caseWeightKg'
export type CaseOwnerField = 'fbaPrepOwner' | 'fbaLabelOwner'
export const CASE_SIZE_FIELDS: readonly CaseSizeField[] = ['unitsPerCase', 'caseLengthCm', 'caseWidthCm', 'caseHeightCm', 'caseWeightKg']
const OWNER_FIELDS: readonly CaseOwnerField[] = ['fbaPrepOwner', 'fbaLabelOwner']

/** One case size as typed: numbers as text ('' = not set). `key` keeps a row's identity while rows come and go. */
export type SizeDraft = Record<CaseSizeField, string> & { key: string }

/**
 * The pop-up as typed. `sizes` null = keep each variant's own list (the parent whose variants differ, untouched).
 * Owners: 'AMAZON' | 'SELLER' | '' (not set), or `CASE_KEEP` on the parent where the variants differ.
 */
export interface CaseDraft { sizes: SizeDraft[] | null; fbaPrepOwner: string; fbaLabelOwner: string }
export const CASE_KEEP = 'keep'

/** Where the pop-up starts, and where "Replace for all variants" starts (the first variant's list). */
export interface CaseStart { draft: CaseDraft; firstSizes: SizeDraft[]; mixed: ReadonlySet<CaseOwnerField | 'sizes'> }

let keySeq = 0
const newKey = (): string => `size-${++keySeq}`
const asText = (v: number | null): string => (v === null ? '' : fmt(v))

/** A size row with nothing typed. */
export const blankSize = (): SizeDraft => ({ key: newKey(), unitsPerCase: '', caseLengthCm: '', caseWidthCm: '', caseHeightCm: '', caseWeightKg: '' })
const toDraft = (v: CaseSizeValues): SizeDraft => ({
  key: newKey(), unitsPerCase: asText(v.unitsPerCase), caseLengthCm: asText(v.caseLengthCm), caseWidthCm: asText(v.caseWidthCm),
  caseHeightCm: asText(v.caseHeightCm), caseWeightKg: asText(v.caseWeightKg),
})
/** A list to edit: its rows, or one blank row when it has none (so the units can be typed at once). */
export const draftsOf = (sizes: readonly CaseSizeValues[]): SizeDraft[] => (sizes.length ? sizes.map(toDraft) : [blankSize()])

export function caseStart(members: readonly CaseMember[]): CaseStart {
  const values = members.map((m) => packValues(m.pack))
  const mixed = new Set<CaseOwnerField | 'sizes'>()
  const firstSizes = draftsOf(values[0]?.sizes ?? [])
  const sameSizes = values.every((v) => same(v.sizes, values[0]?.sizes ?? []))
  if (!sameSizes) mixed.add('sizes')
  const draft: CaseDraft = { sizes: sameSizes ? firstSizes.map((d) => ({ ...d })) : null, fbaPrepOwner: '', fbaLabelOwner: '' }
  for (const f of OWNER_FIELDS) {
    const seen = new Set(values.map((v) => v[f] ?? ''))
    if (seen.size > 1) { mixed.add(f); draft[f] = CASE_KEEP } else draft[f] = [...seen][0] ?? ''
  }
  return { draft, firstSizes, mixed }
}

/** A typed number: '' = not set; a comma reads as the decimal point (`35,5`); text that is not a number → NaN. */
export function parseCaseNumber(text: string): number | null {
  const t = text.trim().replace(',', '.')
  if (t === '') return null
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : Number.NaN
}

const BLANK: CaseSizeValues = { unitsPerCase: 1, caseLengthCm: null, caseWidthCm: null, caseHeightCm: null, caseWeightKg: null }
const isBlank = (d: SizeDraft): boolean => CASE_SIZE_FIELDS.every((f) => d[f].trim() === '')

/** What is wrong with one typed field of a size (the shared `sizeProblem` sentence), or null. '' is fine here. */
export function sizeFieldProblem(field: CaseSizeField, text: string): string | null {
  const n = parseCaseNumber(text)
  if (n === null) return null
  if (Number.isNaN(n)) return 'Enter a number'
  return sizeProblem({ ...BLANK, [field]: n })
}

/** The list a Save would write (biggest first), and what is wrong with it: per row field (`rowKey:field`), then the list. */
export interface ParsedSizes { values: CaseSizeValues[]; problems: Map<string, string>; first: string | null }

/** A row with nothing typed is left out (an "Add case size" not used). A row needs its units; units may not repeat. */
export function parseSizes(rows: readonly SizeDraft[]): ParsedSizes {
  const problems = new Map<string, string>()
  const values: CaseSizeValues[] = []
  const seen = new Set<number>()
  for (const row of rows) {
    if (isBlank(row)) continue
    let ok = true
    for (const f of CASE_SIZE_FIELDS) {
      const problem = sizeFieldProblem(f, row[f])
      if (problem) { problems.set(`${row.key}:${f}`, problem); ok = false }
    }
    const units = parseCaseNumber(row.unitsPerCase)
    if (units === null) { problems.set(`${row.key}:unitsPerCase`, CASE_DIALOG_COPY.needUnits); ok = false }
    else if (ok && seen.has(units)) { problems.set(`${row.key}:unitsPerCase`, CASE_COPY.sameSize(units)); ok = false }
    if (!ok || units === null) continue
    seen.add(units)
    values.push({
      unitsPerCase: units,
      caseLengthCm: parseCaseNumber(row.caseLengthCm), caseWidthCm: parseCaseNumber(row.caseWidthCm),
      caseHeightCm: parseCaseNumber(row.caseHeightCm), caseWeightKg: parseCaseNumber(row.caseWeightKg),
    })
  }
  values.sort((a, b) => b.unitsPerCase - a.unitsPerCase)
  const list = values.length > MAX_CASE_SIZES ? CASE_DIALOG_COPY.max : null
  return { values, problems, first: [...problems.values()][0] ?? list }
}

/** One PUT's values: `sizes` absent = keep each SKU's list; an owner absent = keep, null = not set. */
export interface CaseBody { sizes?: CaseSizeValues[]; fbaPrepOwner?: CaseOwner | null; fbaLabelOwner?: CaseOwner | null }
/** One PUT: these SKUs, these values. */
export interface CaseWrite { productIds: string[]; values: CaseBody }

/** What the pop-up changes: the new list (null = sizes untouched) and the owners typed. */
function changesOf(draft: CaseDraft, start: CaseStart): { sizes: CaseSizeValues[] | null; owners: Array<[CaseOwnerField, CaseOwner | null]> } {
  let sizes: CaseSizeValues[] | null = null
  if (draft.sizes !== null) {
    const next = parseSizes(draft.sizes).values
    const before = start.draft.sizes === null ? null : parseSizes(start.draft.sizes).values
    if (before === null || !same(next, before)) sizes = next
  }
  const owners = OWNER_FIELDS.filter((f) => draft[f] !== start.draft[f] && draft[f] !== CASE_KEEP).map((f): [CaseOwnerField, CaseOwner | null] => [f, owner(draft[f])])
  return { sizes, owners }
}

/** Writes grouped by the values they set; a member whose values do not change is left out. */
function grouped(rows: ReadonlyArray<{ id: string; values: CaseBody }>): CaseWrite[] {
  const byKey = new Map<string, CaseWrite>()
  for (const r of rows) {
    if (Object.keys(r.values).length === 0) continue
    const key = JSON.stringify(r.values)
    const at = byKey.get(key)
    if (at) at.productIds.push(r.id)
    else byKey.set(key, { productIds: [r.id], values: r.values })
  }
  return [...byKey.values()]
}

/** What Save sends: one write per set of values (normally one), only for members that change. [] = nothing to save. */
export function caseWrites(members: readonly CaseMember[], draft: CaseDraft, start: CaseStart): CaseWrite[] {
  const ch = changesOf(draft, start)
  if (ch.sizes === null && ch.owners.length === 0) return []
  return grouped(members.map((m) => {
    const own = packValues(m.pack)
    const values: CaseBody = {}
    if (ch.sizes !== null && !same(own.sizes, ch.sizes)) values.sizes = ch.sizes
    for (const [f, v] of ch.owners) if (own[f] !== v) values[f] = v
    return { id: m.id, values }
  }))
}

/** The Undo of these writes: each member back to what it held before, for the values those writes set. */
export function undoWrites(members: readonly CaseMember[], writes: readonly CaseWrite[]): CaseWrite[] {
  return grouped(members.flatMap((m) => {
    const mine = writes.filter((w) => w.productIds.includes(m.id))
    if (mine.length === 0) return []
    const own = packValues(m.pack)
    const values: CaseBody = {}
    if (mine.some((w) => w.values.sizes !== undefined)) values.sizes = own.sizes
    for (const f of OWNER_FIELDS) if (mine.some((w) => w.values[f] !== undefined)) values[f] = own[f]
    return [{ id: m.id, values }]
  }))
}

/** Why Save cannot run now, or null: a size that does not pass, or nothing changed (''). */
export function caseSaveHeld(members: readonly CaseMember[], draft: CaseDraft, start: CaseStart): string | null {
  if (draft.sizes !== null) {
    const problem = parseSizes(draft.sizes).first
    if (problem) return problem
  }
  return caseWrites(members, draft, start).length === 0 ? '' : null
}

/** Amazon EU's box limits, as a warning, for any case size Save would leave (or that the members hold now). */
export function caseBoxWarning(members: readonly CaseMember[], draft: CaseDraft): string | null {
  const lists = draft.sizes !== null ? [parseSizes(draft.sizes).values] : members.map((m) => packValues(m.pack).sizes)
  for (const list of lists) for (const s of list) {
    const warning = amazonBoxWarning(s)
    if (warning) return warning
  }
  return null
}

/* ── the route ────────────────────────────────────────────────────────────────────────────── */

/** One level whose sealed cases a case-size removal opens (the 409's list). */
export interface SealedCases { productId: string; sku: string; locationCode: string; unitsPerCase: number | null; cases: number }

export type CasePutAnswer =
  | { kind: 'saved'; results: Array<{ productId: string; ok: boolean; noop?: boolean; opened?: Array<{ locationCode: string; unitsPerCase?: number; cases: number }>; error?: string }> }
  | { kind: 'sealed'; sealed: SealedCases[] }

export type CasePut = (write: CaseWrite, openSealedCases: boolean) => Promise<CasePutAnswer>

/** `PUT /api/stock/case-packs` — 200 per-SKU results; 409 `SEALED_CASES` → `sealed`; anything else throws its sentence. */
export async function putCasePacks(
  write: CaseWrite,
  openSealedCases: boolean,
  opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {},
): Promise<CasePutAnswer> {
  const doFetch = opts.fetchImpl ?? fetch
  const res = await doFetch(`${opts.baseUrl ?? getBackendUrl()}/api/stock/case-packs`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productIds: [...write.productIds], ...write.values, ...(openSealedCases ? { openSealedCases: true } : {}) }),
  })
  const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (res.status === 409 && answer && (answer.code === 'SEALED_CASES' || answer.error === 'SEALED_CASES')) {
    const list = Array.isArray(answer.sealed) ? answer.sealed : Array.isArray(answer.detail) ? answer.detail : []
    const sealed = list.flatMap((s): SealedCases[] => {
      const o = s as Record<string, unknown>
      const cases = typeof o.cases === 'number' && Number.isFinite(o.cases) ? o.cases : 0
      const unitsPerCase = typeof o.unitsPerCase === 'number' && Number.isFinite(o.unitsPerCase) ? o.unitsPerCase : null
      return cases > 0 ? [{ productId: String(o.productId ?? ''), sku: String(o.sku ?? ''), locationCode: String(o.locationCode ?? ''), unitsPerCase, cases }] : []
    })
    return { kind: 'sealed', sealed }
  }
  if (!res.ok || !answer) {
    const said = answer && (typeof answer.message === 'string' ? answer.message : typeof answer.error === 'string' ? answer.error : null)
    throw new Error(said ?? `The case was not saved (HTTP ${res.status})`)
  }
  const results = Array.isArray(answer.results) ? (answer.results as Array<Record<string, unknown>>) : []
  return {
    kind: 'saved',
    results: results.map((r) => ({
      productId: String(r.productId ?? ''),
      ok: r.ok === true,
      ...(r.noop === true ? { noop: true } : {}),
      ...(Array.isArray(r.opened) ? { opened: r.opened as Array<{ locationCode: string; unitsPerCase?: number; cases: number }> } : {}),
      ...(typeof r.error === 'string' ? { error: r.error } : {}),
    })),
  }
}

/** The 409's sentence and the count on the confirm button: `4 sealed cases at IT-MAIN become loose units. …`. */
export function sealedSummary(sealed: readonly SealedCases[]): { cases: number; sentence: string } | null {
  const cases = sealed.reduce((n, s) => n + s.cases, 0)
  if (cases <= 0) return null
  const where = [...new Set(sealed.map((s) => s.locationCode).filter(Boolean))].join(', ') || 'your warehouse'
  return { cases, sentence: CASE_COPY.sealedOpen(cases, where) }
}

/** The primary button: `Save`, or — after a 409, the second click confirms — `Save · open 4 cases`. */
export const saveLabel = (cases: number | null, confirming: boolean): string =>
  !confirming ? 'Save' : cases ? `Save · open ${cases} ${cases === 1 ? 'case' : 'cases'}` : 'Save · open cases'

/** The toast after a save: `Case saved · GALE-M · 12 · 6 / case`, `… · No case size`, `… · 4 cases opened`. */
export function caseSavedSentence(label: string, writes: readonly CaseWrite[], opened: number): string {
  const lists = new Set(writes.filter((w) => w.values.sizes !== undefined).map((w) => (w.values.sizes ?? []).map((s) => s.unitsPerCase).join(',')))
  const sizes = lists.size === 1 ? [...lists][0]!.split(',').filter(Boolean).map(Number) : null
  const sizeWords = sizes === null ? null : sizes.length ? CASE_COPY.sizes(sizes) : 'No case size'
  return [`Case saved · ${label}`, sizeWords, opened > 0 ? `${opened} ${opened === 1 ? 'case' : 'cases'} opened` : null]
    .filter(Boolean).join(' · ')
}
