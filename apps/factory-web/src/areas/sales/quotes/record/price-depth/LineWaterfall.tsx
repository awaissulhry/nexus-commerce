'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import type { QuoteDetail, QuoteLine } from '../../api'
import { parsePrice, readOnlyReason, type Grains } from '../../model'
import { readProblem } from '../../problems'
import { priceProblem } from './problems'
import { getCostSheet, priceLine, readListPrices, readPriceReasons, readPricing, type ListPriceLine, type PriceReason } from './api'
import { costBreakdown, lineHeld, netBody, netProblems, type NetDraft, type Words } from './model'
import { LineWaterfallView, type LineWaterfallModel } from './view/LineWaterfallView'

export interface LineWaterfallProps {
  api: ApiClient
  quote: QuoteDetail
  line: QuoteLine
  grains: Grains
  editable: boolean
  onQuote: (next: QuoteDetail) => void
}

const sales = (key: string): Words => ({ ns: 'sales', key })

/**
 * The container of the line drawer's "Cost breakdown and Waterfall" (B-W2b-343, the section B-W2b-316 left open): reads the
 * quote's pricing (this line's stored waterfall, what the list and the cost would give, the margin against the floor),
 * the line's list price (its list, its break's pieces, the surcharges' scope), the price adjustment reasons and — with the
 * cost grain — the revision's cost sheet; writes the line's price by its waterfall (PUT …/price: re-price from the list,
 * from the cost, a net typed with its reason) at the quote's version and hands the record the quote it answers.
 */
export function LineWaterfall({ api, quote, line, grains, editable, onQuote }: LineWaterfallProps) {
  const quoteRef = useRef(quote)
  quoteRef.current = quote
  const [pricing, setPricing] = useState<LineWaterfallModel['pricing']>({ status: 'loading' })
  const [list, setList] = useState<ListPriceLine | null>(null)
  const [reasons, setReasons] = useState<readonly PriceReason[]>([])
  const [cost, setCost] = useState<LineWaterfallModel['cost']>({ status: 'loading' })
  const [net, setNet] = useState<NetDraft | null>(null)
  const [saving, setSaving] = useState<LineWaterfallModel['saving']>(null)
  const [notice, setNotice] = useState<LineWaterfallModel['notice']>(null)
  const [tries, setTries] = useState(0)
  const reason = readOnlyReason(quote, { manage: editable || quote.current.status !== 'DRAFT' })
  const readOnly: Words | null = editable ? null : { ns: 'sales', key: reason ?? 'readOnly.noRight', params: { revision: quote.currentRevision, next: quote.currentRevision + 1, date: quote.current.validUntil ?? '—' } }

  // The pricing and the list prices follow the line and the quote's version (a write elsewhere moves them).
  const versionKey = `${quote.id}:${quote.version}:${line.id}:${tries}`
  useEffect(() => {
    if (!grains.price) return
    const control = new AbortController()
    setPricing((current) => (current.status === 'ready' && current.value.line.lineId === line.id ? current : { status: 'loading' }))
    readPricing(api, quote.id, control.signal)
      .then((answer) => {
        const mine = answer.lines.find((entry) => entry.lineId === line.id)
        setPricing(mine ? { status: 'ready', value: { line: mine, floorPct: answer.floor.marginFloorPct } } : { status: 'error', problem: sales('problem.read.not_found') })
      })
      .catch((error: unknown) => !control.signal.aborted && setPricing({ status: 'error', problem: sales(readProblem(error)) }))
    readListPrices(api, quote.id, control.signal)
      .then((answer) => setList(answer.lines.find((entry) => entry.lineId === line.id) ?? null))
      .catch(() => !control.signal.aborted && setList(null))
    return () => control.abort()
    // The version key names everything a read depends on.
  }, [api, versionKey, grains.price])

  useEffect(() => {
    let live = true
    readPriceReasons(api)
      .then((value) => live && setReasons(value))
      .catch(() => live && setReasons([]))
    return () => {
      live = false
    }
  }, [api])

  // The cost sheet of the line's revision (cost grain; costing.view — a 403 says so in words).
  const costKey = `${line.styleId}:${line.styleRevisionId ?? ''}:${quote.companyId}:${tries}`
  useEffect(() => {
    if (!grains.cost) return setCost({ status: 'held', why: { key: 'drawer.noCostGrain' } })
    if (line.kind !== 'SIZE_GRID') return setCost({ status: 'held', why: { key: 'held.fee' } })
    if (!line.styleRevisionId) return setCost({ status: 'held', why: sales('lines.noCostSheet') })
    const revisionId = line.styleRevisionId
    let live = true
    setCost({ status: 'loading' })
    getCostSheet(api, line.styleId, revisionId, quote.companyId)
      .then((sheet) => live && setCost({ status: 'ready', value: costBreakdown(sheet, quoteRef.current.lines.find((entry) => entry.id === line.id) ?? line) }))
      .catch((error: unknown) => live && setCost(isApiError(error) && error.kind === 'forbidden' ? { status: 'held', why: { key: 'drawer.noCosting' } } : { status: 'error', problem: sales(readProblem(error)) }))
    return () => {
      live = false
    }
    // The revision and the company name the sheet.
  }, [api, costKey, grains.cost])

  useEffect(() => {
    setNet(null)
    setNotice(null)
  }, [line.id])

  const write = useCallback(
    async (how: 'LIST' | 'SUGGESTED' | 'NET') => {
      const current = quoteRef.current
      if (pricing.status !== 'ready' || saving) return
      const entry = pricing.value.line
      if (lineHeld(entry, how)) return
      let body
      if (how === 'NET') {
        if (!net || netProblems(net, entry.unitPrice, reasons).length > 0) return
        body = netBody(entry, parsePrice(net.text)!, net.reasonCode, net.note.trim() || null)
      } else body = { start: how } as const
      setSaving(how)
      setNotice(null)
      try {
        const answer = await priceLine(api, current, line.id, body)
        onQuote(answer.quote)
        if (how === 'NET') setNet(null)
        setNotice({ tone: 'success', words: { key: `done.${how}`, params: { line: line.seq } } })
      } catch (error) {
        const problem = priceProblem(error)
        setNotice({ tone: 'danger', words: problem.words })
        if (problem.reload) setTries((value) => value + 1)
      } finally {
        setSaving(null)
      }
    },
    [api, line.id, line.seq, net, onQuote, pricing, reasons, saving],
  )

  const model: LineWaterfallModel = {
    line,
    currency: quote.current.currency,
    priceBasis: quote.current.priceBasis,
    grains,
    readOnly,
    pricing,
    list,
    reasons,
    cost,
    net,
    saving,
    notice,
  }
  return (
    <LineWaterfallView
      model={model}
      actions={{
        onReprice: (how) => void write(how),
        onNetOpen: (open) => setNet(open ? { lineId: line.id, text: pricing.status === 'ready' ? (pricing.value.line.unitPrice ?? '') : '', reasonCode: '', note: '' } : null),
        onNetDraft: setNet,
        onNetSave: () => void write('NET'),
        onRetry: () => setTries((value) => value + 1),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
