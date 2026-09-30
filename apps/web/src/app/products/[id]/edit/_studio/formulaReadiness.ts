/**
 * P0 (2026-09-30) — per CELL, is its formula state known yet, and what is it. Pure, so `useCellFormulas` stays wiring.
 *
 * Every editor used to wait for ALL `/pim/formulas/batch` reads — one per listing alias and language, one after
 * another (5 × ~0.43 s on production) — and every edit in that window was refused and lost. The sheet read already
 * carries each cell's `formula` / `formulaError` (`studio-sheet.service.ts`, the same `CellFormula` rows and the same
 * locale rule as the batch), so a cell is known the moment its row arrives. The batch reads refresh it.
 *
 * Precedence: this tab's own save > a batch read that answered for the cell > the sheet read.
 */
import { languageColumn } from './sheet/languages'
import { adoptContentVersions } from './sheet/contentVersions'

/** Batch reads in flight at once: parallel, but not one request per alias and language all at the same moment. */
export const FORMULA_READS_AT_ONCE = 4
export const FORMULAS_LOADING = 'Loading formulas…'
/** The cell mark of an edit held until its cell's formula state is known, and of one the sheet dropped first. */
export const HELD_FOR_FORMULAS = 'Saving once this cell’s formulas have loaded.'
export const HELD_EDIT_DROPPED = 'Not saved: the sheet changed before this cell’s formulas loaded. Enter it again.'

export interface KnownFormula { expr: string; lastError?: string | null }
/**
 * A sheet row as this reads it. Of each cell only `formula` (without `=`) and `formulaError` are read — on the wire
 * since #473/#780, absent when the cell has none (#415) — checked here rather than declared on the row mirrors, whose
 * cells also feed the provenance classifier (`formula` is a flag there).
 */
export interface FormulaSeedRow { rowId: string; values: Readonly<Record<string, object | null | undefined>> }
export interface FormulaSeed {
  /** rowId → view key → formula. A row present here is fully known, with or without formulas. */
  rows: ReadonlyMap<string, ReadonlyMap<string, KnownFormula>>
  /** Same content → same signature, so a sheet re-read that changed no formula repaints nothing. */
  signature: string
}

export function seedFromSheet(rows: readonly FormulaSeedRow[]): FormulaSeed {
  const out = new Map<string, Map<string, KnownFormula>>()
  const parts: string[] = []
  for (const row of rows) {
    const cells = new Map<string, KnownFormula>()
    for (const [fieldKey, cell] of Object.entries(row.values ?? {})) {
      const { formula, formulaError } = (cell ?? {}) as { formula?: unknown; formulaError?: unknown }
      if (typeof formula === 'string') cells.set(fieldKey, { expr: formula, lastError: typeof formulaError === 'string' ? formulaError : null })
    }
    out.set(row.rowId, cells)
    parts.push(JSON.stringify([row.rowId, [...cells]]))
  }
  return { rows: out, signature: parts.join('\n') }
}

export interface FormulaReads {
  /** The coordinate and column keys the reads were made for; any change starts from empty. */
  key: string
  /** rowId → language → view key → formula, for every (row, language) a batch read answered. */
  read: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, KnownFormula>>>
  /** rowId → language → that read's error. */
  failed: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** rowId → view key → this tab's own save (null: replaced by a value), until a later read answers for it. */
  saved: ReadonlyMap<string, ReadonlyMap<string, KnownFormula | null>>
}

export const emptyReads = (key: string): FormulaReads => ({ key, read: new Map(), failed: new Map(), saved: new Map() })

/** A view key's language: `title@de` → de; a plain key is read in the sheet's own language. */
const cellLanguage = (fieldKey: string, locale: string) => languageColumn(fieldKey).locale ?? locale

/**
 * Did a batch read answer for this cell? A plain key whose language is not one the reads ask for is never returned by
 * them (`formulaReadKey`), so it counts as answered once every read of its row has.
 */
export function readCovers(reads: FormulaReads, languages: readonly string[], locale: string, rowId: string, fieldKey: string): boolean {
  const answered = reads.read.get(rowId)
  if (!answered) return false
  const language = cellLanguage(fieldKey, locale)
  return languages.includes(language) ? answered.has(language) : languages.every(l => answered.has(l))
}

export function formulaState(reads: FormulaReads, seed: FormulaSeed, languages: readonly string[], locale: string, rowId: string, fieldKey: string): { known: boolean; formula: KnownFormula | null } {
  const saved = reads.saved.get(rowId)
  if (saved?.has(fieldKey)) return { known: true, formula: saved.get(fieldKey) ?? null }
  if (readCovers(reads, languages, locale, rowId, fieldKey)) return { known: true, formula: reads.read.get(rowId)?.get(cellLanguage(fieldKey, locale))?.get(fieldKey) ?? null }
  const seeded = seed.rows.get(rowId)
  if (seeded) return { known: true, formula: seeded.get(fieldKey) ?? null }
  return { known: false, formula: null }
}

/** A row is known when the sheet read carried it or every batch read of it answered. */
export function rowKnown(reads: FormulaReads, seed: FormulaSeed, languages: readonly string[], rowId: string): boolean {
  if (seed.rows.has(rowId)) return true
  const answered = reads.read.get(rowId)
  return !!answered && languages.every(l => answered.has(l))
}

/** The read's own error for an unknown cell, or null while it is still loading. */
export function failureFor(reads: FormulaReads, languages: readonly string[], locale: string, rowId: string, fieldKey: string): string | null {
  const failed = reads.failed.get(rowId)
  if (!failed) return null
  const language = cellLanguage(fieldKey, locale)
  return (languages.includes(language) ? failed.get(language) : failed.values().next().value) ?? null
}

/** Every cell's formula as `formulaState` decides it, for the cells that have one. `signature` changes only with content. */
export function effectiveFormulas(reads: FormulaReads, seed: FormulaSeed, languages: readonly string[], locale: string): { formulas: ReadonlyMap<string, ReadonlyMap<string, KnownFormula>>; signature: string } {
  const out = new Map<string, Map<string, KnownFormula>>()
  const put = (rowId: string, fieldKey: string, formula: KnownFormula | null) => {
    const cells = out.get(rowId) ?? new Map<string, KnownFormula>()
    if (formula) cells.set(fieldKey, formula)
    else cells.delete(fieldKey)
    out.set(rowId, cells)
  }
  for (const [rowId, cells] of seed.rows) for (const [fieldKey, formula] of cells) {
    if (!readCovers(reads, languages, locale, rowId, fieldKey)) put(rowId, fieldKey, formula)
  }
  for (const [rowId, byLanguage] of reads.read) for (const cells of byLanguage.values()) for (const [fieldKey, formula] of cells) put(rowId, fieldKey, formula)
  for (const [rowId, cells] of reads.saved) for (const [fieldKey, formula] of cells) put(rowId, fieldKey, formula)
  // Sorted: which layer answered first must not look like a change.
  const byKey = (a: [string, unknown], b: [string, unknown]) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  const signature = JSON.stringify([...out].filter(([, cells]) => cells.size).sort(byKey).map(([rowId, cells]) => [rowId, [...cells].sort(byKey)]))
  return { formulas: out, signature }
}

/** A batch read answered for `rowIds` in `language`: it replaces that language's answer, its error, and the saves it now covers. */
export function landRead(reads: FormulaReads, answer: { language: string; locale: string; rowIds: readonly string[]; formulas: ReadonlyMap<string, ReadonlyMap<string, KnownFormula>> }): FormulaReads {
  const read = new Map(reads.read), failed = new Map(reads.failed), saved = new Map(reads.saved)
  for (const rowId of answer.rowIds) {
    read.set(rowId, new Map(read.get(rowId)).set(answer.language, answer.formulas.get(rowId) ?? new Map()))
    const errors = failed.get(rowId)
    if (errors?.has(answer.language)) {
      const rest = new Map(errors)
      rest.delete(answer.language)
      if (rest.size) failed.set(rowId, rest)
      else failed.delete(rowId)
    }
    const mine = saved.get(rowId)
    if (mine) {
      const rest = new Map([...mine].filter(([fieldKey]) => cellLanguage(fieldKey, answer.locale) !== answer.language))
      if (rest.size) saved.set(rowId, rest)
      else saved.delete(rowId)
    }
  }
  return { ...reads, read, failed, saved }
}

/** A batch read failed. An earlier answer for the same cells still stands; only cells nothing else knows show the error. */
export function failRead(reads: FormulaReads, failure: { language: string; rowIds: readonly string[]; error: string }): FormulaReads {
  const failed = new Map(reads.failed)
  for (const rowId of failure.rowIds) failed.set(rowId, new Map(failed.get(rowId)).set(failure.language, failure.error))
  return { ...reads, failed }
}

/** A retry starts clean: cells still unknown say "Loading" again until their read answers. */
export const clearFailures = (reads: FormulaReads): FormulaReads => reads.failed.size ? { ...reads, failed: new Map() } : reads

/** This tab saved a formula (or replaced one with a value, `null`): known at once, before any read says so. */
export function saveLocally(reads: FormulaReads, rowId: string, fieldKey: string, formula: KnownFormula | null): FormulaReads {
  const saved = new Map(reads.saved)
  saved.set(rowId, new Map(saved.get(rowId)).set(fieldKey, formula))
  return { ...reads, saved }
}

/**
 * Audit B29 — the `/pim/formulas/batch` reads a load still owes: one per language × listing alias × 250 rows, for the
 * rows the sheet read did NOT carry (a legacy read, the previous language's sheet). A row the sheet read seeded is
 * known with its formulas already (`seedFromSheet`), so it is read again only on an explicit Retry (`forced`).
 * Before, every load sent them all (GALE eBay IT: 5 reads; 15 with three languages) for formulas already on screen.
 */
export function formulaBatchRequests(input: { rowIds: readonly string[]; seeded: (rowId: string) => boolean; forced: boolean; languages: readonly string[]
  aliasOf: (rowId: string) => string }): Array<{ language: string; listingAlias: string; batch: string[] }> {
  const groups = new Map<string, string[]>()
  for (const id of input.rowIds) {
    if (!input.forced && input.seeded(id)) continue
    const alias = input.aliasOf(id)
    groups.set(alias, [...(groups.get(alias) ?? []), id])
  }
  return input.languages.flatMap(language => [...groups].flatMap(([listingAlias, group]) =>
    Array.from({ length: Math.ceil(group.length / 250) }, (_, i) => ({ language, listingAlias, batch: group.slice(i * 250, i * 250 + 250) }))))
}

/**
 * Audit A06 — a formula save (or a value replacing one) writes through the bulk writer with a compare-and-set, so the
 * row's version moves. The answer states the versions it left (`versions`, `contentVersions`); the row adopts them the
 * way it adopts a bulk save's, or the next plain edit on it would send the old token and come back 409.
 */
export interface FormulaVersionRow { id: string; listing?: unknown; values?: unknown }
export function adoptFormulaVersions(row: FormulaVersionRow | null | undefined, answer: unknown, seedProductVersion: (version: number) => void): boolean {
  const versions = (answer as { versions?: { product?: unknown; channelListing?: unknown } } | null)?.versions
  let moved = false
  if (typeof versions?.product === 'number') { seedProductVersion(versions.product); moved = true }
  const listing = row?.listing as { version?: number } | null | undefined
  if (typeof versions?.channelListing === 'number' && listing && typeof listing.version === 'number') { listing.version = versions.channelListing; moved = true }
  if (row && adoptContentVersions(row as never, answer).length) moved = true
  return moved
}

/** The function list is the same for every sheet of a session: read once (a failed read is asked again next time). */
let functionsRead: Promise<unknown> | null = null
export function readFormulaFunctionsOnce(read: () => Promise<unknown>): Promise<unknown> {
  functionsRead ??= read().catch(error => { functionsRead = null; throw error })
  return functionsRead
}
/** For tests: forget the session's function list. */
export function forgetFormulaFunctions(): void { functionsRead = null }

/** Run `tasks` with at most `limit` in flight; results in task order. No new task starts once `signal` aborts. */
export async function runBounded<T>(tasks: ReadonlyArray<() => Promise<T>>, limit: number, signal?: AbortSignal): Promise<Array<PromiseSettledResult<T> | undefined>> {
  const results: Array<PromiseSettledResult<T> | undefined> = new Array(tasks.length).fill(undefined)
  let next = 0
  const worker = async () => {
    while (next < tasks.length && !signal?.aborted) {
      const index = next++
      try { results[index] = { status: 'fulfilled', value: await tasks[index]() } }
      catch (reason) { results[index] = { status: 'rejected', reason } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), tasks.length) }, worker))
  return results
}

export interface HeldEdit { rowId: string; fieldKey: string; apply: () => void; drop?: (reason?: string) => void }

/**
 * Edits made to a cell whose formula state is not known yet. They are kept — never refused — and applied as soon as their
 * cell is known, so a cell that turns out to hold a formula still takes the formula path. ONE edit per cell: a later edit
 * to the same cell (a retype, an undo, a fill over it) replaces the earlier one, because the grid shows the later value
 * and that is the one to save (code review 2026-09-30: the earlier one was saved and the later one skipped).
 */
export function createHeldEdits() {
  let held: HeldEdit[] = []
  return {
    hold(edit: HeldEdit) {
      held = [...held.filter(other => other.rowId !== edit.rowId || other.fieldKey !== edit.fieldKey), edit]
    },
    release(known: (rowId: string, fieldKey: string) => boolean): number {
      const ready = held.filter(edit => known(edit.rowId, edit.fieldKey))
      if (!ready.length) return 0
      held = held.filter(edit => !ready.includes(edit))
      for (const edit of ready) edit.apply()
      return ready.length
    },
    /**
     * A cell whose formula read FAILED will not become known until the operator retries, so its edit is not left
     * "Saving…" forever: it is refused with the read's own error, and can be entered again after Retry.
     */
    dropFailed(failure: (rowId: string, fieldKey: string) => string | null): number {
      const failed = held.map(edit => ({ edit, reason: failure(edit.rowId, edit.fieldKey) })).filter(f => f.reason)
      if (!failed.length) return 0
      held = held.filter(edit => !failed.some(f => f.edit === edit))
      for (const { edit, reason } of failed) edit.drop?.(reason!)
      return failed.length
    },
    /** The sheet changed under the held edits (another coordinate or column set): tell each one it was not saved. */
    drop(): number {
      const dropped = held
      held = []
      for (const edit of dropped) edit.drop?.()
      return dropped.length
    },
    get size() { return held.length },
  }
}
