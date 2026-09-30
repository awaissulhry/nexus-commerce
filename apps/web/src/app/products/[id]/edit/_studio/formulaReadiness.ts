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

export interface HeldEdit { rowId: string; fieldKey: string; apply: () => void; drop?: () => void }

/**
 * Edits made to a cell whose formula state is not known yet. They are kept — never refused — and applied in the order
 * they were made as soon as their cell is known, so a cell that turns out to hold a formula still takes the formula path.
 */
export function createHeldEdits() {
  let held: HeldEdit[] = []
  return {
    hold(edit: HeldEdit) { held.push(edit) },
    release(known: (rowId: string, fieldKey: string) => boolean): number {
      const ready = held.filter(edit => known(edit.rowId, edit.fieldKey))
      if (!ready.length) return 0
      held = held.filter(edit => !ready.includes(edit))
      for (const edit of ready) edit.apply()
      return ready.length
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
