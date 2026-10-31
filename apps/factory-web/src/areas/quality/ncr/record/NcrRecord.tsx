'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isApiError } from '../../../../lib/api/errors'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { downloadLink } from '../../../../record-panels/api'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { useLive, useRecordTab } from '../../_shared/hooks'
import {
  addAction,
  addDecision,
  approveDecision,
  cancelAction,
  cancelNcr,
  carryOut,
  closeNcrHold,
  defectPicker,
  dispositionCodes,
  doneAction,
  editAction,
  editDecision,
  editNcr,
  findClaims,
  findRepairs,
  getNcr,
  linkRecord,
  listPeople,
  listSites,
  moveNcr,
  ncrPhotos,
  newIdempotencyKey,
  openRegisterEntry,
  reasonsOf,
  removeDecision,
  reworkFromDecision,
  searchLinkable,
  stockOf,
  unlinkRecord,
  uploadPhoto,
  workOrderOperations,
  type NcrLinkType,
  type NcrPhoto,
  type NcrRecord as NcrRecordValue,
  type Person,
} from '../api'
import { useCloseFlow } from '../close'
import { instantOf, ncrCan, readProblem, RECORD_TABS, refusalOf, type Say } from '../model'
import type { NcrNotice } from '../parts'
import {
  changesOf,
  choicesOf,
  draftOf,
  holdBodyOf,
  holdSubjects,
  NO_CHOICES,
  quantityValue,
  stockLinesOf,
  carryBodyOf,
  carryKindOf,
  TIME_ZONE,
  type CellState,
  type Choices,
  type Loaded,
  type NcrRecordActions,
  type NcrRecordModel,
  type ProblemDraft,
  type RecordChoices,
  type RecordDialog,
} from './view-model'
import { NcrRecordView } from './view/NcrRecordView'

/**
 * `/w/<company>/quality/ncr/<id>` (SCR-145; `?tab=problem|containment|disposition|linked|activity`): the NCR read once
 * and again on its live changes (any `ncr.` event that names it; while a dialog holds work, a banner says it changed
 * instead); the people who may own it; its site and photos; the pickers each dialog needs, read when it opens. Every write
 * is one call with its own Idempotency-Key and the version read (the NCR's; an action's or a decision's for theirs); the
 * answer is the record as it is now. A stale version reads the record again and says so. Closing is the shared close
 * flow (the checklist, then the office's step-up).
 */
export function NcrRecord({ ncrId }: { ncrId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => ncrCan(session.permissions), [session.permissions])
  const tab = useRecordTab(RECORD_TABS)

  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [opened] = useState(() => new Date().toISOString())
  const [people, setPeople] = useState<readonly Person[] | null>(null)
  const [site, setSite] = useState<{ code: string; name: string } | null>(null)
  const [photos, setPhotos] = useState<Choices<NcrPhoto>>({ items: null, problem: null })
  const [uploading, setUploading] = useState(0)
  const [draft, setDraft] = useState<ProblemDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [cells, setCells] = useState<Record<string, CellState>>({})
  const [choices, setChoices] = useState<RecordChoices>(NO_CHOICES)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [notice, setNotice] = useState<NcrNotice | null>(null)
  const [stale, setStale] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const record = loaded.status === 'ready' ? loaded.record : null
  const current = useRef<NcrRecordValue | null>(null)
  current.current = record
  const dialogRef = useRef<RecordDialog | null>(null)
  dialogRef.current = dialog
  const doneFile = useRef<File | null>(null)
  const carryKey = useRef<string | null>(null)
  const asked = useRef(new Set<keyof RecordChoices>())

  const take = useCallback((next: NcrRecordValue) => {
    setLoaded({ status: 'ready', record: next })
    setAsOf(new Date().toISOString())
    setStale(null)
  }, [])

  const load = useCallback(async () => {
    try {
      take(await getNcr(api, ncrId))
    } catch (error) {
      setLoaded(isApiError(error) && error.kind === 'not_found' ? { status: 'notFound' } : isApiError(error) && error.kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) })
    }
  }, [api, ncrId, take])

  useEffect(() => {
    if (!can.view) {
      setLoaded({ status: 'forbidden' })
      return
    }
    void load()
  }, [load, can.view])

  // The people who may own it (who may be given work on it), else every office person one may name.
  useEffect(() => {
    if (!can.view || !can.people) return
    listPeople(api, { type: 'Nonconformance', id: ncrId })
      .catch(() => listPeople(api, null))
      .then(setPeople)
      .catch(() => setPeople(null))
  }, [api, ncrId, can.view, can.people])

  const companyId = record?.ncr.companyId ?? null
  const siteId = record?.ncr.siteId ?? null
  useEffect(() => {
    if (!siteId || !can.locationsView) return
    listSites(api, companyId)
      .then((sites) => {
        setChoices((now) => ({ ...now, sites: choicesOf(sites) }))
        const found = sites.find((entry) => entry.id === siteId)
        setSite(found ? { code: found.code, name: found.name } : null)
      })
      .catch((error: unknown) => setChoices((now) => ({ ...now, sites: { items: null, problem: readProblem(error) } })))
  }, [api, companyId, siteId, can.locationsView])

  const readPhotos = useCallback(() => {
    if (!can.filesRead) {
      setPhotos({ items: [], problem: null })
      return
    }
    ncrPhotos(api, ncrId)
      .then((items) => setPhotos({ items, problem: null }))
      .catch((error: unknown) => setPhotos({ items: null, problem: readProblem(error) }))
  }, [api, ncrId, can.filesRead])
  useEffect(() => {
    if (can.view) readPhotos()
  }, [readPhotos, can.view])

  const live = useLive(
    (change) => {
      if (!change.type.startsWith('ncr.') && !change.type.startsWith('quality.hold')) return
      if (change.fields.ncrId !== ncrId) return
      if (dialogRef.current) setStale(formatTime(new Date(), { locale }))
      else void load()
    },
    () => void load(),
  )

  // ---- the pickers (each read once, when a dialog first needs it) -------------------------------------------------------
  const need = useCallback(
    (choice: keyof RecordChoices) => {
      const ncr = current.current?.ncr
      if (asked.current.has(choice) && choice !== 'stock' && choice !== 'repairs' && choice !== 'claims') return
      asked.current.add(choice)
      const put = <T,>(key: keyof RecordChoices, work: Promise<readonly T[]>) => {
        setChoices((now) => ({ ...now, [key]: { items: null, problem: null } }))
        work.then((items) => setChoices((now) => ({ ...now, [key]: choicesOf(items) }))).catch((error: unknown) => setChoices((now) => ({ ...now, [key]: { items: null, problem: readProblem(error) } })))
      }
      if (choice === 'defects') put(choice, defectPicker(api))
      else if (choice === 'dispositions') put(choice, can.defectsView ? dispositionCodes(api) : Promise.reject(new Error('no right')))
      else if (choice === 'holdReasons') put(choice, reasonsOf(api, 'HOLD'))
      else if (choice === 'claimReasons') put(choice, reasonsOf(api, 'CLAIM'))
      else if (choice === 'stock' && ncr) put(choice, can.stockView && (ncr.lot || ncr.item) ? stockOf(api, { siteId: ncr.siteId, lotId: ncr.lot?.id ?? null, itemId: ncr.lot ? null : (ncr.item?.id ?? null) }) : Promise.resolve([]))
      else if (choice === 'operations' && ncr?.workOrder) put(choice, workOrderOperations(api, ncr.workOrder.id))
      else if (choice === 'repairs') put(choice, can.repairsView ? findRepairs(api, '') : Promise.resolve([]))
      else if (choice === 'claims' && ncr?.supplier) put(choice, findClaims(api, { partyId: ncr.supplier.id, lotId: ncr.lot?.id ?? null }))
      else if (choice === 'sites' && !current.current) asked.current.delete(choice)
    },
    [api, can.defectsView, can.stockView, can.repairsView],
  )

  // Opening a dialog reads what it picks from.
  const openDialog = useCallback(
    (next: RecordDialog | null) => {
      if (next && (!dialogRef.current || dialogRef.current.kind !== next.kind)) {
        carryKey.current = null
        if (next.kind === 'addAction' || next.kind === 'doneAction') need('holdReasons')
        if (next.kind === 'decide') need('dispositions')
        if (next.kind === 'rework') need('operations')
        if (next.kind === 'doneAction') doneFile.current = null
        if (next.kind === 'carryOut') {
          const decision = current.current?.decisions.find((entry) => entry.id === next.decisionId)
          if (decision) {
            const kind = carryKindOf(decision)
            if (decision.disposition?.stockMoveReason) need('stock')
            if (kind === 'repair') need('repairs')
            if (kind === 'claim' || kind === 'stockAndClaim') {
              need('claimReasons')
              need('claims')
            }
          }
        }
      }
      if (!next) setStale(null)
      setDialog(next)
    },
    [need],
  )

  // The carry-out's lines come from where the goods lie, once that is read.
  const stockItems = choices.stock.items
  useEffect(() => {
    if (!stockItems) return
    setDialog((now) => {
      if (!now || now.kind !== 'carryOut' || now.draft.lines.length > 0) return now
      const decision = current.current?.decisions.find((entry) => entry.id === now.decisionId)
      if (!decision?.disposition?.stockMoveReason) return now
      return { ...now, draft: { ...now.draft, lines: stockLinesOf(stockItems, decision.quantity) } }
    })
  }, [stockItems, dialog?.kind])

  // ---- the close flow ---------------------------------------------------------------------------------------------------
  const closeFlow = useCloseFlow(api, (closed, holdsClosed) => {
    take(closed)
    setNotice({ say: holdsClosed > 0 ? { key: 'close.doneHolds', params: { number: closed.ncr.number, count: holdsClosed } } : { key: 'close.done', params: { number: closed.ncr.number } }, tone: 'success' })
  })

  // ---- writes -------------------------------------------------------------------------------------------------------------
  const refused = useCallback(
    (error: unknown, key: string, params?: Record<string, string | number>): NcrNotice => {
      const refusal = refusalOf(error)
      if (refusal.stale) void load()
      return { say: refusal.stale ? refusal.say : { key, params }, tone: 'danger', detail: refusal.stale ? [] : refusal.detail }
    },
    [load],
  )

  const move = useCallback(
    async (to: 'CONTAINED' | 'DECIDED') => {
      const now = current.current
      if (!now || busy) return
      setBusy(true)
      setNotice(null)
      try {
        take(await moveNcr(api, now.ncr.id, { version: now.ncr.version, to }))
        setNotice({ say: { key: 'board.moved', params: { number: now.ncr.number, stage: to } }, tone: 'success' })
      } catch (error) {
        const refusal = refusalOf(error)
        if (refusal.stale || refusal.checks.length > 0) void load()
        setNotice({ say: refusal.checks.length > 0 ? { key: 'problem.checks' } : refusal.say, tone: 'danger', detail: refusal.detail })
      } finally {
        setBusy(false)
      }
    },
    [api, busy, take, load],
  )

  const save = useCallback(async () => {
    const now = current.current
    if (!now || !draft || saving) return
    const body = changesOf(now.ncr, draft, TIME_ZONE)
    if (Object.keys(body).length === 0) {
      setDraft(null)
      return
    }
    setSaving(true)
    try {
      take(await editNcr(api, now.ncr.id, { version: now.ncr.version, ...body }))
      setDraft(null)
      setNotice({ say: { key: 'problem.saved' }, tone: 'success' })
    } catch (error) {
      setNotice(refused(error, 'problem.notSaved'))
    } finally {
      setSaving(false)
    }
  }, [api, draft, saving, take, refused])

  const cell = useCallback(
    async (key: string, work: () => Promise<NcrRecordValue>) => {
      setCells((now) => ({ ...now, [key]: { state: 'saving' } }))
      try {
        take(await work())
        setCells((now) => ({ ...now, [key]: { state: 'saved' } }))
      } catch (error) {
        setCells((now) => ({ ...now, [key]: { state: 'failed' } }))
        setNotice(refused(error, 'cell.refused'))
      }
    },
    [take, refused],
  )

  const submit = useCallback(async () => {
    const now = current.current
    const open = dialogRef.current
    if (!now || !open || open.busy) return
    const ncr = now.ncr
    setDialog({ ...open, busy: true, notice: null } as RecordDialog)
    let receipt: Say | null = null
    try {
      switch (open.kind) {
        case 'addAction': {
          const draftAction = open.draft
          const hold = draftAction.kind === 'HOLD_STOCK' && draftAction.placeHold ? holdBodyOf(draftAction.hold, holdSubjects(ncr), choices.holdReasons.items) : null
          take(
            await addAction(api, ncr.id, {
              version: ncr.version,
              kind: draftAction.kind,
              description: draftAction.description.trim() || null,
              ownerId: draftAction.ownerId || null,
              dueAt: instantOf(draftAction.dueAt, TIME_ZONE),
              ...(hold ? { hold } : {}),
            }),
          )
          receipt = { key: hold ? 'addAction.doneHold' : 'addAction.done' }
          break
        }
        case 'doneAction': {
          const action = now.containment.find((entry) => entry.id === open.actionId)
          if (!action) break
          if (doneFile.current) await uploadPhoto(api, { companyId: ncr.companyId, siteId: ncr.siteId, record: { type: 'NcrContainmentAction', id: action.id } }, doneFile.current, doneFile.current.name)
          const fresh = doneFile.current ? await getNcr(api, ncr.id) : now
          const hold = action.kind === 'HOLD_STOCK' && !action.hold ? holdBodyOf(open.hold, holdSubjects(ncr), choices.holdReasons.items) : null
          const version = fresh.containment.find((entry) => entry.id === action.id)?.version ?? action.version
          take(await doneAction(api, ncr.id, action.id, { version, evidenceNote: open.evidence.trim() || null, ...(hold ? { hold } : {}) }))
          receipt = { key: 'done.done', params: { seq: action.seq } }
          break
        }
        case 'cancelAction': {
          const action = now.containment.find((entry) => entry.id === open.actionId)
          if (!action) break
          take(await cancelAction(api, ncr.id, action.id, { version: action.version, reason: open.reason.trim() }))
          receipt = { key: 'cancelAction.done', params: { seq: action.seq } }
          break
        }
        case 'decide':
          take(await addDecision(api, ncr.id, { version: ncr.version, dispositionCodeId: open.draft.dispositionCodeId, quantity: quantityValue(open.draft.quantity), note: open.draft.note.trim() || null }))
          receipt = { key: 'decide.done' }
          break
        case 'carryOut': {
          const decision = now.decisions.find((entry) => entry.id === open.decisionId)
          const body = decision ? carryBodyOf(decision, ncr, open.draft) : null
          if (!decision || !body) break
          carryKey.current ??= newIdempotencyKey()
          const answer = await carryOut(api, ncr.id, decision.id, { version: decision.version, ...body }, carryKey.current)
          take(answer.record)
          carryKey.current = null
          receipt = { key: 'carry.done', params: { seq: decision.seq } }
          break
        }
        case 'rework': {
          const decision = now.decisions.find((entry) => entry.id === open.decisionId)
          if (!decision) break
          carryKey.current ??= newIdempotencyKey()
          const answer = await reworkFromDecision(api, ncr.id, decision.id, { version: decision.version, reworkAtOperationId: open.operationId, ...(open.description.trim() ? { description: open.description.trim() } : {}) }, carryKey.current)
          take(answer.record)
          carryKey.current = null
          receipt = { key: 'rework.done', params: { seq: decision.seq } }
          break
        }
        case 'removeDecision': {
          const decision = now.decisions.find((entry) => entry.id === open.decisionId)
          if (!decision) break
          take(await removeDecision(api, ncr.id, decision.id, decision.version))
          receipt = { key: 'remove.done', params: { seq: decision.seq } }
          break
        }
        case 'link':
          if (!open.picked) break
          take(await linkRecord(api, ncr.id, { version: ncr.version, recordType: open.picked.recordType as NcrLinkType, recordId: open.picked.recordId, note: open.note.trim() || null }))
          receipt = { key: 'link.done', params: { label: open.picked.number ?? open.picked.title } }
          break
        case 'closeHold':
          take(await closeNcrHold(api, ncr.id, open.holdId, { version: ncr.version, note: open.note.trim() }))
          receipt = { key: 'closeHold.done' }
          break
        case 'cancelNcr':
          take(await cancelNcr(api, ncr.id, { version: ncr.version, reason: open.reason.trim() }))
          receipt = { key: 'cancelNcr.done', params: { number: ncr.number } }
          break
        case 'register':
          take(await openRegisterEntry(api, ncr.id, { version: ncr.version, description: open.description.trim() || null }))
          receipt = { key: 'register.done' }
          break
      }
      doneFile.current = null
      setDialog(null)
      setStale(null)
      if (receipt) setNotice({ say: receipt, tone: 'success' })
    } catch (error) {
      const refusal = refusalOf(error)
      if (refusal.stale) void load()
      // A refusal wrote nothing: the next attempt is a new command. No answer at all: the same key again (never twice).
      if (!isApiError(error) || error.kind !== 'unavailable') carryKey.current = null
      setDialog((dialogNow) => (dialogNow ? ({ ...dialogNow, busy: false, notice: { say: refusal.say, tone: 'danger', detail: refusal.detail } } as RecordDialog) : dialogNow))
    }
  }, [api, choices.holdReasons.items, take, load])

  const approve = useCallback(
    async (decisionId: string) => {
      const now = current.current
      const decision = now?.decisions.find((entry) => entry.id === decisionId)
      if (!now || !decision) return
      setNotice(null)
      try {
        take(await approveDecision(api, now.ncr.id, decision.id, { version: decision.version }))
        setNotice({ say: { key: 'disposition.approved', params: { seq: decision.seq } }, tone: 'success' })
      } catch (error) {
        setNotice(refused(error, 'disposition.notApproved', { seq: decision.seq }))
      }
    },
    [api, take, refused],
  )

  const unlink = useCallback(
    async (linkId: string) => {
      const now = current.current
      if (!now) return
      try {
        take(await unlinkRecord(api, now.ncr.id, linkId, now.ncr.version))
        setNotice({ say: { key: 'linked.unlinked' }, tone: 'success' })
      } catch (error) {
        setNotice(refused(error, 'linked.notUnlinked'))
      }
    },
    [api, take, refused],
  )

  const addPhotos = useCallback(
    async (files: readonly File[]) => {
      const now = current.current
      if (!now) return
      setUploading(files.length)
      let failed = 0
      for (const file of files) {
        try {
          await uploadPhoto(api, { companyId: now.ncr.companyId, siteId: now.ncr.siteId, record: { type: 'Nonconformance', id: now.ncr.id } }, file, file.name)
        } catch {
          failed += 1
        }
        setUploading((count) => Math.max(0, count - 1))
      }
      setNotice(failed > 0 ? { say: { key: 'photos.notAdded', params: { count: failed } }, tone: 'danger' } : { say: { key: 'photos.added', params: { count: files.length } }, tone: 'success' })
      readPhotos()
    },
    [api, readPhotos],
  )

  const openPhoto = useCallback(
    async (photo: NcrPhoto) => {
      try {
        const answer = await downloadLink(api, photo.id)
        const url = answer.download.url
        window.open(url.startsWith('/') && !url.startsWith('//') ? `/api${url}` : url, '_blank', 'noopener')
      } catch (error) {
        setNotice(refused(error, 'photos.notOpened'))
      }
    },
    [api, refused],
  )

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const findLink = useCallback(
    (query: string) => {
      setDialog((now) => (now?.kind === 'link' ? { ...now, query, picked: null } : now))
      if (searchTimer.current) clearTimeout(searchTimer.current)
      if (query.trim().length < 2) {
        setDialog((now) => (now?.kind === 'link' ? { ...now, hits: null, searching: false } : now))
        return
      }
      searchTimer.current = setTimeout(() => {
        setDialog((now) => (now?.kind === 'link' ? { ...now, searching: true } : now))
        searchLinkable(api, query.trim())
          .then((hits) => setDialog((now) => (now?.kind === 'link' && now.query === query ? { ...now, hits, searching: false } : now)))
          .catch(() => setDialog((now) => (now?.kind === 'link' ? { ...now, hits: [], searching: false } : now)))
      }, 250)
    },
    [api],
  )

  const repairTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const findRepairsNow = useCallback(
    (query: string) => {
      if (repairTimer.current) clearTimeout(repairTimer.current)
      repairTimer.current = setTimeout(() => {
        setChoices((now) => ({ ...now, repairs: { items: null, problem: null } }))
        findRepairs(api, query)
          .then((items) => setChoices((now) => ({ ...now, repairs: choicesOf(items) })))
          .catch((error: unknown) => setChoices((now) => ({ ...now, repairs: { items: null, problem: readProblem(error) } })))
      }, 250)
    },
    [api],
  )

  const actions: NcrRecordActions = {
    onRetry: () => {
      setLoaded({ status: 'loading' })
      void load()
    },
    onReload: () => void load(),
    onDraft: (patch) => {
      if (!record) return
      setDraft((now) => ({ ...(now ?? draftOf(record.ncr, TIME_ZONE)), ...patch }))
    },
    onDiscard: () => setDraft(null),
    onSave: () => void save(),
    onMove: (to) => void move(to),
    onClose: () => {
      if (!record) return
      void closeFlow.open({ id: record.ncr.id, number: record.ncr.number }, can.close ? null : { key: 'held.noClose' }, record)
    },
    onCopy: () => {
      if (!record) return
      void navigator.clipboard
        ?.writeText(record.ncr.number)
        .then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        })
        .catch(() => undefined)
    },
    onKeys: setKeysOpen,
    onDialog: openDialog,
    onSubmitDialog: () => void submit(),
    onNeed: need,
    onFindLink: findLink,
    onFindRepairs: findRepairsNow,
    onPhotos: (files) => void addPhotos(files),
    onOpenPhoto: (photo) => void openPhoto(photo),
    onActionCell: (actionId, change, name) => {
      const now = current.current
      const action = now?.containment.find((entry) => entry.id === actionId)
      if (!now || !action) return
      void cell(`${actionId}:${name}`, () => editAction(api, now.ncr.id, actionId, { version: action.version, ...change }))
    },
    onDecisionCell: (decisionId, change, name) => {
      const now = current.current
      const decision = now?.decisions.find((entry) => entry.id === decisionId)
      if (!now || !decision) return
      void cell(`${decisionId}:${name}`, () => editDecision(api, now.ncr.id, decisionId, { version: decision.version, ...change }))
    },
    onApprove: (decisionId) => void approve(decisionId),
    onUnlink: (linkId) => void unlink(linkId),
    onDoneFile: (file) => {
      doneFile.current = file
      setDialog((now) => (now?.kind === 'doneAction' ? { ...now, photoName: file?.name ?? null } : now))
    },
    onDismissNotice: () => setNotice(null),
    close: closeFlow.actions,
    onStepUp: (code) => void closeFlow.submitStepUp(code),
    onStepUpCancel: closeFlow.cancelStepUp,
  }

  const model: NcrRecordModel = {
    prefix,
    me: session.user.id,
    can,
    tab,
    loaded,
    timeZone: TIME_ZONE,
    now: asOf ?? opened,
    live,
    asOf,
    people,
    site,
    photos,
    uploading,
    draft,
    saving,
    cells,
    choices,
    dialog,
    notice,
    stale,
    busy,
    close: closeFlow.dialog,
    stepUp: closeFlow.stepUp,
    keysOpen,
    copied,
  }

  const panels = record && tab === 'activity' ? <RecordPanels record={{ type: 'Nonconformance', id: record.ncr.id, companyId: record.ncr.companyId, siteId: record.ncr.siteId }} title={`${record.ncr.number} · ${record.ncr.title}`} /> : null
  return <NcrRecordView model={model} actions={actions} panels={panels} />
}
