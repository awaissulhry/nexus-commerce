'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { ApiClient } from '../../../../../lib/api/client'
import type { QuoteDetail } from '../../api'
import { parsePrice, readOnlyReason, type Grains, type QuoteAbilities, type QuoteTab } from '../../model'
import { readProblem } from '../../problems'
import type { QuoteDepthSlots } from '../lines-depth/slots'
import { priceLine, readListPrices, readPriceReasons, readPricing, type PriceReason, type QuoteListPrices, type QuotePricing } from './api'
import { lineHeld, netBody, netProblems, type NetDraft, type Tone, type Words } from './model'
import { priceProblem } from './problems'
import { BlockPrices } from './view/BlockPrices'
import { PricingByLine, type PricingByLineModel } from './view/PricingByLine'

export interface PriceDepthInput {
  api: ApiClient
  quote: QuoteDetail | null
  tab: QuoteTab
  grains: Grains
  can: QuoteAbilities
  /** The record takes the quote a write answers. */
  onQuote: (next: QuoteDetail) => void
}

type Read<T> = { status: 'loading' } | { status: 'error'; problem: Words } | { status: 'ready'; value: T }

/**
 * The quote record's price parts (B-W2b-343) beside B-W2b-316's: reads the quote's pricing by line (GET …/pricing) on the
 * Lines and Price & margin tabs, the lines' list prices and the price adjustment reasons on Price & margin; writes a line's
 * price by its waterfall (PUT …/lines/:lineId/price) — a net typed in its cell with its reason, or the lines selected
 * re-priced from the list or from the cost, one after the other, each at the quote's version as it stands then — and
 * hands the record the quote each write answers. A row opens B-W2b-316's line drawer (`?line=`), where the waterfall is.
 * Returns the slots `pricing` (Price & margin › Pricing by line) and `blockPrices` (a style block's discount and price
 * by size).
 */
export function usePriceDepth(input: PriceDepthInput): Pick<QuoteDepthSlots, 'pricing' | 'blockPrices'> {
  const { api, quote, tab, grains, can } = input
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const quoteRef = useRef(quote)
  quoteRef.current = quote
  const inputRef = useRef(input)
  inputRef.current = input
  const wanted = !!quote && grains.price && (tab === 'price' || tab === 'lines')
  const [pricing, setPricing] = useState<Read<QuotePricing>>({ status: 'loading' })
  const [listPrices, setListPrices] = useState<QuoteListPrices | null>(null)
  const [reasons, setReasons] = useState<readonly PriceReason[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [cells, setCells] = useState<Record<string, 'saving' | 'failed'>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ words: Words; tone: Tone } | null>(null)
  const [manual, setManual] = useState<{ draft: NetDraft; saving: boolean; problem: Words | null } | null>(null)
  const [resetKey, setResetKey] = useState(0)
  const [tries, setTries] = useState(0)

  const key = quote ? `${quote.id}:${quote.version}:${tab}:${tries}` : ''
  useEffect(() => {
    if (!wanted || !quote) return
    const control = new AbortController()
    readPricing(api, quote.id, control.signal)
      .then((value) => setPricing({ status: 'ready', value }))
      .catch((error: unknown) => !control.signal.aborted && setPricing({ status: 'error', problem: { ns: 'sales', key: readProblem(error) } }))
    if (tab === 'price')
      readListPrices(api, quote.id, control.signal)
        .then(setListPrices)
        .catch(() => !control.signal.aborted && setListPrices(null))
    return () => control.abort()
    // The key names the quote, its version and the tab.
  }, [api, key, wanted])

  useEffect(() => {
    if (tab !== 'price' || reasons.length > 0) return
    let live = true
    readPriceReasons(api)
      .then((value) => live && setReasons(value))
      .catch(() => live && setReasons([]))
    return () => {
      live = false
    }
  }, [api, tab, reasons.length])

  useEffect(() => {
    setSelected((current) => current.filter((id) => quote?.lines.some((line) => line.id === id)))
  }, [quote])

  const openLine = useCallback(
    (lineId: string) => {
      const next = new URLSearchParams(params?.toString() ?? '')
      next.set('line', lineId)
      router.replace(`${pathname}?${next.toString()}`, { scroll: false })
    },
    [params, pathname, router],
  )

  const lineLabel = (lineId: string): string => {
    const line = quoteRef.current?.lines.find((entry) => entry.id === lineId)
    return line ? `${line.seq} · ${line.style.code} ${line.colourway.code}` : ''
  }

  const saveNet = async () => {
    const current = quoteRef.current
    const open = manual
    if (!current || !open || open.saving || pricing.status !== 'ready') return
    const entry = pricing.value.lines.find((line) => line.lineId === open.draft.lineId)
    if (!entry || netProblems(open.draft, entry.unitPrice, reasons).length > 0) return
    setManual({ ...open, saving: true, problem: null })
    setCells((state) => ({ ...state, [entry.lineId]: 'saving' }))
    try {
      const answer = await priceLine(api, current, entry.lineId, netBody(entry, parsePrice(open.draft.text)!, open.draft.reasonCode, open.draft.note.trim() || null))
      inputRef.current.onQuote(answer.quote)
      setManual(null)
      setCells(({ [entry.lineId]: _gone, ...rest }) => rest)
      setNotice({ tone: 'success', words: { key: 'done.NET', params: { line: entry.seq } } })
    } catch (error) {
      const problem = priceProblem(error)
      setManual((state) => (state ? { ...state, saving: false, problem: problem.words } : state))
      setCells((state) => ({ ...state, [entry.lineId]: 'failed' }))
      if (problem.reload) setTries((value) => value + 1)
    }
  }

  const bulk = async (how: 'LIST' | 'SUGGESTED', lineIds: string[]) => {
    if (busy || pricing.status !== 'ready') return
    setBusy(true)
    setNotice(null)
    let current = quoteRef.current
    const done: number[] = []
    const refused: Array<{ seq: number; words: Words }> = []
    for (const id of lineIds) {
      const entry = pricing.value.lines.find((line) => line.lineId === id)
      if (!current || !entry || lineHeld(entry, how)) continue
      setCells((state) => ({ ...state, [id]: 'saving' }))
      try {
        const answer = await priceLine(api, current, id, { start: how })
        current = answer.quote
        inputRef.current.onQuote(answer.quote)
        done.push(entry.seq)
        setCells(({ [id]: _gone, ...rest }) => rest)
      } catch (error) {
        refused.push({ seq: entry.seq, words: priceProblem(error).words })
        setCells((state) => ({ ...state, [id]: 'failed' }))
      }
    }
    setBusy(false)
    if (refused.length === 0) {
      setSelected([])
      setNotice({ tone: 'success', words: { key: `bulk.done${how}`, params: { count: done.length } } })
    } else setNotice({ tone: 'warning', words: { key: 'bulk.partly', params: { count: done.length, refused: refused.map((entry) => entry.seq).join(', ') } } })
    setTries((value) => value + 1)
  }

  if (!quote || !grains.price) return {}
  const editable = can.manage && quote.current.status === 'DRAFT'
  const reason = editable ? null : readOnlyReason(quote, can)
  const readOnly: Words | null = reason ? { ns: 'sales', key: reason, params: { revision: quote.currentRevision, next: quote.currentRevision + 1, date: quote.current.validUntil ?? '—' } } : null
  const ready = pricing.status === 'ready' && pricing.value.versionId === quote.current.id ? pricing.value : null
  const manualEntry = manual && ready ? ready.lines.find((line) => line.lineId === manual.draft.lineId) : null

  const model: PricingByLineModel = {
    quote,
    pricing: pricing.status === 'error' ? pricing : ready ? { status: 'ready', value: ready } : { status: 'loading' },
    listPrices,
    reasons,
    grains,
    readOnly,
    selected,
    cells,
    busy,
    notice,
    resetKey,
    manual:
      manual && manualEntry
        ? {
            draft: manual.draft,
            label: lineLabel(manual.draft.lineId),
            current: manualEntry.unitPrice ?? null,
            currency: quote.current.currency,
            steps: manualEntry.steps ?? null,
            fromList: !!manualEntry.fromList,
            reasons,
            saving: manual.saving,
            problem: manual.problem,
          }
        : null,
  }

  return {
    pricing:
      tab === 'price' ? (
        <PricingByLine
          model={model}
          actions={{
            onSelect: setSelected,
            onOpen: openLine,
            onNet: (lineId, text) => setManual({ draft: { lineId, text, reasonCode: '', note: '' }, saving: false, problem: null }),
            onBulk: (how, ids) => void bulk(how, ids),
            onRetry: () => setTries((value) => value + 1),
            onDismissNotice: () => setNotice(null),
            manual: {
              onDraft: (draft) => setManual((state) => (state ? { ...state, draft, problem: null } : state)),
              onSave: () => void saveNet(),
              onClose: () => {
                setManual(null)
                setCells(({ [manual?.draft.lineId ?? '']: _gone, ...rest }) => rest)
                setResetKey((value) => value + 1)
              },
            },
          }}
        />
      ) : undefined,
    blockPrices: tab === 'lines' ? (block) => <BlockPrices model={{ lines: block.lines, currency: quote.current.currency, pricing: ready?.lines ?? null }} /> : undefined,
  }
}
