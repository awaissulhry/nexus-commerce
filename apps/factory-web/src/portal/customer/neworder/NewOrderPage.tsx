'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive, usePortalUnsaved } from '../../shell/frame'
import { addAddress } from '../account/api'
import { addressBody, addressProblems, addressTyped, EMPTY_ADDRESS, type AddressDraft } from '../account/model'
import { fetchCatalogue, fetchStyle } from '../catalogue/api'
import { saveText, useOffline } from '../orders/hooks'
import {
  addLines,
  changeLine,
  createDraft,
  discardDraft,
  fetchDrafts,
  fetchPastOrder,
  fetchPastOrders,
  fileContent,
  portalDraftPort,
  reorderInto,
  sendDraft,
  SHEET_MAX_BYTES,
  takeTodaysPrices,
  templateHref,
  uploadSheet,
  type DraftLine,
  type DraftRecord,
  type DraftRow,
  type NewLine,
} from './api'
import { newOrderBandOf, type NewOrderPhase } from './band'
import {
  headerChanges,
  headerDirty,
  headerDraftOf,
  headerProblem,
  isWay,
  mergeWords,
  newOrderHref,
  NS,
  piecesOfCells,
  refusalOf,
  reorderBody,
  reorderStart,
  sizesBody,
  stylesOf,
  todayIn,
  writeHeld,
  type HeaderDraft,
  type HeaderField,
  type Way,
} from './model'
import type { PickerModel } from './view/Dialogs'
import { pickerLineCount } from './view/Dialogs'
import { NewOrderView } from './view/NewOrderView'
import type { ReorderModel } from './view/ReorderPanel'
import type { SheetState } from './view/UploadPanel'
import { NotInAccess } from './view/parts'
import { useOrderingWords } from './words'
import { DRAFT_NS, useDraftWords } from '../../../lib/order-draft/words'
// ---- F-CP-150 (customer page plan C5, D9–D11): the draft order page — its conversation docked, who may send, who changed it.
import { PortalThread } from '../../shell/thread/PortalThread'
import { fetchColleagues } from './api'
import { draftDiscardHeld, draftSendHeld, draftTitleOf, mayOf, whoMayOrder } from './model'
// ---- end F-CP-150
// ---- F-CP-151 (B-CP-072; D14): the draft's files — announced, PUT to the store, completed; taken out by their version.
import { useT } from '../../../lib/i18n/provider'
import { COMPOSE_NS } from '../../../lib/request-compose/model'
import { heldProblem } from '../../../lib/request-compose/files'
import { contentTypeOf } from '../../../lib/record-thread/attachments/model'
import { putToStore, sha256Hex, StoreError } from '../../../record-panels/store'
import type { DraftFile, DraftFilePart } from './api'
import { DRAFT_FILES_MAX, draftFileCount } from './model'
import { ACCEPT, type UploadRow } from '../../../lib/order-draft/view/files'
// ---- end F-CP-151
// ---- F-CP-154 (customer page plan C5; 12 §2 parts 1, 4, 6; B-CP-075, B-CP-076): lines of every kind, the People and sizes roster,
// "Your price" — every write a draft command at the draft's version; "Your price" only from a price holder (the grain filter refuses it
// from anyone else: the page never sends the key without the grain).
import { changeCustomLine, type CustomLineFields, type DraftChoice } from './api'
import { customLinesOf, draftFilesOf, lineCountOf, ownPriceWriteOf, personBody, personChanges, personDraftOf, personProblems, type PersonDraft } from './model'
// ---- od-w1.2 (THE SIMPLE ORDER START R1): the mail and the products table — the shared part's rows, windows and words.
import { TYPING_PAUSE_MS, changedByOf, choicesTyped, draftMailName, draftViewOf, filesAddHeld, HEADER_FIELDS, optionHeld, productRowsOf, uploadsOpenOf } from '../../../lib/order-draft/model'
import type { SavedBy } from '../../../lib/order-draft/schema'
import { piecesOpenOf, type PiecesMode } from '../../../lib/order-draft/view/RowWindows'
import { CUSTOM_LINE_LIMITS } from '@nexus/factory-domain/sales/portal-ordering/rules'
// ---- end F-CP-154

/**
 * `/p/<party>/orders/new?draft=<id>&way=pick|reorder|upload&styles=&reorder=&line=` for a customer (B-W2b-194, SCR-185, on
 * B-W2b-190's API; design portal.customer.neworder). Without a draft: the three ways in and the drafts to continue; a way
 * makes a DRAFT on the server and the address keeps it (`?draft=`). With a draft: the header saves on leaving a field
 * (PATCH with the draft's version: SaveStatus), a line's sizes and note on leaving the line (PUT), a colour at once, a line
 * out with Undo; Add styles (the picker: styles, then their size grids → POST …/lines), Reorder (past orders → one order's
 * lines with their differences → POST …/reorder), Upload (the template, the dry run, then "Add N rows" → POST …/upload with
 * `apply`); Send is held while the draft has problems ("2 problems — Show me"), saves what was typed first, then POST
 * …/send → the EndState. Writes run one after another (each takes the version the last one left), each with ONE
 * Idempotency-Key per body. No partner live event names an order request: the draft is read again when the tab comes back
 * or the live channel reconnects, and typed work is never overwritten ("it changed elsewhere — read it again").
 *
 * F-CP-150 (customer page plan C5, D9–D11): the ONE draft order. A draft is kept with portal.orderDrafts.edit (the brand's Buyer
 * and Designer; the Admin follows): its Designer starts and fills it without prices, and reads Send held with the names of who may
 * order (the API's `may`); Reorder a past order needs an access that shows orders. The draft's conversation is docked beside it
 * from its first save (`PortalOrderRequest`; the factory reads the draft and may answer there) and stays once it is sent. A 409
 * keeps what was typed and says who changed the draft when the API names them (B-CP-075).
 */
export function CustomerNewOrderPage() {
  return (
    <WithMessages namespaces={[NS, DRAFT_NS /* od-w1.1: the draft order's own words */, 'ds-words', 'lists', 'portal-account', COMPOSE_NS /* F-CP-151: a file's refusal words */]}>
      <NewOrderContainer />
    </WithMessages>
  )
}

type Load = 'loading' | 'error' | 'missing' | 'ready'
type Async<T> = { state: 'loading' | 'error' | 'ready'; value: T }
interface SentInfo {
  customerRef: string | null
  lines: number
  pieces: number
  net: string | null
  currency: string
  seesPrices: boolean
}
type PickerState = Omit<PickerModel, 'onDraft' | 'prefix' | 'writeHeld'>
// od-w1.2 (R1): a row's Pieces window (what is typed until Save) and its Options window ("Add an option" as typed); a person's window.
interface PiecesState {
  rowId: string
  mode: PiecesMode
  total: string
  cells: Record<string, number>
  /** Something was typed in it (leaving the page asks first). */
  typed?: boolean
  busy: boolean
  /** A refusal or a problem, in words. */
  failed: string | null
}
interface OptionsState {
  rowId: string
  topic: string
  typed: string
  busy: boolean
  failed: string | null
}
interface PersonDialogState {
  lineId: string
  personId: string | null
  draft: PersonDraft
  /** Something was typed in it (leaving the page asks first). */
  typed?: boolean
  showProblems: boolean
  busy: boolean
  failed: string | null
}
type ReorderState = Omit<ReorderModel, 'currency' | 'writeHeld'>
interface AddressState {
  draft: AddressDraft
  showProblems: boolean
  busy: boolean
  failed: string | null
  /** The API's refusal at a field (its issue path), in our words (keys of this catalogue). */
  refused: Partial<Record<keyof AddressDraft, string>>
}

const ADDRESS_FIELDS: readonly (keyof AddressDraft)[] = ['name', 'line1', 'line2', 'postalCode', 'city', 'province', 'country', 'contactName', 'phone', 'deliveryNotes']

/** The fields an address refusal names (`body/province` → province), each with our words. */
function refusedFields(error: unknown): Partial<Record<keyof AddressDraft, string>> {
  const out: Partial<Record<keyof AddressDraft, string>> = {}
  if (!isApiError(error)) return out
  for (const issue of error.issues) {
    const path = issuePath(issue).replace(/^body[/.]/, '')
    const field = ADDRESS_FIELDS.find((name) => name === path)
    if (field) out[field] = field === 'province' ? 'address.refused.province' : 'address.refused.field'
  }
  return out
}

const kindOf = (error: unknown): string | null => (isApiError(error) ? error.kind : null)
const NO_REORDER: ReorderState = { q: '', orders: { state: 'loading', rows: [] }, order: null, selected: [], colours: {}, busy: false }

function NewOrderContainer() {
  const frame = usePortalFrame()
  const api = usePortalApi()
  // od-w1.1: the ONE draft order's commands through the portal's port (the office gives the same commands on its own routes).
  const port = useMemo(() => portalDraftPort(api), [api])
  const router = useRouter()
  const search = useSearchParams()
  const words = useOrderingWords()
  const { t, locale } = words
  // od-w1.1: the ONE draft order's own words (its title, a file cap, a line with no piece) are the shared part's catalogue.
  const dw = useDraftWords()
  const offline = useOffline()
  const can = useCallback((permission: string) => frame.me.permissions.includes(permission), [frame.me.permissions])
  // F-CP-150 (D11): the draft is kept with portal.orderDrafts.edit; sending and reordering stay with who may order.
  const allowed = frame.kinds.includes('CUSTOMER') && can('portal.orderDrafts.edit')
  const mayOrder = can('portal.orderRequests.manage')
  const seesOrders = can('portal.salesOrders.view')
  const preview = frame.me.preview
  const draftId = search?.get('draft') ?? null
  const wayParam = search?.get('way')
  const way: Way | null = isWay(wayParam) ? wayParam : null
  const stylesParam = stylesOf(search?.get('styles'))
  const reorderParam = search?.get('reorder') ?? null
  const lineParam = search?.get('line') ?? null
  const today = useMemo(() => todayIn(), [])
  const admins = (frame.access?.admins ?? []).map((admin) => admin.displayName)

  // ── state ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  const [drafts, setDrafts] = useState<Async<DraftRow[]>>({ state: 'loading', value: [] })
  const [load, setLoad] = useState<Load>('loading')
  const [record, setRecord] = useState<DraftRecord | null>(null)
  const [header, setHeader] = useState<HeaderDraft>(headerDraftOf(null))
  const [headerErrors, setHeaderErrors] = useState<Partial<Record<HeaderField, string>>>({})
  const [save, setSave] = useState<SaveStatusState>({ kind: 'idle' })
  const [saving, setSaving] = useState<string[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [notice, setNotice] = useState<{ lines: string[]; undo: DraftLine | null } | null>(null)
  const [sent, setSent] = useState<SentInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [reorder, setReorder] = useState<ReorderState>(NO_REORDER)
  const [sheet, setSheet] = useState<SheetState>({ state: 'idle' })
  const [picker, setPicker] = useState<PickerState | null>(null)
  const [address, setAddress] = useState<AddressState | null>(null)
  const [discard, setDiscard] = useState<{ busy: boolean; failed: string | null } | null>(null)
  const [offlineSince, setOfflineSince] = useState<string | null>(null)
  // ---- F-CP-150: who changed the draft meanwhile (a 409's re-read, once the API names them), and who may send it.
  const [staleBy, setStaleBy] = useState<SavedBy | null>(null)
  const [orderers, setOrderers] = useState<string[] | null>(null)
  // ---- end F-CP-150
  const [uploads, setUploads] = useState<UploadRow[]>([]) // F-CP-151: files going up now, or that did not go
  // ---- F-CP-154: a person's window, "Your price" typed and not saved yet.
  const [personDialog, setPersonDialog] = useState<PersonDialogState | null>(null)
  const [ownPrices, setOwnPrices] = useState<Record<string, string>>({})
  const [ownPriceProblems, setOwnPriceProblems] = useState<Record<string, string>>({})
  // ---- od-w1.2 (R1): the row "Add a product" drew (saved on its first input), the styles the Product cell offers, a row's windows.
  const [pending, setPending] = useState(false)
  const [styles, setStyles] = useState<{ id: string; code: string; name: string }[] | null>(null)
  const [piecesWin, setPiecesWin] = useState<PiecesState | null>(null)
  const [optionsWin, setOptionsWin] = useState<OptionsState | null>(null)
  const [rowFilesId, setRowFilesId] = useState<string | null>(null)
  const ownPricesRef = useRef(ownPrices)
  ownPricesRef.current = ownPrices
  // ---- end F-CP-154

  const recordRef = useRef<DraftRecord | null>(null)
  recordRef.current = record
  const headerRef = useRef(header)
  headerRef.current = header
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => (typingTimer.current ? clearTimeout(typingTimer.current) : undefined), [])
  const sheetFile = useRef<{ fileName: string; contentType: string; content: string } | null>(null)
  const handled = useRef<string | null>(null)

  /** One Idempotency-Key per write and body: a retry of the same body sends the same key. */
  const keys = useRef<Map<string, string>>(new Map())
  const keyFor = (name: string, body: unknown) => {
    const text = `${name}:${JSON.stringify(body)}`
    let key = keys.current.get(text)
    if (!key) {
      key = newIdempotencyKey()
      keys.current.set(text, key)
    }
    return key
  }

  /** Writes run one after another: each reads the version the last one left. */
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const enqueue = <T,>(work: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(work, work)
    queue.current = next.catch(() => undefined)
    return next
  }

  const facts = { preview, offline, busy: false }
  const held = writeHeld(facts)
  const heldWords = held ? t(held) : null

  /** What the draft holds becomes what the page shows (typed work is dropped only by a read the person asked for). */
  const startFrom = useCallback((next: DraftRecord) => {
    setHeader(headerDraftOf(next.request))
    setHeaderErrors({})
    setStale(false)
    setStaleBy(null) // F-CP-150
    setUploads([]) // F-CP-151
    // F-CP-154: "Your price" typed and its problems.
    setOwnPrices({})
    setOwnPriceProblems({})
  }, [])

  const apply = useCallback((next: DraftRecord) => {
    recordRef.current = next
    setRecord(next)
    setStale(false)
    setProblem(null)
  }, [])

  const refused = useCallback(
    (error: unknown) => {
      const kind = kindOf(error)
      setProblem(refusalOf(kind))
      if (kind !== 'conflict') return
      setStale(true)
      // F-CP-150: who changed it ("Changed by Marta Bianchi a moment ago") — read, never applied: what was typed stays.
      const id = recordRef.current?.request.id
      if (id)
        port.read(id)
          .then((next) => setStaleBy(changedByOf(next.request)))
          .catch(() => undefined)
    },
    [api],
  )

  // ── reads ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  const readDrafts = useCallback(() => {
    setDrafts((current) => ({ ...current, state: 'loading' }))
    fetchDrafts(api)
      .then((rows) => setDrafts({ state: 'ready', value: rows }))
      .catch(() => setDrafts({ state: 'error', value: [] }))
  }, [api])

  const read = useCallback(async () => {
    if (!draftId) return
    try {
      const next = await port.read(draftId)
      apply(next)
      startFrom(next)
      setLoad('ready')
    } catch (error) {
      setLoad(kindOf(error) === 'not_found' ? 'missing' : 'error')
    }
  }, [api, draftId, apply, startFrom])

  useEffect(() => {
    if (!allowed) return
    if (draftId) {
      // od-w1.2: the draft this page just made on its first input is already held — its address changes, nothing is read again.
      if (recordRef.current?.request.id === draftId) {
        setLoad('ready')
        return
      }
      setLoad('loading')
      setSent(null)
      void read()
    } else {
      setRecord(null)
      readDrafts()
    }
  }, [allowed, draftId, read, readDrafts])

  useEffect(() => {
    if (offline) setOfflineSince((since) => since ?? new Date().toISOString())
    else setOfflineSince(null)
  }, [offline])

  // ---- F-CP-150 (D11): a colleague who fills drafts but may not order reads who may send it (their names; else the admins).
  const maySend = record ? mayOf(record.request).send : true
  useEffect(() => {
    if (maySend || orderers !== null) return
    if (!can('portal.colleagues.view')) {
      setOrderers(whoMayOrder(null, frame.me.user.id, admins))
      return
    }
    fetchColleagues(api)
      .then((answer) => setOrderers(whoMayOrder(answer.people, answer.me, admins)))
      .catch(() => setOrderers(whoMayOrder(null, frame.me.user.id, admins)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maySend, orderers, api])
  // ---- end F-CP-150

  // ── od-w1.2 (R1): the first input makes the draft ──────────────────────────────────────────────────────────────────────
  // Nothing is required and there is no Start button: a subject typed, a message, a file dropped, a row filled or the first Add of
  // "Add from" makes the draft with what was typed (never an empty draft on a click), and the address keeps it (`?draft=`). Arriving
  // from the catalogue ("Add to order") or an order ("Reorder this line"), the newest draft takes the Add, else a new one.
  const arrived = stylesParam.length > 0 || reorderParam !== null
  const making = useRef<Promise<DraftRecord> | null>(null)
  const ensureDraft = useCallback(
    (first: { subject?: string | null; note?: string | null } = {}): Promise<DraftRecord> => {
      const current = recordRef.current
      if (current) return Promise.resolve(current)
      if (making.current) return making.current
      const made = (async () => {
        const existing = arrived ? (await fetchDrafts(api).catch(() => []))[0] : undefined
        const next = existing ? await port.read(existing.id) : await createDraft(api, { source: 'PICKER', ...first }, keyFor('create', { first, at: Date.now() }))
        apply(next)
        startFrom(next)
        setLoad('ready')
        router.replace(newOrderHref(frame.prefix, { draft: next.request.id, way }), { scroll: false })
        return next
      })()
      making.current = made
      made.catch(() => undefined).finally(() => {
        making.current = null
      })
      return made
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, port, apply, startFrom, router, frame.prefix, way, arrived],
  )

  // The styles the Product cell offers: the customer's catalogue, read once.
  useEffect(() => {
    if (!allowed || styles !== null) return
    fetchCatalogue(api, {})
      .then((read) => setStyles(read.styles.map((style) => ({ id: style.id, code: style.code, name: style.name }))))
      .catch(() => setStyles([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, api])

  // ── the header ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const saveHeader = useCallback(
    (field?: HeaderField): Promise<boolean> => {
      const current = recordRef.current
      const typed = headerRef.current
      // od-w1.2 (R2): the start's first words make the draft — the create carries the subject and the message as typed.
      if (!current) {
        const subject = typed.subject.trim()
        const note = typed.note.trim()
        if ((subject === '' && note === '') || writeHeld({ preview, offline, busy: false })) return Promise.resolve(true)
        setSave({ kind: 'saving' })
        return ensureDraft({ ...(subject !== '' ? { subject } : {}), ...(note !== '' ? { note } : {}) })
          .then((next) => {
            setSave({ kind: 'saved', at: next.request.updatedAt })
            return true
          })
          .catch((error: unknown) => {
            setSave({ kind: 'failed', reason: t(refusalOf(kindOf(error))) })
            refused(error)
            return false
          })
      }
      if (current.request.status !== 'DRAFT') return Promise.resolve(true)
      const fields: HeaderField[] = field ? [field] : HEADER_FIELDS
      const errors = Object.fromEntries(fields.flatMap((name) => {
        const key = headerProblem(name, typed, today)
        return key ? [[name, key]] : []
      })) as Partial<Record<HeaderField, string>>
      setHeaderErrors((before) => {
        const next = { ...before }
        for (const name of fields) delete next[name]
        return { ...next, ...errors }
      })
      const body = headerChanges(headerDraftOf(current.request), typed, field)
      for (const name of Object.keys(errors) as HeaderField[]) delete body[name]
      if (Object.keys(body).length === 0) return Promise.resolve(Object.keys(errors).length === 0)
      if (writeHeld({ preview, offline, busy: false })) return Promise.resolve(false)
      setSave({ kind: 'saving' })
      return enqueue(async () => {
        const version = recordRef.current!.request.version
        try {
          const next = await port.header(current.request.id, { version, ...body }, keyFor('head', { version, body }))
          apply(next)
          setSave({ kind: 'saved', at: next.request.updatedAt })
          return true
        } catch (error) {
          setSave({ kind: 'failed', reason: t(refusalOf(kindOf(error))) })
          refused(error)
          return false
        }
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, apply, refused, preview, offline, today, t, ensureDraft],
  )

  /** Everything typed goes to the server (before a send, or from the unsaved guard). */
  const flush = useCallback(async (): Promise<boolean> => {
    const results = [await saveHeader()]
    for (const lineId of Object.keys(ownPricesRef.current)) results.push(await saveOwnPriceRef.current(lineId)) // F-CP-154
    return results.every(Boolean)
  }, [saveHeader])

  const write = useCallback(
    async <T extends DraftRecord>(name: string, call: (version: number, key: string) => Promise<T>, onError?: (kind: string | null) => void): Promise<T | null> => {
      if (writeHeld({ preview, offline, busy: false })) return null
      setBusy(true)
      try {
        return await enqueue(async () => {
          const version = recordRef.current!.request.version
          const next = await call(version, keyFor(name, { version, at: name }))
          apply(next)
          return next
        })
      } catch (error) {
        if (onError) onError(kindOf(error))
        else refused(error)
        return null
      } finally {
        setBusy(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preview, offline, apply, refused],
  )

  const remove = async (lineId: string) => {
    const current = recordRef.current
    // F-CP-154: a described or made-to-measure line goes out the same way (its people with it); no Undo: its people would not come back.
    const custom = current ? customLinesOf(current.request).find((entry) => entry.id === lineId) : undefined
    if (current && custom) {
      const gone = await write(`remove:${lineId}`, (version, key) => port.removeLine(current.request.id, lineId, version, key))
      if (!gone) return
      setOwnPrices(({ [lineId]: _drop, ...rest }) => rest)
      setNotice({ lines: [t('draftPage.line.removed', { seq: custom.seq })], undo: null })
      return
    }
    const line = current?.request.lines.find((entry) => entry.id === lineId)
    if (!current || !line) return
    const next = await write(`remove:${lineId}`, (version, key) => port.removeLine(current.request.id, lineId, version, key))
    if (!next) return
    setOwnPrices(({ [lineId]: _drop, ...rest }) => rest)
    // A catalogue row comes back with Undo while it has its colour (a row whose colour is not decided yet goes without).
    setNotice({ lines: [t('notice.removed', { seq: line.seq, style: line.style.code, colour: line.colourway?.name ?? '' })], undo: line.colourway ? line : null })
  }

  const undo = async () => {
    const line = notice?.undo
    const current = recordRef.current
    if (!line || !current || !line.colourway) return
    const body: NewLine = { styleId: line.style.id, colourwayId: line.colourway.id, sizes: line.sizes.filter((row) => row.quantity > 0).map((row) => ({ size: row.size, quantity: row.quantity })), note: line.note }
    // F-CP-154: the customer's own price comes back with it (a price holder's line only).
    if (current.seesPrices && line.brandUnitPrice) body.brandUnitPrice = line.brandUnitPrice
    const next = await write(`undo:${line.id}`, (version, key) => addLines(api, current.request.id, { version, lines: [body] }, key))
    if (next) setNotice({ lines: [t('notice.back', { style: line.style.code, colour: line.colourway.name })], undo: null })
  }

  const takePrices = () => {
    const id = recordRef.current?.request.id
    if (id) void write('prices', (version, key) => takeTodaysPrices(api, id, version, key))
  }

  // ---- F-CP-154 (customer page plan C5; 12 §2 parts 1, 4, 6): a line in the customer's own words, its people, "Your price" ----------
  // ---- od-w1.2 (R3; 10-design-r1 § 3): the products table — every cell optional, each saved at once with the draft's version -------
  // A catalogue row writes its line (colour, size run, sizing, options); a row in the customer's words its custom line (words, style,
  // colour in words, total or by person, sizing, options). The row "Add a product" drew is saved by its first input (a new custom line).
  const rowOf = (rowId: string) => (recordRef.current ? productRowsOf(recordRef.current.request, locale).find((row) => row.id === rowId) : undefined)

  const writeRow = async (rowId: string | null, fields: CustomLineFields, onError?: (kind: string | null) => void): Promise<DraftRecord | null> => {
    if (writeHeld({ preview, offline, busy: false })) return null
    if (rowId === null) {
      const current = await ensureDraft().catch((error: unknown) => {
        refused(error)
        return null
      })
      if (!current) return null
      const kind = fields.sizing === 'MADE_TO_MEASURE' ? 'MADE_TO_MEASURE' : 'DESCRIBED'
      const next = await write(`row:new:${JSON.stringify(fields)}`, (version, key) => port.addCustomLine(current.request.id, { version, line: { kind, ...fields } }, key), onError)
      if (next) setPending(false)
      return next
    }
    const current = recordRef.current
    const row = rowOf(rowId)
    if (!current || !row) return null
    setSaving((ids) => [...ids, rowId])
    try {
      return row.catalogue
        ? await write(`row:${rowId}:${JSON.stringify(fields)}`, (version, key) => port.changeLine(current.request.id, rowId, { version, ...(fields.colourwayId ? { colourwayId: fields.colourwayId } : {}), ...(fields.sizes ? { sizes: fields.sizes } : {}), ...(fields.sizing !== undefined ? { sizing: fields.sizing } : {}), ...(fields.choices !== undefined ? { choices: fields.choices } : {}) }, key), onError)
        : await write(`row:${rowId}:${JSON.stringify(fields)}`, (version, key) => port.changeCustomLine(current.request.id, rowId, { version, ...fields }, key), onError)
    } finally {
      setSaving((ids) => ids.filter((id) => id !== rowId))
    }
  }

  const openPieces = (rowId: string) => {
    const row = rowOf(rowId)
    if (!row) return
    setPiecesWin({ rowId, ...piecesOpenOf(row), busy: false, failed: null }) // od-fx8 W-15: on what the row holds
  }

  const savePieces = async () => {
    const win = piecesWin
    const row = win ? rowOf(win.rowId) : undefined
    if (!win || !row || win.busy) return
    let fields: CustomLineFields | null = null
    if (win.mode === 'SIZES' && row.catalogue) fields = { sizes: sizesBody(row.offered, win.cells) }
    else if (win.mode === 'NONE') fields = row.catalogue ? { sizes: [] } : { byPerson: false, quantity: null, sizes: [] }
    else if (win.mode === 'PEOPLE') fields = row.pieces.mode === 'PEOPLE' || row.sizing === 'MADE_TO_MEASURE' ? null : { byPerson: true }
    else if (win.mode === 'TOTAL') {
      const text = win.total.trim()
      const total = /^\d+$/.test(text) ? Number(text) : Number.NaN
      if (text !== '' && (!Number.isInteger(total) || total < 1 || total > CUSTOM_LINE_LIMITS.total)) {
        setPiecesWin({ ...win, failed: dw.t('draftPage.customLine.problem.total') })
        return
      }
      fields = { byPerson: false, quantity: text === '' ? null : total, sizes: [] }
    }
    if (!fields) {
      setPiecesWin(null)
      return
    }
    setPiecesWin({ ...win, busy: true, failed: null })
    let failed: string | null = null
    const next = await writeRow(win.rowId, fields, (kind) => {
      failed = t(refusalOf(kind))
      if (kind === 'conflict') setStale(true)
    })
    if (next) setPiecesWin(null)
    else setPiecesWin((now) => (now ? { ...now, busy: false, failed: failed ?? t('refusal.other') } : now))
  }

  /** A row's options: a pick, a removal or a new option, written at once (names only; [] = none). */
  const writeChoices = async (rowId: string, choices: DraftChoice[]) => {
    setOptionsWin((now) => (now ? { ...now, busy: true, failed: null } : now))
    let failed: string | null = null
    const next = await writeRow(rowId, { choices }, (kind) => {
      failed = t(refusalOf(kind))
      if (kind === 'conflict') setStale(true)
    })
    setOptionsWin((now) => (now ? { ...now, busy: false, failed: next ? null : (failed ?? t('refusal.other')) } : now))
    return next !== null
  }

  const addOption = async () => {
    const win = optionsWin
    const row = win ? rowOf(win.rowId) : undefined
    if (!win || !row || optionHeld(row.choices, win.topic, win.typed)) return
    if (await writeChoices(row.id, [...row.choices, { topic: win.topic.trim(), options: choicesTyped(win.typed), picked: null }])) setOptionsWin((now) => (now ? { ...now, topic: '', typed: '' } : now))
  }

  const openPerson = (lineId: string, personId: string | null = null) => {
    const line = recordRef.current ? customLinesOf(recordRef.current.request).find((entry) => entry.id === lineId) : undefined
    if (!line) return
    const person = personId ? (line.people.find((entry) => entry.id === personId) ?? null) : null
    setPersonDialog({ lineId, personId: person?.id ?? null, draft: personDraftOf(person), showProblems: false, busy: false, failed: null })
  }

  const savePerson = async () => {
    const current = recordRef.current
    if (!current || !personDialog || personDialog.busy) return
    const sheets = draftFilesOf(current.request).sheets
    if (Object.keys(personProblems(personDialog.draft, sheets)).length > 0) {
      setPersonDialog({ ...personDialog, showProblems: true })
      return
    }
    const line = customLinesOf(current.request).find((entry) => entry.id === personDialog.lineId)
    const person = personDialog.personId ? line?.people.find((entry) => entry.id === personDialog.personId) : undefined
    const changes = person ? personChanges(person, personDialog.draft) : null
    if (!line || (changes && Object.keys(changes).length === 0)) {
      setPersonDialog(null)
      return
    }
    setPersonDialog({ ...personDialog, busy: true, failed: null })
    let failed: string | null = null
    const onError = (kind: string | null) => {
      failed = refusalOf(kind)
      if (kind === 'conflict') setStale(true)
    }
    const body = personBody(personDialog.draft)
    const next =
      person && changes
        ? await write(`person:${person.id}:${JSON.stringify(changes)}`, (version, key) => port.changePerson(current.request.id, line.id, person.id, { version, ...changes }, key), onError)
        : await write(`person:new:${line.id}:${JSON.stringify(body)}`, (version, key) => port.addPeople(current.request.id, line.id, { version, people: [body] }, key), onError)
    if (next) setPersonDialog(null)
    else setPersonDialog((now) => (now ? { ...now, busy: false, failed: failed ?? 'refusal.other' } : now))
  }

  const removePersonRow = (lineId: string, personId: string) => {
    const id = recordRef.current?.request.id
    if (id) void write(`removePerson:${personId}`, (version, key) => port.removePerson(id, lineId, personId, version, key))
  }

  /** "Your price" of a line, saved on leaving its cell (catalogue or custom line) — only a price holder's, only what changed. */
  const saveOwnPrice = useCallback(
    async (lineId: string): Promise<boolean> => {
      const current = recordRef.current
      const typed = ownPricesRef.current[lineId]
      if (!current || typed === undefined) return true
      const wanted = ownPriceWriteOf(current, lineId, typed)
      if (wanted && 'problem' in wanted) {
        setOwnPriceProblems((now) => ({ ...now, [lineId]: wanted.problem }))
        return false
      }
      setOwnPriceProblems(({ [lineId]: _drop, ...rest }) => rest)
      if (wanted === null) {
        setOwnPrices(({ [lineId]: _drop, ...rest }) => rest)
        return true
      }
      if (writeHeld({ preview, offline, busy: false })) return false
      setSave({ kind: 'saving' })
      return enqueue(async () => {
        const version = recordRef.current!.request.version
        try {
          const key = keyFor('ownPrice', { lineId, version, value: wanted.value })
          const body = { version, brandUnitPrice: wanted.value }
          const next = wanted.lineKind === 'CATALOGUE' ? await changeLine(api, current.request.id, lineId, body, key) : await changeCustomLine(api, current.request.id, lineId, body, key)
          apply(next)
          // What was typed since this save started stays typed.
          setOwnPrices(({ [lineId]: now, ...rest }) => (now !== undefined && now !== typed ? { ...rest, [lineId]: now } : rest))
          setSave({ kind: 'saved', at: next.request.updatedAt })
          return true
        } catch (error) {
          setSave({ kind: 'failed', reason: t(refusalOf(kindOf(error))) })
          refused(error)
          return false
        }
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, apply, refused, preview, offline, t],
  )
  const saveOwnPriceRef = useRef(saveOwnPrice)
  saveOwnPriceRef.current = saveOwnPrice
  // ---- end F-CP-154

  // ── the picker ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const loadDetail = useCallback(
    (styleId: string) => {
      setPicker((current) => (current ? { ...current, details: { ...current.details, [styleId]: { state: 'loading', detail: null } } } : current))
      fetchStyle(api, styleId)
        .then((detail) => setPicker((current) => (current ? { ...current, details: { ...current.details, [styleId]: { state: 'ready', detail } } } : current)))
        .catch(() => setPicker((current) => (current ? { ...current, details: { ...current.details, [styleId]: { state: 'error', detail: null } } } : current)))
    },
    [api],
  )

  const openPicker = useCallback(
    (styles: readonly string[] = []) => {
      setPicker({ step: styles.length > 0 ? 'sizes' : 'styles', q: '', category: null, ppe: null, catalogue: { state: 'loading', read: null }, selected: [...styles], details: {}, cells: {}, busy: false, problem: null })
      fetchCatalogue(api, {})
        .then((read) => setPicker((current) => (current ? { ...current, catalogue: { state: 'ready', read } } : current)))
        .catch(() => setPicker((current) => (current ? { ...current, catalogue: { state: 'error', read: null } } : current)))
      for (const styleId of styles) loadDetail(styleId)
    },
    [api, loadDetail],
  )

  const onDraft = useMemo(() => Object.fromEntries((record?.request.lines ?? []).flatMap((line) => (line.colourway ? [[`${line.style.id}|${line.colourway.id}`, line.seq]] : []))), [record])

  const addFromPicker = async () => {
    if (!picker || picker.busy) return
    const lines: NewLine[] = []
    for (const styleId of picker.selected) {
      const detail = picker.details[styleId]?.detail
      for (const [colourwayId, typed] of Object.entries(picker.cells[styleId] ?? {})) {
        if (onDraft[`${styleId}|${colourwayId}`] !== undefined || piecesOfCells(typed) === 0) continue
        const colourway = detail?.style.colourways.find((entry) => entry.id === colourwayId)
        lines.push({ styleId, colourwayId, sizes: sizesBody(colourway ? colourway.sizes.map((row) => row.size) : Object.keys(typed), typed) })
      }
    }
    if (lines.length === 0) return
    setPicker({ ...picker, busy: true, problem: null })
    // od-w1.2: the first Add makes the draft (never the click that opened the window).
    const current = await ensureDraft().catch(() => null)
    if (!current) {
      setPicker((now) => (now ? { ...now, busy: false, problem: 'refusal.other' } : now))
      return
    }
    let failed: string | null = null
    const next = await write(`pick:${JSON.stringify(lines)}`, (version, key) => addLines(api, current.request.id, { version, lines }, key), (kind) => {
      failed = kind === 'invalid' ? 'picker.refused' : refusalOf(kind)
      if (kind === 'conflict') setStale(true)
    })
    if (next) {
      setPicker(null)
      setNotice({ lines: [t('done.added', { count: lines.length })], undo: null })
    } else setPicker((now) => (now ? { ...now, busy: false, problem: failed ?? 'refusal.other' } : now))
  }

  // ── reorder ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const readPastOrders = useCallback(
    (q: string) => {
      setReorder((current) => ({ ...current, q, orders: { state: 'loading', rows: current.orders.rows } }))
      fetchPastOrders(api, q)
        .then((rows) => setReorder((current) => ({ ...current, orders: { state: 'ready', rows } })))
        .catch(() => setReorder((current) => ({ ...current, orders: { state: 'error', rows: [] } })))
    },
    [api],
  )

  const openPastOrder = useCallback(
    (orderId: string, only: string | null = null) => {
      setReorder((current) => ({ ...current, order: { id: orderId, state: 'loading', read: null }, selected: [], colours: {} }))
      fetchPastOrder(api, orderId)
        .then((read) => setReorder((current) => (current.order?.id === orderId ? { ...current, order: { id: orderId, state: 'ready', read }, selected: reorderStart(read.lines, only) } : current)))
        .catch(() => setReorder((current) => (current.order?.id === orderId ? { ...current, order: { id: orderId, state: 'error', read: null } } : current)))
    },
    [api],
  )

  const addReorder = async () => {
    const order = reorder.order?.read
    if (!order || reorder.busy) return
    const lines = reorderBody(order.lines, reorder.selected, reorder.colours)
    if (lines.length === 0) return
    setReorder((now) => ({ ...now, busy: true }))
    // od-w1.2: the first Add makes the draft.
    const current = await ensureDraft().catch((error: unknown) => {
      refused(error)
      return null
    })
    if (!current) {
      setReorder((now) => ({ ...now, busy: false }))
      return
    }
    const answer = await write(`reorder:${order.order.id}:${JSON.stringify(lines)}`, (version, key) => reorderInto(api, current.request.id, { version, orderId: order.order.id, lines }, key))
    setReorder((now) => ({ ...now, busy: false, selected: [] }))
    if (answer) setNotice({ lines: mergeWords(answer, answer, t), undo: null })
  }

  // ── upload ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  const readFile = async (file: File) => {
    if (writeHeld({ preview, offline, busy: false })) return
    if (file.size > SHEET_MAX_BYTES) {
      setSheet({ state: 'failed', fileName: file.name, problem: 'upload.tooBig' })
      return
    }
    setSheet({ state: 'reading', fileName: file.name })
    try {
      const content = await fileContent(file)
      const contentType = file.type || (file.name.toLowerCase().endsWith('.csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      sheetFile.current = { fileName: file.name, contentType, content }
      // od-w1.2: a sheet chosen is an input — the draft is made for its dry run (it reads against the draft).
      const current = await ensureDraft()
      const answer = await uploadSheet(api, current.request.id, { fileName: file.name, contentType, content, numberFormat: locale, locale, apply: false }, keyFor('sheet', { fileName: file.name, size: content.length, apply: false }))
      setSheet({ state: 'read', fileName: file.name, answer, applying: false })
    } catch (error) {
      const kind = kindOf(error)
      setSheet({ state: 'failed', fileName: file.name, problem: kind === 'invalid' ? 'upload.unreadable' : refusalOf(kind) })
    }
  }

  const applySheet = async () => {
    const current = recordRef.current
    const file = sheetFile.current
    if (!current || !file || sheet.state !== 'read' || sheet.applying || sheet.answer.dryRun.ready === 0) return
    setSheet({ ...sheet, applying: true })
    try {
      const answer = await enqueue(async () => {
        const version = recordRef.current!.request.version
        return uploadSheet(api, current.request.id, { ...file, numberFormat: locale, locale, apply: true, version }, keyFor('sheet', { fileName: file.fileName, size: file.content.length, apply: true, version }))
      })
      if (answer.applied && answer.record) {
        apply(answer.record)
        setNotice({ lines: mergeWords(answer, answer.record, t), undo: null })
        setSheet({ state: 'idle' })
        sheetFile.current = null
      } else setSheet({ state: 'read', fileName: file.fileName, answer, applying: false })
    } catch (error) {
      setSheet((now) => (now.state === 'read' ? { ...now, applying: false } : now))
      refused(error)
    }
  }

  // ── the address ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const saveAddress = async () => {
    const current = recordRef.current
    if (!address || !current || address.busy) return
    const problems = addressProblems(address.draft)
    if (Object.keys(problems).length > 0) {
      setAddress({ ...address, showProblems: true })
      return
    }
    setAddress({ ...address, busy: true, failed: null })
    try {
      const body = addressBody(address.draft)
      const added = await addAddress(api, body, keyFor('address', body))
      setAddress(null)
      setHeader((now) => ({ ...now, shipToAddressId: added.address.id }))
      headerRef.current = { ...headerRef.current, shipToAddressId: added.address.id }
      await saveHeader('shipToAddressId')
    } catch (error) {
      const fields = refusedFields(error)
      setAddress((now) => (now ? { ...now, busy: false, refused: fields, failed: kindOf(error) === 'invalid' ? (Object.keys(fields).length > 0 ? null : 'address.failed') : refusalOf(kindOf(error)) } : now))
    }
  }

  // ── discard, send ───────────────────────────────────────────────────────────────────────────────────────────────────
  const confirmDiscard = async () => {
    const current = recordRef.current
    if (!current || !discard || discard.busy) return
    setDiscard({ busy: true, failed: null })
    try {
      await enqueue(() => discardDraft(api, current.request.id, recordRef.current!.request.version, keyFor('discard', { id: current.request.id })))
      setDiscard(null)
      setHeader(headerDraftOf(current.request))
      router.replace(newOrderHref(frame.prefix))
    } catch (error) {
      setDiscard({ busy: false, failed: refusalOf(kindOf(error)) })
    }
  }

  const send = async () => {
    const current = recordRef.current
    if (!current || busy) return
    if (!(await flush())) return
    const now = recordRef.current!
    if (draftSendHeld(now.request, { preview, offline, busy: false }, orderers ?? [])) return // F-CP-150; od-w1.2: only an invalid value holds it
    setBusy(true)
    try {
      const answer = await enqueue(() => {
        const version = recordRef.current!.request.version
        return sendDraft(api, now.request.id, version, keyFor('send', { id: now.request.id, version }))
      })
      apply(answer)
      setSent({
        customerRef: answer.request.customerRef,
        lines: answer.request.summary.lines,
        pieces: answer.request.summary.pieces,
        net: answer.request.summary.net ?? null,
        currency: answer.request.currency,
        seesPrices: answer.seesPrices,
      })
      frame.refreshTasks()
    } catch (error) {
      refused(error)
      if (kindOf(error) === 'conflict') void read()
    } finally {
      setBusy(false)
    }
  }

  // ── the way's panel, the address's own asks ─────────────────────────────────────────────────────────────────────────
  const phase: NewOrderPhase = !draftId ? 'start' : sent ? 'sent' : record && record.request.status !== 'DRAFT' ? 'closed' : 'draft'

  useEffect(() => {
    if (phase !== 'draft' && phase !== 'start') return
    const marker = `${record?.request.id ?? 'start'}|${way}|${stylesParam.join(',')}|${reorderParam ?? ''}`
    if (handled.current === marker) return
    handled.current = marker
    // F-CP-150 (D11): past orders only for one whose access shows orders (the way is held for anyone else).
    if (mayOrder && way === 'reorder' && reorder.orders.state === 'loading' && reorder.orders.rows.length === 0) readPastOrders('')
    if (mayOrder && way === 'reorder' && reorderParam) openPastOrder(reorderParam, lineParam)
    // The catalogue's "Add to order": the picker opens with its styles (the draft is made at the first Add).
    if (stylesParam.length > 0) openPicker(stylesParam)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, record?.request.id, way, stylesParam.join(','), reorderParam])

  /** "Add from: catalogue · a past order · a sheet": the window or the panel opens; nothing is made until the first Add. */
  const chooseWay = (next: Way) => {
    if (next === 'reorder' && !mayOrder) return // F-CP-150 (D11): held with why on the page
    if (next === 'pick') {
      openPicker()
      return
    }
    router.replace(newOrderHref(frame.prefix, { draft: recordRef.current?.request.id ?? null, way: next }), { scroll: false })
  }

  // ── live: read again when the tab comes back (typed work is never overwritten) ──────────────────────────────────────
  const dirty =
    (phase === 'draft' || phase === 'start') &&
    (headerDirty(headerDraftOf(record?.request ?? null), header) ||
      (picker !== null && pickerLineCount({ ...picker, onDraft }) > 0) ||
      sheet.state === 'read' ||
      (address !== null && addressTyped(address.draft)) ||
      uploads.some((row) => row.state === 'uploading') || // F-CP-151: never leave half way through an upload
      Object.keys(ownPrices).length > 0 || // F-CP-154: "Your price" typed, not saved yet
      piecesWin?.typed === true || // od-w1.2: a row's Pieces or Options window typed, not saved yet
      (optionsWin !== null && (optionsWin.topic.trim() !== '' || optionsWin.typed.trim() !== '')) ||
      personDialog?.typed === true)
  const recheck = useCallback(() => {
    const current = recordRef.current
    if (!current || current.request.status !== 'DRAFT') return
    port.read(current.request.id)
      .then((next) => {
        if (next.request.version === recordRef.current?.request.version) return
        if (dirty) setStale(true)
        else {
          apply(next)
          startFrom(next)
        }
      })
      .catch(() => undefined)
  }, [port, apply, startFrom, dirty])
  // od-w1.3 (W3): the office writes this draft too — its live `draft_changed` (ids only) reads the draft again; this page's own save
  // comes back as an echo and is skipped by version (a version the page already holds changes nothing; typed work is never overwritten).
  const onLiveChange = useCallback(
    (change: { type: string; fields: Record<string, unknown> }) => {
      const current = recordRef.current
      if (change.type !== 'portal_order_request.draft_changed' || !current || change.fields.requestId !== current.request.id) return
      if (typeof change.fields.version === 'number' && change.fields.version <= current.request.version) return
      recheck()
    },
    [recheck],
  )
  usePortalLive({ onChange: onLiveChange, onReconnect: recheck }, allowed && phase === 'draft')
  useEffect(() => {
    const onVisible = () => (document.visibilityState === 'visible' ? recheck() : undefined)
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [recheck])
  usePortalUnsaved('neworder', { dirty, what: t('unsaved.what'), save: flush })

  // ---- F-CP-151 (B-CP-072; D14): a part's files. Each is checked as the API will (kinds and sizes, never a page or a script),
  // announced, its bytes PUT to the store, completed (held for the virus scan where one runs); then the draft is read again for its
  // files (a file moves no version of the draft: a newer version meanwhile goes through the usual re-read). On live the cards show
  // the e-mail way instead (the API's `uploads`), so nothing is dropped here.
  const tc = useT(COMPOSE_NS)
  const failureOf = useCallback(
    (error: unknown): string => {
      if (error instanceof StoreError) return tc('files.failed.store')
      if (!isApiError(error)) return tc('files.failed.network')
      // The API's own words in the person's language (refusal/TOO_MANY_FILES, refusal/NO_UPLOAD).
      const refusal = error.issues.find((issue) => issuePath(issue).replace(/\./g, '/').startsWith('refusal/'))
      if (refusal?.message) return refusal.message
      return t(error.kind === 'unavailable' ? 'draftPage.files.notNow' : refusalOf(error.kind))
    },
    [tc, t],
  )
  const refreshFiles = useCallback(async () => {
    const current = recordRef.current
    if (!current) return
    try {
      const next = await port.read(current.request.id)
      if (next.request.version === recordRef.current?.request.version) apply(next)
      else recheck()
    } catch {
      // The next read (the tab coming back, the live channel) shows them.
    }
  }, [api, apply, recheck])
  const addFiles = async (part: DraftFilePart, list: readonly File[], lineId: string | null = null /* F-CP-154: a sheet onto one line */) => {
    if (list.length === 0 || writeHeld({ preview, offline, busy: false })) return
    // od-w1.2 (R2): a file dropped on the start's Attachments is a first input — it makes the draft.
    const current = await ensureDraft().catch((error: unknown) => {
      refused(error)
      return null
    })
    if (!current) return
    let room = DRAFT_FILES_MAX - draftFileCount(current.request)
    for (const file of list) {
      const key = newIdempotencyKey()
      const contentType = contentTypeOf(file).split(';')[0]!.trim().toLowerCase()
      const problem = room <= 0 ? { words: dw.t('draftPage.files.full') } : (() => {
        const found = heldProblem({ name: file.name, type: contentType, size: file.size })
        return found ? { words: tc(found.key, found.params) } : null
      })()
      if (problem) {
        setUploads((rows) => [...rows, { key, part, lineId, name: file.name, state: 'failed', failure: problem.words }])
        continue
      }
      room -= 1
      setUploads((rows) => [...rows, { key, part, lineId, name: file.name, state: 'uploading' }])
      try {
        const bytes = await file.arrayBuffer()
        const { file: announced, upload } = await port.announceFile(current.request.id, { part, ...(lineId ? { lineId } : {}), originalName: file.name, contentType, sizeBytes: file.size, sha256: await sha256Hex(bytes) }, key)
        await putToStore(upload, new Blob([bytes], { type: contentType }))
        await port.completeFile(current.request.id, announced.id, newIdempotencyKey())
        setUploads((rows) => rows.filter((row) => row.key !== key))
      } catch (error) {
        setUploads((rows) => rows.map((row) => (row.key === key ? { ...row, state: 'failed' as const, failure: failureOf(error) } : row)))
      }
    }
    await refreshFiles()
  }
  const removeFile = (file: DraftFile) => {
    const id = recordRef.current?.request.id
    if (id) void write(`removeFile:${file.id}:${file.version}`, (_version, key) => port.removeFile(id, file.id, file.version, key))
  }
  // ---- end F-CP-151

  // ── the band ────────────────────────────────────────────────────────────────────────────────────────────────────────
  // F-CP-150: held, never hidden — a Designer reads the names of who may order; Discard… held for a colleague who neither orders
  // nor started the draft.
  const sendHeldNow = record ? draftSendHeld(record.request, { preview, offline, busy: busy || saving.length > 0 }, orderers ?? []) : ({ key: 'held.busy' } as { key: string; count?: number; names?: string })
  const sendWords = sendHeldNow ? t(sendHeldNow.key, sendHeldNow.count !== undefined ? { count: sendHeldNow.count } : sendHeldNow.names !== undefined ? { names: sendHeldNow.names } : undefined) : null
  const discardKey = record ? draftDiscardHeld(record.request, { preview, offline, busy: false }) : held
  const discardWords = discardKey ? t(discardKey) : null
  const title = record ? draftTitleOf(record.request, dw.t, locale, words.day) : null // od-w1.2 (R2): the subject first
  const draftAsk = record && title ? { type: 'PortalOrderRequest', id: record.request.id, label: title } : null
  usePortalBand(
    allowed
      ? newOrderBandOf({
          words,
          phase,
          prefix: frame.prefix,
          template: templateHref(locale),
          customerRef: sent?.customerRef ?? record?.request.customerRef ?? null,
          discardHeld: discardWords,
          title, // F-CP-150 (od-w1.2: the subject, else row 1's product, else "Draft order {date}")
          ask: draftAsk, // F-CP-150
          onDiscard: () => setDiscard({ busy: false, failed: null }),
        })
      : { title: t('band.title') },
  )

  if (!allowed) return <NotInAccess admins={admins} homeHref={frame.prefix} />

  const addAddressHeld = !can('portal.addresses.manage') ? (admins.length > 0 ? t('head.addAddressAdmin', { names: admins.join(', ') }) : t('head.addAddressAdminNone')) : heldWords

  const piecesRow = piecesWin ? rowOf(piecesWin.rowId) : undefined
  const optionsRow = optionsWin ? rowOf(optionsWin.rowId) : undefined
  const filesRow = rowFilesId ? rowOf(rowFilesId) : undefined
  const piecesLine = piecesRow && record ? (customLinesOf(record.request).find((line) => line.id === piecesRow.id && line.byPerson) ?? null) : null
  const draftName = record ? draftMailName(record.request, dw.t) : ''
  const fileCap = record ? filesAddHeld(record.request, { preview: false, offline: false, busy: false }) : null

  return (
    <NewOrderView
      model={{
        state: draftId ? load : 'ready',
        phase,
        prefix: frame.prefix,
        today,
        start: { state: drafts.state, drafts: drafts.value },
        way,
        record,
        header,
        headerErrors,
        save,
        writeHeld: heldWords,
        addAddressHeld,
        reorder: way === 'reorder' && mayOrder ? { ...reorder, currency: record?.request.currency ?? 'EUR', writeHeld: heldWords } : null, // F-CP-150
        upload: way === 'upload' ? { sheet, templateHref: templateHref(locale), writeHeld: heldWords } : null,
        problem,
        stale,
        notice: notice ? { lines: notice.lines, undo: notice.undo !== null } : null,
        sendHeld: sendWords,
        sent,
        closed: record && record.request.status !== 'DRAFT' && !sent ? { status: record.request.status, salesOrder: record.request.salesOrder ? { id: record.request.salesOrder.id } : null } : null, // B-TH-304: no office number
        offlineSince,
        pending,
        styles,
        saving,
        uploads, // F-CP-151
        // ---- F-CP-154
        ownPrices,
        ownPriceProblems,
        // ---- end F-CP-154
        // ---- F-CP-150
        staleBy,
        seesOrders,
        mayOrder,
        // ---- end F-CP-150
        dialogs: {
          picker: picker ? { ...picker, onDraft, prefix: frame.prefix, writeHeld: heldWords } : null,
          address: address ? { ...address, problems: addressProblems(address.draft) } : null,
          discard: discard && record ? { ...discard, lines: lineCountOf(record.request) } : null, // F-CP-154: lines of every kind
          person: (() => {
            if (!personDialog || !record) return null
            const line = customLinesOf(record.request).find((entry) => entry.id === personDialog.lineId)
            if (!line) return null
            const sheets = draftFilesOf(record.request).sheets
            return {
              mode: personDialog.personId ? ('change' as const) : ('add' as const),
              seq: line.seq,
              name: personDialog.personId ? (line.people.find((entry) => entry.id === personDialog.personId)?.name ?? null) : null,
              draft: personDialog.draft,
              problems: personProblems(personDialog.draft, sheets),
              showProblems: personDialog.showProblems,
              sheets,
              busy: personDialog.busy,
              failed: personDialog.failed,
            }
          })(),
          // ---- od-w1.2: a row's windows.
          pieces:
            piecesWin && piecesRow && record
              ? {
                  row: piecesRow,
                  mode: piecesWin.mode,
                  total: piecesWin.total,
                  cells: piecesWin.cells,
                  roster: { draft: draftViewOf(record), writeHeld: heldWords, uploadsOpen: uploadsOpenOf(record.request), addHeld: fileCap ? dw.t(fileCap) : null, draftName },
                  rosterLine: piecesLine,
                  busy: piecesWin.busy,
                  failed: piecesWin.failed,
                  writeHeld: heldWords,
                }
              : null,
          options:
            optionsWin && optionsRow
              ? { row: optionsRow, topic: optionsWin.topic, typed: optionsWin.typed, addHeld: optionHeld(optionsRow.choices, optionsWin.topic, optionsWin.typed), busy: optionsWin.busy, failed: optionsWin.failed, writeHeld: heldWords }
              : null,
          rowFiles:
            filesRow && record
              ? {
                  row: filesRow,
                  files: {
                    files: filesRow.files,
                    uploading: uploads.filter((row) => row.lineId === filesRow.id),
                    open: uploadsOpenOf(record.request),
                    addHeld: heldWords ?? (fileCap ? dw.t(fileCap) : null),
                    removeHeld: heldWords,
                    draftName,
                    dropKey: 'mail.drop',
                    accept: filesRow.sizing === 'MADE_TO_MEASURE' ? ACCEPT.SHEET : ACCEPT.REFERENCE,
                  },
                }
              : null,
        },
      }}
      actions={{
        onWay: chooseWay,
        onContinue: (id) => router.push(newOrderHref(frame.prefix, { draft: id })),
        onRetryStart: readDrafts,
        onHeader: (field, value) => {
          setHeader((now) => ({ ...now, [field]: value }))
          headerRef.current = { ...headerRef.current, [field]: value }
          // od-fx12: the draft saves as you type — after a short pause (the first words make the draft), and again on leaving the box.
          if (typingTimer.current) clearTimeout(typingTimer.current)
          typingTimer.current = setTimeout(() => {
            typingTimer.current = null
            void saveHeader(field)
          }, TYPING_PAUSE_MS)
        },
        onHeaderLeave: (field) => void saveHeader(field),
        onAddAddress: () => setAddress({ draft: EMPTY_ADDRESS, showProblems: false, busy: false, failed: null, refused: {} }),
        onSend: () => void send(),
        onTakePrices: takePrices,
        onUndo: () => void undo(),
        onDismissNotice: () => setNotice(null),
        onReload: () => void read(),
        onRetry: () => {
          setLoad('loading')
          void read()
        },
        onRetrySave: () => void flush(),
        // ---- od-w1.2 (R2, R3): the mail's Attachments; the products table; a row's windows; a Still open item.
        files: {
          onFiles: (list) => void addFiles('REFERENCE', list, null),
          onRemove: removeFile,
          // od-w2.4: the Logo mark — the draft's version, one write (the artwork carry reads the logos).
          onLogo: (file, on) => {
            const id = recordRef.current?.request.id
            if (id) void write(`logo:${file.id}:${on}`, (version, key) => port.markFile(id, file.id, { version, part: on ? 'LOGO' : 'REFERENCE' }, key))
          },
        },
        table: {
          onProduct: (rowId, value) => void writeRow(rowId, 'styleId' in value ? { styleId: value.styleId } : { description: value.words === '' ? null : value.words }),
          onSizing: (rowId, sizing) => void writeRow(rowId, { sizing }),
          onColour: (rowId, value) => void writeRow(rowId, 'colourwayId' in value ? { colourwayId: value.colourwayId } : { colourText: value.words === '' ? null : value.words }),
          onPieces: openPieces,
          onOptions: (rowId) => setOptionsWin({ rowId, topic: '', typed: '', busy: false, failed: null }),
          onFiles: (rowId) => setRowFilesId(rowId),
          onRemove: (rowId) => void remove(rowId),
          onAdd: () => setPending(true),
          onDropPending: () => setPending(false),
        },
        pieces: {
          onMode: (mode) => setPiecesWin((now) => (now ? { ...now, mode, typed: true, failed: null } : now)),
          onTotal: (text) => setPiecesWin((now) => (now ? { ...now, total: text, typed: true, failed: null } : now)),
          onCells: (cells) => setPiecesWin((now) => (now ? { ...now, cells, typed: true } : now)),
          onSave: () => void savePieces(),
          onClose: () => setPiecesWin((now) => (now?.busy ? now : null)),
          // By person: the person's window takes the place of the Pieces window (one centred window at a time).
          people: {
            onAddPerson: (lineId) => {
              setPiecesWin(null)
              openPerson(lineId)
            },
            onChangePerson: (lineId, personId) => {
              setPiecesWin(null)
              openPerson(lineId, personId)
            },
            onRemovePerson: removePersonRow,
            onFiles: (part, list, lineId) => void addFiles(part, list, lineId ?? null),
          },
        },
        options: {
          onPick: (topic, picked) => {
            const row = optionsRow
            if (row) void writeChoices(row.id, row.choices.map((choice) => (choice.topic === topic ? { ...choice, picked } : choice)))
          },
          onRemove: (topic) => {
            const row = optionsRow
            if (row) void writeChoices(row.id, row.choices.filter((choice) => choice.topic !== topic))
          },
          onTopic: (text) => setOptionsWin((now) => (now ? { ...now, topic: text } : now)),
          onTyped: (text) => setOptionsWin((now) => (now ? { ...now, typed: text } : now)),
          onAdd: () => void addOption(),
          onClose: () => setOptionsWin(null),
        },
        rowFiles: {
          onFiles: (list) => (filesRow ? void addFiles(filesRow.sizing === 'MADE_TO_MEASURE' ? 'SHEET' : 'REFERENCE', list, filesRow.id) : undefined),
          onRemove: removeFile,
          onClose: () => setRowFilesId(null),
        },
        onStillOpen: ({ rowId }) => {
          const element = document.getElementById(rowId ? `row-${rowId}` : 'od-date')
          element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
          element?.querySelector<HTMLElement>('input, select, button')?.focus({ preventScroll: true })
        },
        reorder: {
          onSearch: (q) => readPastOrders(q),
          onOpenOrder: (orderId) => openPastOrder(orderId),
          onBack: () => setReorder((current) => ({ ...current, order: null, selected: [], colours: {} })),
          onSelect: (ids) => setReorder((current) => ({ ...current, selected: ids })),
          onColour: (orderLineId, colourwayId) =>
            setReorder((current) => ({
              ...current,
              colours: { ...current.colours, [orderLineId]: colourwayId },
              selected: colourwayId ? (current.selected.includes(orderLineId) ? current.selected : [...current.selected, orderLineId]) : current.selected.filter((id) => id !== orderLineId),
            })),
          onAdd: () => void addReorder(),
          onRetryOrders: () => readPastOrders(reorder.q),
          onRetryOrder: () => (reorder.order ? openPastOrder(reorder.order.id) : undefined),
        },
        upload: {
          onFile: (file) => void readFile(file),
          onApply: () => void applySheet(),
          onRefusedCsv: () => (sheet.state === 'read' && sheet.answer.dryRun.refusedCsv ? saveText(t('upload.refusedFile'), sheet.answer.dryRun.refusedCsv) : undefined),
          onOther: () => {
            sheetFile.current = null
            setSheet({ state: 'idle' })
          },
        },
        picker: {
          onSearch: (q) => setPicker((now) => (now ? { ...now, q } : now)),
          onFilter: (patch) => setPicker((now) => (now ? { ...now, ...patch } : now)),
          onToggle: (styleId) => setPicker((now) => (now ? { ...now, selected: now.selected.includes(styleId) ? now.selected.filter((id) => id !== styleId) : [...now.selected, styleId] } : now)),
          onNext: () => {
            if (!picker || picker.selected.length === 0) return
            setPicker({ ...picker, step: 'sizes' })
            for (const styleId of picker.selected) if (!picker.details[styleId] || picker.details[styleId]!.state === 'error') loadDetail(styleId)
          },
          onBack: () => setPicker((now) => (now ? { ...now, step: 'styles', problem: null } : now)),
          onCells: (styleId, next) => setPicker((now) => (now ? { ...now, cells: { ...now.cells, [styleId]: next } } : now)),
          onAdd: () => void addFromPicker(),
          onClose: () => setPicker(null),
          onRetry: () => openPicker(picker?.selected ?? []),
          onRetryStyle: loadDetail,
        },
        address: {
          onField: (field, value) => {
            setAddress((now) => {
              if (!now) return now
              const { [field]: _gone, ...refused } = now.refused
              return { ...now, draft: { ...now.draft, [field]: value }, failed: null, refused }
            })
          },
          onSave: () => void saveAddress(),
          onClose: () => setAddress((now) => (now?.busy ? now : null)),
        },
        discard: { onConfirm: () => void confirmDiscard(), onCancel: () => setDiscard((now) => (now?.busy ? now : null)) },
        // ---- F-CP-154: the roster's person window, "Your price".
        price: {
          onType: (lineId, text) => {
            setOwnPrices((now) => ({ ...now, [lineId]: text }))
            ownPricesRef.current = { ...ownPricesRef.current, [lineId]: text }
            setOwnPriceProblems(({ [lineId]: _drop, ...rest }) => rest)
          },
          onLeave: (lineId) => void saveOwnPrice(lineId),
        },
        person: {
          onField: (field, value) => setPersonDialog((now) => (now ? { ...now, draft: { ...now.draft, [field]: value }, failed: null, typed: true } : now)),
          onSave: () => void savePerson(),
          onClose: () => setPersonDialog((now) => (now?.busy ? now : null)),
        },
        // ---- end F-CP-154
      }}
    >
      {/* F-CP-150 (D10): the draft's ONE conversation, docked from its first save; it stays once the draft is sent. */}
      {record && draftId && phase !== 'start' ? <PortalThread type="PortalOrderRequest" id={record.request.id} /> : null}
    </NewOrderView>
  )
}
