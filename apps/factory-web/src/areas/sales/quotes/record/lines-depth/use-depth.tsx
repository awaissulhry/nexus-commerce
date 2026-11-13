'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { ApiClient } from '../../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { useLocale } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { downloadLink } from '../../../../../record-panels/api'
import { storeUrl } from '../../../../../record-panels/store'
import { getQuote, removeLine, updateQuote, type QuoteDetail, type QuoteVersionRow, type StyleDetail } from '../../api'
import { parsePercent, parsePrice, readOnlyReason, type Grains, type QuoteAbilities, type QuoteTab } from '../../model'
import { readProblem, writeProblem } from '../../problems'
import { pasteLines, type PasteAnswer } from '../../paste/api'
import { goalSeek, quoteSource, type GoalAnswer, type QuoteSource } from '../goalseek/api'
import type { TargetOf } from '../goalseek/view/TargetPrice'
import { saveTerms, sendPayLink, type PayLinkAnswer } from '../terms-depth/api'
import { deliveryDraftOf, deliveryPatch, deliveryProblems, type DeliveryDraft } from '../terms-depth/model'
import { compareVersions, type VersionsCompared } from '../versions-depth/api'
import { changeSizes, fillLines, listCurves, readTerms, readWarnings, saveDeliveries, styleScaleOf, type FillAnswer, type QuoteTerms, type QuoteWarnings, type SizeChangeKind, type SizeCurve, type SizesAnswer } from './api'
import { lineDrawerSections } from './drawer-sections'
import { DEPTH_NS, deliveriesBody, deliveryRowsOf, lineLabel, scheduleChanged, scheduleProblems, sizesOfLine, tableRows, type DeliveryRow, type DepthReviewState, type Tone, type Words } from './model'
import type { QuoteDepthSlots } from './slots'
import type { BulkLine, BulkReviewKind } from './view/BulkReview'
import { depthSlots, type QuoteDepthActions, type QuoteDepthModel } from './view/DepthSlots'
import type { BulkKind } from './view/LinesTable'
import type { LinesView } from './view/LinesTop'

type Read<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

export interface DepthInput {
  api: ApiClient
  quote: QuoteDetail | null
  /** `/w/<company>` */
  prefix: string
  tab: QuoteTab
  me: string
  permissions: readonly string[]
  grains: Grains
  can: QuoteAbilities
  styles: Readonly<Record<string, StyleDetail | null>>
  versions: { items: QuoteVersionRow[] | null; people: Readonly<Record<string, string>>; problem: string | null }
  today: string
  /** The record takes the quote a write answers. */
  onQuote: (next: QuoteDetail) => void
  /** W1's versions read again (after a change note). */
  onVersions: () => void
}

interface BulkState {
  kind: BulkReviewKind
  lineIds: string[]
  styleId: string | null
  value: string
  sizeKind: SizeChangeKind
  curves: { status: 'loading' | 'ready' | 'error'; items: SizeCurve[] } | undefined
  curveId: string
  totals: Record<string, string>
  preview: GoalAnswer | SizesAnswer | FillAnswer | null
  state: DepthReviewState
  key: string
  /** Try again asks the plan once more. */
  tries: number
}

interface GoalState {
  target: TargetOf
  lineId: string
  value: string
  preview: GoalAnswer | null
  state: 'idle' | 'reading' | 'ready' | 'failed' | 'saving'
  problem: Words | null
  tries: number
}

const PREVIEW_DELAY_MS = 400
const say = (problem: { key: string }): Words => ({ ns: 'sales', key: problem.key })

/**
 * The quote record's W2b container (B-W2b-316): reads the Warnings, the terms and schedules, the inquiry the quote came
 * from, the compare of two versions, the curves of a style's scale; asks every bulk change's plan first (`preview`) and
 * writes the same body after the review; keeps the line drawer (`?line=`) and the Blocks | Table switch (`?view=table`) in
 * the address. Every write sends the quote's version as it stands now and hands the record the quote it answers (or reads
 * it again after a terms write), so W1's record, summary rail and live updates follow. Returns the record's slots.
 */
export function useQuoteDepth(input: DepthInput): QuoteDepthSlots {
  const { api, quote, prefix, tab, grains, can, permissions, today } = input
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const t = useMemo(() => createTranslator(locale, messagesFor(locale, [DEPTH_NS])[DEPTH_NS] ?? {}), [locale])
  const view: LinesView = params?.get('view') === 'table' ? 'table' : 'blocks'
  const lineId = params?.get('line') ?? null
  const quoteRef = useRef<QuoteDetail | null>(quote)
  quoteRef.current = quote
  const inputRef = useRef(input)
  inputRef.current = input
  const quoteId = quote?.id ?? null
  const version = quote?.version ?? 0
  const editable = !!quote && can.manage && quote.current.status === 'DRAFT'
  const reason = quote ? readOnlyReason(quote, can) : null
  const readOnly: Words | null = quote && reason ? { ns: 'sales', key: reason, params: { revision: quote.currentRevision, next: quote.currentRevision + 1, date: quote.current.validUntil ?? '—' } } : null
  const recordBase = `${prefix}/sales/quotes/${quoteId ?? ''}`
  const lineBase = `${recordBase}?tab=lines&line=`

  const [notice, setNotice] = useState<QuoteDepthModel['notice']>(null)
  const tell = (words: Words, tone: Tone) => setNotice({ words, tone })

  const setParams = useCallback(
    (change: Record<string, string | null>) => {
      const next = new URLSearchParams(params?.toString() ?? '')
      for (const [name, value] of Object.entries(change)) {
        if (value === null) next.delete(name)
        else next.set(name, value)
      }
      const qs = next.toString()
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [params, pathname, router],
  )

  // ---- reads ----------------------------------------------------------------------------------------------------------
  const [warnings, setWarnings] = useState<Read<QuoteWarnings>>({ status: 'loading' })
  const [terms, setTerms] = useState<Read<QuoteTerms>>({ status: 'loading' })
  const [source, setSource] = useState<QuoteSource>(null)
  const termsWanted = tab === 'terms' || (tab === 'lines' && (view === 'table' || lineId !== null)) || (tab === 'price' && lineId !== null) /* B-W2b-343: the drawer docks on Price & margin too */

  const loadWarnings = useCallback(() => {
    if (!quoteId) return
    readWarnings(api, quoteId)
      .then((value) => setWarnings({ status: 'ready', value }))
      .catch((error: unknown) => setWarnings({ status: 'error', problem: readProblem(error) }))
  }, [api, quoteId])
  const loadTerms = useCallback(() => {
    if (!quoteId) return
    readTerms(api, quoteId)
      .then((value) => setTerms({ status: 'ready', value }))
      .catch((error: unknown) => setTerms({ status: 'error', problem: readProblem(error) }))
  }, [api, quoteId])

  useEffect(() => {
    if (tab === 'lines') loadWarnings()
  }, [tab, loadWarnings, version])
  useEffect(() => {
    if (termsWanted) loadTerms()
  }, [termsWanted, loadTerms, version])
  const sourceAllowed = permissions.includes('sales.inquiries.view')
  useEffect(() => {
    if (!quoteId || !sourceAllowed) return
    quoteSource(api, quoteId)
      .then(setSource)
      .catch(() => setSource(null))
  }, [api, quoteId, sourceAllowed])

  /** The quote read again (after a terms write: its version moved). */
  const refreshQuote = useCallback(async () => {
    const current = quoteRef.current
    if (!current) return
    try {
      inputRef.current.onQuote(await getQuote(api, current.id))
    } catch {
      // W1's live update reads it again.
    }
  }, [api])

  // ---- the line drawer ------------------------------------------------------------------------------------------------
  const [rows, setRows] = useState<{ lineId: string; rows: DeliveryRow[]; dirty: boolean } | null>(null)
  const [drawerSaving, setDrawerSaving] = useState(false)
  const [drawerProblem, setDrawerProblem] = useState<Words | null>(null)
  const drawerLine = quote && lineId ? (quote.lines.find((line) => line.id === lineId) ?? null) : null
  const drawerSchedule = terms.status === 'ready' && lineId ? (terms.value.lines.find((line) => line.lineId === lineId) ?? null) : null
  useEffect(() => {
    if (!lineId) return setRows(null)
    if (terms.status !== 'ready') return
    setRows((current) => (current && current.lineId === lineId && current.dirty ? current : { lineId, rows: deliveryRowsOf(drawerSchedule), dirty: false }))
    setDrawerProblem(null)
    // The saved schedule of this line is the dependency (a new read of the terms resets a clean draft).
  }, [lineId, terms])
  useEffect(() => {
    // A line no longer on the quote (removed, a new version) closes the drawer.
    if (lineId && quote && !quote.lines.some((line) => line.id === lineId)) setParams({ line: null })
  }, [lineId, quote, setParams])

  const saveSchedule = async () => {
    const current = quoteRef.current
    if (!current || !drawerLine || !rows || drawerSaving) return
    if (scheduleProblems(rows.rows, drawerLine, today).length > 0) return
    setDrawerSaving(true)
    setDrawerProblem(null)
    try {
      const answer = await saveDeliveries(api, current, drawerLine.id, deliveriesBody(rows.rows, drawerLine))
      setTerms({ status: 'ready', value: answer })
      setRows({ lineId: drawerLine.id, rows: deliveryRowsOf(answer.lines.find((line) => line.lineId === drawerLine.id) ?? null), dirty: false })
      tell({ key: 'notice.scheduleSaved', params: { line: lineLabel(current, drawerLine.id) } }, 'success')
      void refreshQuote()
    } catch (error) {
      const problem = writeProblem(error)
      setDrawerProblem(say(problem))
      if (problem.reload) {
        loadTerms()
        void refreshQuote()
      }
    } finally {
      setDrawerSaving(false)
    }
  }

  // ---- Table selection ------------------------------------------------------------------------------------------------
  const [selected, setSelected] = useState<string[]>([])
  useEffect(() => {
    setSelected((current) => current.filter((id) => quote?.lines.some((line) => line.id === id)))
  }, [quote])

  // ---- the bulk reviews (Table actions, Fill by curve) -----------------------------------------------------------------
  const [bulk, setBulk] = useState<BulkState | null>(null)
  const bulkRef = useRef(bulk)
  bulkRef.current = bulk
  const previewSeq = useRef(0)

  const bulkLines = (ids: readonly string[]): BulkLine[] => {
    const current = quoteRef.current
    if (!current) return []
    const schedules = terms.status === 'ready' ? terms.value.lines : []
    return current.lines
      .filter((line) => ids.includes(line.id))
      .sort((a, b) => a.seq - b.seq)
      .map((line) => {
        const style = inputRef.current.styles[line.styleId]
        const dates = (schedules.find((entry) => entry.lineId === line.id)?.deliveries ?? []).map((delivery) => delivery.deliveryDate).sort()
        return { id: line.id, label: lineLabel(current, line.id), sizes: sizesOfLine(line), order: style?.sizes ?? line.sizes.map((row) => row.size), delivery: dates.length > 0 ? { first: dates[0]!, count: dates.length } : null }
      })
  }

  /** Why the form above the review cannot be asked yet (the host's words), or null. */
  const leadHeldOf = (state: BulkState): Words | null => {
    switch (state.kind) {
      case 'price':
        return parsePrice(state.value) === null ? { key: 'review.held.price' } : null
      case 'discount':
        return parsePercent(state.value) === null ? { key: 'review.held.discount' } : null
      case 'sizes':
        if (state.sizeKind === 'PERCENT') return /^-?\d{1,4}([.,]\d{1,4})?$/.test(state.value.trim()) && Number(state.value.trim().replace(',', '.')) !== 0 && Number(state.value.trim().replace(',', '.')) > -100 ? null : { key: 'review.held.pct' }
        if (state.sizeKind === 'DELTA') return /^-?\d{1,6}$/.test(state.value.trim()) && Number(state.value) !== 0 ? null : { key: 'review.held.delta' }
        return /^\d{1,6}$/.test(state.value.trim()) && (state.sizeKind === 'SET' || Number(state.value) > 0) ? null : { key: 'review.held.pieces' }
      case 'fill':
        if (!state.curveId) return { key: 'review.held.curve' }
        return state.lineIds.every((id) => /^\d{1,7}$/.test((state.totals[id] ?? '').trim()) && Number(state.totals[id]) > 0) ? null : { key: 'review.held.totals' }
      case 'delivery':
        return /^\d{4}-\d{2}-\d{2}$/.test(state.value) ? (state.value < today ? { key: 'review.held.past' } : null) : { key: 'review.held.date' }
      default:
        return null
    }
  }

  const askPlan = useCallback(
    async (state: BulkState, write: boolean): Promise<GoalAnswer | SizesAnswer | FillAnswer | null> => {
      const current = quoteRef.current
      if (!current) return null
      const preview = !write
      switch (state.kind) {
        case 'price':
          return goalSeek(api, current, { lineIds: state.lineIds, target: { kind: 'UNIT_PRICE', unitPrice: parsePrice(state.value) ?? '' } }, preview, state.key)
        case 'discount':
          return goalSeek(api, current, { lineIds: state.lineIds, target: { kind: 'DISCOUNT', pct: parsePercent(state.value) ?? '' } }, preview, state.key)
        case 'sizes': {
          const value = state.value.trim().replace(',', '.')
          const change = state.sizeKind === 'PERCENT' ? { kind: state.sizeKind, pct: value } : { kind: state.sizeKind, pieces: Number.parseInt(value, 10) }
          return changeSizes(api, current, { lineIds: state.lineIds, change }, preview, state.key)
        }
        case 'fill':
          return fillLines(api, current, { curveId: state.curveId, lines: state.lineIds.map((id) => ({ lineId: id, pieces: Number.parseInt(state.totals[id] ?? '0', 10) })) }, preview, state.key)
        default:
          return null
      }
    },
    [api],
  )

  // The plan is asked again shortly after the form stops changing.
  const bulkAsk = bulk ? `${bulk.kind}|${bulk.value}|${bulk.sizeKind}|${bulk.curveId}|${JSON.stringify(bulk.totals)}|${version}|${bulk.tries}` : null
  useEffect(() => {
    const state = bulkRef.current
    if (!state || state.state.phase === 'saving' || state.state.phase === 'done') return
    if (state.kind === 'delivery' || state.kind === 'remove') return setBulk((current) => (current ? { ...current, state: { phase: 'ready' } } : current))
    if (leadHeldOf(state)) return setBulk((current) => (current ? { ...current, preview: null, state: { phase: 'ready' } } : current))
    const mine = ++previewSeq.current
    setBulk((current) => (current ? { ...current, state: { phase: 'reading' } } : current))
    const timer = setTimeout(() => {
      askPlan(state, false)
        .then((answer) => mine === previewSeq.current && setBulk((current) => (current ? { ...current, preview: answer, state: { phase: 'ready' } } : current)))
        .catch((error: unknown) => mine === previewSeq.current && setBulk((current) => (current ? { ...current, preview: null, state: { phase: 'failed', problem: say(writeProblem(error)) } } : current)))
    }, PREVIEW_DELAY_MS)
    return () => clearTimeout(timer)
    // bulkAsk holds every input the plan depends on.
  }, [bulkAsk, askPlan])

  const openBulk = (kind: BulkReviewKind, ids: readonly string[], styleId: string | null = null) => {
    const current = quoteRef.current
    if (!current) return
    const totals = Object.fromEntries(current.lines.filter((line) => ids.includes(line.id)).map((line) => [line.id, line.quantity > 0 ? String(line.quantity) : '']))
    setBulk({ kind, lineIds: [...ids], styleId, value: '', sizeKind: 'PERCENT', curves: kind === 'fill' ? { status: 'loading', items: [] } : undefined, curveId: '', totals, preview: null, state: { phase: 'ready' }, key: newIdempotencyKey(), tries: 0 })
    if (kind === 'fill' && styleId) {
      styleScaleOf(api, styleId)
        .then((scale) => listCurves(api, { companyId: current.companyId, sizeScaleId: scale.id }))
        .then((items) => setBulk((state) => (state && state.kind === 'fill' ? { ...state, curves: { status: 'ready', items }, curveId: items.length === 1 ? items[0]!.id : state.curveId } : state)))
        .catch(() => setBulk((state) => (state && state.kind === 'fill' ? { ...state, curves: { status: 'error', items: [] } } : state)))
    }
  }

  const saveBulk = async () => {
    const state = bulkRef.current
    if (!state || leadHeldOf(state) || state.state.phase === 'saving') return
    setBulk({ ...state, state: { phase: 'saving' } })
    const results: Record<string, { ok: boolean; words: Words }> = {}
    try {
      if (state.kind === 'delivery' || state.kind === 'remove') {
        let current = quoteRef.current
        for (const id of state.lineIds) {
          if (!current) break
          const line = current.lines.find((entry) => entry.id === id)
          if (!line) {
            results[id] = { ok: false, words: { key: 'review.result.gone' } }
            continue
          }
          try {
            if (state.kind === 'remove') {
              current = await removeLine(api, current, id)
              inputRef.current.onQuote(current)
              results[id] = { ok: true, words: { key: 'review.result.removed' } }
            } else {
              const answer = await saveDeliveries(api, current, id, [{ deliveryDate: state.value, sizes: sizesOfLine(line) }])
              setTerms({ status: 'ready', value: answer })
              current = { ...current, version: answer.quoteVersion }
              results[id] = { ok: true, words: { key: 'review.result.saved' } }
            }
          } catch (error) {
            results[id] = { ok: false, words: say(writeProblem(error)) }
            if (writeProblem(error).reload) break
          }
        }
        if (state.kind === 'delivery') void refreshQuote()
      } else {
        const answer = await askPlan(state, true)
        if (answer?.quote) inputRef.current.onQuote(answer.quote)
        for (const id of state.lineIds) results[id] = { ok: true, words: { key: 'review.result.saved' } }
      }
      setBulk((current) => (current ? { ...current, state: { phase: 'done', results } } : current))
      setSelected([])
    } catch (error) {
      const problem = writeProblem(error)
      setBulk((current) => (current ? { ...current, state: { phase: 'failed', problem: say(problem) } } : current))
      if (problem.reload) void refreshQuote()
    }
  }

  // ---- paste lines ----------------------------------------------------------------------------------------------------
  const [paste, setPaste] = useState<{ text: string; preview: PasteAnswer | null; state: DepthReviewState; key: string; tries: number } | null>(null)
  const pasteText = paste?.text ?? null
  const pasteTries = paste?.tries ?? 0
  const pasteSeq = useRef(0)
  useEffect(() => {
    if (pasteText === null) return
    const current = quoteRef.current
    if (!current || pasteText.trim() === '') return setPaste((state) => (state ? { ...state, preview: null, state: { phase: 'ready' } } : state))
    const mine = ++pasteSeq.current
    setPaste((state) => (state && state.state.phase !== 'done' ? { ...state, state: { phase: 'reading' } } : state))
    const timer = setTimeout(() => {
      pasteLines(api, current, pasteText, true)
        .then((answer) => mine === pasteSeq.current && setPaste((state) => (state ? { ...state, preview: answer, state: { phase: 'ready' } } : state)))
        .catch((error: unknown) => mine === pasteSeq.current && setPaste((state) => (state ? { ...state, preview: null, state: isApiError(error) && error.kind === 'invalid' ? { phase: 'ready' } : { phase: 'failed', problem: say(writeProblem(error)) } } : state)))
    }, PREVIEW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [api, pasteText, version, pasteTries])

  const savePaste = async () => {
    const state = paste
    const current = quoteRef.current
    if (!state || !current || state.state.phase === 'saving') return
    setPaste({ ...state, state: { phase: 'saving' } })
    try {
      const answer = await pasteLines(api, current, state.text, false, state.key)
      if (answer.quote) inputRef.current.onQuote(answer.quote)
      const results = Object.fromEntries(answer.rows.filter((row) => row.action !== 'SKIP').map((row) => [String(row.row), { ok: true, words: { key: row.action === 'ADD' ? 'review.result.added' : 'review.result.saved' } }]))
      setPaste((current) => (current ? { ...current, preview: answer, state: { phase: 'done', results } } : current))
    } catch (error) {
      const problem = writeProblem(error)
      setPaste((current) => (current ? { ...current, state: { phase: 'failed', problem: say(problem) } } : current))
      if (problem.reload) void refreshQuote()
    }
  }

  // ---- Target price ---------------------------------------------------------------------------------------------------
  const sizeGrid = useMemo(() => (quote?.lines ?? []).filter((line) => line.kind === 'SIZE_GRID').sort((a, b) => a.seq - b.seq), [quote?.lines])
  const [goal, setGoal] = useState<GoalState>({ target: 'line', lineId: '', value: '', preview: null, state: 'idle', problem: null, tries: 0 })
  const goalLine = goal.lineId && sizeGrid.some((line) => line.id === goal.lineId) ? goal.lineId : (sizeGrid[0]?.id ?? '')
  const goalSeq = useRef(0)
  useEffect(() => {
    if (tab !== 'price' || !quoteRef.current || goal.state === 'saving') return
    const value = parsePrice(goal.value)
    if (value === null || (goal.target === 'line' && !goalLine)) return setGoal((state) => ({ ...state, preview: null, state: 'idle', problem: null }))
    const mine = ++goalSeq.current
    setGoal((state) => ({ ...state, state: 'reading', problem: null }))
    const timer = setTimeout(() => {
      const current = quoteRef.current
      if (!current) return
      goalSeek(api, current, goal.target === 'line' ? { lineIds: [goalLine], target: { kind: 'UNIT_PRICE', unitPrice: value } } : { target: { kind: 'TOTAL', amount: value } }, true)
        .then((answer) => mine === goalSeq.current && setGoal((state) => ({ ...state, preview: answer, state: 'ready' })))
        .catch((error: unknown) => mine === goalSeq.current && setGoal((state) => ({ ...state, preview: null, state: 'failed', problem: say(writeProblem(error)) })))
    }, PREVIEW_DELAY_MS)
    return () => clearTimeout(timer)
    // The plan follows the target, its line and the quote's version.
  }, [api, tab, goal.target, goalLine, goal.value, version, goal.tries])

  const applyGoal = async () => {
    const current = quoteRef.current
    const value = parsePrice(goal.value)
    if (!current || value === null || !goal.preview || goal.preview.held.length > 0) return
    setGoal((state) => ({ ...state, state: 'saving' }))
    try {
      const answer = await goalSeek(api, current, goal.target === 'line' ? { lineIds: [goalLine], target: { kind: 'UNIT_PRICE', unitPrice: value } } : { target: { kind: 'TOTAL', amount: value } }, false)
      if (answer.quote) inputRef.current.onQuote(answer.quote)
      setGoal((state) => ({ ...state, value: '', preview: null, state: 'idle' }))
      tell({ key: 'notice.goalApplied', params: { count: answer.lines.length } }, 'success')
    } catch (error) {
      const problem = writeProblem(error)
      setGoal((state) => ({ ...state, state: 'failed', problem: say(problem) }))
      if (problem.reload) void refreshQuote()
    }
  }

  // ---- terms in depth -------------------------------------------------------------------------------------------------
  const [draft, setDraft] = useState<{ draft: DeliveryDraft; dirty: boolean } | null>(null)
  const [termsSaving, setTermsSaving] = useState<'acceptance' | 'delivery' | null>(null)
  const [termsProblem, setTermsProblem] = useState<Words | null>(null)
  useEffect(() => {
    if (terms.status === 'ready') setDraft((current) => (current?.dirty ? current : { draft: deliveryDraftOf(terms.value), dirty: false }))
  }, [terms])

  const writeTerms = async (which: 'acceptance' | 'delivery', patch: Parameters<typeof saveTerms>[2], words: Words) => {
    const current = quoteRef.current
    if (!current) return
    setTermsSaving(which)
    setTermsProblem(null)
    try {
      const answer = await saveTerms(api, current, patch)
      setTerms({ status: 'ready', value: answer })
      setDraft({ draft: deliveryDraftOf(answer), dirty: false })
      tell(words, 'success')
      void refreshQuote()
    } catch (error) {
      const problem = writeProblem(error)
      setTermsProblem(say(problem))
      if (problem.reload) {
        loadTerms()
        void refreshQuote()
      }
    } finally {
      setTermsSaving(null)
    }
  }

  // ---- versions: select two, compare ------------------------------------------------------------------------------------
  const [versionPick, setVersionPick] = useState<string[]>([])
  const [compare, setCompare] = useState<{ from: number; to: number; state: Read<VersionsCompared>; noteSaving: boolean; noteDone: boolean; tries: number } | null>(null)
  const comparePair = compare ? `${compare.from}:${compare.to}:${compare.tries}` : null
  useEffect(() => {
    if (!compare || !quoteId || compare.from === compare.to) return
    let gone = false
    setCompare((state) => (state ? { ...state, state: { status: 'loading' } } : state))
    compareVersions(api, quoteId, compare.from, compare.to)
      .then((value) => !gone && setCompare((state) => (state ? { ...state, state: { status: 'ready', value } } : state)))
      .catch((error: unknown) => !gone && setCompare((state) => (state ? { ...state, state: { status: 'error', problem: readProblem(error) } } : state)))
    return () => {
      gone = true
    }
    // The pair is the dependency.
  }, [api, quoteId, comparePair])

  const takeNote = async (note: string) => {
    const current = quoteRef.current
    if (!current || !compare) return
    setCompare({ ...compare, noteSaving: true })
    try {
      inputRef.current.onQuote(await updateQuote(api, current, { changeNote: note }))
      inputRef.current.onVersions()
      setCompare((state) => (state ? { ...state, noteSaving: false, noteDone: true } : state))
    } catch (error) {
      setCompare((state) => (state ? { ...state, noteSaving: false } : state))
      tell(say(writeProblem(error)), 'danger')
    }
  }

  // ---- the deposit's pay-online page ------------------------------------------------------------------------------------
  const deposit = input.versions.items?.find((entry) => entry.deposit)?.deposit ?? null
  const [pay, setPay] = useState<{ confirm: boolean; sending: boolean; sent: PayLinkAnswer | null; problem: Words | null }>({ confirm: false, sending: false, sent: null, problem: null })
  const sendPay = async () => {
    if (!deposit) return
    setPay((state) => ({ ...state, sending: true, problem: null }))
    try {
      const sent = await sendPayLink(api, deposit.id)
      setPay({ confirm: false, sending: false, sent, problem: null })
    } catch (error) {
      setPay((state) => ({ ...state, confirm: false, sending: false, problem: say(writeProblem(error)) }))
    }
  }

  // ---- the model ------------------------------------------------------------------------------------------------------
  if (!quote) return {}
  const tableModel = view === 'table' && tab === 'lines' ? { rows: tableRows(quote, terms.status === 'ready' ? terms.value : null, warnings.status === 'ready' ? warnings.value.warnings : null), currency: quote.current.currency, priceBasis: quote.current.priceBasis, grains, readOnly, selected, busy: bulk?.state.phase === 'saving' } : null
  const drawerIndex = drawerLine ? [...quote.lines].sort((a, b) => a.seq - b.seq).findIndex((line) => line.id === drawerLine.id) + 1 : 0
  const model: QuoteDepthModel = {
    notice,
    linesTop: tab === 'lines' ? { warnings: { state: warnings.status === 'ready' ? warnings : warnings.status === 'error' ? { status: 'error' } : { status: 'loading' }, prefix, lineBase, price: grains.price }, view } : null,
    table: tableModel,
    composer: { inquiry: source ? { number: source.number, href: `${prefix}${recordAddress({ type: 'Inquiry', id: source.id }, OFFICE_PAGES)}` } : null },
    canFill: editable,
    goal:
      tab === 'price'
        ? {
            target: goal.target,
            lineId: goalLine,
            lines: sizeGrid.map((line) => ({ id: line.id, label: lineLabel(quote, line.id) })),
            value: goal.value,
            currency: quote.current.currency,
            priceBasis: quote.current.priceBasis,
            grains,
            preview: goal.preview,
            state: goal.state,
            problem: goal.problem,
            readOnly: readOnly ?? (sizeGrid.length === 0 ? { key: 'goal.held.noLines' } : null),
            inquiry: source ? { number: source.number, targetUnitPrice: source.targetUnitPrice ?? null } : null,
            open: goal.value !== '',
          }
        : null,
    terms:
      tab === 'terms'
        ? {
            terms: terms.status === 'ready' ? terms : terms.status === 'error' ? { status: 'error' } : { status: 'loading' },
            readOnly,
            draft: draft?.draft ?? { incoterm: '', place: '', shipComplete: false },
            saving: termsSaving,
            problem: termsProblem,
            capacityHref: permissions.includes('planning.promise.view') ? `${prefix}/planning/promise?calc=1&quote=${encodeURIComponent(quote.id)}` : null,
            lineBase,
          }
        : null,
    versions: tab === 'versions' ? { items: input.versions.items, people: input.versions.people, me: input.me, grains, problem: input.versions.problem, selected: versionPick } : null,
    deposit: tab === 'documents' && deposit ? { deposit: { id: deposit.id, status: deposit.status }, mayRecord: permissions.includes('payments.record'), to: quote.contact?.email ?? null, confirm: pay.confirm, sending: pay.sending, sent: pay.sent ? { to: pay.sent.link.to, expiresAt: pay.sent.link.expiresAt, delivery: pay.sent.delivery } : null, problem: pay.problem } : null,
    drawer:
      drawerLine && (tab === 'lines' || tab === 'price' /* B-W2b-343: a Pricing by line row opens it */)
        ? {
            line: drawerLine,
            style: input.styles[drawerLine.styleId] ?? null,
            currency: quote.current.currency,
            priceBasis: quote.current.priceBasis,
            grains,
            readOnly,
            schedule: terms.status === 'ready' ? { status: 'ready', value: drawerSchedule, promiseDate: terms.value.promiseDate } : terms.status === 'error' ? { status: 'error' } : { status: 'loading' },
            rows: rows?.lineId === drawerLine.id ? rows.rows : deliveryRowsOf(drawerSchedule),
            saving: drawerSaving,
            problem: drawerProblem,
            today,
            position: { index: drawerIndex, count: quote.lines.length },
            sections: lineDrawerSections({ api, quote, line: drawerLine, grains, editable, onQuote: input.onQuote, t, /* B-W2b-343 */ locale }),
          }
        : null,
    bulk: bulk
      ? {
          kind: bulk.kind,
          lines: bulkLines(bulk.lineIds),
          currency: quote.current.currency,
          value: bulk.value,
          sizeKind: bulk.sizeKind,
          curves: bulk.curves,
          curveId: bulk.curveId,
          totals: bulk.totals,
          preview: bulk.preview,
          state: bulk.state,
          leadHeld: leadHeldOf(bulk),
          today,
          grains,
        }
      : null,
    paste: paste ? { text: paste.text, preview: paste.preview, state: paste.state } : null,
    compare: compare
      ? {
          from: compare.from,
          to: compare.to,
          versions: (input.versions.items ?? []).map((entry) => ({ revision: entry.revision, status: entry.status, sentAt: entry.sentAt })).sort((a, b) => b.revision - a.revision),
          state: compare.state,
          noteHeld: quote.current.status !== 'DRAFT' ? { key: 'compare.held.notDraft', params: { next: quote.currentRevision + 1 } } : !can.manage ? { ns: 'sales', key: 'held.noManage' } : null,
          noteSaving: compare.noteSaving,
          noteDone: compare.noteDone,
        }
      : null,
  }

  const openLine = (id: string) => setParams({ tab: 'lines', line: id })
  const actions: QuoteDepthActions = {
    onDismissNotice: () => setNotice(null),
    onView: (next) => setParams({ view: next === 'table' ? 'table' : null }),
    onRetryWarnings: loadWarnings,
    table: {
      onSelect: setSelected,
      onOpen: openLine,
      onBulk: (kind: BulkKind, ids) => openBulk(kind, ids),
    },
    onPaste: () => setPaste({ text: '', preview: null, state: { phase: 'ready' }, key: newIdempotencyKey(), tries: 0 }),
    onOpenLine: openLine,
    onFill: (styleId) => openBulk('fill', quote.lines.filter((line) => line.styleId === styleId && line.kind === 'SIZE_GRID').map((line) => line.id), styleId),
    goal: {
      onTarget: (target) => setGoal((state) => ({ ...state, target, preview: null })),
      onLine: (id) => setGoal((state) => ({ ...state, lineId: id, preview: null })),
      onValue: (value) => setGoal((state) => ({ ...state, value })),
      onApply: () => void applyGoal(),
      onRetry: () => setGoal((state) => ({ ...state, tries: state.tries + 1 })),
    },
    terms: {
      onAcceptance: (mode) => void writeTerms('acceptance', { acceptanceMode: mode }, { key: 'notice.acceptanceSaved' }),
      onDraft: (next) => setDraft({ draft: next, dirty: true }),
      onSaveDelivery: () => {
        if (terms.status !== 'ready' || !draft) return
        const patch = deliveryPatch(deliveryDraftOf(terms.value), draft.draft)
        if (Object.keys(patch).length === 0 || deliveryProblems(draft.draft).length > 0) return
        void writeTerms('delivery', patch, { key: 'notice.deliverySaved' })
      },
      onRetry: loadTerms,
    },
    versions: {
      onSelect: setVersionPick,
      onCompare: (pair) => setCompare({ ...pair, state: { status: 'loading' }, noteSaving: false, noteDone: false, tries: 0 }),
      onDownload: (fileId) => {
        downloadLink(api, fileId)
          .then(({ download }) => {
            const anchor = document.createElement('a')
            anchor.href = storeUrl(download.url)
            anchor.rel = 'noopener'
            document.body.appendChild(anchor)
            anchor.click()
            anchor.remove()
          })
          .catch((error: unknown) => tell({ ns: 'sales', key: readProblem(error) }, 'danger'))
      },
      onRetry: input.onVersions,
    },
    deposit: {
      onConfirm: (open) => setPay((state) => ({ ...state, confirm: open })),
      onSend: () => void sendPay(),
    },
    drawer: {
      onClose: () => setParams({ line: null }),
      onStep: (step) => {
        const sorted = [...quote.lines].sort((a, b) => a.seq - b.seq)
        const index = sorted.findIndex((line) => line.id === lineId)
        const next = sorted[index + step]
        if (next) setParams({ line: next.id })
      },
      onRows: (next) => drawerLine && setRows({ lineId: drawerLine.id, rows: next, dirty: scheduleChanged(next, drawerSchedule, drawerLine) }),
      onSave: () => void saveSchedule(),
      onRetry: loadTerms,
    },
    bulk: {
      onValue: (value) => setBulk((state) => (state ? { ...state, value } : state)),
      onSizeKind: (kind) => setBulk((state) => (state ? { ...state, sizeKind: kind } : state)),
      onCurve: (curveId) => setBulk((state) => (state ? { ...state, curveId } : state)),
      onTotal: (id, value) => setBulk((state) => (state ? { ...state, totals: { ...state.totals, [id]: value } } : state)),
      onSave: () => void saveBulk(),
      onClose: () => setBulk(null),
      onRetry: () => setBulk((state) => (state ? { ...state, key: newIdempotencyKey(), state: { phase: 'ready' }, tries: state.tries + 1 } : state)),
    },
    paste: {
      onText: (text) => setPaste((state) => (state ? { ...state, text, state: state.state.phase === 'done' ? { phase: 'ready' } : state.state, key: state.state.phase === 'done' ? newIdempotencyKey() : state.key } : state)),
      onSave: () => void savePaste(),
      onClose: () => setPaste(null),
      onRetry: () => setPaste((state) => (state ? { ...state, key: newIdempotencyKey(), tries: state.tries + 1 } : state)),
    },
    compare: {
      onPair: (pair) => setCompare((state) => (state ? { ...state, ...pair, noteDone: false } : state)),
      onUseNote: (note) => void takeNote(note),
      onClose: () => setCompare(null),
      onRetry: () => setCompare((state) => (state ? { ...state, tries: state.tries + 1 } : state)),
    },
  }
  return depthSlots(model, actions, t)
}
