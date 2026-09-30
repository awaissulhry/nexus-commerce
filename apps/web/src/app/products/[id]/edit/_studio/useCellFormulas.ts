'use client'

/**
 * PES.2 — the master sheet's half of D16 cell formulas: the endpoints, and nothing else.
 *
 * The EDITOR is the engine's (`design-system/grid/editors/FormulaCellEditor`), and it deliberately
 * knows no URLs. This hook is the lane side of that seam, and the seam exists for a measured reason
 * rather than a tidy one: `POST /pim/formulas/preview` **requires `market`** and refuses without it
 * (#729), because the column key set a `$ref` may name differs per market — 40 keys on IT and 35 on
 * DE for the same product. A component that assembled its own request body would have to guess at a
 * market it cannot see, and a guess there is a plausible wrong answer, not an error.
 *
 * 🔴 It also owns the SAVE, and that is the part with teeth. A formula is stored in `CellFormula`
 * and its RESULT is written to the value layer by the server (§1.6(A)). If the sheet's ordinary
 * write path saw `="a" + $brand` it would store those characters as the cell's literal value — and
 * `overrideData` is read as a value layer by the resolver, so the formula text would publish to a
 * channel and preflight would call it valid. The interception in `onCellValueChanged` is what stops
 * that, and this is the function it hands off to.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { formulaSaveOutcome } from '@/design-system/grid'
import { createFormulaSaveQueue } from '@/design-system/grid/editors/formulaSaveQueue'
import type { FormulaFunctionDoc, FormulaPreviewResponse } from '@/design-system/grid'
import { getBackendUrl } from '@/lib/backend-url'
import { columnLanguages, languageField } from './sheet/languages'
import { formulaReadKey } from './sheet/formulaColumns'
import { useSaveReporter } from './contracts'
import { reportedFormulaWrite } from './formulaWrites'
import { FORMULA_READS_AT_ONCE, FORMULAS_LOADING, clearFailures, createHeldEdits, effectiveFormulas, emptyReads, failRead, failureFor, formulaState, landRead, rowKnown, runBounded, saveLocally, seedFromSheet, type FormulaReads, type FormulaSeedRow, type KnownFormula } from './formulaReadiness'

export interface CellFormulaRow {
  productId: string
  fieldKey: string
  expr: string
  /**
   * #780 — the SERVER'S OWN reason the last evaluation produced nothing, or null when it produced a
   * value. `CellFormula.lastError`, serialised by `toRow` and returned by `/pim/formulas/batch`.
   *
   * 🔴 IT WAS ON THE WIRE ALL ALONG AND THIS MIRROR DROPPED IT. Measured 2026-09-04: the server row
   * carries fifteen fields (`id scope channel marketplace locale market dependsOn lastError
   * evaluatedAt version updatedBy …`) and this interface named three, so a refused formula reached
   * the browser and was discarded at the parse boundary — which is why the refusal "rendered
   * nowhere at rest" and only the person who caused it ever saw it. Fourth instance of the wire→UI
   * mirror drift in this programme (#770 counted three). Widened only by what is consumed; the rest
   * stays unmirrored deliberately, and that is a choice rather than an oversight now.
   */
  lastError?: string | null
}

export interface UseCellFormulasInput {
  writeFacts?: (rowId: string, fieldKey: string) => import('@nexus/shared/content-language').ContentWriteFacts | undefined
  channelConnectionId?: string | null
  aliasKey?: string | null
  /** The family's parent — the id in the URL, used for the family-wide read. */
  productId: string
  /**
   * 🔴 The full COORDINATE, not just a market (#775). A formula is stored per
   * `scope · channel · marketplace · locale · market`, and the channel sheets need every part —
   * `cell-formula.routes.ts:52` has taken them all along. Master passes `scope: 'master'` and leaves
   * the channel pair undefined; a channel scope passes all five.
   *
   * This hook moved out of `sheet/master/` for that reason: master and the channel scopes must share
   * ONE seam or they drift the first time either fixes a parse. The engine cannot own it — it knows
   * URLs, and the editor deliberately knows none — so it lives here, above both sheets.
   */
  scope?: 'master' | 'channel'
  channel?: string | null
  marketplace?: string | null
  market: string
  locale: string
  /** Every row on the sheet, so one batch read covers the family. */
  rowIds: readonly string[]
  columnKeys?: readonly string[]
  rowScopes?: Readonly<Record<string, { productId: string; aliasKey: string }>>
  /**
   * P0 — the sheet read's rows, which already carry each cell's `formula` / `formulaError`. A row given here is known
   * at once; the batch reads only refresh it. Pass only rows read for THIS coordinate (not a legacy read, not the
   * previous language's sheet), or a cell would be judged by another coordinate's formulas.
   */
  seedRows?: readonly FormulaSeedRow[]
  onSettled?: () => void
  onValueSaved?: (rowId: string, fieldKey: string, value: unknown) => void
}

export interface CellFormulas {
  /** Every row's formula state is known. Editing does not wait for this: see `knownFor`. */
  ready: boolean
  loadError: string | null
  /** P0 — this cell's formula state is known (from the sheet read, a batch read or this tab's save). */
  knownFor: (rowId: string, fieldKey: string) => boolean
  /** Why this cell cannot open its editor yet ("Loading formulas…" or the read's error), or null. No row: the whole sheet. */
  unavailableFor: (rowId: string | undefined, fieldKey: string) => string | null
  /**
   * Run `edit` once this cell's formula state is known — at once if it already is. Held edits apply in the order they
   * were made; `drop` runs instead if the coordinate or column set changes first.
   */
  whenKnown: (rowId: string, fieldKey: string, edit: () => void, drop?: (reason?: string) => void) => void
  sourceLabel: string
  sourceLabelFor: (fieldKey?: string) => string
  replace: (rowId: string, fieldKey: string, value: unknown) => Promise<{ ok: boolean; error?: string }>

  /** `rowId` + `fieldKey` → the stored expression, so editing a formula cell opens the formula. */
  exprFor: (rowId: string, fieldKey: string) => string | null
  /**
   * #780 — `rowId` + `fieldKey` → the SERVER'S reason the formula produced nothing, or `null`.
   * The sheet renders this verbatim as the refused cell's tooltip; it is never composed with, and
   * never prefixed by, anything the client writes.
   */
  errorFor: (rowId: string, fieldKey: string) => string | null
  /** The language's functions, for the signature hint. Empty until loaded — never invented. */
  functions: FormulaFunctionDoc[]
  preview: (rowId: string, fieldKey: string, expr: string, signal?: AbortSignal) => Promise<FormulaPreviewResponse>
  save: (rowId: string, fieldKey: string, expr: string) => Promise<{ ok: boolean; error?: string }>
  /** Drop a formula, keeping the value it last produced. The audit row keeps it restorable. */
  pinOver: (rowId: string, fieldKey: string) => Promise<{ ok: boolean; error?: string }>
  reload: () => void
}

export function useCellFormulas({ productId, scope = 'master', channel = null, marketplace = null, market, locale, channelConnectionId, aliasKey, rowIds, columnKeys, rowScopes, seedRows, writeFacts, onSettled, onValueSaved }: UseCellFormulasInput): CellFormulas {
  const reporter = useSaveReporter()
  const coord = useMemo(() => ({ scope, channel, marketplace, market, locale, channelConnectionId, aliasKey }), [scope, channel, marketplace, market, locale, channelConnectionId, aliasKey])
  const columnsKey = JSON.stringify(columnKeys ?? [])
  const keys = useMemo(() => JSON.parse(columnsKey) as string[], [columnsKey])
  const languages = useMemo(() => { const selected = columnLanguages(keys); return selected.length ? selected : [locale] }, [keys, locale])
  const rowScopeKey = JSON.stringify(rowScopes ?? {})
  const scopes = useMemo(() => JSON.parse(rowScopeKey) as NonNullable<UseCellFormulasInput['rowScopes']>, [rowScopeKey])
  const target = useCallback((rowId: string, fieldKey: string) => {
    if (rowScopes && !scopes[rowId]) throw new Error('This listing is no longer in the selected destination. Reload before editing.')
    return { ...coord, ...languageField(fieldKey, locale), productId: scopes[rowId]?.productId ?? rowId, aliasKey: scopes[rowId]?.aliasKey ?? coord.aliasKey }
  }, [coord, scopes, !!rowScopes, locale])
  const coordinateKey = JSON.stringify([coord, rowScopeKey, columnsKey])
  /* The reads' key leaves the row set out: a row added or removed keeps what is known about every other row. */
  const readKey = JSON.stringify([coord, columnsKey])
  const idsKey = rowIds.join(',')
  const [reads, setReads] = useState<FormulaReads>(() => emptyReads(readKey))
  const current = useMemo(() => reads.key === readKey ? reads : emptyReads(readKey), [reads, readKey])
  const seedDraft = useMemo(() => seedFromSheet(seedRows ?? []), [seedRows])
  const seedRef = useRef(seedDraft)
  if (seedRef.current.signature !== seedDraft.signature) seedRef.current = seedDraft
  const seed = seedRef.current
  const [functions, setFunctions] = useState<FormulaFunctionDoc[]>([])
  const [nonce, setNonce] = useState(0)
  const live = useRef({ coordinateKey, writeFacts, onSettled, onValueSaved })
  live.current = { coordinateKey, writeFacts, onSettled, onValueSaved }
  const revision = useRef(0)
  const queue = useMemo(() => createFormulaSaveQueue(() => {
    if (live.current.coordinateKey !== coordinateKey) return
    setNonce(n => n + 1)
    live.current.onSettled?.()
  }), [coordinateKey])
  useEffect(() => { queue.activate(); return () => queue.dispose() }, [queue])
  const reload = useCallback(() => setNonce(n => n + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${getBackendUrl()}/api/pim/formulas/functions`, { credentials: 'include', signal: controller.signal })
      .then(r => r.ok ? r.json() : null).then(j => { if (Array.isArray(j?.functions)) setFunctions(j.functions) }).catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const mine = revision.current
    /* A reload keeps what is already known; only the errors go, so a retried cell says "Loading" again. */
    setReads(previous => previous.key === readKey ? clearFailures(previous) : emptyReads(readKey))
    const land = (change: (previous: FormulaReads) => FormulaReads) => {
      if (!controller.signal.aborted) setReads(previous => previous.key === readKey ? change(previous) : previous)
    }
    const ids = idsKey ? idsKey.split(',') : []
    const groups = new Map<string, string[]>()
    for (const id of ids) {
      const alias = scopes[id]?.aliasKey ?? coord.aliasKey ?? ''
      groups.set(alias, [...(groups.get(alias) ?? []), id])
    }
    const requests = languages.flatMap(language => [...groups].flatMap(([listingAlias, group]) =>
      Array.from({ length: Math.ceil(group.length / 250) }, (_, i) => ({ language, listingAlias, batch: group.slice(i * 250, i * 250 + 250) }))))
    /* P0 — in parallel (production waited 5 × ~0.43 s, one alias after another), and each answer lands on its own. */
    void runBounded(requests.map(({ language, listingAlias, batch }) => async () => {
      const rowByProduct = new Map(batch.map(id => [scopes[id]?.productId ?? id, id]))
      try {
        const response = await fetch(`${getBackendUrl()}/api/pim/formulas/batch`, {
          method: 'POST', credentials: 'include', signal: controller.signal,
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...coord, locale: language, aliasKey: listingAlias, productIds: [...rowByProduct.keys()] }),
        })
        if (!response.ok) throw new Error('Could not load formulas. Retry before editing formula fields.')
        const body = await response.json()
        if (!body.formulas || typeof body.formulas !== 'object') throw new Error('The formula list could not be read. Retry before editing.')
        const found = new Map<string, Map<string, KnownFormula>>()
        const add = (f: CellFormulaRow) => {
          if (!f || typeof f.expr !== 'string') return
          const viewKey = formulaReadKey(keys, f.fieldKey, language, locale)
          const rowId = rowByProduct.get(f.productId) ?? f.productId
          if (viewKey) found.set(rowId, (found.get(rowId) ?? new Map<string, KnownFormula>()).set(viewKey, f))
        }
        if (Array.isArray(body.formulas)) body.formulas.forEach(add)
        else for (const [pid, fields] of Object.entries(body.formulas)) {
          for (const [fieldKey, f] of Object.entries(fields as Record<string, CellFormulaRow>)) add({ ...f, productId: pid, fieldKey })
        }
        // A read that began before one of this tab's saves may predate it; that save's settle reads again.
        if (mine === revision.current) land(previous => landRead(previous, { language, locale, rowIds: batch, formulas: found }))
      } catch (error) {
        land(previous => failRead(previous, { language, rowIds: batch, error: error instanceof Error ? error.message : String(error) }))
      }
    }), FORMULA_READS_AT_ONCE, controller.signal)
    return () => controller.abort()
  }, [idsKey, nonce, coord, scopes, readKey, languages, keys, locale])

  const ids = useMemo(() => idsKey ? idsKey.split(',') : [], [idsKey])
  const ready = ids.every(id => rowKnown(current, seed, languages, id))
  const loadError = useMemo(() => {
    for (const errors of current.failed.values()) for (const error of errors.values()) return error
    return null
  }, [current])
  const knownFor = useCallback((rowId: string, fieldKey: string) => formulaState(current, seed, languages, locale, rowId, fieldKey).known, [current, seed, languages, locale])
  const unavailableFor = useCallback((rowId: string | undefined, fieldKey: string) => {
    if (rowId === undefined) return ready ? null : loadError ?? FORMULAS_LOADING
    return knownFor(rowId, fieldKey) ? null : failureFor(current, languages, locale, rowId, fieldKey) ?? FORMULAS_LOADING
  }, [ready, loadError, knownFor, current, languages, locale])
  /* The marks repaint when a cell's formula CHANGES, not every time a read lands with the same answer. */
  const effectiveDraft = useMemo(() => effectiveFormulas(current, seed, languages, locale), [current, seed, languages, locale])
  const effectiveRef = useRef(effectiveDraft)
  if (effectiveRef.current.signature !== effectiveDraft.signature) effectiveRef.current = effectiveDraft
  const effective = effectiveRef.current
  const exprFor = useCallback((rowId: string, fieldKey: string) => effective.formulas.get(rowId)?.get(fieldKey)?.expr ?? null, [effective])
  const errorFor = useCallback((rowId: string, fieldKey: string) => effective.formulas.get(rowId)?.get(fieldKey)?.lastError ?? null, [effective])

  const held = useMemo(() => createHeldEdits(), [])
  useEffect(() => () => { held.drop() }, [held, readKey])
  useEffect(() => {
    held.release(knownFor)
    held.dropFailed((rowId, fieldKey) => knownFor(rowId, fieldKey) ? null : failureFor(current, languages, locale, rowId, fieldKey))
  }, [held, knownFor, current, languages, locale])
  const whenKnown = useCallback((rowId: string, fieldKey: string, edit: () => void, drop?: (reason?: string) => void) => {
    if (knownFor(rowId, fieldKey)) edit()
    else held.hold({ rowId, fieldKey, apply: edit, drop })
  }, [held, knownFor])
  const preview = useCallback(async (rowId: string, fieldKey: string, expr: string, signal?: AbortSignal): Promise<FormulaPreviewResponse> => {
    const res = await fetch(`${getBackendUrl()}/api/pim/formulas/preview`, { method: 'POST', credentials: 'include', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...target(rowId, fieldKey), expr }) })
    const body = await res.json()
    return res.ok ? body : { ok: false, error: body?.error ?? 'Could not check the formula.' }
  }, [target])

  const commit = useCallback((rowId: string, fieldKey: string, change: { expr: string } | { value: unknown }) => reportedFormulaWrite(reporter, rowId, fieldKey, () => queue.enqueue(rowId, async () => {
    const destination = target(rowId, fieldKey)
    const literal = 'value' in change
    const res = await fetch(`${getBackendUrl()}/api/pim/formulas/product/${encodeURIComponent(destination.productId)}${literal ? '/value' : ''}`, {
      method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...destination, ...change, contentAddress: live.current.writeFacts?.(rowId, fieldKey)?.contentAddress, contentAcknowledged: live.current.writeFacts?.(rowId, fieldKey)?.contentAcknowledged }),
    })
    const body = await res.json()
    if (!res.ok) return { ok: false, error: body?.error ?? 'Could not save this field.' }
    revision.current += 1
    if (live.current.coordinateKey === coordinateKey && (literal || body.formula)) setReads(previous => previous.key === readKey ? saveLocally(previous, rowId, fieldKey, literal ? null : body.formula) : previous)
    const result = literal ? { ok: true } : formulaSaveOutcome(body)
    if (result.ok && live.current.coordinateKey === coordinateKey) live.current.onValueSaved?.(rowId, fieldKey, body.value)
    return result
  })), [reporter, queue, target, coordinateKey, readKey])
  const save = useCallback((rowId: string, fieldKey: string, expr: string) => commit(rowId, fieldKey, { expr }), [commit])
  const replace = useCallback((rowId: string, fieldKey: string, value: unknown) => commit(rowId, fieldKey, { value }), [commit])
  const pinOver = useCallback((rowId: string, fieldKey: string) => reportedFormulaWrite(reporter, rowId, fieldKey, () => queue.enqueue(rowId, async () => {
    const { productId: canonicalId, ...destination } = target(rowId, fieldKey)
    const q = new URLSearchParams()
    for (const [name, value] of Object.entries(destination)) if (value != null) q.set(name, value)
    const res = await fetch(`${getBackendUrl()}/api/pim/formulas/product/${encodeURIComponent(canonicalId)}?${q}`, { method: 'DELETE', credentials: 'include' })
    const body = await res.json()
    return res.ok ? { ok: true } : { ok: false, error: body?.error ?? 'Could not remove the formula.' }
  })), [reporter, queue, target])
  void productId
  const sourceLabelFor = (fieldKey?: string) => {
    const language = languageField(fieldKey ?? '', locale).locale
    return scope === 'channel' ? `${channel} · ${marketplace} · ${language}` : `Shared product · ${language}`
  }
  return { ready, loadError, knownFor, unavailableFor, whenKnown, sourceLabel: sourceLabelFor(), sourceLabelFor,
    exprFor, errorFor, functions, preview, save, replace, pinOver, reload }
}
