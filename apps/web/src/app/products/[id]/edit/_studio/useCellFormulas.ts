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
  onSettled?: () => void
  onValueSaved?: (rowId: string, fieldKey: string, value: unknown) => void
}

export interface CellFormulas {
  ready: boolean
  loadError: string | null
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

/* `::`, not a raw NUL. A separator has to be one that neither half can contain, or two different
   cells collide on one key — a product id is a cuid and a column key is `[A-Za-z0-9_.]`, so `::`
   cannot appear in either and the key stays unambiguous.

   🔴 It was a literal NUL byte, and that made the whole FILE binary to every text tool: `file(1)`
   reported `data`, BSD grep answered "Binary file matches", and the grep wrapper here returns a
   BLANK count — which reads as zero. So every grep-based DS guard was silently scanning nothing
   here while reporting clean. I met the symptom myself and missed it: two greps on this file came
   back empty and I worked around them with a direct read instead of asking why. A quiet instrument
   is not a negative result, and that time the quiet instrument was mine. */
const key = (rowId: string, fieldKey: string) => `${rowId}::${fieldKey}`

export function useCellFormulas({ productId, scope = 'master', channel = null, marketplace = null, market, locale, channelConnectionId, aliasKey, rowIds, columnKeys, rowScopes, writeFacts, onSettled, onValueSaved }: UseCellFormulasInput): CellFormulas {
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
  const idsKey = rowIds.join(',')
  const snapshotKey = JSON.stringify([coordinateKey, idsKey])
  const [snapshot, setSnapshot] = useState<{ key: string; formulas: Map<string, CellFormulaRow> }>({ key: '', formulas: new Map() })
  const [loadError, setLoadError] = useState<string | null>(null)
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
    setLoadError(null)
    const ids = idsKey ? idsKey.split(',') : []
    const read = async () => {
      const next = new Map<string, CellFormulaRow>()
      const groups = new Map<string, string[]>()
      for (const id of ids) {
        const alias = scopes[id]?.aliasKey ?? coord.aliasKey ?? ''
        groups.set(alias, [...(groups.get(alias) ?? []), id])
      }
      for (const language of languages) {
        for (const [listingAlias, group] of groups) {
          for (let start = 0; start < group.length; start += 250) {
            const batch = group.slice(start, start + 250)
            const rowByProduct = new Map(batch.map(id => [scopes[id]?.productId ?? id, id]))
            const response = await fetch(`${getBackendUrl()}/api/pim/formulas/batch`, {
              method: 'POST', credentials: 'include', signal: controller.signal,
              headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...coord, locale: language, aliasKey: listingAlias, productIds: [...rowByProduct.keys()] }),
            })
            if (!response.ok) throw new Error('Could not load formulas. Retry before editing formula fields.')
            const body = await response.json()
            if (!body.formulas || typeof body.formulas !== 'object') throw new Error('The formula list could not be read. Retry before editing.')
            const add = (f: CellFormulaRow) => {
              if (!f || typeof f.expr !== 'string') return
              const viewKey = formulaReadKey(keys, f.fieldKey, language, locale)
              if (viewKey) next.set(key(rowByProduct.get(f.productId) ?? f.productId, viewKey), f)
            }
            if (Array.isArray(body.formulas)) body.formulas.forEach(add)
            else for (const [pid, fields] of Object.entries(body.formulas)) {
              for (const [fieldKey, f] of Object.entries(fields as Record<string, CellFormulaRow>)) add({ ...f, productId: pid, fieldKey })
            }
          }
        }
      }
      if (!controller.signal.aborted && mine === revision.current) setSnapshot({ key: snapshotKey, formulas: next })
    }
    read().catch(error => { if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : String(error)) })
    return () => controller.abort()
  }, [idsKey, nonce, coord, scopes, snapshotKey, languages, keys, locale])

  const ready = snapshot.key === snapshotKey && !loadError
  const exprFor = useCallback((rowId: string, fieldKey: string) => snapshot.key === snapshotKey ? snapshot.formulas.get(key(rowId, fieldKey))?.expr ?? null : null, [snapshot, snapshotKey])
  const errorFor = useCallback((rowId: string, fieldKey: string) => snapshot.key === snapshotKey ? snapshot.formulas.get(key(rowId, fieldKey))?.lastError ?? null : null, [snapshot, snapshotKey])
  const preview = useCallback(async (rowId: string, fieldKey: string, expr: string, signal?: AbortSignal): Promise<FormulaPreviewResponse> => {
    const res = await fetch(`${getBackendUrl()}/api/pim/formulas/preview`, { method: 'POST', credentials: 'include', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...target(rowId, fieldKey), expr }) })
    const body = await res.json()
    return res.ok ? body : { ok: false, error: body?.error ?? 'Could not check the formula.' }
  }, [target])

  const commit = useCallback((rowId: string, fieldKey: string, change: { expr: string } | { value: unknown }) => queue.enqueue(rowId, async () => {
    const destination = target(rowId, fieldKey)
    const literal = 'value' in change
    const res = await fetch(`${getBackendUrl()}/api/pim/formulas/product/${encodeURIComponent(destination.productId)}${literal ? '/value' : ''}`, {
      method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...destination, ...change, contentAddress: live.current.writeFacts?.(rowId, fieldKey)?.contentAddress, contentAcknowledged: live.current.writeFacts?.(rowId, fieldKey)?.contentAcknowledged }),
    })
    const body = await res.json()
    if (!res.ok) return { ok: false, error: body?.error ?? 'Could not save this field.' }
    revision.current += 1
    if (live.current.coordinateKey === coordinateKey) setSnapshot(previous => {
      if (previous.key !== snapshotKey) return previous
      const formulas = new Map(previous.formulas)
      if (literal) formulas.delete(key(rowId, fieldKey))
      else if (body.formula) formulas.set(key(rowId, fieldKey), body.formula)
      return { ...previous, formulas }
    })
    const result = literal ? { ok: true } : formulaSaveOutcome(body)
    if (result.ok && live.current.coordinateKey === coordinateKey) live.current.onValueSaved?.(rowId, fieldKey, body.value)
    return result
  }), [queue, target, coordinateKey, snapshotKey])
  const save = useCallback((rowId: string, fieldKey: string, expr: string) => commit(rowId, fieldKey, { expr }), [commit])
  const replace = useCallback((rowId: string, fieldKey: string, value: unknown) => commit(rowId, fieldKey, { value }), [commit])
  const pinOver = useCallback((rowId: string, fieldKey: string) => queue.enqueue(rowId, async () => {
    const { productId: canonicalId, ...destination } = target(rowId, fieldKey)
    const q = new URLSearchParams()
    for (const [name, value] of Object.entries(destination)) if (value != null) q.set(name, value)
    const res = await fetch(`${getBackendUrl()}/api/pim/formulas/product/${encodeURIComponent(canonicalId)}?${q}`, { method: 'DELETE', credentials: 'include' })
    const body = await res.json()
    return res.ok ? { ok: true } : { ok: false, error: body?.error ?? 'Could not remove the formula.' }
  }), [queue, target])
  void productId
  const sourceLabelFor = (fieldKey?: string) => {
    const language = languageField(fieldKey ?? '', locale).locale
    return scope === 'channel' ? `${channel} · ${marketplace} · ${language}` : `Shared product · ${language}`
  }
  return { ready, loadError, sourceLabel: sourceLabelFor(), sourceLabelFor,
    exprFor, errorFor, functions, preview, save, replace, pinOver, reload }
}
