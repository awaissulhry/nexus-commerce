'use client'

import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { findStyles, getStyle } from '../../quotes/api'
import { isApiError } from '../../../../lib/api/errors'
import { applyAmendment, cancelOrder, closeLines, getCancelCheck, previewAmendment, reopenLines, type CancelCheck, type CloseLinesAnswer, type Order } from '../api'
import { previewCloseLines, type ClosePreview } from '../api' // F-OP-107
// F-OP-108: "Apply as a priced change" from the strip (one button; its fee; the extra deposit by the order's own rule).
import { applyPricedChange } from '../depth/api'
import { PRICED_EMPTY, pricedBodyOf } from '../depth/model'
import { draftOf, namesOf, newKey, withCells, type DraftLine } from '../daily-model'
// F-OP-106: the strip's preview (one body, one key; a stale answer dropped), the notice after Apply.
import { amendBodyOf, amendKeyOf, appliedNotice, reviewHeld, tookPreview } from '../daily-model'
import { headerChangedOf, SHIP_TO_FIELD_ID } from '../daily-model' // F-OP-110
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
import { requestedBodyOf } from './record-model' // F-OO-144: Requested's small dialog (one amendment, the amend builder)

export type LinesActsModel = Pick<OrderRecordModel, 'amend' | 'closedLines' | 'cancelCheck' | 'portalGone' | 'newLineOptions' | 'split' /* F-OP-111 */ | 'closePreview' /* F-OP-107 */>
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
  | 'onAmendOutcome' // F-OP-107
  | 'onAmendFee' // F-OP-108
  | 'onAmendText' // F-OP-109
  | 'onAmendRemove' // F-OP-109
  | 'onClosePreview' // F-OP-107
  | 'onComposerQuery'
  | 'onComposerPick'
  | 'onComposerToggle'
  | 'onComposerAdd'
  | 'onCloseLines'
  | 'onReopenLines'
  | 'onCancelOrder'
  | 'onPricedOffer'
  | 'onSplit' // F-OP-111
  | 'onChangeShipTo' // F-OP-110
  | 'onRequestedDate' // F-OO-144
>

/** The amendment's body as the API reads it (the preview, Apply, and the priced change it may become; daily-model amendBodyOf). */
export type AmendBody = ReturnType<typeof amendBodyOf>

const part = <T,>(value: T): Part<T> => ({ value, problem: null })
/** The reason the strip's preview is asked with (the preview writes nothing; Apply sends the typed reason). */
const PREVIEW_REASON = 'Review before applying.'
/** F-OP-106: the strip asks its preview this long after the last edit (and at once on blur). */
const PREVIEW_AFTER_MS = 500

/** The draft's own hold (a typed price that is not one, no line left, nothing changed): nothing is asked of the API then. */
const draftHeld = (draft: AmendState, value: Order) => reviewHeld(draft.lines, value, { changed: headerChangedOf(draft, value) /* F-OP-110: the ship-to too */ })

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
    /** F-OP-110: the page's one focus (an element by its id, once it is drawn): ⋯ Change ship-to… focuses the header's Ship to. */
    readonly focus?: (id: string) => void
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
  const { api, orderId, current, write, version, setNotice, load, order, setDialog, clearChanged, showLines, pricedStart, permissions, focus } = input
  const [amend, setAmend] = useState<AmendState | null>(null)
  const amendRef = useRef<AmendState | null>(null)
  amendRef.current = amend
  const [cancelCheck, setCancelCheck] = useState<Part<CancelCheck> | null>(null)
  const [closedLines, setClosedLines] = useState<CloseLinesAnswer | null>(null)
  // ---- F-OP-107: Close remaining lines' preview (the latest ask wins: an answer for other lines is dropped) ----
  const [closePreview, setClosePreview] = useState<Part<ClosePreview> | null>(null)
  const closeSeq = useRef(0)
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
      extraOutcome: null, // F-OP-107
      fee: '', // F-OP-108
      // F-OP-110: Ship to — the order's own until another is picked; the customer's delivery addresses read now (parties.view).
      shipToAddressId: '',
      addresses: mayAddresses ? PART_LOADING : null,
    })
    showLines()
    for (const styleId of styleIds) void readStyle(styleId)
    if (mayAddresses)
      listShipToAddresses(api, value.partyId)
        .then((rows) => setAmend((known) => (known ? { ...known, addresses: part(rows) } : known)))
        .catch((error: unknown) => setAmend((known) => (known ? { ...known, addresses: { value: null, problem: readProblem(error) } } : known)))
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
    // F-OO-125: a door that opens edit mode (Overview's line "Change quantity or sizes…", the requested date's Change…) while a draft is
    // open keeps the draft (Lines shown) — it never starts over on what was typed.
    onAmendStart: () => (amendRef.current ? showLines() : startAmend()),
    // F-OP-110: ⋯ Change ship-to… — the one edit path: edit mode (kept when already open), Ship to focused.
    onChangeShipTo: () => {
      if (!amendRef.current) startAmend()
      else showLines()
      focus?.(SHIP_TO_FIELD_ID)
    },
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
    onAmendApply: (asPriced) => {
      const draft = amendRef.current
      if (!draft) return
      const key = newIdempotencyKey()
      const reason = draft.reason.trim()
      const tick = { chosen: draft.tell.chosen, reach: portalGone ? ('none' as const) : ('portal' as const) }
      const tell = tickOn(tick, draft.tell.words) && tellHeld(tick, draft.tell.words) === null ? draft.tell.words.trim() : null
      void write(async () => {
        const value = current.current!
        // F-OP-107 (B2): the extra pieces' outcome goes only while the preview names extra pieces.
        const extra = (draft.review?.preview?.workOrders?.extra.length ?? 0) > 0 && draft.extraOutcome ? { extraOutcome: draft.extraOutcome } : {}
        // F-OP-108: a frozen field makes it a priced change — the strip's fee (typed only with the price grain); the extra deposit is the
        // order's own percent of the growth ("Deposit and words…" opens its dialog to set another).
        const done = asPriced
          ? await applyPricedChange(api, orderId, { ...pricedBodyOf({ ...PRICED_EMPTY, fee: draft.fee }, amendBodyOf(draft, value), true), version: value.version, reason, ...extra }, key).then((answer) => ({ order: answer.order, revision: answer.change.revision, workOrders: answer.workOrders }))
          : await applyAmendment(api, orderId, { version: value.version, reason, ...amendBodyOf(draft, value), ...extra }, key).then((answer) => ({ order: answer.order, revision: answer.amendment?.revision ?? draft.revision /* B-OP-015: none when only the address moved */, workOrders: answer.workOrders, addressOnly: answer.amendment === null /* F-OP-110 */ }))
        setAmend(null)
        clearChanged()
        // "Amendment 3 applied · WO-0311 changed · WO-0312 waits for production": the work orders followed in the same command.
        // F-OP-110: only the delivery address moved (no amendment written): said as that.
        setNotice({ tone: 'success', words: 'addressOnly' in done && done.addressOnly ? { key: 'edit.shipToDone' } : appliedNotice(done.revision, done.workOrders, null) })
        // ---- F-SA-242: ticked, the words go as our message in the order's conversation (the thread's own portal send), after
        // the amendment took; a refusal never undoes the amendment — it is said in the one notice.
        if (tell) {
          const revision = done.revision
          try {
            await postPortalReplyKeyed(api, { type: 'SalesOrder', id: orderId }, { body: tell, attachments: [] }, newIdempotencyKey())
            setNotice({ tone: 'success', words: appliedNotice(revision, done.workOrders, value.party?.legalName ?? '') })
          } catch (error) {
            const refusal = portalRefusal(error)
            const gone = refusal === 'notice.portal.NO_PORTAL' || refusal === 'notice.portal.NO_PARTY'
            if (gone) setPortalGone(true)
            setNotice({ tone: 'warning', words: { key: gone ? 'notice.amendedNotReached' : 'notice.amendedNotTold', params: { revision, customer: value.party?.legalName ?? '' } } })
          }
        }
        // ---- end F-SA-242
        return done.order
      }, null)
    },
    onAmendOutcome: (outcome) => setAmend((known) => (known ? { ...known, extraOutcome: outcome } : known)), // F-OP-107
    onAmendFee: (text) => setAmend((known) => (known ? { ...known, fee: text } : known)), // F-OP-108
    // ---- F-OP-109: a line's text, and Remove line (a line in work orders too: they follow; its cut pieces go to the picker) ----
    onAmendText: (key, field, text) => setAmend((known) => (known ? { ...known, lines: known.lines.map((line) => (line.key === key ? { ...line, text: { description: line.text?.description ?? '', note: line.text?.note ?? '', [field]: text } } : line)) } : known)),
    onAmendRemove: (key) => setAmend((known) => (known ? { ...known, lines: known.lines.map((line) => (line.key === key && !line.locked ? { ...line, sizes: {} } : line)) } : known)),
    // ---- F-OP-107: Close remaining lines' preview of the lines chosen (nothing written) ----
    onClosePreview: (lineIds) => {
      const mine = ++closeSeq.current
      if (lineIds.length === 0) return setClosePreview(null)
      setClosePreview(PART_LOADING)
      previewCloseLines(api, orderId, lineIds)
        .then((answer) => mine === closeSeq.current && setClosePreview(part(answer)))
        .catch((error: unknown) => mine === closeSeq.current && setClosePreview({ value: null, problem: readProblem(error) }))
    },
    onComposerQuery: composerQuery,
    onComposerPick: composerPick,
    onComposerToggle: (colourwayId) => setAmend((known) => (known ? { ...known, composer: { ...known.composer, picked: known.composer.picked.includes(colourwayId) ? known.composer.picked.filter((id) => id !== colourwayId) : [...known.composer.picked, colourwayId] } } : known)),
    onComposerAdd: composerAdd,
    onCloseLines: (lineIds, reason, reasonCode, extraOutcome) =>
      void write(
        async () => {
          const answer = await closeLines(api, orderId, { version: version(), reason, ...(reasonCode ? { reasonCode } : {}), ...(lineIds.length > 0 ? { lineIds } : {}), ...(extraOutcome ? { extraOutcome } : {}) /* F-OP-107 */ })
          setClosedLines(answer)
          return answer.order
        },
        null,
        true,
      ),
    onReopenLines: (lineIds, reason) => void write(async () => (await reopenLines(api, orderId, { version: version(), reason, ...(lineIds.length > 0 ? { lineIds } : {}) })).order, 'notice.reopened'),
    onCancelOrder: (reason, typed, extraOutcome) => void write(async () => (await cancelOrder(api, orderId, { version: version(), reason, confirmNumber: typed, ...(extraOutcome ? { extraOutcome } : {}) /* F-OP-107 */ })).order, 'notice.cancelled'),
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
    // ---- F-OO-144 (order overview 10-design §4.2; review F7): Requested by customer's small dialog — ONE amendment through the page's
    // one write (the same route as Apply): every line as it is, the new date, the order's version as read. It applies at once (no
    // yes asked); the dialog closes and the order the API answers replaces the page's. A refusal is said inside the dialog (a stale
    // version reads the order again).
    onRequestedDate: ({ date, reason }) => {
      const key = newIdempotencyKey()
      void write(async () => {
        const value = current.current!
        const answer = await applyAmendment(api, orderId, requestedBodyOf(value, date, reason), key)
        setNotice({ tone: 'success', words: appliedNotice(answer.amendment?.revision ?? (value.amendments.latestRevision ?? 0) + 1, answer.workOrders, null) })
        return answer.order
      }, null)
    },
    // ---- end F-OO-144
    // B-W2b-323: the priced change's own dialog with the draft's lines; F-OP-108: "Deposit and words…" beside the strip's fee.
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
    model: { amend, closedLines, cancelCheck, portalGone, newLineOptions, split: { addresses, refusals, made } /* F-OP-111 */, closePreview /* F-OP-107 */ },
    actions,
    amendRef,
    endAmend: () => setAmend(null),
    readCancelCheck,
    // A dialog opens or closes: the lines the last close closed are not said again; the cancel reads its impact check as it opens.
    opened: (next) => {
      setClosedLines(null)
      // F-OP-107: Close remaining lines reads its preview as its lines are chosen (the dialog asks); nothing of an older one stays.
      closeSeq.current += 1
      setClosePreview(null)
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
