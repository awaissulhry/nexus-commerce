'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { isApiError } from '../../../../lib/api/errors'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { usePathname } from 'next/navigation'
import { useCoalesced, useLive } from '../../_shared/hooks'
import {
  actionCancel,
  actionDone,
  addAction,
  addFiling,
  cancelIncident,
  editAction,
  editFiling,
  editIncident,
  fileFiling,
  makeAction,
  markSeen,
  moveIncident,
  openFilings,
  openPeople,
  photoAddress,
  readIncident,
  readMachines,
  receiptAddress,
  setFilingNeeded,
  uploadPhoto,
  uploadReceipt,
  type IncidentAction,
  type IncidentPerson,
  type InailFiling,
} from '../api'
import { editBody, filingDraftOf, filingPeople, filingPlan, incidentOfChange, incidentsCan, makeBodyOf, newActionBody, newActionDraft, problemOf, readProblemOf } from '../model'
import { RECORD_TABS, type FilingsOpen, type IncidentRecordModel, type PageNotice, type Protected, type RecordDialog, type RecordTab } from '../view-model'
import { IncidentRecordView } from './view/IncidentRecordView'

type Loaded = IncidentRecordModel['loaded']

/**
 * `/w/<company>/plant/incidents/<id>?tab=report|actions|authority` (SCR-210-record): GET /safety/incidents/:id (the record:
 * people as counts, the deadlines without their type), re-read on live incident events of this incident. Marks it "seen by
 * safety" once when the reader may manage it (POST …/seen: the record's read never writes). The protected reads (…/people/open,
 * …/filings/open) run only on the person's click after the PrivacyNote, each recorded by the API; their answers live in this
 * container's state and leave with Hide or the page. Every write: one command, the version read, its own Idempotency-Key.
 */
export function IncidentRecord({ incidentId }: { incidentId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const params = useSearchParams()
  const pathname = usePathname()
  const prefix = pathname.replace(/\/plant\/incidents\/[^/]+\/?$/, '')
  const can = useMemo(() => incidentsCan(session.permissions), [session.permissions])
  const tabParam = params.get('tab')
  const tab: RecordTab = (RECORD_TABS as readonly string[]).includes(tabParam ?? '') ? (tabParam as RecordTab) : 'report'

  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [people, setPeople] = useState<Protected<readonly IncidentPerson[]>>({ state: 'closed' })
  const [filings, setFilings] = useState<Protected<FilingsOpen>>({ state: 'closed' })
  const [edit, setEdit] = useState<IncidentRecordModel['edit']>(null)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [notice, setNotice] = useState<PageNotice | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [bulkBusy, setBulkBusy] = useState(false)
  const turn = useRef(0)
  const seenAsked = useRef(false)
  const writeKey = useRef(newIdempotencyKey())

  const read = useCallback(() => {
    const mine = ++turn.current
    return readIncident(api, incidentId).then(
      (value) => {
        if (mine !== turn.current) return
        setLoaded({ status: 'ready', value })
        setAsOf(new Date().toISOString())
      },
      (error: unknown) => {
        if (mine !== turn.current) return
        if (isApiError(error) && error.kind === 'not_found') setLoaded({ status: 'notFound' })
        else if (isApiError(error) && error.kind === 'forbidden') setLoaded({ status: 'forbidden' })
        // The plant record frame says it in the plant catalogue's words (it has no "problem.read").
        else setLoaded({ status: 'error', problem: readProblemOf(error) === 'problem.read' ? 'problem.unavailable' : readProblemOf(error) })
      },
    )
  }, [api, incidentId])

  useEffect(() => {
    setLoaded({ status: 'loading' })
    setPeople({ state: 'closed' })
    setFilings({ state: 'closed' })
    seenAsked.current = false
    void read()
  }, [read])

  const incident = loaded.status === 'ready' ? loaded.value.incident : null

  // "Seen by safety": once, when the reader keeps the incidents and nobody has seen it yet.
  useEffect(() => {
    if (!incident || seenAsked.current || !incident.canManage || incident.seen || incident.status !== 'OPEN') return
    seenAsked.current = true
    markSeen(api, incident.id, newIdempotencyKey()).then(
      () => void read(),
      () => undefined,
    )
  }, [api, incident, read])

  const reread = useCoalesced(() => void read(), 600)
  const live = useLive(
    (change) => {
      const { moves, incidentId: id } = incidentOfChange(change)
      if (moves && id === incidentId) reread()
    },
    () => reread(),
    can.view,
  )

  const fresh = () => {
    writeKey.current = newIdempotencyKey()
  }
  const failed = (error: unknown) => setDialog((current) => (current && 'busy' in current ? ({ ...current, busy: false, problem: problemOf(error) } as RecordDialog) : current))
  const busy = () => setDialog((current) => (current && 'busy' in current ? ({ ...current, busy: true, problem: null } as RecordDialog) : current))

  // ---- the protected reads -------------------------------------------------------------------------------------------------
  const openPeopleNow = async (): Promise<readonly IncidentPerson[] | null> => {
    if (!incident) return null
    setPeople({ state: 'reading' })
    try {
      const value = await openPeople(api, incident.id)
      setPeople({ state: 'open', value, at: new Date().toISOString() })
      return value
    } catch (error) {
      setPeople({ state: 'error', problem: readProblemOf(error) })
      return null
    }
  }
  const openFilingsNow = async (): Promise<FilingsOpen | null> => {
    if (!incident) return null
    setFilings({ state: 'reading' })
    try {
      const answer = await openFilings(api, incident.id)
      const value = { filings: answer.filings, rule: answer.rule, now: answer.now }
      setFilings({ state: 'open', value, at: new Date().toISOString() })
      return value
    } catch (error) {
      setFilings({ state: 'error', problem: readProblemOf(error) })
      return null
    }
  }

  /** After the note: the filings and the people (the filing dialog names its person), then the dialog on the filing due first. */
  const confirmNote = async () => {
    const then = dialog?.kind === 'peopleNote' ? dialog.then : 'filings'
    setDialog(null)
    const [openedFilings, openedPeople] = await Promise.all([filings.state === 'open' ? Promise.resolve(filings.value) : openFilingsNow(), people.state === 'open' ? Promise.resolve(people.value) : openPeopleNow()])
    if (then !== 'filings' || !openedFilings) return
    const first = openedFilings.filings.find((filing) => filing.status === 'DUE') ?? openedFilings.filings.find((filing) => filing.status === 'WAITING_CERTIFICATE') ?? null
    fresh()
    setDialog({ kind: 'filing', draft: filingDraftOf(first, filingPeople(openedPeople ?? [])), busy: false, problem: null, done: [] })
  }

  // ---- the actions ---------------------------------------------------------------------------------------------------------
  const machinesFor = useCallback(
    (siteId: string) => {
      if (!can.plantView) return
      setDialog((current) => (current?.kind === 'action' ? { ...current, machines: { status: 'loading' } } : current))
      readMachines(api, siteId).then(
        (value) => setDialog((current) => (current?.kind === 'action' ? { ...current, machines: { status: 'ready', value } } : current)),
        (error: unknown) => setDialog((current) => (current?.kind === 'action' ? { ...current, machines: { status: 'error', problem: readProblemOf(error) } } : current)),
      )
    },
    [api, can.plantView],
  )
  const actionInto = dialog?.kind === 'action' ? dialog.draft.into : null
  const actionMachines = dialog?.kind === 'action' ? dialog.machines : null
  useEffect(() => {
    if (actionInto === 'MAINTENANCE_JOB' && actionMachines === null && incident) machinesFor(incident.siteId)
  }, [actionInto, actionMachines, incident, machinesFor])

  const saveAction = async () => {
    if (!incident || dialog?.kind !== 'action' || dialog.busy) return
    const action = dialog.actionId === 'new' ? null : (incident.actions.find((entry) => entry.id === dialog.actionId) ?? null)
    busy()
    try {
      if (!action) {
        await addAction(api, incident.id, newActionBody(dialog.draft, incident, session.user.id), writeKey.current)
        setNotice({ tone: 'success', key: dialog.draft.into === 'NONE' ? 'notice.actionAdded' : `notice.made.${dialog.draft.into}` })
      } else if (dialog.mode === 'make') {
        const make = makeBodyOf(dialog.draft, incident)
        if (!make) return
        await makeAction(api, incident.id, action.id, { version: action.version, make }, writeKey.current)
        setNotice({ tone: 'success', key: `notice.made.${dialog.draft.into}` })
      } else if (dialog.mode === 'done') {
        await actionDone(api, incident.id, action.id, { version: action.version, ...(dialog.draft.evidenceNote.trim() ? { evidenceNote: dialog.draft.evidenceNote.trim() } : {}) }, writeKey.current)
        setNotice({ tone: 'success', key: 'notice.actionDone' })
      } else if (dialog.mode === 'cancel') {
        await actionCancel(api, incident.id, action.id, { version: action.version, reason: dialog.draft.reason.trim() }, writeKey.current)
        setNotice({ tone: 'success', key: 'notice.actionCancelled' })
      } else if (dialog.mode === 'edit') {
        await editAction(api, incident.id, action.id, { version: action.version, title: dialog.draft.title.trim(), dueOn: dialog.draft.dueOn || null }, writeKey.current)
        setNotice({ tone: 'success', key: 'notice.actionSaved' })
      }
      fresh()
      setDialog(null)
      void read()
    } catch (error) {
      failed(error)
    }
  }

  const bulkDone = async (picked: readonly IncidentAction[]) => {
    if (!incident || bulkBusy || picked.length === 0) return
    setBulkBusy(true)
    let done = 0
    const refused: { label: string; key: string }[] = []
    for (const action of picked) {
      try {
        await actionDone(api, incident.id, action.id, { version: action.version }, newIdempotencyKey())
        done += 1
      } catch (error) {
        refused.push({ label: `${action.seq}. ${action.title}`, key: problemOf(error).key })
      }
    }
    setBulkBusy(false)
    setSelected([])
    setNotice({ tone: refused.length > 0 ? 'warning' : 'success', key: 'notice.actionsDone', params: { count: done }, refused })
    void read()
  }

  // ---- the filing ----------------------------------------------------------------------------------------------------------
  const saveFiling = async () => {
    if (!incident || dialog?.kind !== 'filing' || dialog.busy) return
    const opened = filings.state === 'open' ? filings.value.filings : []
    const filing: InailFiling | null = dialog.draft.filingId === 'new' ? null : (opened.find((entry) => entry.id === dialog.draft.filingId) ?? null)
    const plan = filingPlan(dialog.draft, filing)
    busy()
    const done: string[] = [...dialog.done]
    try {
      let target: { id: string; version: number } | null = filing ? { id: filing.id, version: filing.version } : null
      if (plan.add && !done.includes('add')) {
        const added = await addFiling(api, incident.id, plan.add, `${writeKey.current}.add`)
        target = added[added.length - 1] ?? null
        done.push('add')
      }
      if (plan.edit && target && !done.includes('edit')) {
        const answer = await editFiling(api, incident.id, target.id, { version: target.version, ...plan.edit }, `${writeKey.current}.edit`)
        target = { id: answer.filing.id, version: answer.filing.version }
        done.push('edit')
      }
      if (plan.file && target && !done.includes('file')) {
        const answer = await fileFiling(api, incident.id, target.id, { version: target.version, ...plan.file }, `${writeKey.current}.file`)
        target = { id: answer.id, version: answer.version }
        done.push('file')
      }
      if (plan.receipt && target && !done.includes('receipt')) {
        await uploadReceipt(api, incident.id, target.id, plan.receipt, `${writeKey.current}.receipt`)
        done.push('receipt')
      }
      fresh()
      setDialog(null)
      setNotice({ tone: 'success', key: plan.file ? 'notice.filed' : 'notice.filingSaved' })
      await read()
      await openFilingsNow()
    } catch (error) {
      setDialog((current) => (current?.kind === 'filing' ? { ...current, busy: false, problem: problemOf(error), done } : current))
    }
  }

  const setNeeded = async (filing: InailFiling, needed: boolean) => {
    if (!incident) return
    try {
      await setFilingNeeded(api, incident.id, filing.id, needed, filing.version, newIdempotencyKey())
      setNotice({ tone: 'success', key: needed ? 'notice.needed' : 'notice.notNeeded' })
      await read()
      await openFilingsNow()
    } catch (error) {
      setNotice({ tone: 'danger', key: problemOf(error).key })
    }
  }

  // ---- the record's own writes ---------------------------------------------------------------------------------------------
  const move = async (kind: 'close' | 'reopen') => {
    if (!incident || (dialog?.kind !== 'close' && dialog?.kind !== 'reopen') || dialog.busy) return
    busy()
    try {
      await moveIncident(api, incident.id, kind, incident.version, writeKey.current)
      fresh()
      setDialog(null)
      setNotice({ tone: 'success', key: kind === 'close' ? 'notice.closed' : 'notice.reopened', params: { number: incident.number } })
      void read()
    } catch (error) {
      failed(error)
    }
  }
  const cancel = async () => {
    if (!incident || dialog?.kind !== 'cancel' || dialog.busy) return
    busy()
    try {
      await cancelIncident(api, incident.id, { version: incident.version, reason: dialog.reason.trim() }, writeKey.current)
      fresh()
      setDialog(null)
      setNotice({ tone: 'success', key: 'notice.cancelled', params: { number: incident.number } })
      void read()
    } catch (error) {
      failed(error)
    }
  }
  const saveEdit = async () => {
    if (!incident || !edit || edit.busy) return
    const body = editBody(incident, edit.draft)
    if (!body) return
    setEdit({ ...edit, busy: true, problem: null })
    try {
      await editIncident(api, incident.id, body, writeKey.current)
      fresh()
      setEdit(null)
      setNotice({ tone: 'success', key: 'notice.edited' })
      void read()
    } catch (error) {
      setEdit((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }
  const addPhoto = async (photo: CapturedPhoto) => {
    if (!incident || dialog?.kind !== 'photo') return
    busy()
    try {
      await uploadPhoto(api, incident.id, photo.marked ?? photo.photo, `photo-${incident.photos.length + 1}.jpg`, writeKey.current)
      fresh()
      setDialog(null)
      setNotice({ tone: 'success', key: 'notice.photo' })
      void read()
    } catch (error) {
      failed(error)
    }
  }
  const openAddress = async (reading: Promise<string>) => {
    // A new tab opened at once (the click's gesture), then pointed at the 60-second address once it is read.
    const tabRef = window.open('', '_blank')
    if (tabRef) tabRef.opener = null
    try {
      const url = await reading
      if (tabRef) tabRef.location.href = url
      else window.open(url, '_blank', 'noopener')
    } catch (error) {
      tabRef?.close()
      setNotice({ tone: 'danger', key: problemOf(error).key })
    }
  }

  return (
    <IncidentRecordView
      model={{
        prefix,
        can,
        tab,
        loaded,
        live,
        asOf,
        people,
        filings,
        edit,
        dialog,
        notice,
        photoUrls: {},
        selected,
        bulkBusy,
        locale,
        userId: session.user.id,
      }}
      actions={{
        onRetry: () => {
          setLoaded({ status: 'loading' })
          void read()
        },
        onDismissNotice: () => setNotice(null),
        onOpenPeople: () => void openPeopleNow(),
        onHidePeople: () => setPeople({ state: 'closed' }),
        onOpenFilings: () => void openFilingsNow(),
        onHideFilings: () => setFilings({ state: 'closed' }),
        onConfirmNote: () => void confirmNote(),
        onEdit: (draft) => {
          fresh()
          setEdit(draft ? { draft, busy: false, problem: null } : null)
        },
        onSaveEdit: () => void saveEdit(),
        onDialog: (next) => {
          fresh()
          // A filing needs the protected reads first: the note says so; with both open the dialog opens at once.
          if (next?.kind === 'peopleNote' && filings.state === 'open' && people.state === 'open') {
            const first = filings.value.filings.find((filing) => filing.status === 'DUE') ?? filings.value.filings.find((filing) => filing.status === 'WAITING_CERTIFICATE') ?? null
            setDialog({ kind: 'filing', draft: filingDraftOf(first, filingPeople(people.value)), busy: false, problem: null, done: [] })
            return
          }
          setDialog(next)
        },
        onClose: () => void move('close'),
        onReopen: () => void move('reopen'),
        onCancel: () => void cancel(),
        onCancelReason: (reason) => setDialog((current) => (current?.kind === 'cancel' ? { ...current, reason } : current)),
        onActionDraft: (draft) => setDialog((current) => (current?.kind === 'action' ? { ...current, draft, problem: null } : current)),
        onActionMode: (mode, into) => {
          fresh()
          setDialog((current) => {
            if (current?.kind !== 'action') return current
            const action = incident?.actions.find((entry) => entry.id === current.actionId)
            const draft = mode === 'make' ? { ...newActionDraft(into ?? 'MAINTENANCE_JOB', incident?.machine?.id ?? null), title: action?.title ?? '' } : mode === 'edit' ? { ...current.draft, title: action?.title ?? current.draft.title, dueOn: action?.dueOn ?? '' } : current.draft
            return { ...current, mode, draft, problem: null }
          })
        },
        onActionSave: () => void saveAction(),
        onBulkDone: bulkDone,
        onSelected: setSelected,
        onFilingDraft: (draft) => setDialog((current) => (current?.kind === 'filing' ? { ...current, draft, problem: null } : current)),
        onFilingSave: () => void saveFiling(),
        onFilingNeeded: (filing, needed) => void setNeeded(filing, needed),
        onOpenReceipt: (filing) => {
          if (incident && filing.receipt) void openAddress(receiptAddress(api, incident.id, filing.id, filing.receipt.fileId))
        },
        onPhoto: (photo) => void addPhoto(photo),
        onPhotoOpen: (fileId) => {
          if (incident) void openAddress(photoAddress(api, incident.id, fileId))
        },
      }}
    />
  )
}
