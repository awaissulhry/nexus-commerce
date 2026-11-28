'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalFrame, usePortalLive, usePortalUnsaved } from '../../shell/frame'
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
  templateHref,
  uploadSheet,
  type DraftLine,
  type DraftRecord,
  type DraftRow,
  type NewLine,
} from './api'
import type { NewOrderPhase } from './band'
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
import type { ReorderModel } from './view/ReorderPanel'
import type { SheetState } from './view/UploadPanel'
import { NotInAccess } from './view/parts'
import { useOrderingWords } from './words'
import { DRAFT_NS, useDraftWords } from '../../../lib/order-draft/words'
// ---- F-CP-150 (customer page plan C5, D9–D11): the draft order page — its conversation docked, who may send, who changed it.
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
// ---- owb-po3 (design § 5zi B–E): the New order WINDOW over the orders page — the ONE lines table, columns of your own, the picture of
// the order, the after-Send state. The window is the shared part's (lib/order-draft/view/DraftWindow); the commands stay here.
import { recordSchema } from './api'
import { DraftWindow, type DraftWindowModel } from '../../../lib/order-draft/view/DraftWindow'
import { savedByWords, shipToOptions, stillOpenEntries } from '../../../lib/order-draft/model'
import { lineRowsOfDraft, modelFields, nextLineFields, ownColumnsOfRecord, piecesOfRows, type LinePrices, type ModelStyle, type NewDesignKind } from '../../../lib/order-lines/model'
import { ownColumnsPort } from '../../../lib/order-lines/api'
import type { OwnColumn, OwnValue } from '../../../lib/order-lines/schema'
import { OwnColumnsWindow } from '../../../lib/order-lines/own-columns/OwnColumnsWindow'
import { OrderPictureWindow } from '../../../lib/record-picture/OrderPictureWindow'
import { orderPicturePath, orderPictureSaver } from '../../../lib/record-picture/api'
import { pictureKindOf, type PictureChoice } from '../../../lib/record-picture/order-picture'
import { Button } from '@nexus/ui/primitives'
import { NewAddressDialog, StylePickerDialog } from './view/Dialogs'
import { ReorderPanel } from './view/ReorderPanel'
import { UploadPanel } from './view/UploadPanel'
import { OptionsWindow, PiecesWindow, RowFilesWindow } from '../../../lib/order-draft/view/RowWindows'
import { PersonDialog } from '../../../lib/order-draft/view/PeopleRoster'
import { closedOf, draftRowWords, reorderHeldKey } from './model'
// ---- end owb-po3

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
  /** owb-po3.4: the after-Send state of the window — its subject, the day wanted, the request (Open the order). */
  subject: string
  wanted: string | null
  requestId: string
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
  const [styles, setStyles] = useState<ModelStyle[] | null>(null)
  const [piecesWin, setPiecesWin] = useState<PiecesState | null>(null)
  const [optionsWin, setOptionsWin] = useState<OptionsState | null>(null)
  const [rowFilesId, setRowFilesId] = useState<string | null>(null)
  const ownPricesRef = useRef(ownPrices)
  ownPricesRef.current = ownPrices
  // ---- end F-CP-154
  // ---- owb-po3: "Columns of your own" (the customer's columns: null while read), the picture window, a line's refusal in words.
  const ownPort = useMemo(() => ownColumnsPort(api, 'portal'), [api])
  const [ownWin, setOwnWin] = useState<{ columns: OwnColumn[] | null; busy: boolean; refused: string | null } | null>(null)
  const [pictureOpen, setPictureOpen] = useState(false)
  const [lineRefusals, setLineRefusals] = useState<Record<string, string>>({})
  // ---- end owb-po3

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
    } else setRecord(null)
    // owb-po3.1: the window's head always says "Drafts n" (the customer's other drafts).
    readDrafts()
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
      // owb-po3: the Model cell's groups (own label = Your designs) and a style's colourways (the line's Material).
      .then((read) => setStyles(read.styles.map((style) => ({ id: style.id, code: style.code, name: style.name, ownLabel: style.ownLabel, colours: style.colours.map((colour) => ({ id: colour.id, name: colour.name })) }))))
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
    // owb-po3.2: a line taken out is kept (owb-po1: soft) and comes back with "Put it back" (the table lists it): no notice, no Undo.
    if (current?.request.removedLines !== undefined) {
      await write(`remove:${lineId}`, (version, key) => port.removeLine(current.request.id, lineId, version, key))
      setOwnPrices(({ [lineId]: _drop, ...rest }) => rest)
      return
    }
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
      router.push(`${frame.prefix}/orders`) // owb-po3.1: the window closes onto the orders page
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
        subject: draftTitleOf(answer.request, dw.t, locale, words.day),
        wanted: answer.request.requestedDate,
        requestId: answer.request.id,
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
  // owb-po3.1: no band of its own — the orders page behind the window keeps the band.

  if (!allowed) return <NotInAccess admins={admins} homeHref={frame.prefix} />

  const addAddressHeld = !can('portal.addresses.manage') ? (admins.length > 0 ? t('head.addAddressAdmin', { names: admins.join(', ') }) : t('head.addAddressAdminNone')) : heldWords

  const piecesRow = piecesWin ? rowOf(piecesWin.rowId) : undefined
  const optionsRow = optionsWin ? rowOf(optionsWin.rowId) : undefined
  const filesRow = rowFilesId ? rowOf(rowFilesId) : undefined
  const piecesLine = piecesRow && record ? (customLinesOf(record.request).find((line) => line.id === piecesRow.id && line.byPerson) ?? null) : null
  const draftName = record ? draftMailName(record.request, dw.t) : ''
  const fileCap = record ? filesAddHeld(record.request, { preview: false, offline: false, busy: false }) : null

  // ── owb-po3: the window ─────────────────────────────────────────────────────────────────────────────────────────────
  const request = record?.request ?? null
  const kinds: NewDesignKind[] = (request?.madeToMeasure?.garmentTypes ?? []).map((type) => ({ code: type.code, words: type.words[locale] }))
  const lineRows = request ? lineRowsOfDraft(request, { styles: styles ?? [], kinds }) : []
  const isDraft = !request || request.status === 'DRAFT'
  const prices: LinePrices | null =
    record?.seesPrices && request
      ? {
          currency: request.currency,
          edit: isDraft && held === null,
          byLine: Object.fromEntries([
            ...request.lines.map((line) => [line.id, { list: line.priceNow ?? null, own: ownPrices[line.id] ?? line.brandUnitPrice ?? null }] as const),
            ...customLinesOf(request).map((line) => [line.id, { list: null, own: ownPrices[line.id] ?? line.brandUnitPrice ?? null }] as const),
          ]),
        }
      : null
  const sum = prices
    ? lineRows.reduce<number | null>((total, row) => {
        const price = prices.byLine[row.id]
        const each = Number(price?.own ?? price?.list ?? Number.NaN)
        return Number.isFinite(each) && row.pieces.count ? (total ?? 0) + each * row.pieces.count : total
      }, null)
    : null
  const od = request ? productRowsOf(request, locale) : []
  const entries = request ? stillOpenEntries(request.stillOpen, od, dw.t) : []
  const ownFiles = request ? draftFilesOf(request) : null
  const refusals = { ...Object.fromEntries(Object.entries(ownPriceProblems).map(([lineId, key]) => [lineId, t(key)])), ...lineRefusals }
  const usedIds = ownColumnsOfRecord(request?.ownColumns).map((column) => column.id)
  const windowPhase: DraftWindowModel['phase'] =
    phase === 'sent' ? 'sent' : phase === 'closed' ? 'closed' : draftId && load === 'missing' ? 'missing' : draftId && load === 'error' ? 'failed' : draftId && load === 'loading' ? 'loading' : 'draft'
  const end =
    windowPhase === 'missing'
      ? { title: t('missing.title'), body: t('missing.body'), openHref: null }
      : windowPhase === 'closed' && request
        ? (() => {
            const closed = closedOf(request.status, seesOrders)
            return { title: t('closed.titleNone'), body: t(closed.body), openHref: request.salesOrder ? `${frame.prefix}/orders/${encodeURIComponent(request.salesOrder.id)}` : closed.open ? `${frame.prefix}/orders/requests/${encodeURIComponent(request.id)}` : null }
          })()
        : null
  const banner: DraftWindowModel['banner'] = offlineSince
    ? { tone: 'warning', title: t('offline.title', { time: words.time(offlineSince) }) }
    : stale
      ? { tone: 'warning', title: dw.t('draft.stale'), action: { words: dw.t('draft.reload'), run: 'reload' } }
      : problem
        ? { tone: 'danger', title: t(problem) }
        : notice
          ? { tone: 'success', title: notice.lines[0] ?? '', action: notice.undo ? { words: dw.t('notice.undo'), run: 'undo' } : { words: dw.t('notice.hide'), run: 'dismiss' } }
          : null
  const otherDrafts = drafts.value.filter((row) => row.id !== request?.id && row.status === 'DRAFT')
  const pictureChoices: PictureChoice[] = ownFiles
    ? [...ownFiles.logos, ...ownFiles.references]
        .filter((file) => file.contentType.startsWith('image/') || file.contentType === 'application/pdf')
        .map((file) => ({ fileId: file.id, name: file.originalName ?? '—', kind: pictureKindOf({ type: file.contentType, name: file.originalName ?? '' }), small: null }))
    : []

  /** owb-po3.2: a line's own value, saved at once with its own version (it changes no price and no promise; the draft's version stays). */
  const saveOwnValue = (lineId: string, columnId: string, value: OwnValue['value'], version: number | null) => {
    if (writeHeld({ preview, offline, busy: false })) return
    void enqueue(async () => {
      try {
        const saved = await ownPort.putValue({ line: { kind: 'REQUEST_LINE', id: lineId }, columnId, value, ...(version !== null ? { version } : {}) }, keyFor('own', { lineId, columnId, value, version }))
        const now = recordRef.current
        if (!now) return
        const own = now.request.ownColumns ?? { used: [], values: {} }
        apply({ ...now, request: { ...now.request, ownColumns: { ...own, values: { ...own.values, [lineId]: { ...(own.values[lineId] ?? {}), [columnId]: saved } } } } })
      } catch (error) {
        refused(error)
      }
    })
  }
  /** owb-po3.3: the columns this draft uses (≤ 8, in order); a column going off with values clears them only on `dropValues`. */
  const useColumns = async (ids: string[], dropValues: boolean) => {
    const current = await ensureDraft().catch((error: unknown) => {
      refused(error)
      return null
    })
    if (!current) return
    setOwnWin((now) => (now ? { ...now, busy: true, refused: null } : now))
    let failed: string | null = null
    await write(`columns:${ids.join(',')}:${dropValues}`, (version, key) => ownPort.useOnRequest(current.request.id, { version, columnIds: ids, ...(dropValues ? { dropValues: true } : {}) }, recordSchema, key), (kind) => {
      failed = t(refusalOf(kind))
    })
    setOwnWin((now) => (now ? { ...now, busy: false, refused: failed } : now))
  }
  const readColumns = () =>
    ownPort
      .list()
      .then((columns) => setOwnWin((now) => (now ? { ...now, columns } : now)))
      .catch(() => setOwnWin((now) => (now ? { ...now, columns: [], refused: t('refusal.other') } : now)))
  /** A picture from the computer or the phone: it goes up as a file of the draft (a reference), then it is a choice of the window. */
  const uploadPicture = async (file: File): Promise<PictureChoice> => {
    const current = await ensureDraft()
    const contentType = contentTypeOf(file).split(';')[0]!.trim().toLowerCase()
    const bytes = await file.arrayBuffer()
    const { file: announced, upload } = await port.announceFile(current.request.id, { part: 'REFERENCE', originalName: file.name, contentType, sizeBytes: file.size, sha256: await sha256Hex(bytes) }, newIdempotencyKey())
    await putToStore(upload, new Blob([bytes], { type: contentType }))
    await port.completeFile(current.request.id, announced.id, newIdempotencyKey())
    void refreshFiles()
    return { fileId: announced.id, name: file.name, kind: pictureKindOf({ type: contentType, name: file.name }), small: null }
  }
  const close = () => {
    void flush().finally(() => router.push(`${frame.prefix}/orders`))
  }
  const reorderHeld = reorderHeldKey(mayOrder)
  // The windows' and panels' actions (as the page form gave them; the window stacks the windows over itself).
  const piecesActions = {
    onMode: (mode: PiecesMode) => setPiecesWin((now) => (now ? { ...now, mode, typed: true, failed: null } : now)),
    onTotal: (text: string) => setPiecesWin((now) => (now ? { ...now, total: text, typed: true, failed: null } : now)),
    onCells: (cells: Record<string, number>) => setPiecesWin((now) => (now ? { ...now, cells, typed: true } : now)),
    onSave: () => void savePieces(),
    onClose: () => setPiecesWin((now) => (now?.busy ? now : null)),
    // By person: the person's window takes the place of the Pieces window (one window at a time over the New order).
    people: {
      onAddPerson: (lineId: string) => {
        setPiecesWin(null)
        openPerson(lineId)
      },
      onChangePerson: (lineId: string, personId: string) => {
        setPiecesWin(null)
        openPerson(lineId, personId)
      },
      onRemovePerson: removePersonRow,
      onFiles: (part: DraftFilePart, list: File[], lineId?: string | null) => void addFiles(part, list, lineId ?? null),
    },
  }
  const optionsActions = {
    onPick: (topic: string, picked: string | null) => {
      const row = optionsRow
      if (row) void writeChoices(row.id, row.choices.map((choice) => (choice.topic === topic ? { ...choice, picked } : choice)))
    },
    onRemove: (topic: string) => {
      const row = optionsRow
      if (row) void writeChoices(row.id, row.choices.filter((choice) => choice.topic !== topic))
    },
    onTopic: (text: string) => setOptionsWin((now) => (now ? { ...now, topic: text } : now)),
    onTyped: (text: string) => setOptionsWin((now) => (now ? { ...now, typed: text } : now)),
    onAdd: () => void addOption(),
    onClose: () => setOptionsWin(null),
  }
  const reorderActions = {
    onSearch: (q: string) => readPastOrders(q),
    onOpenOrder: (orderId: string) => openPastOrder(orderId),
    onBack: () => setReorder((current) => ({ ...current, order: null, selected: [], colours: {} })),
    onSelect: (ids: string[]) => setReorder((current) => ({ ...current, selected: ids })),
    onColour: (orderLineId: string, colourwayId: string) =>
      setReorder((current) => ({
        ...current,
        colours: { ...current.colours, [orderLineId]: colourwayId },
        selected: colourwayId ? (current.selected.includes(orderLineId) ? current.selected : [...current.selected, orderLineId]) : current.selected.filter((id) => id !== orderLineId),
      })),
    onAdd: () => void addReorder(),
    onRetryOrders: () => readPastOrders(reorder.q),
    onRetryOrder: () => (reorder.order ? openPastOrder(reorder.order.id) : undefined),
  }
  const uploadActions = {
    onFile: (file: File) => void readFile(file),
    onApply: () => void applySheet(),
    onRefusedCsv: () => (sheet.state === 'read' && sheet.answer.dryRun.refusedCsv ? saveText(t('upload.refusedFile'), sheet.answer.dryRun.refusedCsv) : undefined),
    onOther: () => {
      sheetFile.current = null
      setSheet({ state: 'idle' })
    },
  }
  const pickerActions = {
    onSearch: (q: string) => setPicker((now) => (now ? { ...now, q } : now)),
    onFilter: (patch: Partial<PickerState>) => setPicker((now) => (now ? { ...now, ...patch } : now)),
    onToggle: (styleId: string) => setPicker((now) => (now ? { ...now, selected: now.selected.includes(styleId) ? now.selected.filter((id) => id !== styleId) : [...now.selected, styleId] } : now)),
    onNext: () => {
      if (!picker || picker.selected.length === 0) return
      setPicker({ ...picker, step: 'sizes' })
      for (const styleId of picker.selected) if (!picker.details[styleId] || picker.details[styleId]!.state === 'error') loadDetail(styleId)
    },
    onBack: () => setPicker((now) => (now ? { ...now, step: 'styles', problem: null } : now)),
    onCells: (styleId: string, next: Record<string, Record<string, number>>) => setPicker((now) => (now ? { ...now, cells: { ...now.cells, [styleId]: next } } : now)),
    onAdd: () => void addFromPicker(),
    onClose: () => setPicker(null),
    onRetry: () => openPicker(picker?.selected ?? []),
    onRetryStyle: loadDetail,
  }
  const addressActions = {
    onField: (field: keyof AddressDraft, value: string) => {
      setAddress((now) => {
        if (!now) return now
        const { [field]: _gone, ...refused } = now.refused
        return { ...now, draft: { ...now.draft, [field]: value }, failed: null, refused }
      })
    },
    onSave: () => void saveAddress(),
    onClose: () => setAddress((now) => (now?.busy ? now : null)),
  }
  const personActions = {
    onField: <Key extends keyof PersonDraft>(field: Key, value: PersonDraft[Key]) => setPersonDialog((now) => (now ? { ...now, draft: { ...now.draft, [field]: value }, failed: null, typed: true } : now)),
    onSave: () => void savePerson(),
    onClose: () => setPersonDialog((now) => (now?.busy ? now : null)),
  }

  const windowModel: DraftWindowModel = {
    open: true,
    phase: windowPhase,
    title: title ?? dw.t('window.newOrder'),
    saved: save.kind === 'saving' ? dw.t('window.saving') : save.kind === 'failed' ? (save.reason ?? t('refusal.other')) : request ? savedByWords(request, dw.t, { time: words.time, day: words.day, today, door: 'portal' }) : dw.t('save.notYet'),
    drafts: otherDrafts.length > 0 ? otherDrafts.map((row) => ({ id: row.id, title: row.draft?.title ?? row.subject ?? draftTitleOf({ lines: [], createdAt: row.createdAt }, dw.t, locale, words.day), line: draftRowWords(row, t, words.day) })) : null,
    picture: request ? { chosen: (request.picture?.fileId ?? null) !== null, held: heldWords } : null,
    header,
    headerErrors,
    shipTo: shipToOptions(record?.addresses ?? [], header.shipToAddressId || null),
    today,
    lines: {
      rows: lineRows,
      mode: isDraft ? 'draft' : 'sent',
      columns: ownColumnsOfRecord(request?.ownColumns),
      styles: styles ?? [],
      kinds,
      prices,
      pending,
      removed: request?.removedLines ?? [],
      writeHeld: heldWords,
      saving,
      columnsDoor: true,
      refusals,
      door: 'portal',
    },
    files: {
      files: ownFiles ? [...ownFiles.logos, ...ownFiles.references].filter((file) => file.lineId === null) : [],
      logos: ownFiles ? ownFiles.logos.map((file) => file.id) : [],
      sheets: ownFiles ? ownFiles.sheets.filter((file) => file.lineId === null) : [],
      uploading: uploads.filter((row) => !row.lineId),
      open: request ? uploadsOpenOf(request) : true,
      addHeld: heldWords ?? (fileCap ? dw.t(fileCap) : null),
      removeHeld: heldWords,
      draftName,
      dropKey: 'mail.drop',
      accept: ACCEPT.REFERENCE,
    },
    side: { lines: lineRows.length, pieces: words.pieces(piecesOfRows(lineRows)), sum: sum !== null && request ? words.price(sum.toFixed(2), request.currency) : null, stillOpen: entries, openCount: request?.stillOpen?.openCount ?? entries.length },
    sendHeld: request ? sendWords : dw.t('window.sendFirst'),
    busy,
    deleteHeld: request ? discardWords : dw.t('window.sendFirst'),
    deleteAsk: discard !== null,
    writeHeld: heldWords,
    banner,
    sent: sent ? { subject: sent.subject, lines: sent.lines, pieces: words.pieces(sent.pieces), wanted: sent.wanted ? words.day(sent.wanted) : null, openHref: `${frame.prefix}/orders/requests/${encodeURIComponent(sent.requestId)}` } : null,
    end,
  }

  const addFrom = (
    <span className="fw-pno-addfrom">
      <span className="fw-pno-quiet">{dw.t('add.from')}</span>
      <span className="fw-pno-addways">
        {(['pick', 'reorder', 'upload'] as const).map((way) => (
          <Button key={way} size="sm" variant="quiet" heldReason={way === 'reorder' && reorderHeld ? t(reorderHeld) : heldWords} onClick={() => chooseWay(way)}>
            {dw.t(way === 'pick' ? 'add.catalogue' : way === 'reorder' ? 'add.pastOrder' : 'add.sheet')}
          </Button>
        ))}
      </span>
    </span>
  )
  const panels = (
    <>
      {way === 'reorder' && mayOrder ? <ReorderPanel model={{ ...reorder, currency: request?.currency ?? 'EUR', writeHeld: heldWords }} actions={reorderActions} /> : null}
      {way === 'upload' ? <UploadPanel model={{ sheet, templateHref: templateHref(locale), writeHeld: heldWords }} actions={uploadActions} /> : null}
    </>
  )
  const personModel = (() => {
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
      failed: personDialog.failed ? t(personDialog.failed) : null,
    }
  })()

  return (
    <>
      <DraftWindow
        model={windowModel}
        slots={{ addFrom, panels }}
        actions={{
          onClose: close,
          onSend: () => void send(),
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
          ...(addAddressHeld === null ? { onAddAddress: () => setAddress({ draft: EMPTY_ADDRESS, showProblems: false, busy: false, failed: null, refused: {} }) } : {}),
          onPicture: () => setPictureOpen(true),
          onOpenDraft: (id) => router.push(newOrderHref(frame.prefix, { draft: id })),
          onDeleteDraft: (id) => {
            const row = drafts.value.find((entry) => entry.id === id)
            if (!row || writeHeld({ preview, offline, busy: false })) return
            discardDraft(api, id, row.version, keyFor('discardOther', { id, version: row.version }))
              .then(() => readDrafts())
              .catch((error: unknown) => refused(error))
          },
          onAsk: () => setDiscard({ busy: false, failed: null }),
          onAskCancel: () => setDiscard((now) => (now?.busy ? now : null)),
          onDelete: () => void confirmDiscard(),
          onFiles: (part, list) => void addFiles(part, list, null),
          onRemoveFile: removeFile,
          onLogo: (file, on) => {
            const id = recordRef.current?.request.id
            if (id) void write(`logo:${file.id}:${on}`, (version, key) => port.markFile(id, file.id, { version, part: on ? 'LOGO' : 'REFERENCE' }, key))
          },
          onStillOpen: ({ rowId }) => {
            const element = document.getElementById(rowId ? `line-${rowId}` : 'od-date')
            element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
            element?.querySelector<HTMLElement>('input, select, button')?.focus({ preventScroll: true })
          },
          onBanner: (run) => (run === 'reload' ? void read() : run === 'undo' ? void undo() : setNotice(null)),
          onOpenOrder: () => {
            const href = windowModel.sent?.openHref ?? windowModel.end?.openHref
            if (href) router.push(href)
          },
          onNewOrder: () => router.push(newOrderHref(frame.prefix)),
          lines: {
            onModel: (rowId, choice) => void writeRow(rowId, modelFields(choice)),
            onMaterial: (rowId, value) => {
              const row = lineRows.find((entry) => entry.id === rowId)
              if (!row) return
              if (row.material.how === 'COLOURWAY') {
                if (value !== '') void writeRow(rowId, { colourwayId: value })
                return
              }
              const choices = rowOf(rowId)?.choices ?? []
              void writeRow(rowId, { choices: choices.map((choice) => (choice.topic === row.material.topic ? { ...choice, picked: value === '' ? null : value } : choice)) })
            },
            onAddMaterial: (rowId) => setOptionsWin({ rowId, topic: dw.t('window.materialTopic'), typed: '', busy: false, failed: null }),
            onSizes: openPieces,
            onPieces: (rowId, count) => {
              setLineRefusals(({ [rowId]: _drop, ...rest }) => rest)
              void writeRow(rowId, { byPerson: false, quantity: count, sizes: [] })
            },
            onOwnValue: (rowId, columnId, value, version) => {
              setLineRefusals(({ [rowId]: _drop, ...rest }) => rest)
              saveOwnValue(rowId, columnId, value, version)
            },
            onPrice: (rowId, text) => {
              setOwnPrices((now) => ({ ...now, [rowId]: text }))
              ownPricesRef.current = { ...ownPricesRef.current, [rowId]: text }
              setOwnPriceProblems(({ [rowId]: _drop, ...rest }) => rest)
              void saveOwnPrice(rowId)
            },
            ...(port.copyLine
              ? {
                  onCopy: (rowId: string) => {
                    const id = recordRef.current?.request.id
                    if (id) void write(`copy:${rowId}`, (version, key) => port.copyLine!(id, rowId, version, key))
                  },
                }
              : {}),
            onTakeOut: (rowId) => void remove(rowId),
            ...(port.putBackLine
              ? {
                  onPutBack: (lineId: string) => {
                    const id = recordRef.current?.request.id
                    if (id) void write(`putBack:${lineId}`, (version, key) => port.putBackLine!(id, lineId, version, key))
                  },
                }
              : {}),
            onAdd: () => {
              // A new line takes the model and the material of the line above; the first one asks "Choose the model…".
              const fields = nextLineFields(lineRows[lineRows.length - 1])
              if (fields) void writeRow(null, fields)
              else setPending(true)
            },
            onDropPending: () => setPending(false),
            onColumns: () => {
              setOwnWin({ columns: null, busy: false, refused: null })
              void readColumns()
            },
            onRefused: (rowId, refusal) => setLineRefusals((now) => ({ ...now, [rowId]: refusal })),
          },
        }}
      />
      {/* The windows over the window (the DS stacks them): a row's sizes, its options, its files, a person, the catalogue, an address. */}
      {picker ? <StylePickerDialog model={{ ...picker, onDraft, prefix: frame.prefix, writeHeld: heldWords }} actions={pickerActions} /> : null}
      {address ? <NewAddressDialog model={{ ...address, problems: addressProblems(address.draft) }} actions={addressActions} /> : null}
      {piecesWin && piecesRow && record ? (
        <PiecesWindow
          model={{
            row: piecesRow,
            mode: piecesWin.mode,
            total: piecesWin.total,
            cells: piecesWin.cells,
            roster: { draft: draftViewOf(record), writeHeld: heldWords, uploadsOpen: uploadsOpenOf(record.request), addHeld: fileCap ? dw.t(fileCap) : null, draftName },
            rosterLine: piecesLine,
            busy: piecesWin.busy,
            failed: piecesWin.failed,
            writeHeld: heldWords,
          }}
          actions={piecesActions}
        />
      ) : null}
      {optionsWin && optionsRow ? (
        <OptionsWindow
          model={{ row: optionsRow, topic: optionsWin.topic, typed: optionsWin.typed, addHeld: optionHeld(optionsRow.choices, optionsWin.topic, optionsWin.typed), busy: optionsWin.busy, failed: optionsWin.failed, writeHeld: heldWords }}
          actions={optionsActions}
        />
      ) : null}
      {filesRow && record ? (
        <RowFilesWindow
          model={{
            row: filesRow,
            files: { files: filesRow.files, uploading: uploads.filter((row) => row.lineId === filesRow.id), open: uploadsOpenOf(record.request), addHeld: heldWords ?? (fileCap ? dw.t(fileCap) : null), removeHeld: heldWords, draftName, dropKey: 'mail.drop', accept: filesRow.sizing === 'MADE_TO_MEASURE' ? ACCEPT.SHEET : ACCEPT.REFERENCE },
          }}
          actions={{ onFiles: (list) => void addFiles(filesRow.sizing === 'MADE_TO_MEASURE' ? 'SHEET' : 'REFERENCE', list, filesRow.id), onRemove: removeFile }}
          onClose={() => setRowFilesId(null)}
        />
      ) : null}
      {personModel ? <PersonDialog model={personModel} actions={personActions} /> : null}
      {ownWin ? (
        <OwnColumnsWindow
          model={{ open: true, door: 'portal', columns: ownWin.columns, used: usedIds, values: request?.ownColumns?.values ?? {}, busy: ownWin.busy || busy, refused: ownWin.refused, writeHeld: heldWords }}
          actions={{
            onClose: () => setOwnWin(null),
            onUse: (ids, dropValues) => void useColumns(ids, dropValues),
            onCreate: (input) => {
              setOwnWin((now) => (now ? { ...now, busy: true, refused: null } : now))
              ownPort
                .create(input, keyFor('ownCreate', input))
                .then(async (column) => {
                  await readColumns()
                  if (usedIds.length < 8) await useColumns([...usedIds, column.id], false)
                  else setOwnWin((now) => (now ? { ...now, busy: false } : now))
                })
                .catch((error: unknown) => setOwnWin((now) => (now ? { ...now, busy: false, refused: t(refusalOf(kindOf(error))) } : now)))
            },
            onCloseColumn: (column) => {
              ownPort
                .close(column.id, column.version, keyFor('ownClose', { id: column.id, version: column.version }))
                .then(() => readColumns())
                .catch((error: unknown) => setOwnWin((now) => (now ? { ...now, refused: t(refusalOf(kindOf(error))) } : now)))
            },
          }}
        />
      ) : null}
      {pictureOpen && request ? (
        <OrderPictureWindow
          open
          onClose={() => setPictureOpen(false)}
          number={dw.t('window.yourOrder')}
          subject={title}
          record={{ source: 'customerOrder', recordId: request.id }}
          now={{ fileId: request.picture?.fileId ?? null, version: request.version }}
          choices={pictureChoices}
          save={orderPictureSaver(api, orderPicturePath('portal', 'request', request.id))}
          upload={uploadPicture}
          onSaved={(saved) => {
            const now = recordRef.current
            if (now) apply({ ...now, request: { ...now.request, version: saved.version, picture: { fileId: saved.pictureFileId, setAt: saved.pictureSetAt, contentType: null } } })
          }}
        />
      ) : null}
    </>
  )
}
