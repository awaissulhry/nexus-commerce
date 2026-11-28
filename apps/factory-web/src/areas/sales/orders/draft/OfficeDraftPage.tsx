'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { useLiveBus } from '../../../../shell/live/use-live'
import { WithMessages } from '../../../../record-panels/i18n'
import { useT } from '../../../../lib/i18n/provider'
import { COMPOSE_NS } from '../../../../lib/request-compose/model'
import { heldProblem } from '../../../../lib/request-compose/files'
import { contentTypeOf } from '../../../../lib/record-thread/attachments/model'
import { putToStore, sha256Hex, StoreError } from '../../../../record-panels/store'
import { TYPING_PAUSE_MS, changedByOf, choicesTyped, customLinesOf, draftFileCount, draftFilesOf, DRAFT_FILES_MAX, draftTitleOf, headerChanges, headerDirty, headerDraftOf, headerProblem, HEADER_FIELDS, optionHeld, personBody, personChanges, personDraftOf, personProblems, productRowsOf, sizesBody, todayIn, type HeaderDraft, type HeaderField, type PersonDraft } from '../../../../lib/order-draft/model'
import type { CustomLineFields, DraftChoice, DraftFile, DraftFilePart, DraftRecord, SavedBy } from '../../../../lib/order-draft/schema'
import { DRAFT_NS, DraftDoorProvider, useDraftWords } from '../../../../lib/order-draft/words'
import type { UploadRow } from '../../../../lib/order-draft/view/files'
import { piecesOpenOf, type PiecesMode } from '../../../../lib/order-draft/view/RowWindows'
import { CUSTOM_LINE_LIMITS } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { STYLE_CODE } from '@nexus/factory-domain/product/styles/rules'
import { findStyles, listRequestCustomers, listScales, readStyle, type ScaleOption, type StyleDetail } from '../../inquiries/api'
import { mapStylesOf } from '../../inquiries/catalogue-model'
import type { StyleDraftDraft } from '../../inquiries/model'
import { listCustomerDrafts, type DraftRow } from '../../customers/record/drafts/api'
import { officeDraftHref } from '../../customers/record/drafts/model'
import { confirmDraft, createOfficeDraft, makeDraftStyle, officeDraftPort, readOfficeRequest, type ConfirmAnswer, type ConfirmBody, type OfficeRead } from './api'
import { confirmBodyOf, confirmHeldOf, confirmRowsOf, type ConfirmEntry } from './confirm-model'
import { OfficeDraftView } from './view/OfficeDraftView'
import { OfficeRecordThread } from '../../../_shared/record-thread/OfficeRecordThread'
// ---- owb-of5 step 1 (L3: Draft and Sent keep this page; of5 puts the order band on it): the band's read (owb-of1 Shape) and the picture's ports
import { readRequestBand, type RequestBand } from '../record/band/api'
import { orderPicturePath, orderPictureSaver, pictureReader } from '../../../../lib/record-picture/api'
import { pictureKindOf, type PictureChoice } from '../../../../lib/record-picture/order-picture'
// ---- end owb-of5

/**
 * `/w/<co>/sales/orders/new` (no `?party=`) — the office's door to the ONE draft order (THE SIMPLE ORDER START, od-w2.1; R1–R3): the
 * start (the customer picked above the mail, nothing else required; the first input makes the draft for THAT customer) and the draft
 * `?draft=<id>`: the same shared page the portal draws, in the office's record frame with the draft's office thread (office notes
 * allowed), its host cards in ONE row under Still open — Confirm order (+ the Confirm window: what the rows left open), Design work
 * (Make style draft) and Price (the price grain only). Every write is the SAME draft command the portal calls, on the office's routes,
 * at the draft's version; the customer's live portal page hears it. `orders.manage` writes; `orders.view` reads (read only, said).
 */
export function OfficeDraftPage() {
  return (
    <WithMessages namespaces={[DRAFT_NS, 'ds-words', 'lists', 'records', 'orders' /* od-fx8 W-02: the band's ‹ Orders, New order */, 'sales-inquiries', COMPOSE_NS]}>
      {/* The office's whole word set (its voice) for the container's own words too. */}
      <DraftDoorProvider door="office">
        <OfficeDraftContainer />
      </DraftDoorProvider>
    </WithMessages>
  )
}

type Load = 'loading' | 'error' | 'missing' | 'ready'
interface PiecesState {
  rowId: string
  mode: PiecesMode
  total: string
  cells: Record<string, number>
  typed?: boolean
  busy: boolean
  failed: string | null
}
interface OptionsState {
  rowId: string
  topic: string
  typed: string
  busy: boolean
  failed: string | null
}
interface PersonState {
  lineId: string
  personId: string | null
  draft: PersonDraft
  typed?: boolean
  showProblems: boolean
  busy: boolean
  failed: string | null
}
export interface ConfirmState {
  entries: Record<string, ConfirmEntry>
  busy: boolean
  failed: string | null
}
interface StyleState {
  draft: StyleDraftDraft
  scales: { status: 'loading' } | { status: 'ready'; value: readonly ScaleOption[] } | { status: 'error'; problem: string }
  busy: boolean
  failed: string | null
}

const kindOf = (error: unknown): string | null => (isApiError(error) ? error.kind : null)

function OfficeDraftContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const search = useSearchParams()
  const words = useDraftWords()
  const { t, locale } = words
  const tc = useT(COMPOSE_NS)
  const port = useMemo(() => officeDraftPort(api), [api])
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? null
  const may = (permission: string) => session.permissions.includes(permission)
  const manages = may('orders.manage')
  const draftId = search?.get('draft') ?? null
  const today = useMemo(() => todayIn(), [])

  // ── state ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const [partyId, setPartyId] = useState<string | null>(null)
  const [customers, setCustomers] = useState<{ state: 'loading' | 'error' | 'ready'; rows: { id: string; label: string }[] }>({ state: 'loading', rows: [] })
  const [drafts, setDrafts] = useState<{ state: 'off' | 'loading' | 'error' | 'ready'; rows: DraftRow[] }>({ state: 'off', rows: [] })
  const [load, setLoad] = useState<Load>(draftId ? 'loading' : 'ready')
  const [record, setRecord] = useState<DraftRecord | null>(null)
  const [office, setOffice] = useState<OfficeRead | null>(null)
  const [header, setHeader] = useState<HeaderDraft>(headerDraftOf(null))
  const [headerErrors, setHeaderErrors] = useState<Partial<Record<HeaderField, string>>>({})
  const [save, setSave] = useState<SaveStatusState>({ kind: 'idle' })
  const [problem, setProblem] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [staleBy, setStaleBy] = useState<SavedBy | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [uploads, setUploads] = useState<UploadRow[]>([])
  const [pending, setPending] = useState(false)
  const [saving, setSaving] = useState<string[]>([])
  const [styles, setStyles] = useState<{ id: string; code: string; name: string }[] | null>(null)
  const [details, setDetails] = useState<Record<string, StyleDetail>>({})
  const [piecesWin, setPiecesWin] = useState<PiecesState | null>(null)
  const [optionsWin, setOptionsWin] = useState<OptionsState | null>(null)
  const [rowFilesId, setRowFilesId] = useState<string | null>(null)
  const [person, setPerson] = useState<PersonState | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [styleWin, setStyleWin] = useState<StyleState | null>(null)
  const [done, setDone] = useState<ConfirmAnswer['made'] | null>(null)
  const [band, setBand] = useState<RequestBand | null>(null) // owb-of5: the band of a Draft or Sent order (null: not read, or before of1)

  const recordRef = useRef<DraftRecord | null>(null)
  recordRef.current = record
  const headerRef = useRef(header)
  headerRef.current = header
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => (typingTimer.current ? clearTimeout(typingTimer.current) : undefined), [])
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
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const enqueue = <T,>(work: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(work, work)
    queue.current = next.catch(() => undefined)
    return next
  }
  /** Why nothing can be written now (words): a role that reads orders only. */
  const held = manages ? null : t('save.readonly')
  /** A refusal in words: the API's own sentence where it gives one, else the part's. */
  const refusalWords = (error: unknown): string => (isApiError(error) && error.message ? error.message : t('refusal.other'))

  const apply = useCallback((next: DraftRecord) => {
    recordRef.current = next
    setRecord(next)
    setStale(false)
    setProblem(null)
  }, [])
  const startFrom = useCallback((next: DraftRecord) => {
    setHeader(headerDraftOf(next.request))
    headerRef.current = headerDraftOf(next.request)
    setHeaderErrors({})
    setStale(false)
    setStaleBy(null)
    setUploads([])
  }, [])
  const refused = useCallback(
    (error: unknown) => {
      setProblem(refusalWords(error))
      if (kindOf(error) !== 'conflict') return
      setStale(true)
      const id = recordRef.current?.request.id
      if (id)
        port
          .read(id)
          .then((next) => setStaleBy(changedByOf(next.request)))
          .catch(() => undefined)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [port],
  )

  // ── reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const readOffice = useCallback((id: string) => {
    // owb-of5: the band's own read beside the office read (its number, subject, picture, life, open details, what this reader may do).
    readRequestBand(api, id)
      .then(setBand)
      .catch(() => setBand(null))
    readOfficeRequest(api, id)
      .then((read) => {
        setOffice(read)
        setPartyId(read.request.party.id)
      })
      .catch(() => setOffice(null))
  }, [api])
  const read = useCallback(async () => {
    if (!draftId) return
    try {
      const next = await port.read(draftId)
      apply(next)
      startFrom(next)
      setLoad('ready')
      readOffice(draftId)
    } catch (error) {
      setLoad(kindOf(error) === 'not_found' ? 'missing' : 'error')
    }
  }, [port, draftId, apply, startFrom, readOffice])
  useEffect(() => {
    if (!draftId) return
    if (recordRef.current?.request.id === draftId) {
      setLoad('ready')
      return
    }
    setLoad('loading')
    void read()
  }, [draftId, read])
  // The start: the company's customers (as New request picks them).
  useEffect(() => {
    // od-fx8 W-08: a reader (no orders.manage) starts no draft: no customer is read (its start says so in words).
    if (draftId || !companyId || !manages) return
    listRequestCustomers(api, companyId)
      .then((answer) => setCustomers({ state: 'ready', rows: answer.customers.map((row) => ({ id: row.id, label: `${row.code} · ${row.tradeName ?? row.legalName}` })) }))
      .catch(() => setCustomers({ state: 'error', rows: [] }))
  }, [api, companyId, draftId, manages])
  // The picked customer's drafts to continue, and its catalogue for the Product cell (its own label's styles and the open ones).
  useEffect(() => {
    if (!partyId) return
    if (!draftId) {
      setDrafts({ state: 'loading', rows: [] })
      listCustomerDrafts(api, partyId)
        .then((rows) => setDrafts({ state: 'ready', rows }))
        .catch(() => setDrafts({ state: 'error', rows: [] }))
    }
    findStyles(api, '')
      .then((all) => setStyles(mapStylesOf(all, partyId).map((style) => ({ id: style.id, code: style.code, name: style.name }))))
      .catch(() => setStyles([]))
  }, [api, partyId, draftId])

  // ── the first input makes the draft (for the picked customer) ─────────────────────────────────────────────────────────
  const making = useRef<Promise<DraftRecord> | null>(null)
  const ensureDraft = useCallback(
    (first: { subject?: string; note?: string } = {}): Promise<DraftRecord> => {
      const current = recordRef.current
      if (current) return Promise.resolve(current)
      if (making.current) return making.current
      if (!companyId || !partyId) return Promise.reject(new Error(t('start.customerHeld')))
      const made = (async () => {
        const next = await createOfficeDraft(api, { companyId, partyId, ...first }, keyFor('create', { partyId, first }))
        apply(next)
        startFrom(next)
        setLoad('ready')
        readOffice(next.request.id)
        router.replace(officeDraftHref(prefix, next.request.id), { scroll: false })
        return next
      })()
      making.current = made
      made.catch(() => undefined).finally(() => {
        making.current = null
      })
      return made
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, companyId, partyId, apply, startFrom, readOffice, router, prefix],
  )

  const write = useCallback(
    async (name: string, call: (version: number, key: string) => Promise<DraftRecord>, onError?: (error: unknown) => void): Promise<DraftRecord | null> => {
      if (held) return null
      try {
        return await enqueue(async () => {
          const version = recordRef.current!.request.version
          const next = await call(version, keyFor(name, { version, at: name }))
          apply(next)
          setSave({ kind: 'saved', at: next.request.updatedAt })
          return next
        })
      } catch (error) {
        if (onError) onError(error)
        else refused(error)
        return null
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [held, apply, refused],
  )

  // ── the header (the mail, Date and delivery) ──────────────────────────────────────────────────────────────────────────
  const saveHeader = useCallback(
    (field?: HeaderField): Promise<boolean> => {
      const current = recordRef.current
      const typed = headerRef.current
      if (!current) {
        const subject = typed.subject.trim()
        const note = typed.note.trim()
        if ((subject === '' && note === '') || held || !partyId) return Promise.resolve(true)
        setSave({ kind: 'saving' })
        return ensureDraft({ ...(subject ? { subject } : {}), ...(note ? { note } : {}) })
          .then((next) => {
            setSave({ kind: 'saved', at: next.request.updatedAt })
            return true
          })
          .catch((error: unknown) => {
            setSave({ kind: 'failed', reason: refusalWords(error) })
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
      setSave({ kind: 'saving' })
      return write(`head:${JSON.stringify(body)}`, (version, key) => port.header(current.request.id, { version, ...body }, key)).then((next) => next !== null)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [held, partyId, ensureDraft, write, port, today],
  )

  // ── the products table ────────────────────────────────────────────────────────────────────────────────────────────────
  const rowOf = (rowId: string) => (recordRef.current ? productRowsOf(recordRef.current.request, locale).find((row) => row.id === rowId) : undefined)
  const writeRow = async (rowId: string | null, fields: CustomLineFields, onError?: (error: unknown) => void): Promise<DraftRecord | null> => {
    if (held) return null
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
  const remove = (rowId: string) => {
    const id = recordRef.current?.request.id
    if (id) void write(`remove:${rowId}`, (version, key) => port.removeLine(id, rowId, version, key))
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
        setPiecesWin({ ...win, failed: t('draftPage.customLine.problem.total') })
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
    const next = await writeRow(win.rowId, fields, (error) => {
      failed = refusalWords(error)
      if (kindOf(error) === 'conflict') setStale(true)
    })
    if (next) setPiecesWin(null)
    else setPiecesWin((now) => (now ? { ...now, busy: false, failed: failed ?? t('refusal.other') } : now))
  }
  const writeChoices = async (rowId: string, choices: DraftChoice[]) => {
    setOptionsWin((now) => (now ? { ...now, busy: true, failed: null } : now))
    let failed: string | null = null
    const next = await writeRow(rowId, { choices }, (error) => {
      failed = refusalWords(error)
    })
    setOptionsWin((now) => (now ? { ...now, busy: false, failed: next ? null : (failed ?? t('refusal.other')) } : now))
    return next !== null
  }

  // ── people (a custom size's roster) ───────────────────────────────────────────────────────────────────────────────────
  const openPerson = (lineId: string, personId: string | null = null) => {
    const line = recordRef.current ? customLinesOf(recordRef.current.request).find((entry) => entry.id === lineId) : undefined
    if (!line) return
    const found = personId ? (line.people.find((entry) => entry.id === personId) ?? null) : null
    setPiecesWin(null)
    setPerson({ lineId, personId: found?.id ?? null, draft: personDraftOf(found), showProblems: false, busy: false, failed: null })
  }
  const savePerson = async () => {
    const current = recordRef.current
    if (!current || !person || person.busy) return
    const sheets = draftFilesOf(current.request).sheets
    if (Object.keys(personProblems(person.draft, sheets)).length > 0) {
      setPerson({ ...person, showProblems: true })
      return
    }
    const line = customLinesOf(current.request).find((entry) => entry.id === person.lineId)
    const found = person.personId ? line?.people.find((entry) => entry.id === person.personId) : undefined
    const changes = found ? personChanges(found, person.draft) : null
    if (!line || (changes && Object.keys(changes).length === 0)) {
      setPerson(null)
      return
    }
    setPerson({ ...person, busy: true, failed: null })
    let failed: string | null = null
    const body = personBody(person.draft)
    const next =
      found && changes
        ? await write(`person:${found.id}:${JSON.stringify(changes)}`, (version, key) => port.changePerson(current.request.id, line.id, found.id, { version, ...changes }, key), (error) => (failed = refusalWords(error)))
        : await write(`person:new:${line.id}:${JSON.stringify(body)}`, (version, key) => port.addPeople(current.request.id, line.id, { version, people: [body] }, key), (error) => (failed = refusalWords(error)))
    if (next) setPerson(null)
    else setPerson((now) => (now ? { ...now, busy: false, failed: failed ?? t('refusal.other') } : now))
  }

  // ── files (the mail's Attachments, a row's files, the Logo mark) ──────────────────────────────────────────────────────
  const failureOf = (error: unknown): string => {
    if (error instanceof StoreError) return tc('files.failed.store')
    if (!isApiError(error)) return tc('files.failed.network')
    const refusal = error.issues.find((issue) => issuePath(issue).replace(/\./g, '/').startsWith('refusal/'))
    return refusal?.message ?? refusalWords(error)
  }
  const addFiles = async (part: DraftFilePart, list: readonly File[], lineId: string | null = null) => {
    if (list.length === 0 || held) return
    const current = await ensureDraft().catch((error: unknown) => {
      refused(error)
      return null
    })
    if (!current) return
    let room = DRAFT_FILES_MAX - draftFileCount(current.request)
    for (const file of list) {
      const key = newIdempotencyKey()
      const contentType = contentTypeOf(file).split(';')[0]!.trim().toLowerCase()
      const found = room <= 0 ? null : heldProblem({ name: file.name, type: contentType, size: file.size })
      const why = room <= 0 ? t('draftPage.files.full') : found ? tc(found.key, found.params) : null
      if (why) {
        setUploads((rows) => [...rows, { key, part, lineId, name: file.name, state: 'failed', failure: why }])
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
    const next = await port.read(current.request.id).catch(() => null)
    if (next) apply(next)
  }
  const removeFile = (file: DraftFile) => {
    const id = recordRef.current?.request.id
    if (id) void write(`removeFile:${file.id}:${file.version}`, (_version, key) => port.removeFile(id, file.id, file.version, key))
  }
  const markLogo = (file: DraftFile, on: boolean) => {
    const id = recordRef.current?.request.id
    if (id) void write(`logo:${file.id}:${on}`, (version, key) => port.markFile(id, file.id, { version, part: on ? 'LOGO' : 'REFERENCE' }, key))
  }

  // ── Confirm (send if still a draft + the existing accept, ONE office command) ────────────────────────────────────────
  const openConfirm = () => {
    const current = recordRef.current
    if (!current) return
    const entries = Object.fromEntries(confirmRowsOf(productRowsOf(current.request, locale)).map((entry) => [entry.rowId, entry]))
    setConfirm({ entries, busy: false, failed: null })
  }
  const pickStyle = (rowId: string, styleId: string) => {
    setConfirm((now) => (now ? { ...now, entries: { ...now.entries, [rowId]: { ...now.entries[rowId]!, styleId, colourwayId: null } } } : now))
    if (styleId && !details[styleId])
      readStyle(api, styleId)
        .then((detail) => setDetails((now) => ({ ...now, [styleId]: detail })))
        .catch(() => undefined)
  }
  const sendConfirm = async () => {
    const current = recordRef.current
    if (!current || !confirm || confirm.busy) return
    const rows = productRowsOf(current.request, locale)
    if (confirmHeldOf(rows, confirm.entries)) return
    const body: Omit<ConfirmBody, 'version'> = confirmBodyOf(rows, confirm.entries, current.seesPrices)
    setConfirm({ ...confirm, busy: true, failed: null })
    try {
      const answer = await enqueue(() => confirmDraft(api, current.request.id, { version: recordRef.current!.request.version, ...body }, keyFor('confirm', { id: current.request.id, body })))
      setConfirm(null)
      setDone(answer.made)
      const next = await port.read(current.request.id).catch(() => null)
      if (next) apply(next)
    } catch (error) {
      setConfirm((now) => (now ? { ...now, busy: false, failed: refusalWords(error) } : now))
    }
  }

  // ── Design work: Make style draft (today's Incoming window) ───────────────────────────────────────────────────────────
  const openStyle = () => {
    const current = recordRef.current
    if (!current || !companyId) return
    setStyleWin({ draft: { code: '', name: draftTitleOf(current.request, t, locale).slice(0, 200), productType: '', sizeScaleId: '', season: '', fileIds: [] }, scales: { status: 'loading' }, busy: false, failed: null })
    listScales(api, companyId)
      .then((value) => setStyleWin((now) => (now ? { ...now, scales: { status: 'ready', value } } : now)))
      .catch(() => setStyleWin((now) => (now ? { ...now, scales: { status: 'error', problem: 'styleDraft.scalesFailed' } } : now)))
  }
  const styleHeld = (draft: StyleDraftDraft): string | null => (!STYLE_CODE.test(draft.code.trim().toUpperCase()) ? 'styleDraft.held.code' : !draft.productType ? 'styleDraft.held.type' : !draft.sizeScaleId ? 'styleDraft.held.scale' : null)
  const sendStyle = async () => {
    const current = recordRef.current
    if (!current || !styleWin || styleWin.busy || styleHeld(styleWin.draft)) return
    const draft = styleWin.draft
    const body = { code: draft.code.trim().toUpperCase(), ...(draft.name.trim() ? { name: draft.name.trim() } : {}), productType: draft.productType, ...(draft.sizeScaleId ? { sizeScaleId: draft.sizeScaleId } : {}), ...(draft.season.trim() ? { season: draft.season.trim() } : {}), fileIds: [...draft.fileIds] }
    setStyleWin({ ...styleWin, busy: true, failed: null })
    try {
      await enqueue(() => makeDraftStyle(api, current.request.id, { version: recordRef.current!.request.version, ...body }, keyFor('style', body)))
      setStyleWin(null)
      readOffice(current.request.id)
      const next = await port.read(current.request.id).catch(() => null)
      if (next) apply(next)
    } catch (error) {
      setStyleWin((now) => (now ? { ...now, busy: false, failed: refusalWords(error) } : now))
    }
  }

  // ── live: the customer and colleagues write this draft too ───────────────────────────────────────────────────────────
  const dirty = headerDirty(headerDraftOf(recordRef.current?.request ?? null), header) || piecesWin?.typed === true || person?.typed === true || uploads.some((row) => row.state === 'uploading')
  const recheck = useCallback(() => {
    const current = recordRef.current
    if (!current || current.request.status !== 'DRAFT') return
    port
      .read(current.request.id)
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
  useLiveBus(
    {
      onChange: (change) => {
        const current = recordRef.current
        if (!current || !change.type.startsWith('portal_order_request.') || change.fields.requestId !== current.request.id) return
        if (typeof change.fields.version === 'number' && change.fields.version <= current.request.version) return
        recheck()
      },
      onReconnect: recheck,
    },
    record !== null,
  )

  const rows = record ? productRowsOf(record.request, locale) : []
  // ---- owb-of5 step 1: the band's picture — the batch read of a portal order's picture; Save for who may (the band's may.picture,
  // else orders.manage: sales and the owner, never the designer); the draft's references and logos that may be its picture.
  const pictureRead = useMemo(() => pictureReader(api), [api])
  const requestId = record?.request.id ?? null
  const mayPicture = band ? band.may.picture : manages
  const pictureSave = useMemo(() => (requestId && mayPicture ? orderPictureSaver(api, orderPicturePath('office', 'request', requestId)) : null), [api, requestId, mayPicture])
  const pictureChoices: PictureChoice[] = record
    ? [...draftFilesOf(record.request).references, ...draftFilesOf(record.request).logos]
        .filter((file) => file.originalName !== null && (file.contentType.startsWith('image/') || file.contentType === 'application/pdf'))
        .map((file) => ({ fileId: file.id, name: file.originalName!, kind: pictureKindOf({ type: file.contentType, name: file.originalName! }), small: null }))
    : []
  // ---- end owb-of5
  const piecesRow = piecesWin ? rows.find((row) => row.id === piecesWin.rowId) : undefined
  const optionsRow = optionsWin ? rows.find((row) => row.id === optionsWin.rowId) : undefined
  const filesRow = rowFilesId ? rows.find((row) => row.id === rowFilesId) : undefined

  // The draft's office thread (office notes allowed; the customer reads its messages in the portal), docked by the record frame.
  const title = record ? draftTitleOf(record.request, t, locale, words.day) : ''
  const thread = record ? <OfficeRecordThread docked record={{ type: 'PortalOrderRequest', id: record.request.id, companyId: null }} title={title} recordLabel={title} party={office ? { id: office.request.party.id, name: office.request.party.name } : null} partyRole="customer" /> : null

  return (
    <OfficeDraftView
      thread={thread}
      model={{
        prefix,
        load: draftId ? load : 'ready',
        today,
        customer: office ? { id: office.request.party.id, code: office.request.party.code, name: office.request.party.name } : null,
        start: draftId ? null : { customers, partyId, drafts },
        record,
        office,
        header,
        headerErrors,
        save,
        writeHeld: held,
        problem,
        stale,
        staleBy,
        notice,
        pending,
        styles,
        saving,
        uploads,
        piecesWin: piecesWin && piecesRow ? { ...piecesWin, row: piecesRow } : null,
        optionsWin: optionsWin && optionsRow ? { ...optionsWin, row: optionsRow, addHeld: optionHeld(optionsRow.choices, optionsWin.topic, optionsWin.typed) } : null,
        filesRow: filesRow ?? null,
        person,
        confirm,
        details,
        styleWin: styleWin ? { ...styleWin, held: styleHeld(styleWin.draft) } : null,
        done,
        band, // owb-of5
        picture: record ? { read: pictureRead, save: pictureSave, choices: pictureChoices } : null, // owb-of5
        mayStyles: office?.may.styleDraft ?? may('product.styles.manage'),
        mayConfirm: (office?.may.confirm ?? manages) && rows.length > 0,
      }}
      actions={{
        onCustomer: (id) => {
          setPartyId(id || null)
          setStyles(null)
        },
        onContinue: (id) => router.push(officeDraftHref(prefix, id)),
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
        onReload: () => void read(),
        onRetry: () => {
          setLoad('loading')
          void read()
        },
        onRetrySave: () => void saveHeader(),
        onDismissNotice: () => setNotice(null),
        onPictureSaved: () => (recordRef.current ? readOffice(recordRef.current.request.id) : undefined), // owb-of5: the band reads its picture again
        files: { onFiles: (list) => void addFiles('REFERENCE', list, null), onRemove: removeFile, onLogo: markLogo },
        table: {
          onProduct: (rowId, value) => void writeRow(rowId, 'styleId' in value ? { styleId: value.styleId } : { description: value.words === '' ? null : value.words }),
          onSizing: (rowId, sizing) => void writeRow(rowId, { sizing }),
          onColour: (rowId, value) => void writeRow(rowId, 'colourwayId' in value ? { colourwayId: value.colourwayId } : { colourText: value.words === '' ? null : value.words }),
          onPieces: openPieces,
          onOptions: (rowId) => setOptionsWin({ rowId, topic: '', typed: '', busy: false, failed: null }),
          onFiles: (rowId) => setRowFilesId(rowId),
          onRemove: remove,
          onAdd: () => setPending(true),
          onDropPending: () => setPending(false),
        },
        pieces: {
          onMode: (mode) => setPiecesWin((now) => (now ? { ...now, mode, typed: true, failed: null } : now)),
          onTotal: (text) => setPiecesWin((now) => (now ? { ...now, total: text, typed: true, failed: null } : now)),
          onCells: (cells) => setPiecesWin((now) => (now ? { ...now, cells, typed: true } : now)),
          onSave: () => void savePieces(),
          onClose: () => setPiecesWin((now) => (now?.busy ? now : null)),
          people: {
            onAddPerson: (lineId) => openPerson(lineId),
            onChangePerson: (lineId, personId) => openPerson(lineId, personId),
            onRemovePerson: (lineId, personId) => {
              const id = recordRef.current?.request.id
              if (id) void write(`removePerson:${personId}`, (version, key) => port.removePerson(id, lineId, personId, version, key))
            },
            onFiles: (part, list, lineId) => void addFiles(part, list, lineId ?? null),
          },
        },
        options: {
          onPick: (topic, picked) => (optionsRow ? void writeChoices(optionsRow.id, optionsRow.choices.map((choice) => (choice.topic === topic ? { ...choice, picked } : choice))) : undefined),
          onRemove: (topic) => (optionsRow ? void writeChoices(optionsRow.id, optionsRow.choices.filter((choice) => choice.topic !== topic)) : undefined),
          onTopic: (text) => setOptionsWin((now) => (now ? { ...now, topic: text } : now)),
          onTyped: (text) => setOptionsWin((now) => (now ? { ...now, typed: text } : now)),
          onAdd: () => {
            const win = optionsWin
            if (!win || !optionsRow || optionHeld(optionsRow.choices, win.topic, win.typed)) return
            void writeChoices(optionsRow.id, [...optionsRow.choices, { topic: win.topic.trim(), options: choicesTyped(win.typed), picked: null }]).then((ok) => (ok ? setOptionsWin((now) => (now ? { ...now, topic: '', typed: '' } : now)) : undefined))
          },
          onClose: () => setOptionsWin(null),
        },
        rowFiles: {
          onFiles: (list) => (filesRow ? void addFiles(filesRow.sizing === 'MADE_TO_MEASURE' ? 'SHEET' : 'REFERENCE', list, filesRow.id) : undefined),
          onRemove: removeFile,
          onClose: () => setRowFilesId(null),
        },
        person: {
          onField: (field, value) => setPerson((now) => (now ? { ...now, draft: { ...now.draft, [field]: value }, failed: null, typed: true } : now)),
          onSave: () => void savePerson(),
          onClose: () => setPerson((now) => (now?.busy ? now : null)),
        },
        onStillOpen: (rowId) => {
          const element = document.getElementById(rowId ? `row-${rowId}` : 'od-date')
          element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
          element?.querySelector<HTMLElement>('input, select, button')?.focus({ preventScroll: true })
        },
        confirm: {
          onOpen: openConfirm,
          onStyle: pickStyle,
          onEntry: (rowId, patch) => setConfirm((now) => (now ? { ...now, entries: { ...now.entries, [rowId]: { ...now.entries[rowId]!, ...patch } } } : now)),
          onSend: () => void sendConfirm(),
          onClose: () => setConfirm((now) => (now?.busy ? now : null)),
        },
        style: {
          onOpen: openStyle,
          onDraft: (patch) => setStyleWin((now) => (now ? { ...now, draft: { ...now.draft, ...patch } } : now)),
          onSubmit: () => void sendStyle(),
          onClose: () => setStyleWin((now) => (now?.busy ? now : null)),
        },
      }}
    />
  )
}
