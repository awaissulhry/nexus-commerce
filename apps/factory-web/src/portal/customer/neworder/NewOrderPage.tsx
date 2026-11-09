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
  changeHeader,
  changeLine,
  createDraft,
  discardDraft,
  fetchDraft,
  fetchDrafts,
  fetchPastOrder,
  fetchPastOrders,
  fileContent,
  removeLine,
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
  sendHeld,
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
 */
export function CustomerNewOrderPage() {
  return (
    <WithMessages namespaces={[NS, 'ds-words', 'lists', 'portal-account']}>
      <NewOrderContainer />
    </WithMessages>
  )
}

type Load = 'loading' | 'error' | 'missing' | 'ready'
type Async<T> = { state: 'loading' | 'error' | 'ready'; value: T }
type Typed = Record<string, Record<string, number>>
interface SentInfo {
  number: string
  customerRef: string | null
  confirmBy: string | null
  lines: number
  pieces: number
  net: string | null
  currency: string
  seesPrices: boolean
}
type PickerState = Omit<PickerModel, 'onDraft' | 'prefix' | 'writeHeld'>
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
  const router = useRouter()
  const search = useSearchParams()
  const words = useOrderingWords()
  const { t, locale } = words
  const offline = useOffline()
  const can = useCallback((permission: string) => frame.me.permissions.includes(permission), [frame.me.permissions])
  const allowed = frame.kinds.includes('CUSTOMER') && can('portal.orderRequests.manage')
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
  }, [])

  const apply = useCallback((next: DraftRecord) => {
    recordRef.current = next
    setRecord(next)
    setStale(false)
    setProblem(null)
  }, [])

  const refused = useCallback((error: unknown) => {
    const kind = kindOf(error)
    setProblem(refusalOf(kind))
    if (kind === 'conflict') setStale(true)
  }, [])

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
      const next = await fetchDraft(api, draftId)
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
    else if (reorderParam) void startDraft('reorder', { reorder: reorderParam, line: lineParam, reuse: true })
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
          const next = await changeHeader(api, current.request.id, { version, ...body }, keyFor('head', { version, body }))
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
          const next = await changeLine(api, current.request.id, lineId, { version, ...body }, keyFor('line', { lineId, version, body }))
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
    void write(`colour:${lineId}:${colourwayId}`, (version, key) => changeLine(api, id, lineId, { version, colourwayId }, key))
  }

  const remove = async (lineId: string) => {
    const current = recordRef.current
    const line = current?.request.lines.find((entry) => entry.id === lineId)
    if (!current || !line) return
    const next = await write(`remove:${lineId}`, (version, key) => removeLine(api, current.request.id, lineId, version, key))
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
    const next = await write(`undo:${line.id}`, (version, key) => addLines(api, current.request.id, { version, lines: [body] }, key))
    if (next) setNotice({ lines: [t('notice.back', { style: line.style.code, colour: line.colourway.name })], undo: null })
  }

  const takePrices = () => {
    const id = recordRef.current?.request.id
    if (id) void write('prices', (version, key) => takeTodaysPrices(api, id, version, key))
  }

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
    const heldNow = sendHeld(now.request, { preview, offline, busy: false, emptyLine: false })
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
        number: answer.sent.number,
        customerRef: answer.request.customerRef,
        confirmBy: answer.sent.confirmBy,
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
    if (way === 'reorder' && reorder.orders.state === 'loading' && reorder.orders.rows.length === 0) readPastOrders('')
    if (way === 'reorder' && reorderParam) openPastOrder(reorderParam, lineParam)
    if (stylesParam.length > 0) openPicker(stylesParam)
    // "Pick styles" chosen for an empty draft: the picker opens by itself.
    else if (way === 'pick' && record.request.lines.length === 0) openPicker()
    if (stylesParam.length > 0 || reorderParam) router.replace(newOrderHref(frame.prefix, { draft: record.request.id, way }), { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, record?.request.id, way, stylesParam.join(','), reorderParam])

  const chooseWay = (next: Way) => {
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
      (address !== null && addressTyped(address.draft)))
  const recheck = useCallback(() => {
    const current = recordRef.current
    if (!current || current.request.status !== 'DRAFT') return
    fetchDraft(api, current.request.id)
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

  // ── the band ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const sendHeldNow = record ? sendHeld(record.request, { preview, offline, busy: busy || saving.length > 0, emptyLine: typedEmpty }) : { key: 'held.busy' }
  const sendWords = sendHeldNow ? t(sendHeldNow.key, sendHeldNow.count !== undefined ? { count: sendHeldNow.count } : undefined) : null
  usePortalBand(
    allowed
      ? newOrderBandOf({
          words,
          phase,
          prefix: frame.prefix,
          template: templateHref(locale),
          customerRef: sent?.customerRef ?? record?.request.customerRef ?? null,
          number: sent?.number ?? null,
          sendHeld: sendWords,
          discardHeld: heldWords,
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
        start: { state: drafts.state, drafts: drafts.value, choosing, held: heldWords },
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
        reorder: way === 'reorder' ? { ...reorder, currency: record?.request.currency ?? 'EUR', writeHeld: heldWords } : null,
        upload: way === 'upload' ? { sheet, templateHref: templateHref(locale), writeHeld: heldWords } : null,
        problem,
        stale,
        notice: notice ? { lines: notice.lines, undo: notice.undo !== null } : null,
        sendHeld: sendWords,
        showProblems,
        sent,
        closed: record && record.request.status !== 'DRAFT' && !sent ? { status: record.request.status, number: record.request.number, salesOrder: record.request.salesOrder } : null,
        offlineSince,
        dialogs: {
          picker: picker ? { ...picker, onDraft, prefix: frame.prefix, writeHeld: heldWords } : null,
          address: address ? { ...address, problems: addressProblems(address.draft) } : null,
          discard: discard && record ? { ...discard, lines: record.request.lines.length } : null,
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
          onDropSize: (lineId, size) => {
            const line = recordRef.current?.request.lines.find((entry) => entry.id === lineId)
            if (!line) return
            const { [size]: _drop, ...rest } = cellsRef.current[lineId] ?? Object.fromEntries(line.sizes.map((row) => [row.size, row.quantity]))
            cellsRef.current = { ...cellsRef.current, [lineId]: rest }
            setCells((now) => ({ ...now, [lineId]: rest }))
            void saveLine(lineId)
          },
          onAddStyles: () => openPicker(),
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
      }}
    />
  )
}
