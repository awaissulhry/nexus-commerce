'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppointmentSignMethod } from '@nexus/factory-domain/safety/organisation/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import type { LiveChange } from '../../../record-panels/model'
import {
  cancelDeadline,
  cancelNotice,
  createAppointment,
  createDeadline,
  editAppointmentNote,
  editDeadline,
  endAppointment,
  fileAddress,
  fileNotice,
  markDeadlineDone,
  readAppointment,
  readContacts,
  readDeadline,
  readOwners,
  readPeople,
  readShifts,
  setNoticeDue,
  signAppointment,
  uploadFile,
  type Appointment,
  type CalendarAnswer,
  type RlsNotice,
} from './api'
import {
  appointmentBody,
  appointmentHeld,
  deadlineBody,
  deadlineEdit,
  deadlineHeld,
  doneHeld,
  draftOfDeadline,
  EMPTY_DEADLINE,
  endHeld,
  filingDraftOf,
  filingHeld,
  newAppointmentDraft,
  problemOf,
  readProblemOf,
  signHeld,
  type AppointmentDraft,
  type CalendarAddress,
  type CalendarCan,
  type DeadlineDraft,
  type EndDraft,
  type FilingDraft,
  type PageSection,
} from './model'
import type { AppointmentNewState, AppointmentOpenState, CalendarPageActions, CalendarPageModel, DeadlineNewState, DeadlineOpenState, EndTermsState, FilingState, PageNotice } from './view-model'

export interface DialogDeps {
  api: ApiClient
  address: CalendarAddress
  go: (change: Partial<CalendarAddress>) => void
  companyId: string | null
  siteId: string | null
  today: string
  can: CalendarCan
  calendar: CalendarAnswer | null
  notices: readonly RlsNotice[]
  appointments: readonly Appointment[]
  onChanged: (...sections: PageSection[]) => void
  onNotice: (notice: PageNotice | null) => void
}

type DialogState = Pick<CalendarPageModel, 'deadlineNew' | 'deadline' | 'appointment' | 'filing' | 'endTerms'>
type DialogActions = Omit<CalendarPageActions, 'onAddress' | 'onNavigate' | 'onRetryCounts' | 'onRetryCalendar' | 'onRetryOrganisation' | 'onRetryNotices' | 'onDismissNotice' | 'onKept' | 'onBulkDone'>

/** A write's own key, asked once per press (a second press while busy is held by the view). */
const key = () => newIdempotencyKey()

/** The kind and the id of an item key (`DEADLINE:<id>`). */
const keyParts = (value: string | null): { kind: string; id: string } | null => {
  if (!value) return null
  const at = value.indexOf(':')
  return at > 0 ? { kind: value.slice(0, at), id: value.slice(at + 1) } : null
}

/**
 * The SCR-267 dialogs (B-W2b-120), each opened by the address so a link or Back opens and closes it: Add deadline
 * (`?new=1`), the Deadline window (`?open=DEADLINE:<id>`: facts, evidence, Mark done, Edit, Cancel; J / K over the list),
 * the Appointment (`?appoint=new|<id>`: a new appointment, then on the saved one the letter, the appointee's signature,
 * End term, the note), Record RLS notice (`?filing=<id>`: filed on + reference, the receipt, the due day confirmed,
 * Cancel), and End term N. Every write carries the version read and its own Idempotency-Key; a refusal stays in the
 * dialog in our words (at its field when the API names one); a lost answer is "not known", never "saved".
 */
export function useCalendarDialogs(deps: DialogDeps): { state: DialogState; actions: DialogActions; onLive: (change: LiveChange) => void } {
  const { api, address, go, companyId, siteId, today, can, notices, appointments, onChanged, onNotice } = deps
  const [deadlineNew, setDeadlineNew] = useState<DeadlineNewState | null>(null)
  const [deadline, setDeadline] = useState<DeadlineOpenState | null>(null)
  const [appointment, setAppointment] = useState<AppointmentNewState | AppointmentOpenState | null>(null)
  const [filing, setFiling] = useState<FilingState | null>(null)
  const [endTerms, setEndTerms] = useState<EndTermsState | null>(null)
  const justCreated = useRef<string | null>(null)

  // ---- Add deadline ----------------------------------------------------------------------------------------------------

  useEffect(() => {
    if (!address.newDeadline) {
      setDeadlineNew(null)
      return
    }
    setDeadlineNew({ draft: EMPTY_DEADLINE, owners: { status: 'loading' }, busy: false, problem: null })
    if (!companyId || !can.manageCalendar) {
      setDeadlineNew((current) => current && { ...current, owners: { status: 'ready', value: [] } })
      return
    }
    let live = true
    readOwners(api, companyId).then(
      (owners) => live && setDeadlineNew((current) => current && { ...current, owners: { status: 'ready', value: owners }, draft: current.draft.ownerId ? current.draft : { ...current.draft, ownerId: owners.find((owner) => owner.me)?.id ?? '' } }),
      (error: unknown) => live && setDeadlineNew((current) => current && { ...current, owners: { status: 'error', problem: readProblemOf(error) } }),
    )
    return () => {
      live = false
    }
  }, [address.newDeadline, api, companyId, can.manageCalendar])

  const createNow = () => {
    const open = deadlineNew
    if (!open || !companyId || open.busy || deadlineHeld(open.draft)) return
    setDeadlineNew({ ...open, busy: true, problem: null })
    createDeadline(api, deadlineBody(open.draft, companyId, siteId), key()).then(
      (made) => {
        setDeadlineNew(null)
        go({ newDeadline: false })
        onNotice({ tone: 'success', key: 'done.deadlineAdded', params: { title: made.title } })
        onChanged('calendar', 'counts')
      },
      (error: unknown) => setDeadlineNew((current) => current && { ...current, busy: false, problem: problemOf(error) }),
    )
  }

  // ---- the Deadline window ------------------------------------------------------------------------------------------------

  const openParts = keyParts(address.open)
  const openDeadlineId = openParts?.kind === 'DEADLINE' ? openParts.id : null
  const deadlineIdRef = useRef<string | null>(null)
  deadlineIdRef.current = openDeadlineId

  // An appointment's or a notice's item key opens its own dialog (a link may name the item).
  useEffect(() => {
    if (openParts?.kind === 'APPOINTMENT_END') go({ open: null, appoint: openParts.id })
    else if (openParts?.kind === 'RLS_NOTICE') go({ open: null, filing: openParts.id })
    // Only when the key changes.
  }, [address.open])

  const readDeadlineNow = useCallback(
    (id: string) =>
      readDeadline(api, id).then(
        (record) => {
          if (deadlineIdRef.current === id) setDeadline((current) => (current && current.id === id ? { ...current, read: { status: 'ready', value: record } } : current))
        },
        (error: unknown) => {
          if (deadlineIdRef.current === id) setDeadline((current) => (current && current.id === id ? { ...current, read: { status: 'error', problem: readProblemOf(error) } } : current))
        },
      ),
    [api],
  )

  useEffect(() => {
    if (!openDeadlineId || !address.open) {
      setDeadline(null)
      return
    }
    setDeadline({ key: address.open, id: openDeadlineId, read: { status: 'loading' }, mode: 'view', draft: null, owners: null, doneNote: '', cancelReason: '', busy: false, uploading: false, problem: null, next: null, saved: null })
    void readDeadlineNow(openDeadlineId)
  }, [openDeadlineId, readDeadlineNow])

  const deadlineRecord = deadline?.read.status === 'ready' ? deadline.read.value : null
  const patchDeadline = (change: Partial<DeadlineOpenState>) => setDeadline((current) => current && { ...current, ...change })

  /** A write on the open deadline: busy, then read it again (its earlier occurrences too) and say what was done. */
  const deadlineWrite = (work: () => Promise<unknown>, saved: string, after: Partial<DeadlineOpenState> = {}) => {
    const open = deadline
    if (!open || open.busy) return
    patchDeadline({ busy: true, problem: null, saved: null })
    work().then(
      async () => {
        await readDeadlineNow(open.id)
        patchDeadline({ busy: false, saved, ...after })
        onChanged('calendar', 'counts')
      },
      (error: unknown) => patchDeadline({ busy: false, problem: problemOf(error) }),
    )
  }

  // ---- the Appointment -----------------------------------------------------------------------------------------------------

  const appointId = address.appoint && address.appoint !== 'new' ? address.appoint : null
  const appointIdRef = useRef<string | null>(null)
  appointIdRef.current = appointId

  const readAppointmentNow = useCallback(
    (id: string) =>
      readAppointment(api, id).then(
        (record) => {
          if (appointIdRef.current !== id) return
          setAppointment((current) => (current?.mode === 'open' && current.id === id ? { ...current, read: { status: 'ready', value: record }, note: current.note ?? record.appointment.note ?? '' } : current))
        },
        (error: unknown) => {
          if (appointIdRef.current !== id) return
          setAppointment((current) => (current?.mode === 'open' && current.id === id ? { ...current, read: { status: 'error', problem: readProblemOf(error) } } : current))
        },
      ),
    [api],
  )

  useEffect(() => {
    if (address.appoint !== 'new') return
    setAppointment({ mode: 'new', draft: newAppointmentDraft(address.role, address.at, today), people: { status: 'loading' }, contacts: { status: 'loading' }, shifts: { status: 'loading' }, busy: false, problem: null })
    if (!companyId || !can.manageOrganisation) {
      setAppointment((current) => current?.mode === 'new' ? { ...current, people: { status: 'ready', value: { people: [], complete: true } }, contacts: { status: 'ready', value: { contacts: [], complete: true } }, shifts: { status: 'ready', value: [] } } : current)
      return
    }
    let live = true
    const set = (change: Partial<AppointmentNewState>) => live && setAppointment((current) => (current?.mode === 'new' ? { ...current, ...change } : current))
    readPeople(api, companyId, null).then((value) => set({ people: { status: 'ready', value } }), (error: unknown) => set({ people: { status: 'error', problem: readProblemOf(error) } }))
    readContacts(api, companyId, null).then((value) => set({ contacts: { status: 'ready', value } }), (error: unknown) => set({ contacts: { status: 'error', problem: readProblemOf(error) } }))
    readShifts(api, companyId).then((value) => set({ shifts: { status: 'ready', value } }), (error: unknown) => set({ shifts: { status: 'error', problem: readProblemOf(error) } }))
    return () => {
      live = false
    }
    // A new dialog per address (the role and the place it was opened for).
  }, [address.appoint, address.role, address.at, api, companyId, can.manageOrganisation])

  useEffect(() => {
    if (!appointId) {
      if (address.appoint !== 'new') setAppointment(null)
      return
    }
    const created = justCreated.current === appointId
    justCreated.current = null
    setAppointment({ mode: 'open', id: appointId, read: { status: 'loading' }, step: 'view', signMethod: 'OFFICE', end: { untilDate: today, reason: '' }, note: null, busy: false, uploading: false, problem: null, saved: null, created })
    void readAppointmentNow(appointId)
  }, [appointId, readAppointmentNow])

  const patchOpen = (change: Partial<AppointmentOpenState>) => setAppointment((current) => (current?.mode === 'open' ? { ...current, ...change } : current))
  const openAppointment = appointment?.mode === 'open' && appointment.read.status === 'ready' ? appointment.read.value.appointment : null

  const appointmentWrite = (work: (row: Appointment) => Promise<unknown>, saved: string, after: Partial<AppointmentOpenState> = {}, sections: PageSection[] = ['organisation']) => {
    if (appointment?.mode !== 'open' || appointment.busy || !openAppointment) return
    const id = appointment.id
    patchOpen({ busy: true, problem: null, saved: null })
    work(openAppointment).then(
      async () => {
        await readAppointmentNow(id)
        patchOpen({ busy: false, saved, ...after })
        onChanged(...sections)
      },
      (error: unknown) => patchOpen({ busy: false, problem: problemOf(error) }),
    )
  }

  // ---- Record RLS notice ---------------------------------------------------------------------------------------------------

  const listed = filing ? (notices.find((entry) => entry.id === filing.id) ?? null) : null
  useEffect(() => {
    if (!address.filing) {
      setFiling(null)
      return
    }
    setFiling({ id: address.filing, latest: null, step: 'file', draft: { filedOn: today, reference: '', dueOn: '', cancelReason: '' }, busy: false, uploading: false, problem: null, saved: null })
  }, [address.filing])
  // The confirmed due day starts at the notice's own, once the panel's read has it.
  useEffect(() => {
    if (listed && filing && !filing.draft.dueOn) setFiling((current) => current && { ...current, draft: { ...filingDraftOf(listed, today), filedOn: current.draft.filedOn, reference: current.draft.reference } })
  }, [listed, filing, today])

  const filingWrite = (work: (notice: RlsNotice) => Promise<RlsNotice>, saved: string, close = false) => {
    const open = filing
    const notice = open?.latest ?? listed
    if (!open || open.busy || !notice) return
    setFiling({ ...open, busy: true, problem: null, saved: null })
    work(notice).then(
      (latest) => {
        onChanged('notices', 'counts', 'calendar')
        if (close) {
          go({ filing: null })
          onNotice({ tone: 'success', key: saved })
          return
        }
        setFiling((current) => current && { ...current, latest, busy: false, saved, step: 'file' })
      },
      (error: unknown) => setFiling((current) => current && { ...current, busy: false, problem: problemOf(error) }),
    )
  }

  // ---- files ---------------------------------------------------------------------------------------------------------------

  const openFile = (fileId: string) => {
    fileAddress(api, fileId).then(
      (url) => window.open(url, '_blank', 'noopener'),
      () => onNotice({ tone: 'danger', key: 'problem.file' }),
    )
  }

  // ---- live ----------------------------------------------------------------------------------------------------------------

  const onLive = (change: LiveChange) => {
    if (change.type === 'safety_deadline.changed' && deadline && !deadline.busy && change.fields.deadlineId === deadline.id) void readDeadlineNow(deadline.id)
    if (change.type === 'safety_appointment.changed' && appointment?.mode === 'open' && !appointment.busy && change.fields.appointmentId === appointment.id) void readAppointmentNow(appointment.id)
  }

  // ---- the actions ---------------------------------------------------------------------------------------------------------

  const actions: DialogActions = {
    onDeadlineDraft: (draft: DeadlineDraft) => setDeadlineNew((current) => current && { ...current, draft, problem: null }),
    onCreateDeadline: createNow,

    onDeadlineMode: (mode) => {
      if (!deadline) return
      if (mode !== 'edit' || !deadlineRecord) return patchDeadline({ mode, problem: null, saved: null })
      patchDeadline({ mode, draft: draftOfDeadline(deadlineRecord.deadline), owners: { status: 'loading' }, problem: null, saved: null })
      readOwners(api, deadlineRecord.deadline.companyId).then(
        (owners) => patchDeadline({ owners: { status: 'ready', value: owners } }),
        (error: unknown) => patchDeadline({ owners: { status: 'error', problem: readProblemOf(error) } }),
      )
    },
    onDeadlineEditDraft: (draft) => patchDeadline({ draft, problem: null }),
    onSaveDeadline: () => {
      if (!deadline?.draft || !deadlineRecord || deadlineHeld(deadline.draft)) return
      const edit = deadlineEdit(deadlineRecord.deadline, deadline.draft)
      if (!edit) return patchDeadline({ mode: 'view' })
      deadlineWrite(() => editDeadline(api, deadlineRecord.deadline.id, edit, key()), 'done.deadlineSaved', { mode: 'view', draft: null })
    },
    onDoneNote: (doneNote) => patchDeadline({ doneNote }),
    onMarkDone: () => {
      if (!deadline || !deadlineRecord || doneHeld(deadlineRecord.deadline)) return
      const note = deadline.doneNote.trim()
      let next: DeadlineOpenState['next'] = null
      deadlineWrite(
        async () => {
          const answer = await markDeadlineDone(api, deadlineRecord.deadline.id, { version: deadlineRecord.deadline.version, ...(note ? { note } : {}) }, key())
          next = answer.next
          patchDeadline({ next })
        },
        'done.deadlineDone',
        { doneNote: '' },
      )
    },
    onCancelReason: (cancelReason) => patchDeadline({ cancelReason }),
    onCancelDeadline: () => {
      if (!deadline || !deadlineRecord || !deadline.cancelReason.trim()) return
      deadlineWrite(() => cancelDeadline(api, deadlineRecord.deadline.id, { version: deadlineRecord.deadline.version, reason: deadline.cancelReason.trim() }, key()), 'done.deadlineCancelled', { mode: 'view', cancelReason: '' })
    },
    onEvidence: (files: File[]) => {
      if (!deadline || !deadlineRecord || deadline.uploading || files.length === 0) return
      const record = { type: 'SafetyDeadline' as const, id: deadlineRecord.deadline.id, companyId: deadlineRecord.deadline.companyId }
      patchDeadline({ uploading: true, problem: null, saved: null })
      ;(async () => {
        for (const file of files) await uploadFile(api, record, file)
      })().then(
        async () => {
          await readDeadlineNow(record.id)
          patchDeadline({ uploading: false, saved: 'done.uploaded' })
          onChanged('calendar')
        },
        (error: unknown) => patchDeadline({ uploading: false, problem: problemOf(error) }),
      )
    },
    onOpenFile: openFile,
    onRetryDeadline: () => {
      if (!deadline) return
      patchDeadline({ read: { status: 'loading' } })
      void readDeadlineNow(deadline.id)
    },

    onAppointmentDraft: (draft: AppointmentDraft) => setAppointment((current) => (current?.mode === 'new' ? { ...current, draft, problem: null } : current)),
    onSaveAppointment: () => {
      if (appointment?.mode !== 'new' || appointment.busy || !companyId || appointmentHeld(appointment.draft, today)) return
      setAppointment({ ...appointment, busy: true, problem: null })
      createAppointment(api, appointmentBody(appointment.draft, companyId), key()).then(
        (answer) => {
          justCreated.current = answer.appointment.id
          onChanged('organisation', 'notices', 'counts', 'calendar')
          go({ appoint: answer.appointment.id, role: null, at: null })
        },
        (error: unknown) => setAppointment((current) => (current?.mode === 'new' ? { ...current, busy: false, problem: problemOf(error) } : current)),
      )
    },
    onRetryAppointment: () => {
      if (appointment?.mode !== 'open') return
      patchOpen({ read: { status: 'loading' } })
      void readAppointmentNow(appointment.id)
    },
    onLetter: (files: File[]) => {
      if (appointment?.mode !== 'open' || appointment.uploading || !openAppointment || files.length === 0) return
      const id = appointment.id
      const record = { type: 'SafetyAppointment' as const, id: openAppointment.id, companyId: openAppointment.companyId }
      patchOpen({ uploading: true, problem: null, saved: null })
      uploadFile(api, record, files[0]!).then(
        async () => {
          await readAppointmentNow(id)
          patchOpen({ uploading: false, saved: 'done.letter' })
          onChanged('organisation')
        },
        (error: unknown) => patchOpen({ uploading: false, problem: problemOf(error) }),
      )
    },
    onSignMethod: (signMethod: AppointmentSignMethod) => patchOpen({ signMethod, problem: null }),
    onSign: (name: string) => {
      if (appointment?.mode !== 'open' || !openAppointment || signHeld(openAppointment, appointment.signMethod)) return
      const method = appointment.signMethod
      const signedName = method === 'PAPER' ? openAppointment.appointee.name : name.trim()
      appointmentWrite((row) => signAppointment(api, row.id, { version: row.version, method, signedName }, key()), 'done.signed')
    },
    onAppointmentStep: (step) => patchOpen({ step, problem: null, saved: null }),
    onEndDraft: (end: EndDraft) => patchOpen({ end, problem: null }),
    onEndTerm: () => {
      if (appointment?.mode !== 'open' || !openAppointment || endHeld(appointment.end, [openAppointment])) return
      const end = appointment.end
      appointmentWrite((row) => endAppointment(api, row.id, { version: row.version, untilDate: end.untilDate, endReason: end.reason.trim() }, key()), 'done.ended', { step: 'view' }, ['organisation', 'counts', 'calendar'])
    },
    onNoteDraft: (note: string) => patchOpen({ note }),
    onSaveNote: () => {
      if (appointment?.mode !== 'open' || !openAppointment) return
      const note = (appointment.note ?? '').trim()
      appointmentWrite((row) => editAppointmentNote(api, row.id, { version: row.version, note: note || null }, key()), 'done.noteSaved')
    },

    onFilingDraft: (draft: FilingDraft) => setFiling((current) => current && { ...current, draft, problem: null }),
    onFilingStep: (step) => setFiling((current) => current && { ...current, step, problem: null, saved: null }),
    onRecordFiling: () => {
      const notice = filing?.latest ?? listed
      if (!filing || !notice || filingHeld(filing.draft, notice, today)) return
      const draft = filing.draft
      filingWrite((row) => fileNotice(api, row.id, { version: row.version, filedOn: draft.filedOn, reference: draft.reference.trim() }, key()), 'done.filed')
    },
    onSetDue: () => {
      if (!filing || !filing.draft.dueOn) return
      const dueOn = filing.draft.dueOn
      filingWrite((row) => setNoticeDue(api, row.id, { version: row.version, dueOn }, key()), 'done.dueSet')
    },
    onCancelNotice: () => {
      if (!filing || !filing.draft.cancelReason.trim()) return
      const reason = filing.draft.cancelReason.trim()
      filingWrite((row) => cancelNotice(api, row.id, { version: row.version, reason }, key()), 'done.noticeCancelled', true)
    },
    onReceipt: (files: File[]) => {
      const notice = filing?.latest ?? listed
      if (!filing || filing.uploading || !notice || files.length === 0) return
      setFiling({ ...filing, uploading: true, problem: null, saved: null })
      uploadFile(api, { type: 'RlsNotice', id: notice.id, companyId: notice.companyId }, files[0]!).then(
        () => {
          setFiling((current) => current && { ...current, uploading: false, saved: 'done.receipt' })
          onChanged('notices')
        },
        (error: unknown) => setFiling((current) => current && { ...current, uploading: false, problem: problemOf(error) }),
      )
    },

    onEndTerms: (ids) => setEndTerms(ids && ids.length > 0 ? { ids, draft: { untilDate: today, reason: '' }, busy: false, problem: null } : null),
    onEndTermsDraft: (draft) => setEndTerms((current) => current && { ...current, draft, problem: null }),
    onApplyEndTerms: async () => {
      const open = endTerms
      if (!open || open.busy) return
      const rows = appointments.filter((row) => open.ids.includes(row.id))
      if (endHeld(open.draft, rows)) return
      setEndTerms({ ...open, busy: true, problem: null })
      let done = 0
      const refused: { label: string; key: string }[] = []
      for (const row of rows) {
        try {
          await endAppointment(api, row.id, { version: row.version, untilDate: open.draft.untilDate, endReason: open.draft.reason.trim() }, key())
          done += 1
        } catch (error) {
          refused.push({ label: row.appointee.name, key: problemOf(error).key })
        }
      }
      setEndTerms(null)
      onNotice({ tone: refused.length > 0 ? 'warning' : 'success', key: 'bulk.endResult', params: { count: done }, refused })
      onChanged('organisation', 'counts', 'calendar')
    },
  }

  return { state: { deadlineNew, deadline, appointment, filing, endTerms }, actions, onLive }
}
