'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ExtraOutcome } from '@nexus/factory-domain/order-apply/rules'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { getStyle, type StyleDetail } from '../../quotes/api'
import { applyAmendment, findStylesForOrder, previewAmendment, type Order, type OrderStyleRow } from '../api'
import { applyPricedChange, type Freeze } from '../depth/api'
import { frozenOffer, frozenProblemsOf, PRICED_EMPTY, pricedBodyOf } from '../depth/model'
import { readProblem, writeProblem, type OrderAbilities } from '../model'
import { askApproval } from '../../../../record-panels/approvals/api'
import { postPortalReplyKeyed } from '../../../_shared/record-thread/api'
import { portalRefusal } from '../../../_shared/record-thread/state'
import { tellHeld, tickOn } from '../../../home/approvals/requests/model'
import { rowAnchor } from './dock/discuss'
import { changedBy } from './live'
import {
  addLines,
  addSize,
  askDefaultOf,
  bodyLinesOf,
  draftKeyOf,
  EMPTY_HISTORY,
  isEmptyDraft,
  newLineKey,
  putBack,
  rebaseDraft,
  removeLine,
  savedNotice,
  setCell,
  setNewLine,
  setPrice,
  setText,
  takeTheirs,
  undoLast,
  withoutClash,
  type Clash,
  type DraftHistory,
  type NewLine,
} from './lines-draft'
import { cellId, priceCellId } from './lines-table'
import type { AddStyleState, LinesTabActions, LinesTabModel, MovedState, ReviewState } from './lines-tab-model'
import type { RecordActsBase } from './record-model'

/**
 * F-OL-03 (Order LINES lane, plan v2 §1; 10-design-tab §11, §12, §15; 18-lead-settles F10, F22, F25, F31) — the Lines tab's container:
 * the draft of MY changes (always there, an undo stack of its steps), its rebase when another person saves (my cells kept, the
 * moved lines named, a cell both changed waits for Keep mine / Take theirs), "Review and save" (the server's preview of THIS draft,
 * Why optional, ONE tick "Ask {customer} to accept the new order", the extra cut pieces pre-picked "Keep for this customer", the words
 * for the customer), and ONE save: the amendment with the order's version — or, frozen by a company rule, the priced change in the
 * SAME window (fee optional, 0 allowed) — then the ask (`POST /approvals-out` REVISED_ORDER; a failure never undoes the save: "Ask
 * again") and the words in the order's conversation. A 409 reads the order again, rebases and says so inside the window. Also: the
 * order's own style search for Add a style, + Add a colour, the line's options window and the doors that land on a box. Mounted by
 * OrderRecord.tsx; the view draws what it returns and fetches nothing.
 */

export interface LinesDraftInput extends RecordActsBase {
  readonly order: Order | null
  readonly can: OrderAbilities
  /** The company's freeze rules as read (the priced path; the locks). */
  readonly freeze: Freeze | null
  /** The office person's language (who saved meanwhile, in words). */
  readonly language: 'it' | 'en'
  /** Show the Lines tab (the container writes the address; nothing when it shows). */
  readonly showLines: () => void
  /** The page's one focus (an element by its id, once it is drawn). */
  readonly focus: (id: string) => void
  /** Today's options window of one saved line (OrderLineOptions, its own container); null: none. */
  readonly options: (lineId: string, onClose: () => void) => ReactNode
}

const REVIEW_EMPTY = { phase: 'reading', preview: null, problem: null, why: null, words: '', ask: null, tell: { words: '', chosen: null }, extraOutcome: null, fee: '', changedMeanwhile: false } as const
const ADD_EMPTY: AddStyleState = Object.freeze({ query: '', results: null, searching: false, problem: null, row: null, chosen: null, picked: [] }) as AddStyleState
/** The customer's answer is asked for within a week (the ask's own default otherwise). */
const ASK_DAYS = 7

export function useLinesDraft(input: LinesDraftInput): { model: LinesTabModel; actions: LinesTabActions; hasDraft: () => boolean } {
  const { api, orderId, current, write, setNotice, load, order, can, freeze, language, showLines, focus, options } = input
  const [history, setHistoryState] = useState<DraftHistory>(EMPTY_HISTORY)
  const historyRef = useRef(history)
  const setHistory = useCallback((next: DraftHistory | ((known: DraftHistory) => DraftHistory)) => {
    const value = typeof next === 'function' ? next(historyRef.current) : next
    historyRef.current = value
    setHistoryState(value)
  }, [])
  const [clashes, setClashes] = useState<readonly Clash[]>([])
  const [moved, setMoved] = useState<MovedState | null>(null)
  const [styles, setStyles] = useState<Record<string, StyleDetail | null | undefined>>({})
  const [unlisted, setUnlisted] = useState<ReadonlySet<string>>(new Set())
  const [review, setReviewState] = useState<ReviewState | null>(null)
  const reviewRef = useRef<ReviewState | null>(null)
  const setReview = useCallback((next: ReviewState | null | ((known: ReviewState | null) => ReviewState | null)) => {
    const value = typeof next === 'function' ? next(reviewRef.current) : next
    reviewRef.current = value
    setReviewState(value)
  }, [])
  const [addStyle, setAddStyle] = useState<AddStyleState | null>(null)
  const [addColour, setAddColour] = useState<{ styleId: string } | null>(null)
  const [askFailed, setAskFailed] = useState<string | null>(null)
  const [portalGone, setPortalGone] = useState(false)
  const [optionsFor, setOptionsFor] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const searchSeq = useRef(0)
  const askingStyles = useRef(new Set<string>())

  // ---- two people: the order the draft is typed on; another person's save rebases the draft on the fresh order (10 §15) ----
  const baseRef = useRef<Order | null>(null)
  const version = order?.version ?? null
  useEffect(() => {
    if (!order) return
    const base = baseRef.current
    baseRef.current = order
    if (!base || base.version === order.version || isEmptyDraft(historyRef.current.draft)) return
    const rebased = rebaseDraft(base, order, historyRef.current.draft)
    setHistory((known) => ({ draft: rebased.draft, undo: known.undo.map((entry) => rebaseDraft(base, order, entry).draft), last: null }))
    setClashes((known) => [...known.filter((clash) => rebased.clashes.every((entry) => entry.lineId !== clash.lineId || JSON.stringify(entry.field) !== JSON.stringify(clash.field))), ...rebased.clashes])
    const by = changedBy(order.lastChange, ['order'], language)
    if (rebased.moved.length > 0 || rebased.gone.length > 0) setMoved({ by: by.name, at: by.at ?? new Date().toISOString(), lineIds: rebased.moved, gone: rebased.gone })
    if (reviewRef.current) setReview((known) => (known ? { ...known, changedMeanwhile: true } : known))
    // The order's version is the only thing this follows (a new read of the same version changes nothing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  // ---- Review and save: the preview of THIS draft (asked when the window opens and whenever the draft or the version moves) ----
  const reviewOpen = review !== null
  const key = order ? draftKeyOf(history.draft, order) : null
  const asking = useRef<string | null>(null)
  useEffect(() => {
    if (!reviewOpen || !key || !order) return
    if (asking.current === key) return
    const known = reviewRef.current
    if (known && known.key === key && known.phase !== 'failed') return
    asking.current = key
    setReview((open) => (open ? { ...open, key, phase: 'reading', preview: null, problem: null } : open))
    previewAmendment(api, orderId, { version: order.version, lines: bodyLinesOf(historyRef.current.draft, order) })
      .then((preview) =>
        setReview((open) => {
          if (!open || open.key !== key) return open
          // Pieces already cut beyond the new figures: "Keep for this customer" picked for you (never "put in stock").
          const extraOutcome: ExtraOutcome | null = open.extraOutcome ?? ((preview.workOrders?.extra.length ?? 0) > 0 ? 'LEFTOVER' : null)
          return { ...open, phase: 'ready', preview, problem: null, extraOutcome }
        }),
      )
      .catch((error: unknown) => {
        const words = writeProblem(error)
        setReview((open) => (open && open.key === key ? { ...open, phase: 'failed', preview: null, problem: words, changedMeanwhile: open.changedMeanwhile || words.reload } : open))
        if (words.reload) void load()
      })
      .finally(() => {
        if (asking.current === key) asking.current = null
      })
  }, [reviewOpen, key, api, orderId, order, load, setReview])

  // ---- the line's options window (today's container) ----
  const optionsNode = optionsFor ? options(optionsFor, () => setOptionsFor(null)) : null

  /** The style a card or a new row needs (its sizes, colourways, offered sizes): read once. */
  const readStyle = useCallback(
    (styleId: string) => {
      if (askingStyles.current.has(styleId)) return
      askingStyles.current.add(styleId)
      getStyle(api, styleId)
        .then((style) => setStyles((known) => ({ ...known, [styleId]: style })))
        .catch(() => setStyles((known) => ({ ...known, [styleId]: null })))
    },
    [api],
  )

  /** A door lands on a row: the Lines tab, then its first box (or its price box), else the row itself. */
  const land = (lineId: string | null, box: 'first' | 'price') => {
    showLines()
    const value = current.current
    if (!value) return
    const line = (lineId ? value.lines.find((entry) => entry.id === lineId) : null) ?? value.lines.find((entry) => entry.kind === 'SIZE_GRID' && !entry.closedShort) ?? value.lines.find((entry) => entry.kind !== 'FEE') ?? null
    if (!line) return
    const firstSize = line.sizes.find((size) => size.size !== null)?.size ?? null
    const typeable = can.manage && line.kind === 'SIZE_GRID' && !line.closedShort && !historyRef.current.draft.lines[line.id]?.removed
    if (typeable && box === 'price' && can.price) focus(priceCellId(line.id))
    else if (typeable && firstSize) focus(cellId(line.id, firstSize))
    else focus(rowAnchor('SalesOrderLine', line.id))
  }

  /** The new rows a style adds (its active colourways picked), and the size columns its card shows from now on. */
  const newRows = (style: StyleDetail, colourwayIds: readonly string[], copy: Readonly<Record<string, number>> = {}): NewLine[] =>
    style.colourways
      .filter((colourway) => colourwayIds.includes(colourway.id) && colourway.status === 'ACTIVE')
      .map((colourway) => ({ key: newLineKey(style.id, colourway.id), styleId: style.id, colourwayId: colourway.id, colour: `${colourway.code} · ${colourway.name}`, style: { code: style.code, name: style.name }, sizes: Object.fromEntries(Object.entries(copy).filter(([size, pieces]) => pieces > 0 && colourway.offeredSizes.includes(size))), price: '', description: '', note: '' }))

  const addRows = (style: StyleDetail, rows: readonly NewLine[]) => {
    const value = current.current
    if (!value || rows.length === 0) return
    const shown = new Set(value.lines.filter((line) => line.styleId === style.id).flatMap((line) => line.sizes.flatMap((size) => (size.size === null ? [] : [size.size]))))
    const offered = [...new Set(rows.flatMap((row) => style.colourways.find((entry) => entry.id === row.colourwayId)?.offeredSizes ?? []))]
    const columns = (offered.length > 0 ? offered : style.sizes).filter((size) => !shown.has(size))
    setHistory((known) => addLines(known, value, rows, columns.length > 0 ? { [style.id]: columns } : {}))
    setStyles((known) => ({ ...known, [style.id]: style }))
    const first = rows[0]!
    const firstSize = style.colourways.find((entry) => entry.id === first.colourwayId)?.offeredSizes[0] ?? style.sizes[0]
    if (firstSize) focus(cellId(first.key, firstSize))
  }

  // ---- the save ----
  const save = (reason: string | undefined, question: string) => {
    const open = reviewRef.current
    const draft = historyRef.current.draft
    if (!open?.preview || open.phase !== 'ready') return
    const frozen = open.preview.ok ? [] : frozenProblemsOf(open.preview.problems)
    const priced = frozen.length > 0 && frozenOffer(frozen, freeze) === 'priced'
    const ask = priced ? true : (open.ask ?? askDefaultOf(open.preview, can.price))
    const tick = { chosen: open.tell.chosen, reach: portalGone ? ('none' as const) : ('portal' as const) }
    const tell = tickOn(tick, open.tell.words) && tellHeld(tick, open.tell.words) === null ? open.tell.words.trim() : null
    const idempotency = newIdempotencyKey()
    void write(
      async () => {
        const value = current.current
        if (!value) return null
        const lines = bodyLinesOf(draft, value)
        const extra = (open.preview?.workOrders?.extra.length ?? 0) > 0 && open.extraOutcome ? { extraOutcome: open.extraOutcome } : {}
        setSaving(true)
        try {
          const done = priced
            ? await applyPricedChange(api, orderId, { ...pricedBodyOf({ ...PRICED_EMPTY, fee: can.price ? open.fee : '' }, { lines }, can.price), version: value.version, ...(reason ? { reason } : {}), ...extra, askCustomer: true }, idempotency)
            : await applyAmendment(api, orderId, { version: value.version, lines, ...(reason ? { reason } : {}), ...extra, askCustomer: ask }, idempotency)
          // The draft empties BEFORE the answered order lands, so the order is never "rebased" on my own save.
          setHistory(EMPTY_HISTORY)
          setClashes([])
          setMoved(null)
          setReview(null)
          setNotice({ tone: 'success', words: savedNotice(done.workOrders, ask) })
          // The ask (a plain change: a priced change asks through its own link): its failure never undoes the save.
          if (ask && !priced) void askCustomer(question, value)
          if (tell) void tellCustomer(tell, value)
          return done.order
        } catch (error) {
          const words = writeProblem(error)
          if (words.key === 'problem.write.moved') {
            // Someone saved meanwhile: the order is read again (the draft rebased), the window says so and asks its preview again.
            setReview((known) => (known ? { ...known, changedMeanwhile: true } : known))
            return null
          }
          setReview((known) => (known ? { ...known, problem: words } : known))
          return null
        } finally {
          setSaving(false)
        }
      },
      null,
      true,
    )
  }

  const askCustomer = async (question: string, value: Order) => {
    try {
      await askApproval(api, { kind: 'REVISED_ORDER', recordType: 'SalesOrder', recordId: value.id, question, dueAt: new Date(Date.now() + ASK_DAYS * 86_400_000).toISOString(), fileIds: [], send: true, language: value.language === 'en' ? 'en' : 'it' })
      setAskFailed(null)
    } catch {
      setAskFailed(question)
    }
  }

  const tellCustomer = async (words: string, value: Order) => {
    try {
      await postPortalReplyKeyed(api, { type: 'SalesOrder', id: value.id }, { body: words, attachments: [] }, newIdempotencyKey())
    } catch (error) {
      const refusal = portalRefusal(error)
      const gone = refusal === 'notice.portal.NO_PORTAL' || refusal === 'notice.portal.NO_PARTY'
      if (gone) setPortalGone(true)
      setNotice({ tone: 'warning', words: gone ? { key: 'save.notReached', params: { customer: value.party?.legalName ?? '' } } : { key: 'save.notTold' } })
    }
  }

  const order0 = () => current.current
  const actions: LinesTabActions = {
    onCell: (key, size, pieces) => {
      const value = order0()
      if (!value) return
      setHistory((known) => (key.startsWith('new:') ? setNewLine(known, key, { size, pieces }) : setCell(known, value, key, size, pieces)))
    },
    onPrice: (key, text) => {
      const value = order0()
      if (!value) return
      setHistory((known) => (key.startsWith('new:') ? setNewLine(known, key, { price: text }) : setPrice(known, value, key, text)))
    },
    onText: (key, field, text) => {
      const value = order0()
      if (!value) return
      setHistory((known) => (key.startsWith('new:') ? setNewLine(known, key, { field, text }) : setText(known, value, key, field, text)))
    },
    onRemove: (key) => {
      const value = order0()
      if (!value) return
      setHistory((known) => removeLine(known, value, key))
      // From Overview's ⋯ too: the Lines tab with the struck row in view.
      if (!key.startsWith('new:')) {
        showLines()
        focus(rowAnchor('SalesOrderLine', key))
      }
    },
    onPutBack: (lineId) => {
      const value = order0()
      if (!value) return
      setHistory((known) => putBack(known, value, lineId))
    },
    onUndo: () => setHistory((known) => undoLast(known)),
    onDiscard: () => {
      setHistory(EMPTY_HISTORY)
      setClashes([])
      setMoved(null)
      setReview(null)
    },
    onAddSize: (styleId, size) => setHistory((known) => addSize(known, styleId, size)),
    onReadStyle: (styleId) => {
      if (styles[styleId] === undefined) readStyle(styleId)
    },
    // ---- Review and save ----
    onReview: () => {
      if (!order) return
      setReview({ ...REVIEW_EMPTY, key: '' })
    },
    onReviewClose: () => setReview(null),
    onReviewRetry: () => setReview((known) => (known ? { ...known, key: '', phase: 'reading' } : known)),
    onReviewWhy: (pick) => setReview((known) => (known ? { ...known, why: pick } : known)),
    onReviewWords: (text) => setReview((known) => (known ? { ...known, words: text } : known)),
    onReviewAsk: (on) => setReview((known) => (known ? { ...known, ask: on } : known)),
    onReviewTell: (next) => setReview((known) => (known ? { ...known, tell: { ...known.tell, ...next } } : known)),
    onReviewOutcome: (outcome) => setReview((known) => (known ? { ...known, extraOutcome: outcome } : known)),
    onReviewFee: (text) => setReview((known) => (known ? { ...known, fee: text } : known)),
    onSave: ({ reason, question }) => save(reason, question),
    onAskAgain: () => {
      const value = order0()
      if (value && askFailed !== null) void askCustomer(askFailed, value)
    },
    onAskDismiss: () => setAskFailed(null),
    // ---- two people ----
    onKeepMine: (clash) => setClashes((known) => withoutClash(known, clash)),
    onTakeTheirs: (clash) => {
      const value = order0()
      if (!value) return
      setHistory((known) => takeTheirs(known, value, clash))
      setClashes((known) => withoutClash(known, clash))
    },
    onMovedDismiss: () => setMoved(null),
    // ---- Add a style (our collection and this customer's own styles only: the order's own search) ----
    onAddStyleOpen: () => setAddStyle(ADD_EMPTY),
    onAddStyleClose: () => setAddStyle(null),
    onAddStyleQuery: (query) => {
      const mine = ++searchSeq.current
      if (query.trim() === '') return setAddStyle((known) => (known ? { ...known, query: '', results: null, searching: false, problem: null } : known))
      setAddStyle((known) => (known ? { ...known, query, searching: true, problem: null } : known))
      findStylesForOrder(api, orderId, query)
        .then((results) => mine === searchSeq.current && setAddStyle((known) => (known ? { ...known, results, searching: false } : known)))
        .catch((error: unknown) => mine === searchSeq.current && setAddStyle((known) => (known ? { ...known, searching: false, problem: { key: readProblem(error) } } : known)))
    },
    onAddStylePick: (row: OrderStyleRow | null) => {
      if (!row) return setAddStyle((known) => (known ? { ...known, row: null, chosen: null, picked: [] } : known))
      setAddStyle((known) => (known ? { ...known, row, chosen: null, picked: [] } : known))
      getStyle(api, row.id)
        .then((style) => {
          setStyles((known) => ({ ...known, [style.id]: style }))
          setAddStyle((known) => (known && known.row?.id === row.id ? { ...known, chosen: style } : known))
        })
        .catch((error: unknown) => setAddStyle((known) => (known ? { ...known, problem: { key: readProblem(error) } } : known)))
    },
    onAddStyleToggle: (colourwayId) => setAddStyle((known) => (known ? { ...known, picked: known.picked.includes(colourwayId) ? known.picked.filter((id) => id !== colourwayId) : [...known.picked, colourwayId] } : known)),
    onAddStyleAdd: () => {
      const open = addStyle
      if (!open?.chosen) return
      const rows = newRows(open.chosen, open.picked)
      const notPriced = (open.row?.colourways ?? []).filter((entry) => entry.listPriced === false).map((entry) => entry.id)
      if (notPriced.length > 0) setUnlisted((known) => new Set([...known, ...notPriced]))
      setAddStyle(null)
      addRows(open.chosen, rows)
    },
    // ---- + Add a colour: a colour of the card's style not on the order yet; "Copy the sizes of: {colour}" ----
    onAddColourOpen: (styleId) => {
      setAddColour(styleId ? { styleId } : null)
      if (styleId && styles[styleId] === undefined) readStyle(styleId)
    },
    onAddColour: (styleId, colourwayId, copyFrom) => {
      const style = styles[styleId]
      const value = order0()
      if (!style || !value) return
      const draft = historyRef.current.draft
      const source = copyFrom ? value.lines.find((line) => line.id === copyFrom) : null
      const copy: Record<string, number> = source
        ? Object.fromEntries(source.sizes.flatMap((size) => (size.size === null ? [] : [[size.size, draft.lines[source.id]?.sizes?.[size.size] ?? size.quantity]])))
        : { ...(draft.added.find((line) => line.key === copyFrom)?.sizes ?? {}) }
      setAddColour(null)
      addRows(style, newRows(style, [colourwayId], copy))
    },
    onOptions: (lineId) => setOptionsFor(lineId),
    onLand: ({ lineId, box }) => land(lineId, box),
  }

  return {
    model: { draft: history.draft, canUndo: history.undo.length > 0, clashes, moved, styles, unlisted, review, addStyle, addColour, askFailed: askFailed !== null, portalGone, options: optionsNode, saving },
    actions,
    hasDraft: () => !isEmptyDraft(historyRef.current.draft),
  }
}
