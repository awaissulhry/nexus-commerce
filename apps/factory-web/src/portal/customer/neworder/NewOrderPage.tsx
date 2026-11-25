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
  columnsOf,
  headerChanges,
  headerDirty,
  headerDraftOf,
  headerProblem,
  isWay,
  lineChanged,
  lineHeld,
  mergeWords,
  newOrderHref,
  NS,
  piecesOfCells,
  problemPlace,
  refusalOf,
  reorderBody,
  reorderStart,
  sizesBody,
  stylesOf,
  todayIn,
  WAY_SOURCE,
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
import { DRAFT_FILES_MAX, draftFileCount, LATER_PART_OF, laterToggleOf } from './model'
import type { UploadRow } from '../../../lib/order-draft/view/DraftFiles'
// ---- end F-CP-151
// ---- F-CP-154 (customer page plan C5; 12 §2 parts 1, 4, 6; B-CP-075, B-CP-076): lines of every kind, the People and sizes roster,
// "Your price" — every write a draft command at the draft's version; "Your price" only from a price holder (the grain filter refuses it
// from anyone else: the page never sends the key without the grain).
import { changeCustomLine, type CustomLine } from './api'
import {
  ADD_KIND_OF,
  customLineBody,
  customLineChanges,
  customLineDraftOf,
  customLineProblems,
  customLinesOf,
  draftFilesOf,
  isAddKind,
  lineCountOf,
  mtmOf,
  ownPriceWriteOf,
  personBody,
  personChanges,
  personDraftOf,
  personProblems,
  type AddKind,
  type CustomLineDraft,
  type PersonDraft,
} from './model'
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
type Typed = Record<string, Record<string, number>>
interface SentInfo {
  customerRef: string | null
  lines: number
  pieces: number
  net: string | null
  currency: string
  seesPrices: boolean
}
type PickerState = Omit<PickerModel, 'onDraft' | 'prefix' | 'writeHeld'>
// F-CP-154: a described or made-to-measure line's window, a person's window.
interface CustomDialogState {
  mode: 'add' | 'change'
  lineId: string | null
  draft: CustomLineDraft
  /** Something was typed in it (leaving the page asks first). */
  typed?: boolean
  showProblems: boolean
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
  const [choosing, setChoosing] = useState<Way | null>(null)
  const [load, setLoad] = useState<Load>('loading')
  const [record, setRecord] = useState<DraftRecord | null>(null)
  const [header, setHeader] = useState<HeaderDraft>(headerDraftOf(null))
  const [headerErrors, setHeaderErrors] = useState<Partial<Record<HeaderField, string>>>({})
  const [save, setSave] = useState<SaveStatusState>({ kind: 'idle' })
  const [cells, setCells] = useState<Typed>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [notice, setNotice] = useState<{ lines: string[]; undo: DraftLine | null } | null>(null)
  const [showProblems, setShowProblems] = useState(false)
  const [sent, setSent] = useState<SentInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [reorder, setReorder] = useState<ReorderState>(NO_REORDER)
  const [sheet, setSheet] = useState<SheetState>({ state: 'idle' })
  const [picker, setPicker] = useState<PickerState | null>(null)
  const [address, setAddress] = useState<AddressState | null>(null)
  const [discard, setDiscard] = useState<{ busy: boolean; failed: string | null } | null>(null)
  const [offlineSince, setOfflineSince] = useState<string | null>(null)
  // ---- F-CP-150: who changed the draft meanwhile (a 409's re-read, once the API names them), and who may send it.
  const [staleBy, setStaleBy] = useState<string | null>(null)
  const [orderers, setOrderers] = useState<string[] | null>(null)
  // ---- end F-CP-150
  const [uploads, setUploads] = useState<UploadRow[]>([]) // F-CP-151: files going up now, or that did not go
  // ---- F-CP-154: a custom line's window (with the styles it may name), a person's window, "Your price" typed and not saved yet.
  const [customDialog, setCustomDialog] = useState<CustomDialogState | null>(null)
  const [customStyles, setCustomStyles] = useState<{ state: 'loading' | 'error' | 'ready'; rows: { id: string; code: string; name: string }[] }>({ state: 'loading', rows: [] })
  const [personDialog, setPersonDialog] = useState<PersonDialogState | null>(null)
  const [ownPrices, setOwnPrices] = useState<Record<string, string>>({})
  const [ownPriceProblems, setOwnPriceProblems] = useState<Record<string, string>>({})
  const [describing, setDescribing] = useState(false)
  const ownPricesRef = useRef(ownPrices)
  ownPricesRef.current = ownPrices
  // ---- end F-CP-154

  const recordRef = useRef<DraftRecord | null>(null)
  recordRef.current = record
  const headerRef = useRef(header)
  headerRef.current = header
  const cellsRef = useRef(cells)
  cellsRef.current = cells
  const notesRef = useRef(notes)
  notesRef.current = notes
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
    setCells({})
    setNotes({})
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
          .then((next) => setStaleBy(next.request.lastEditedBy ?? null))
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
    setChoosing(null)
    if (draftId) {
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

  // ── the start: a way makes a draft ──────────────────────────────────────────────────────────────────────────────────
  const startDraft = useCallback(
    async (chosen: Way, extra: { styles?: readonly string[]; reorder?: string | null; line?: string | null; reuse?: boolean } = {}) => {
      if (writeHeld({ preview, offline, busy: false })) return
      setChoosing(chosen)
      try {
        const existing = extra.reuse ? (await fetchDrafts(api).catch(() => []))[0] : undefined
        const id = existing ? existing.id : (await createDraft(api, { source: WAY_SOURCE[chosen] }, keyFor('create', { way: chosen, at: Date.now() }))).request.id
        router.replace(newOrderHref(frame.prefix, { draft: id, way: chosen, styles: extra.styles ?? null, reorder: extra.reorder ?? null, line: extra.line ?? null }))
      } catch (error) {
        setChoosing(null)
        setProblem(refusalOf(kindOf(error)))
        setDrafts((current) => ({ ...current }))
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, preview, offline, router, frame.prefix],
  )

  // The catalogue's "Add to order" and the order record's "Reorder this line" arrive without a draft: the newest draft
  // takes them, else a new one.
  useEffect(() => {
    if (!allowed || draftId || choosing) return
    if (stylesParam.length > 0) void startDraft('pick', { styles: stylesParam, reuse: true })
    else if (reorderParam && mayOrder) void startDraft('reorder', { reorder: reorderParam, line: lineParam, reuse: true }) // F-CP-150
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, draftId, stylesParam.join(','), reorderParam])

  // ── the header ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const saveHeader = useCallback(
    (field?: HeaderField): Promise<boolean> => {
      const current = recordRef.current
      if (!current || current.request.status !== 'DRAFT') return Promise.resolve(true)
      const typed = headerRef.current
      const fields: HeaderField[] = field ? [field] : ['customerRef', 'shipToAddressId', 'requestedDate', 'note']
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
    [api, apply, refused, preview, offline, today, t],
  )

  // ── lines ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  const saveLine = useCallback(
    (lineId: string): Promise<boolean> => {
      const current = recordRef.current
      const line = current?.request.lines.find((entry) => entry.id === lineId)
      if (!current || !line) return Promise.resolve(true)
      const typed = cellsRef.current[lineId]
      const note = notesRef.current[lineId]
      const body: { sizes?: ReturnType<typeof sizesBody>; note?: string | null } = {}
      if (typed && lineChanged(line, typed)) {
        if (lineHeld(typed)) return Promise.resolve(false)
        body.sizes = sizesBody(columnsOf(line), typed)
      }
      if (note !== undefined && (note.trim() === '' ? null : note.trim()) !== (line.note ?? null)) body.note = note.trim() === '' ? null : note.trim()
      if (body.sizes === undefined && body.note === undefined) {
        setCells(({ [lineId]: _drop, ...rest }) => rest)
        setNotes(({ [lineId]: _drop, ...rest }) => rest)
        return Promise.resolve(true)
      }
      if (writeHeld({ preview, offline, busy: false })) return Promise.resolve(false)
      setSaving((ids) => [...ids, lineId])
      setSave({ kind: 'saving' })
      return enqueue(async () => {
        const version = recordRef.current!.request.version
        try {
          const next = await port.changeLine(current.request.id, lineId, { version, ...body }, keyFor('line', { lineId, version, body }))
          apply(next)
          // What was typed since this save started stays typed.
          if (body.sizes) setCells(({ [lineId]: now, ...rest }) => (now && now !== typed ? { ...rest, [lineId]: now } : rest))
          if (body.note !== undefined) setNotes(({ [lineId]: now, ...rest }) => (now !== undefined && now !== note ? { ...rest, [lineId]: now } : rest))
          setSave({ kind: 'saved', at: next.request.updatedAt })
          return true
        } catch (error) {
          setSave({ kind: 'failed', reason: t(refusalOf(kindOf(error))) })
          refused(error)
          return false
        } finally {
          setSaving((ids) => ids.filter((id) => id !== lineId))
        }
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, apply, refused, preview, offline, t],
  )

  /** Everything typed goes to the server (before a send, or from the unsaved guard). */
  const flush = useCallback(async (): Promise<boolean> => {
    const results = [await saveHeader()]
    for (const lineId of new Set([...Object.keys(cellsRef.current), ...Object.keys(notesRef.current)])) results.push(await saveLine(lineId))
    for (const lineId of Object.keys(ownPricesRef.current)) results.push(await saveOwnPriceRef.current(lineId)) // F-CP-154
    return results.every(Boolean)
  }, [saveHeader, saveLine])

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

  const changeColour = (lineId: string, colourwayId: string) => {
    const id = recordRef.current?.request.id
    if (!id) return
    void write(`colour:${lineId}:${colourwayId}`, (version, key) => port.changeLine(id, lineId, { version, colourwayId }, key))
  }

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
    setCells(({ [lineId]: _drop, ...rest }) => rest)
    setNotes(({ [lineId]: _drop, ...rest }) => rest)
    setNotice({ lines: [t('notice.removed', { seq: line.seq, style: line.style.code, colour: line.colourway.name })], undo: line })
  }

  const undo = async () => {
    const line = notice?.undo
    const current = recordRef.current
    if (!line || !current) return
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
  /** The styles a custom line may name: a described line its own label's, a made-to-measure line any of its catalogue. */
  const readCustomStyles = useCallback(
    (kind: CustomLine['kind']) => {
      setCustomStyles({ state: 'loading', rows: [] })
      fetchCatalogue(api, kind === 'DESCRIBED' ? { range: 'OWN_LABEL' } : {})
        .then((read) => setCustomStyles({ state: 'ready', rows: read.styles.filter((style) => kind !== 'DESCRIBED' || style.ownLabel).map((style) => ({ id: style.id, code: style.code, name: style.name })) }))
        .catch(() => setCustomStyles({ state: 'error', rows: [] }))
    },
    [api],
  )

  /** "Describe it" / "Made to measure": on the start the draft is made first (its address opens the window); on a draft, the window. */
  const openCustom = async (kind: AddKind) => {
    if (writeHeld({ preview, offline, busy: false })) return
    if (!draftId) {
      setDescribing(true)
      try {
        const made = await createDraft(api, { source: 'PICKER' }, keyFor('create', { add: kind, at: Date.now() }))
        router.replace(newOrderHref(frame.prefix, { draft: made.request.id, add: kind }))
      } catch (error) {
        setProblem(refusalOf(kindOf(error)))
      } finally {
        setDescribing(false)
      }
      return
    }
    if (!recordRef.current) return
    const custom = ADD_KIND_OF[kind]
    if (custom === 'MADE_TO_MEASURE' && !mtmOf(recordRef.current.request).open) return // held with words in "Add a line ▾"
    setCustomDialog({ mode: 'add', lineId: null, draft: customLineDraftOf(custom), showProblems: false, busy: false, failed: null })
    readCustomStyles(custom)
  }

  const openChangeCustom = (lineId: string) => {
    const line = recordRef.current ? customLinesOf(recordRef.current.request).find((entry) => entry.id === lineId) : undefined
    if (!line) return
    setCustomDialog({ mode: 'change', lineId, draft: customLineDraftOf(line.kind, line), showProblems: false, busy: false, failed: null })
    readCustomStyles(line.kind)
  }

  const saveCustom = async () => {
    const current = recordRef.current
    if (!current || !customDialog || customDialog.busy) return
    if (Object.keys(customLineProblems(customDialog.draft)).length > 0) {
      setCustomDialog({ ...customDialog, showProblems: true })
      return
    }
    const line = customDialog.lineId ? customLinesOf(current.request).find((entry) => entry.id === customDialog.lineId) : undefined
    const changes = line ? customLineChanges(line, customDialog.draft) : null
    if (changes && Object.keys(changes).length === 0) {
      setCustomDialog(null)
      return
    }
    setCustomDialog({ ...customDialog, busy: true, failed: null })
    let failed: string | null = null
    const onError = (kind: string | null) => {
      failed = refusalOf(kind)
      if (kind === 'conflict') setStale(true)
    }
    const next =
      line && changes
        ? await write(`customLine:${line.id}:${JSON.stringify(changes)}`, (version, key) => port.changeCustomLine(current.request.id, line.id, { version, ...changes }, key), onError)
        : await write(`customLine:new:${JSON.stringify(customLineBody(customDialog.draft))}`, (version, key) => port.addCustomLine(current.request.id, { version, line: customLineBody(customDialog.draft) }, key), onError)
    if (next) setCustomDialog(null)
    else setCustomDialog((now) => (now ? { ...now, busy: false, failed: failed ?? 'refusal.other' } : now))
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

  const onDraft = useMemo(() => Object.fromEntries((record?.request.lines ?? []).map((line) => [`${line.style.id}|${line.colourway.id}`, line.seq])), [record])

  const addFromPicker = async () => {
    const current = recordRef.current
    if (!picker || !current || picker.busy) return
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
    const current = recordRef.current
    const order = reorder.order?.read
    if (!current || !order || reorder.busy) return
    const lines = reorderBody(order.lines, reorder.selected, reorder.colours)
    if (lines.length === 0) return
    setReorder((now) => ({ ...now, busy: true }))
    const answer = await write(`reorder:${order.order.id}:${JSON.stringify(lines)}`, (version, key) => reorderInto(api, current.request.id, { version, orderId: order.order.id, lines }, key))
    setReorder((now) => ({ ...now, busy: false, selected: [] }))
    if (answer) setNotice({ lines: mergeWords(answer, answer, t), undo: null })
  }

  // ── upload ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  const readFile = async (file: File) => {
    const current = recordRef.current
    if (!current || writeHeld({ preview, offline, busy: false })) return
    if (file.size > SHEET_MAX_BYTES) {
      setSheet({ state: 'failed', fileName: file.name, problem: 'upload.tooBig' })
      return
    }
    setSheet({ state: 'reading', fileName: file.name })
    try {
      const content = await fileContent(file)
      const contentType = file.type || (file.name.toLowerCase().endsWith('.csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      sheetFile.current = { fileName: file.name, contentType, content }
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
      setCells({})
      setNotes({})
      setHeader(headerDraftOf(current.request))
      router.replace(newOrderHref(frame.prefix))
    } catch (error) {
      setDiscard({ busy: false, failed: refusalOf(kindOf(error)) })
    }
  }

  const showMe = useCallback(() => {
    setShowProblems(true)
    const first = recordRef.current?.request.problems[0]
    if (!first) return
    const element = document.getElementById(problemPlace(first))
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    element?.focus({ preventScroll: true })
  }, [])

  const typedEmpty = Object.values(cells).some((typed) => piecesOfCells(typed) === 0)
  const send = async () => {
    const current = recordRef.current
    if (!current || busy) return
    if (!(await flush())) {
      setShowProblems(true)
      return
    }
    const now = recordRef.current!
    const heldNow = draftSendHeld(now.request, { preview, offline, busy: false, emptyLine: false }, orderers ?? []) // F-CP-150
    if (heldNow) {
      if (heldNow.key === 'held.problems') showMe()
      return
    }
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
    if (phase !== 'draft' || !record) return
    const marker = `${record.request.id}|${way}|${stylesParam.join(',')}|${reorderParam ?? ''}`
    if (handled.current === marker) return
    handled.current = marker
    // F-CP-150 (D11): past orders only for one whose access shows orders (the way is held for anyone else).
    if (mayOrder && way === 'reorder' && reorder.orders.state === 'loading' && reorder.orders.rows.length === 0) readPastOrders('')
    if (mayOrder && way === 'reorder' && reorderParam) openPastOrder(reorderParam, lineParam)
    if (stylesParam.length > 0) openPicker(stylesParam)
    // "Pick styles" chosen for an empty draft: the picker opens by itself.
    else if (way === 'pick' && record.request.lines.length === 0) openPicker()
    if (stylesParam.length > 0 || reorderParam) router.replace(newOrderHref(frame.prefix, { draft: record.request.id, way }), { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, record?.request.id, way, stylesParam.join(','), reorderParam])

  // F-CP-154: the start's "Describe it" made the draft; its address (`add=`) opens the window once, then leaves the address.
  const addParam = search?.get('add') ?? null
  useEffect(() => {
    if (phase !== 'draft' || !record || !isAddKind(addParam)) return
    void openCustom(addParam)
    router.replace(newOrderHref(frame.prefix, { draft: record.request.id, way }), { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, record?.request.id, addParam])

  const chooseWay = (next: Way) => {
    if (next === 'reorder' && !mayOrder) return // F-CP-150 (D11): held with why on the page
    if (phase === 'start') {
      void startDraft(next)
      return
    }
    const current = recordRef.current
    if (!current) return
    if (next === way && next === 'pick') openPicker()
    // The address's way; the effect above opens its panel (and the picker for an empty draft).
    else router.replace(newOrderHref(frame.prefix, { draft: current.request.id, way: next }), { scroll: false })
    if (next === 'pick' && next !== way && current.request.lines.length > 0) openPicker()
  }

  // ── live: read again when the tab comes back (typed work is never overwritten) ──────────────────────────────────────
  const dirty =
    phase === 'draft' &&
    (headerDirty(record ? headerDraftOf(record.request) : header, header) ||
      Object.keys(cells).length > 0 ||
      Object.keys(notes).length > 0 ||
      (picker !== null && pickerLineCount({ ...picker, onDraft }) > 0) ||
      sheet.state === 'read' ||
      (address !== null && addressTyped(address.draft)) ||
      uploads.some((row) => row.state === 'uploading') || // F-CP-151: never leave half way through an upload
      Object.keys(ownPrices).length > 0 || // F-CP-154: "Your price" typed, not saved yet
      customDialog?.typed === true ||
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
  }, [api, apply, startFrom, dirty])
  usePortalLive({ onReconnect: recheck }, allowed && phase === 'draft')
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
    const current = recordRef.current
    if (!current || writeHeld({ preview, offline, busy: false })) return
    let room = DRAFT_FILES_MAX - draftFileCount(current.request)
    for (const file of list) {
      const key = newIdempotencyKey()
      const contentType = contentTypeOf(file).split(';')[0]!.trim().toLowerCase()
      const problem = room <= 0 ? { words: dw.t('draftPage.files.full') } : (() => {
        const found = heldProblem({ name: file.name, type: contentType, size: file.size })
        return found ? { words: tc(found.key, found.params) } : null
      })()
      if (problem) {
        setUploads((rows) => [...rows, { key, part, name: file.name, state: 'failed', failure: problem.words }])
        continue
      }
      room -= 1
      setUploads((rows) => [...rows, { key, part, name: file.name, state: 'uploading' }])
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
  /** "Sending later" for a part (sheets: People and sizes) — once the API keeps the mark (B-CP-075). */
  const markLater = (part: DraftFilePart, on: boolean) => {
    const current = recordRef.current
    const toggle = current ? laterToggleOf(current.request, LATER_PART_OF[part]) : null
    if (!current || !toggle || toggle.on === on) return
    void write(`later:${toggle.next.join(',')}`, (version, key) => port.header(current.request.id, { version, laterParts: toggle.next }, key))
  }
  // ---- end F-CP-151

  // ── the band ────────────────────────────────────────────────────────────────────────────────────────────────────────
  // F-CP-150: held, never hidden — a Designer reads the names of who may order; Discard… held for a colleague who neither orders
  // nor started the draft.
  const sendHeldNow = record ? draftSendHeld(record.request, { preview, offline, busy: busy || saving.length > 0, emptyLine: typedEmpty }, orderers ?? []) : ({ key: 'held.busy' } as { key: string; count?: number; names?: string })
  const sendWords = sendHeldNow ? (sendHeldNow.key === 'lines.held.empty' ? dw.t : t)(sendHeldNow.key, sendHeldNow.count !== undefined ? { count: sendHeldNow.count } : sendHeldNow.names !== undefined ? { names: sendHeldNow.names } : undefined) : null
  const discardKey = record ? draftDiscardHeld(record.request, { preview, offline, busy: false }) : held
  const discardWords = discardKey ? t(discardKey) : null
  const draftAsk = record ? { type: 'PortalOrderRequest', id: record.request.id, label: draftTitleOf(record.request, dw.t, locale) } : null
  usePortalBand(
    allowed
      ? newOrderBandOf({
          words,
          phase,
          prefix: frame.prefix,
          template: templateHref(locale),
          customerRef: sent?.customerRef ?? record?.request.customerRef ?? null,
          sendHeld: sendWords,
          discardHeld: discardWords,
          title: record ? draftTitleOf(record.request, dw.t, locale) : null, // F-CP-150 (F-CP-154: a line in the customer's own words names it)
          ask: draftAsk, // F-CP-150
          onSend: () => void send(),
          onDiscard: () => setDiscard({ busy: false, failed: null }),
        })
      : { title: t('band.title') },
  )

  if (!allowed) return <NotInAccess admins={admins} homeHref={frame.prefix} />

  const addAddressHeld = !can('portal.addresses.manage') ? (admins.length > 0 ? t('head.addAddressAdmin', { names: admins.join(', ') }) : t('head.addAddressAdminNone')) : heldWords
  const typedCells = cells

  return (
    <NewOrderView
      model={{
        state: draftId ? load : 'ready',
        phase,
        prefix: frame.prefix,
        today,
        start: { state: drafts.state, drafts: drafts.value, choosing, held: heldWords, describing }, // F-CP-154: "Describe it"
        way,
        record,
        header,
        headerErrors,
        save,
        cells: typedCells,
        notes,
        saving,
        writeHeld: heldWords,
        addAddressHeld,
        reorder: way === 'reorder' && mayOrder ? { ...reorder, currency: record?.request.currency ?? 'EUR', writeHeld: heldWords } : null, // F-CP-150
        upload: way === 'upload' ? { sheet, templateHref: templateHref(locale), writeHeld: heldWords } : null,
        problem,
        stale,
        notice: notice ? { lines: notice.lines, undo: notice.undo !== null } : null,
        sendHeld: sendWords,
        showProblems,
        sent,
        closed: record && record.request.status !== 'DRAFT' && !sent ? { status: record.request.status, salesOrder: record.request.salesOrder ? { id: record.request.salesOrder.id } : null } : null, // B-TH-304: no office number
        offlineSince,
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
          // ---- F-CP-154: a custom line's window, a person's window.
          customLine:
            customDialog && record
              ? {
                  mode: customDialog.mode,
                  kind: customDialog.draft.kind,
                  seq: customDialog.lineId ? (customLinesOf(record.request).find((entry) => entry.id === customDialog.lineId)?.seq ?? null) : null,
                  draft: customDialog.draft,
                  problems: customLineProblems(customDialog.draft),
                  showProblems: customDialog.showProblems,
                  styles: customStyles,
                  garmentTypes: mtmOf(record.request).garmentTypes,
                  busy: customDialog.busy,
                  failed: customDialog.failed,
                }
              : null,
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
          // ---- end F-CP-154
        },
      }}
      actions={{
        onWay: chooseWay,
        onContinue: (id) => router.push(newOrderHref(frame.prefix, { draft: id })),
        onRetryStart: readDrafts,
        onHeader: (field, value) => {
          setHeader((now) => ({ ...now, [field]: value }))
          headerRef.current = { ...headerRef.current, [field]: value }
        },
        onHeaderLeave: (field) => void saveHeader(field),
        onAddAddress: () => setAddress({ draft: EMPTY_ADDRESS, showProblems: false, busy: false, failed: null, refused: {} }),
        onShowMe: showMe,
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
        lines: {
          onCells: (lineId, next) => setCells((now) => ({ ...now, [lineId]: next })),
          onLeave: (lineId) => void saveLine(lineId),
          onNote: (lineId, note) => setNotes((now) => ({ ...now, [lineId]: note })),
          onColour: changeColour,
          onRemove: (lineId) => void remove(lineId),
          onChangeCustom: openChangeCustom, // F-CP-154
          onDropSize: (lineId, size) => {
            const line = recordRef.current?.request.lines.find((entry) => entry.id === lineId)
            if (!line) return
            const { [size]: _drop, ...rest } = cellsRef.current[lineId] ?? Object.fromEntries(line.sizes.map((row) => [row.size, row.quantity]))
            cellsRef.current = { ...cellsRef.current, [lineId]: rest }
            setCells((now) => ({ ...now, [lineId]: rest }))
            void saveLine(lineId)
          },
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
        // F-CP-151: a part's files (F-CP-154: a measurement sheet onto one line).
        files: { onFiles: (part, list, lineId) => void addFiles(part, list, lineId ?? null), onRemove: removeFile, onLater: markLater },
        // ---- F-CP-154: "Describe it" / "Made to measure", the roster, "Your price", their windows.
        onAddKind: (kind) => void openCustom(kind),
        people: { onAddPerson: (lineId) => openPerson(lineId), onChangePerson: (lineId, personId) => openPerson(lineId, personId), onRemovePerson: removePersonRow },
        price: {
          onType: (lineId, text) => {
            setOwnPrices((now) => ({ ...now, [lineId]: text }))
            ownPricesRef.current = { ...ownPricesRef.current, [lineId]: text }
            setOwnPriceProblems(({ [lineId]: _drop, ...rest }) => rest)
          },
          onLeave: (lineId) => void saveOwnPrice(lineId),
        },
        customLine: {
          onField: (field, value) => setCustomDialog((now) => (now ? { ...now, draft: { ...now.draft, [field]: value }, failed: null, typed: true } : now)),
          onSave: () => void saveCustom(),
          onClose: () => setCustomDialog((now) => (now?.busy ? now : null)),
        },
        person: {
          onField: (field, value) => setPersonDialog((now) => (now ? { ...now, draft: { ...now.draft, [field]: value }, failed: null, typed: true } : now)),
          onSave: () => void savePerson(),
          onClose: () => setPersonDialog((now) => (now?.busy ? now : null)),
        },
        // ---- end F-CP-154
        // F-CP-150: a chip of the checklist — its part's card, scrolled into view and focused.
        onChip: (target) => {
          const element = document.getElementById(target)
          element?.scrollIntoView({ block: 'start', behavior: 'smooth' })
          element?.focus({ preventScroll: true })
        },
      }}
    >
      {/* F-CP-150 (D10): the draft's ONE conversation, docked from its first save; it stays once the draft is sent. */}
      {record && draftId && phase !== 'start' ? <PortalThread type="PortalOrderRequest" id={record.request.id} /> : null}
    </NewOrderView>
  )
}
