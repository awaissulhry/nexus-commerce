'use client'

import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { findStyles, getStyle } from '../../quotes/api'
import { isApiError } from '../../../../lib/api/errors'
import { applyAmendment, cancelOrder, closeLines, getCancelCheck, previewAmendment, reopenLines, type CancelCheck, type CloseLinesAnswer, type Order } from '../api'
import { draftOf, namesOf, newKey, withCells, type DraftLine } from '../daily-model'
// F-OP-106: the strip's preview (one body, one key; a stale answer dropped), the notice after Apply.
import { amendBodyOf, amendKeyOf, appliedNotice, reviewHeld, tookPreview } from '../daily-model'
import { tellHeld, tickOn } from '../../../home/approvals/requests/model'
import { readProblem, writeProblem } from '../model'
// ---- F-OP-111: Split into new orders… (POST …/split; the customer's delivery addresses for a part's Ship to) ----
import { listShipToAddresses, splitOrder, type ShipToAddress } from '../api'
import { splitBodyOf, splitRefusals, type SplitRefusal } from '../model'
// B-W2b-374: an amendment's new line's options.
import { NewLineOptions } from '../../_shared/options-entry/NewLineOptions'
// F-SA-242: the Amend review's tick writes the customer's words through the thread's own portal send.
import { postPortalReplyKeyed } from '../../../_shared/record-thread/api'
import { portalRefusal } from '../../../_shared/record-thread/state'
import { COMPOSER_EMPTY, PART_LOADING, type AmendState, type OrderRecordActions, type OrderRecordModel, type Part, type RecordActsBase, type RecordDialog } from './record-model'

export type LinesActsModel = Pick<OrderRecordModel, 'amend' | 'closedLines' | 'cancelCheck' | 'portalGone' | 'newLineOptions' | 'split' /* F-OP-111 */>
export type LinesActsActions = Pick<
  OrderRecordActions,
  | 'onAmendStart'
  | 'onAmendDiscard'
  | 'onAmendCells'
  | 'onAmendPrice'
  | 'onAmendHeader'
  | 'onAmendPreview' // F-OP-106
  | 'onAmendReason' // F-OP-106
  | 'onAmendTell' // F-OP-106
  | 'onAmendApply'
  | 'onComposerQuery'
  | 'onComposerPick'
  | 'onComposerToggle'
  | 'onComposerAdd'
  | 'onCloseLines'
  | 'onReopenLines'
  | 'onCancelOrder'
  | 'onPricedOffer'
  | 'onSplit' // F-OP-111
>

/** The amendment's body as the API reads it (the preview, Apply, and the priced change it may become; daily-model amendBodyOf). */
export type AmendBody = ReturnType<typeof amendBodyOf>

const part = <T,>(value: T): Part<T> => ({ value, problem: null })
/** The reason the strip's preview is asked with (the preview writes nothing; Apply sends the typed reason). */
const PREVIEW_REASON = 'Review before applying.'
/** F-OP-106: the strip asks its preview this long after the last edit (and at once on blur). */
const PREVIEW_AFTER_MS = 500

/** The draft's own hold (a typed price that is not one, no line left, nothing changed): nothing is asked of the API then. */
const draftHeld = (draft: AmendState, value: Order) => {
  const body = amendBodyOf(draft, value)
  return reviewHeld(draft.lines, value, { changed: 'customerRef' in body || 'requestedDate' in body })
}

/**
 * F-OP-134 (N-5): the Lines tab's acts — B-W2a-50: "Amend order" holds the draft here (each style read for its sizes and colourways;
 * F-OP-106: the strip's preview is asked 500 ms after the last edit and on blur, one call at a time, an answer for an older draft
 * dropped; ONE Apply sends the version as read, the reason and the words for the customer (F-SA-242: through the thread's portal send)),
 * close and reopen lines, the cancel's impact check when its dialog opens, then the cancel with the typed number; F-OP-111: Split
 * into new orders (the customer's delivery addresses read as it opens, parties.view; a refusal said at its place). Mounted by the
 * container (OrderRecord.tsx), which hands what it returns to the view as plain props; a view never imports it.
 */
export function useLinesActs(
  input: RecordActsBase & {
    /** The order as this render draws it (an amendment's new line is named by it). */
    readonly order: Order | null
    readonly setDialog: (dialog: RecordDialog | null) => void
    /** "Changed by <name> at hh:mm" goes with the draft it was about. */
    readonly clearChanged: () => void
    /** Amend shows the Lines tab (the container writes the address). */
    readonly showLines: () => void
    /** B-W2b-323: "Send as a priced change" from Review amendment — the draft's lines go with it. */
    readonly pricedStart: (amendment: AmendBody) => void
    /** F-OP-111: the person's rights (a part's Ship to reads the customer's addresses with parties.view). */
    readonly permissions: readonly string[]
  },
): {
  model: LinesActsModel
  actions: LinesActsActions
  /** The draft while one is typed (the live re-read waits for Reload under it). */
  amendRef: { readonly current: AmendState | null }
  /** The draft ends (applied as a priced change, or put aside). */
  endAmend: () => void
  readCancelCheck: () => void
  opened: (next: RecordDialog | null) => void
} {
  const { api, orderId, current, write, version, setNotice, load, order, setDialog, clearChanged, showLines, pricedStart, permissions } = input
  const [amend, setAmend] = useState<AmendState | null>(null)
  const amendRef = useRef<AmendState | null>(null)
  amendRef.current = amend
  const [cancelCheck, setCancelCheck] = useState<Part<CancelCheck> | null>(null)
  const [closedLines, setClosedLines] = useState<CloseLinesAnswer | null>(null)
  const [portalGone, setPortalGone] = useState(false) // F-SA-242
  const searchSeq = useRef(0)
  // ---- F-OP-111: the split's addresses (null: no right to read them), its refusals by place, the orders it made ----
  const mayAddresses = permissions.includes('parties.view')
  const [addresses, setAddresses] = useState<Part<ShipToAddress[]> | null>(null)
  const [refusals, setRefusals] = useState<readonly SplitRefusal[]>([])
  const [made, setMade] = useState<readonly { id: string; number: string }[] | null>(null)
  const readAddresses = (partyId: string) => {
    setAddresses(PART_LOADING)
    listShipToAddresses(api, partyId)
      .then((rows) => setAddresses(part(rows)))
      .catch((error: unknown) => setAddresses({ value: null, problem: readProblem(error) }))
  }
  // ---- end F-OP-111

  // ---- B-W2a-50: the amendment draft --------------------------------------------------------------------------------
  const readStyle = useCallback(
    (styleId: string) =>
      getStyle(api, styleId)
        .then((style) => setAmend((known) => (known ? { ...known, styles: { ...known.styles, [styleId]: style } } : known)))
        .catch(() => setAmend((known) => (known ? { ...known, styles: { ...known.styles, [styleId]: null } } : known))),
    [api],
  )
  const startAmend = () => {
    const value = current.current
    if (!value) return
    const styleIds = [...new Set(value.lines.map((line) => line.styleId))]
    setNotice(null)
    setAmend({
      revision: (value.amendments.latestRevision ?? 0) + 1,
      lines: draftOf(value),
      customerRef: value.customerRef ?? '',
      requestedDate: value.requestedDate ?? '',
      styles: Object.fromEntries(styleIds.map((styleId) => [styleId, undefined])),
      composer: COMPOSER_EMPTY,
      review: null,
      reason: '', // F-OP-106
      tell: { words: '', chosen: null }, // F-OP-106
    })
    showLines()
    for (const styleId of styleIds) void readStyle(styleId)
  }
  // ---- F-OP-106: the strip's preview — one call at a time; when it comes back the draft is asked again if it moved on meanwhile (an
  // answer is kept with the key it was asked for: the strip draws it only while that key is the draft's, so a stale one never shows).
  const asking = useRef(false)
  const askPreview = useCallback(() => {
    const draft = amendRef.current
    const value = current.current
    if (!draft || !value || asking.current || draftHeld(draft, value)) return
    const key = amendKeyOf(draft, value)
    if (draft.review?.key === key && draft.review.phase !== 'failed') return
    asking.current = true
    setAmend((known) => (known ? { ...known, review: { phase: 'reading', key, preview: null, problem: null } } : known))
    // The API checks a reason in the preview too: it is asked with a stand-in (nothing is written); Apply sends the real one.
    previewAmendment(api, orderId, { version: value.version, reason: PREVIEW_REASON, ...amendBodyOf(draft, value) })
      .then((preview) => setAmend((known) => tookPreview(known, { phase: 'ready', key, preview, problem: null })))
      .catch((error: unknown) => {
        const words = writeProblem(error)
        setAmend((known) => tookPreview(known, { phase: 'failed', key, preview: null, problem: words }))
        if (words.reload) void load()
      })
      .finally(() => {
        asking.current = false
        // The draft may have moved on while this one was asked: ask for it now (nothing when it is the same).
        setTimeout(() => askAgain.current(), 0)
      })
  }, [api, orderId, current, load])
  const askAgain = useRef(askPreview)
  askAgain.current = askPreview
  const draftKey = amend && order ? amendKeyOf(amend, order) : null
  useEffect(() => {
    if (draftKey === null) return
    const timer = setTimeout(() => askAgain.current(), PREVIEW_AFTER_MS)
    return () => clearTimeout(timer)
  }, [draftKey])
  // ---- end F-OP-106
  const composerQuery = (query: string) => {
    const mine = ++searchSeq.current
    const companyId = current.current?.companyId ?? null
    if (query.trim() === '') {
      setAmend((known) => (known ? { ...known, composer: { ...known.composer, query: '', results: null, searching: false, problem: null } } : known))
      return
    }
    setAmend((known) => (known ? { ...known, composer: { ...known.composer, query, searching: true, problem: null } } : known))
    findStyles(api, query, companyId)
      .then((results) => mine === searchSeq.current && setAmend((known) => (known ? { ...known, composer: { ...known.composer, results, searching: false } } : known)))
      .catch((error: unknown) => mine === searchSeq.current && setAmend((known) => (known ? { ...known, composer: { ...known.composer, searching: false, problem: readProblem(error) } } : known)))
  }
  const composerPick = (styleId: string | null) => {
    if (!styleId) {
      setAmend((known) => (known ? { ...known, composer: { ...known.composer, chosen: null, picked: [] } } : known))
      return
    }
    getStyle(api, styleId)
      .then((style) => setAmend((known) => (known ? { ...known, styles: { ...known.styles, [styleId]: style }, composer: { ...known.composer, chosen: style, picked: [] } } : known)))
      .catch((error: unknown) => setAmend((known) => (known ? { ...known, composer: { ...known.composer, problem: readProblem(error) } } : known)))
  }
  const composerAdd = () =>
    setAmend((known) => {
      const chosen = known?.composer.chosen
      if (!known || !chosen) return known
      const have = new Set(known.lines.filter((line) => line.styleId === chosen.id).map((line) => line.colourwayId))
      const added = known.composer.picked.filter((colourwayId) => !have.has(colourwayId)).map((colourwayId) => ({ key: newKey(chosen.id, colourwayId), lineId: null, styleId: chosen.id, colourwayId, sizes: {}, price: '', locked: false }))
      return { ...known, lines: [...known.lines, ...added], composer: COMPOSER_EMPTY }
    })

  // The cancel dialog's impact check (read when it opens, again on Try again).
  const readCancelCheck = () => {
    setCancelCheck(PART_LOADING)
    getCancelCheck(api, orderId)
      .then((answer) => setCancelCheck(part(answer)))
      .catch((error: unknown) => setCancelCheck({ value: null, problem: readProblem(error) }))
  }

  const actions: LinesActsActions = {
    onAmendStart: startAmend,
    onAmendDiscard: () => {
      setAmend(null)
      clearChanged()
    },
    onAmendCells: (styleId, next) => setAmend((known) => (known ? { ...known, lines: withCells(known.lines, Object.fromEntries(Object.entries(next).filter(([key]) => known.lines.some((line) => line.key === key && line.styleId === styleId)))) } : known)),
    onAmendPrice: (key, text) => setAmend((known) => (known ? { ...known, lines: known.lines.map((line) => (line.key === key ? { ...line, price: text } : line)) } : known)),
    onAmendHeader: (field, text) => setAmend((known) => (known ? { ...known, [field]: text } : known)),
    // ---- F-OP-106: the strip's own parts; ONE Apply (no second dialog) ----
    onAmendPreview: () => askAgain.current(),
    onAmendReason: (text) => setAmend((known) => (known ? { ...known, reason: text } : known)),
    onAmendTell: (next) => setAmend((known) => (known ? { ...known, tell: { ...known.tell, ...next } } : known)),
    onAmendApply: () => {
      const draft = amendRef.current
      if (!draft) return
      const key = newIdempotencyKey()
      const reason = draft.reason.trim()
      const tick = { chosen: draft.tell.chosen, reach: portalGone ? ('none' as const) : ('portal' as const) }
      const tell = tickOn(tick, draft.tell.words) && tellHeld(tick, draft.tell.words) === null ? draft.tell.words.trim() : null
      void write(async () => {
        const value = current.current!
        const answer = await applyAmendment(api, orderId, { version: value.version, reason, ...amendBodyOf(draft, value) }, key)
        setAmend(null)
        clearChanged()
        // "Amendment 3 applied · WO-0311 changed · WO-0312 waits for production": the work orders followed in the same command.
        setNotice({ tone: 'success', words: appliedNotice(answer.amendment.revision, answer.workOrders, null) })
        // ---- F-SA-242: ticked, the words go as our message in the order's conversation (the thread's own portal send), after
        // the amendment took; a refusal never undoes the amendment — it is said in the one notice.
        if (tell) {
          const revision = answer.amendment.revision
          try {
            await postPortalReplyKeyed(api, { type: 'SalesOrder', id: orderId }, { body: tell, attachments: [] }, newIdempotencyKey())
            setNotice({ tone: 'success', words: appliedNotice(revision, answer.workOrders, value.party?.legalName ?? '') })
          } catch (error) {
            const refusal = portalRefusal(error)
            const gone = refusal === 'notice.portal.NO_PORTAL' || refusal === 'notice.portal.NO_PARTY'
            if (gone) setPortalGone(true)
            setNotice({ tone: 'warning', words: { key: gone ? 'notice.amendedNotReached' : 'notice.amendedNotTold', params: { revision, customer: value.party?.legalName ?? '' } } })
          }
        }
        // ---- end F-SA-242
        return answer.order
      }, null)
    },
    onComposerQuery: composerQuery,
    onComposerPick: composerPick,
    onComposerToggle: (colourwayId) => setAmend((known) => (known ? { ...known, composer: { ...known.composer, picked: known.composer.picked.includes(colourwayId) ? known.composer.picked.filter((id) => id !== colourwayId) : [...known.composer.picked, colourwayId] } } : known)),
    onComposerAdd: composerAdd,
    onCloseLines: (lineIds, reason, reasonCode) =>
      void write(
        async () => {
          const answer = await closeLines(api, orderId, { version: version(), reason, ...(reasonCode ? { reasonCode } : {}), ...(lineIds.length > 0 ? { lineIds } : {}) })
          setClosedLines(answer)
          return answer.order
        },
        null,
        true,
      ),
    onReopenLines: (lineIds, reason) => void write(async () => (await reopenLines(api, orderId, { version: version(), reason, ...(lineIds.length > 0 ? { lineIds } : {}) })).order, 'notice.reopened'),
    onCancelOrder: (reason, typed) => void write(async () => (await cancelOrder(api, orderId, { version: version(), reason, confirmNumber: typed })).order, 'notice.cancelled'),
    // ---- F-OP-111: the parts become orders of their own (the order's version as read); the dialog then shows them, each a link, and
    // the page stays. A refusal is said at its place (a part, or the split as a whole) beside the dialog's one problem line.
    onSplit: ({ parts, reason }) => {
      const value = current.current
      if (!value) return
      const body = splitBodyOf(value, parts, reason, value.version)
      const key = newIdempotencyKey()
      setRefusals([])
      void write(
        async () => {
          try {
            const answer = await splitOrder(api, orderId, body, key)
            setMade(answer.orders)
            setNotice({ tone: 'success', words: { key: 'split.notice', params: { numbers: answer.orders.map((entry) => entry.number).join(', ') } } })
            return answer.order
          } catch (error) {
            if (isApiError(error) && error.kind === 'invalid') setRefusals(splitRefusals(error.issues, body, value))
            throw error
          }
        },
        null,
        true,
      )
    },
    // ---- end F-OP-111
    // B-W2b-323: "Send as a priced change" from Review amendment (the draft's lines go with it).
    onPricedOffer: () => {
      const draft = amendRef.current
      const value = current.current
      if (!draft || !value) return
      setDialog(null)
      pricedStart(amendBodyOf(draft, value))
    },
  }

  // B-W2b-374 (XF3:02): an amendment's new line takes its options when it is made.
  const newLineOptions = (line: DraftLine): ReactNode =>
    createElement(NewLineOptions, {
      key: line.key,
      api,
      styleId: line.styleId,
      colourwayId: line.colourwayId,
      line: (({ style, colour }) => ({ style, colour }))(namesOf(line, order, amend?.styles[line.styleId])),
      picks: line.options ?? [],
      onChange: (picks) => setAmend((known) => (known ? { ...known, lines: known.lines.map((entry) => (entry.key === line.key ? { ...entry, options: picks } : entry)) } : known)),
    })

  return {
    model: { amend, closedLines, cancelCheck, portalGone, newLineOptions, split: { addresses, refusals, made } /* F-OP-111 */ },
    actions,
    amendRef,
    endAmend: () => setAmend(null),
    readCancelCheck,
    // A dialog opens or closes: the lines the last close closed are not said again; the cancel reads its impact check as it opens.
    opened: (next) => {
      setClosedLines(null)
      if (next?.kind === 'cancel') readCancelCheck()
      // F-OP-111: the split opens with nothing said yet; its Ship to reads the customer's delivery addresses (parties.view).
      setRefusals([])
      setMade(null)
      if (next?.kind === 'split') {
        const value = current.current
        if (value && mayAddresses) readAddresses(value.partyId)
        else setAddresses(null)
      }
    },
  }
}
