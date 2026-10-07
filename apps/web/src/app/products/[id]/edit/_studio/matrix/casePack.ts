/**
 * The Matrix Case column and its pop-up (Step 3 part D, Owner 2026-10-07) — the pure part: what a cell shows, its
 * tooltip, the pop-up's starting values and checks, the writes a Save sends, and the route's client.
 *
 *   Case        ← Shared group: Base price · Stock · Case · FBA qty
 *   12 / case   ← a variant with a case size; blank without one
 *   Mixed       ← the parent, when its variants differ (else their one size)
 *
 * The values are `MatrixRowRead.pack` (`ProductPackage`): units per case, case size (cm) and weight (kg), and who preps
 * and labels for FBA. A Save writes them absolute through `PUT /api/stock/case-packs`. On the parent one Save serves every
 * variant: a field left as it was keeps each variant's own value, so the writes are grouped by the values they set.
 * The rule and the words are `@nexus/shared/stock-cases` (the API's too).
 */
import { amazonBoxWarning, CASE_COPY, packProblem, type CaseOwner, type CasePackValues } from '@nexus/shared/stock-cases'
import { getBackendUrl } from '@/lib/backend-url'

import type { MatrixCasePack, MatrixRowRead } from './contract'

export const CASE_LABEL = 'Case'
export const CASE_HEADER_TIP = 'Units per sealed case, case size and weight, FBA prep and labels. Enter opens it.'
export const CASE_EDIT_COPY = { label: 'Case', detail: 'Enter or F2 opens the case.' } as const
export const CASE_MIXED = 'Mixed'

/* ── the cell ─────────────────────────────────────────────────────────────────────────────── */

type PackRow = Pick<MatrixRowRead, 'role' | 'pack'>

export interface CaseCellView {
  /** What the cell shows: `12 / case`, `Mixed`, or '' (no case size). */
  text: string
  /** What a sort, a copy and an export read: units per case; null when none, or mixed. */
  value: number | null
  look: 'set' | 'none' | 'mixed'
  /** The pop-up may open: the server reads case packs (`pack` present), and a parent has variants. */
  door: boolean
  tooltip: string | undefined
}

const unitsOf = (pack: MatrixCasePack | null | undefined): number | null => {
  const n = pack?.unitsPerCase
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const owner = (v: unknown): CaseOwner | null => (v === 'AMAZON' || v === 'SELLER' ? v : null)
const ownerWord = (v: CaseOwner | null): string | null => (v === 'AMAZON' ? 'Amazon' : v === 'SELLER' ? 'Seller' : null)

/** A read pack as the absolute values a Save sends (a Decimal that arrived as a string reads as its number). */
export function packValues(pack: MatrixCasePack | null | undefined): CasePackValues {
  return {
    unitsPerCase: unitsOf(pack),
    caseLengthCm: num(pack?.caseLengthCm),
    caseWidthCm: num(pack?.caseWidthCm),
    caseHeightCm: num(pack?.caseHeightCm),
    caseWeightKg: num(pack?.caseWeightKg),
    fbaPrepOwner: owner(pack?.fbaPrepOwner),
    fbaLabelOwner: owner(pack?.fbaLabelOwner),
  }
}

const fmt = (n: number): string => String(Math.round(n * 100) / 100)

/** One SKU's case in a line or two: `12 per case · 60 × 40 × 35 cm · 14.5 kg` / `Prep: Seller · Labels: Seller`. */
export function caseTooltip(pack: MatrixCasePack | CasePackValues | null | undefined): string | undefined {
  const v = packValues(pack as MatrixCasePack | null | undefined)
  const first: string[] = []
  if (v.unitsPerCase !== null) first.push(`${v.unitsPerCase} per case`)
  const sides = [v.caseLengthCm, v.caseWidthCm, v.caseHeightCm]
  if (sides.some((s) => s !== null)) first.push(`${sides.map((s) => (s === null ? '?' : fmt(s))).join(' × ')} cm`)
  if (v.caseWeightKg !== null) first.push(`${fmt(v.caseWeightKg)} kg`)
  const second: string[] = []
  const prep = ownerWord(v.fbaPrepOwner)
  const labels = ownerWord(v.fbaLabelOwner)
  if (prep) second.push(`Prep: ${prep}`)
  if (labels) second.push(`Labels: ${labels}`)
  const lines = [first.join(' · '), second.join(' · ')].filter(Boolean)
  return lines.length ? lines.join('\n') : 'No case size'
}

/** The parent's tooltip when its variants differ: each case size and how many variants use it. */
function mixedTooltip(family: readonly PackRow[]): string {
  const counts = new Map<number | null, number>()
  for (const r of family) { const u = unitsOf(r.pack); counts.set(u, (counts.get(u) ?? 0) + 1) }
  const lines = [...counts.entries()]
    .sort((a, b) => (a[0] === null ? 1 : b[0] === null ? -1 : a[0] - b[0]))
    .map(([u, n]) => `${u === null ? 'Not set' : CASE_COPY.perCase(u)} · ${n} ${n === 1 ? 'variant' : 'variants'}`)
  return [CASE_MIXED, ...lines].join('\n')
}

const sameValues = (a: CasePackValues, b: CasePackValues): boolean => JSON.stringify(a) === JSON.stringify(b)

/** `All 6 variants` — the parent's pop-up title and tooltip. */
export const allVariants = (n: number): string => `All ${n} ${n === 1 ? 'variant' : 'variants'}`

/**
 * What a Case cell shows. A variant: its own case size. The parent (`family` = its variants): their one size, `Mixed`
 * when they differ, blank when none has one. Absent `pack` (an older server) shows blank and opens nothing.
 */
export function caseCellView(row: PackRow | null | undefined, family: readonly PackRow[] = []): CaseCellView {
  if (!row) return { text: '', value: null, look: 'none', door: false, tooltip: undefined }
  if (row.role !== 'parent' || family.length === 0) {
    const u = unitsOf(row.pack)
    const door = row.pack !== undefined && row.role !== 'parent'
    return { text: u === null ? '' : CASE_COPY.perCase(u), value: u, look: u === null ? 'none' : 'set', door, tooltip: row.pack === undefined ? undefined : caseTooltip(row.pack) }
  }
  const door = family.some((r) => r.pack !== undefined)
  const units = new Set(family.map((r) => unitsOf(r.pack)))
  if (units.size > 1) return { text: CASE_MIXED, value: null, look: 'mixed', door, tooltip: mixedTooltip(family) }
  const u = [...units][0] ?? null
  const first = packValues(family[0]?.pack)
  const allSame = family.every((r) => sameValues(packValues(r.pack), first))
  const tooltip = !door ? undefined : allSame ? caseTooltip(first) : u === null ? 'No case size' : `${allVariants(family.length)}: ${CASE_COPY.perCase(u)}`
  return { text: u === null ? '' : CASE_COPY.perCase(u), value: u, look: u === null ? 'none' : 'set', door, tooltip }
}

/* ── the pop-up ───────────────────────────────────────────────────────────────────────────── */

/** One SKU the pop-up writes: a variant, or every variant of the parent. */
export interface CaseMember { id: string; sku: string; pack: MatrixCasePack | null | undefined }

export type CaseNumberField = 'unitsPerCase' | 'caseLengthCm' | 'caseWidthCm' | 'caseHeightCm' | 'caseWeightKg'
export type CaseOwnerField = 'fbaPrepOwner' | 'fbaLabelOwner'
export type CaseField = CaseNumberField | CaseOwnerField
export const CASE_NUMBER_FIELDS: readonly CaseNumberField[] = ['unitsPerCase', 'caseLengthCm', 'caseWidthCm', 'caseHeightCm', 'caseWeightKg']
const CASE_FIELDS: readonly CaseField[] = [...CASE_NUMBER_FIELDS, 'fbaPrepOwner', 'fbaLabelOwner']

/**
 * The pop-up's fields as typed: numbers as text ('' = not set), owners 'AMAZON' | 'SELLER' | '' (not set), and
 * `CASE_KEEP` on the parent for a field its variants differ on — left so, each variant keeps its own value.
 */
export type CaseDraft = Record<CaseField, string>
export const CASE_KEEP = 'keep'

/** Where the pop-up starts: the members' common value per field, `CASE_KEEP` where they differ. */
export interface CaseStart { draft: CaseDraft; mixed: ReadonlySet<CaseField> }

const asText = (v: number | string | null): string => (v === null ? '' : typeof v === 'number' ? fmt(v) : v)

export function caseStart(members: readonly CaseMember[]): CaseStart {
  const values = members.map((m) => packValues(m.pack))
  const draft = {} as CaseDraft
  const mixed = new Set<CaseField>()
  for (const f of CASE_FIELDS) {
    const seen = new Set(values.map((v) => asText(v[f])))
    if (seen.size > 1) { mixed.add(f); draft[f] = CASE_KEEP } else draft[f] = [...seen][0] ?? ''
  }
  return { draft, mixed }
}

/** A typed number: '' = not set; a comma reads as the decimal point (`35,5`); text that is not a number → NaN. */
export function parseCaseNumber(text: string): number | null {
  const t = text.trim().replace(',', '.')
  if (t === '') return null
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : Number.NaN
}

const EMPTY: CasePackValues = { unitsPerCase: null, caseLengthCm: null, caseWidthCm: null, caseHeightCm: null, caseWeightKg: null, fbaPrepOwner: null, fbaLabelOwner: null }

/** What is wrong with one field as typed (the shared `packProblem` sentence), or null. */
export function caseFieldProblem(field: CaseField, text: string): string | null {
  if (field === 'fbaPrepOwner' || field === 'fbaLabelOwner' || text === CASE_KEEP) return null
  const n = parseCaseNumber(text)
  if (n !== null && Number.isNaN(n)) return 'Enter a number'
  return packProblem({ ...EMPTY, [field]: n })
}

const changedFields = (draft: CaseDraft, start: CaseStart): CaseField[] => CASE_FIELDS.filter((f) => draft[f] !== start.draft[f] && draft[f] !== CASE_KEEP)

/** One member's values after the pop-up: a changed field takes the typed value, every other field keeps its own. */
function finalValues(member: CaseMember, draft: CaseDraft, changed: readonly CaseField[]): CasePackValues {
  const out = packValues(member.pack)
  for (const f of changed) {
    if (f === 'fbaPrepOwner' || f === 'fbaLabelOwner') out[f] = owner(draft[f])
    else out[f] = parseCaseNumber(draft[f]) as number | null
  }
  return out
}

/** One PUT: these SKUs, these absolute values. */
export interface CaseWrite { productIds: string[]; values: CasePackValues }

/** Writes grouped by the values they set; a member whose values do not change is left out. */
function grouped(rows: ReadonlyArray<{ id: string; values: CasePackValues }>): CaseWrite[] {
  const byKey = new Map<string, CaseWrite>()
  for (const r of rows) {
    const key = JSON.stringify(r.values)
    const at = byKey.get(key)
    if (at) at.productIds.push(r.id)
    else byKey.set(key, { productIds: [r.id], values: r.values })
  }
  return [...byKey.values()]
}

/** What Save sends: one write per set of values (normally one), only for members that change. [] = nothing to save. */
export function caseWrites(members: readonly CaseMember[], draft: CaseDraft, start: CaseStart): CaseWrite[] {
  const changed = changedFields(draft, start)
  if (changed.length === 0) return []
  return grouped(members.flatMap((m) => {
    const values = finalValues(m, draft, changed)
    return sameValues(values, packValues(m.pack)) ? [] : [{ id: m.id, values }]
  }))
}

/** The Undo of these writes: each member back to what it held before. */
export function undoWrites(members: readonly CaseMember[], writes: readonly CaseWrite[]): CaseWrite[] {
  const written = new Set(writes.flatMap((w) => w.productIds))
  return grouped(members.filter((m) => written.has(m.id)).map((m) => ({ id: m.id, values: packValues(m.pack) })))
}

/** Why Save cannot run now, or null: a field that does not pass, or nothing changed (''). */
export function caseSaveHeld(members: readonly CaseMember[], draft: CaseDraft, start: CaseStart): string | null {
  for (const f of CASE_FIELDS) {
    if (draft[f] === start.draft[f]) continue
    const problem = caseFieldProblem(f, draft[f])
    if (problem) return problem
  }
  return caseWrites(members, draft, start).length === 0 ? '' : null
}

/** Amazon EU's box limits, as a warning, for any of the values Save would leave (or that the members hold now). */
export function caseBoxWarning(members: readonly CaseMember[], draft: CaseDraft, start: CaseStart): string | null {
  const changed = changedFields(draft, start)
  for (const m of members) {
    const v = finalValues(m, draft, changed)
    if (CASE_NUMBER_FIELDS.some((f) => Number.isNaN(v[f] as number))) continue
    const warning = amazonBoxWarning(v)
    if (warning) return warning
  }
  return null
}

/* ── the route ────────────────────────────────────────────────────────────────────────────── */

/** One level whose sealed cases a case-size change opens (the 409's list). */
export interface SealedCases { productId: string; sku: string; locationCode: string; cases: number }

export type CasePutAnswer =
  | { kind: 'saved'; results: Array<{ productId: string; ok: boolean; noop?: boolean; opened?: Array<{ locationCode: string; cases: number }>; error?: string }> }
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
      return cases > 0 ? [{ productId: String(o.productId ?? ''), sku: String(o.sku ?? ''), locationCode: String(o.locationCode ?? ''), cases }] : []
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
      ...(Array.isArray(r.opened) ? { opened: r.opened as Array<{ locationCode: string; cases: number }> } : {}),
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

/** The toast after a save: `Case saved · GALE-M · 12 / case`, `… · 4 cases opened`. */
export function caseSavedSentence(label: string, writes: readonly CaseWrite[], opened: number): string {
  const units = new Set(writes.map((w) => w.values.unitsPerCase))
  const u = units.size === 1 ? [...units][0] ?? null : null
  return [`Case saved · ${label}`, u !== null ? CASE_COPY.perCase(u) : null, opened > 0 ? `${opened} ${opened === 1 ? 'case' : 'cases'} opened` : null]
    .filter(Boolean).join(' · ')
}
