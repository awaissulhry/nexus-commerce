'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { liveMatches } from '../../../quality/_shared/hooks'
import {
  addInstruction,
  addStandardCourses,
  applyClassCourses,
  closeSession,
  createCourse,
  getClassNeeds,
  getCourse,
  getRequirements,
  getRoleNeeds,
  getSession,
  getStandardList,
  listCourses,
  listInstruction,
  listOpenSessions,
  paperInstruction,
  previewClassCourses,
  previewCourse,
  recordTraining,
  saveCourse,
  setCourseStatus,
  uploadCertificate,
  voidInstruction,
  type Attendance,
  type ClassNeeds,
  type ClassPreview,
  type Course,
  type CourseRecord,
  type CoursePreview,
  type Courses,
  type InstructionEntry,
  type InstructionList,
  type Requirements,
  type RoleNeeds,
  type StandardList,
  type TrainingSession,
} from './api'
import {
  classBody,
  classLinesHeld,
  classLinesOf,
  closable,
  closeHeld,
  courseChanges,
  courseDraftOf,
  courseHeld,
  emptyCourseDraft,
  emptyInstructionDraft,
  emptyRecordDraft,
  instructionBody,
  instructionHeld,
  needOf,
  newCourseBody,
  nothingChanges,
  readProblemOf,
  recordBody,
  recordHeld,
  recordPerson,
  standardBody,
  standardHeld,
  standardRowsOf,
  trainingProblem,
  type ClassLine,
  type CourseDraft,
  type InstructionDraft,
  type RecordDraft,
  type StandardRow,
  type TrainingAddress,
  type TrainingCan,
  type TrainingProblem,
} from './model'

/** A section's read: loading, ready, or failed with a message key (never drawn as empty). */
export type Section<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

/** A person the dialogs may name (from the matrix's rows, else the people the due list names). */
export interface PersonOption {
  employeeId: string
  name: string
  companyId: string
  siteId: string
}

const common = { busy: false, problem: null as TrainingProblem | null }

export type TrainingDialog =
  | ({ kind: 'course'; courseId: string | null; record: CourseRecord | null; loading: boolean; draft: CourseDraft; preview: CoursePreview | null } & typeof common)
  | ({ kind: 'standard'; list: StandardList | null; rows: StandardRow[]; groupWide: boolean } & typeof common)
  | ({ kind: 'need'; ref: { kind: 'role' | 'class'; id: string }; role: RoleNeeds | null; machine: ClassNeeds | null } & typeof common)
  | ({ kind: 'classCourses'; classId: string; needs: ClassNeeds | null; lines: ClassLine[]; preview: ClassPreview | null } & typeof common)
  | ({ kind: 'record'; way: 'elsewhere' | 'session'; draft: RecordDraft; sessions: TrainingSession[] | null; sessionId: string | null; session: { session: TrainingSession; attendances: Attendance[] } | null; results: Record<string, 'PASSED' | 'FAILED'>; certificateFailed: number } & typeof common)
  | ({ kind: 'instruction'; draft: InstructionDraft } & typeof common)
  | ({ kind: 'voidEntry'; entry: InstructionEntry; reason: string } & typeof common)

export interface TrainingDialogActions {
  onClose: () => void
  onPatch: (patch: Record<string, unknown>) => void
  onCoursePreview: () => void
  onCourseBack: () => void
  onCourseSave: () => void
  onCourseStatus: (to: 'archive' | 'restore') => void
  onStandardAdd: () => void
  onClassCourses: (classId: string) => void
  onClassPreview: () => void
  onClassBack: () => void
  onClassApply: () => void
  onRecordWay: (way: 'elsewhere' | 'session') => void
  onSession: (sessionId: string | null) => void
  onRecord: () => void
  onCloseSession: () => void
  onInstruction: () => void
  onPaper: (entry: InstructionEntry) => void
  onVoid: () => void
}

export interface TrainingFacts {
  companyId: string | null
  siteId: string | null
  /** The API's today (the matrix's or the catalogue's). */
  today: string
  people: readonly PersonOption[]
}

const LIVE = ['safety_course.changed', 'training_requirement.changed', 'role_sheet.changed', 'training.recorded', 'instruction.changed', 'training_session.changed', 'training_attendance.changed']
const OWN_MS = 4000

/**
 * The training lenses of People › Skills & training and their dialogs (B-W2b-146): each lens reads its own section when it is
 * shown (the catalogue, who needs what, the instruction register), the Course and need pop-ups follow the address
 * (`?course=`, `?need=`), the others are local. Every write is one command (Idempotency-Key, the version read, a preview's
 * fingerprint where the API asks one); a refusal is said in words at its dialog. Others' live changes re-read the lens shown
 * (its counts; nothing moves under a dialog). `onDone(key, params)` says what happened.
 */
export function useTraining(api: ApiClient, can: TrainingCan, address: TrainingAddress, facts: TrainingFacts, go: (change: Partial<TrainingAddress>) => void, onDone: (key: string, params?: Record<string, string | number>) => void) {
  const [courses, setCourses] = useState<Section<Courses>>({ status: 'idle' })
  const [requirements, setRequirements] = useState<Section<Requirements>>({ status: 'idle' })
  const [instruction, setInstruction] = useState<Section<InstructionList>>({ status: 'idle' })
  const [dialog, setDialog] = useState<TrainingDialog | null>(null)
  const ownUntil = useRef(0)
  const lens = address.lens
  const { companyId, siteId } = facts

  const readCourses = useCallback(async (quiet = false) => {
    if (!can.view) return
    if (!quiet) setCourses({ status: 'loading' })
    try {
      setCourses({ status: 'ready', value: await listCourses(api, { companyId, status: address.status, q: address.q }) })
    } catch (error) {
      setCourses({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, can.view, companyId, address.status, address.q])

  const readRequirements = useCallback(async (quiet = false) => {
    if (!can.view) return
    if (!quiet) setRequirements({ status: 'loading' })
    try {
      setRequirements({ status: 'ready', value: await getRequirements(api, { companyId, siteId }) })
    } catch (error) {
      setRequirements({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, can.view, companyId, siteId])

  const readInstruction = useCallback(async (quiet = false) => {
    if (!can.view) return
    if (!quiet) setInstruction({ status: 'loading' })
    try {
      setInstruction({ status: 'ready', value: await listInstruction(api, { companyId, siteId, view: address.entries, q: address.q }) })
    } catch (error) {
      setInstruction({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, can.view, companyId, siteId, address.entries, address.q])

  const readLens = useCallback(
    (quiet = false) => {
      if (lens === 'courses') return readCourses(quiet)
      if (lens === 'needs') return readRequirements(quiet)
      if (lens === 'instruction') return readInstruction(quiet)
      return undefined
    },
    [lens, readCourses, readRequirements, readInstruction],
  )

  useEffect(() => {
    void readLens()
  }, [readLens])

  const later = useCoalesced(() => {
    if (lens === 'matrix') return
    // The counts of the lens shown are re-read quietly; a pop-up keeps what it read.
    void readLens(true)
  }, 1200)
  const live = useLive(
    (change) => {
      if (liveMatches(change, LIVE) && Date.now() > ownUntil.current) later()
    },
    () => void readLens(true),
    can.view,
  )

  const patch = useCallback((change: Record<string, unknown>) => setDialog((current) => (current ? ({ ...current, ...change } as TrainingDialog) : current)), [])
  const fail = useCallback((error: unknown) => patch({ busy: false, problem: trainingProblem(error) }), [patch])
  const done = useCallback(
    (key: string, params?: Record<string, string | number>, reread: Array<() => unknown> = []) => {
      ownUntil.current = Date.now() + OWN_MS
      onDone(key, params)
      for (const read of reread) void read()
    },
    [onDone],
  )

  // ---- the Course pop-up and the need record follow the address ---------------------------------------------------------------
  useEffect(() => {
    if (!address.course) {
      setDialog((current) => (current?.kind === 'course' ? null : current))
      return
    }
    if (address.course === 'new') {
      setDialog({ kind: 'course', courseId: null, record: null, loading: false, draft: emptyCourseDraft('GENERAL', companyId === null), preview: null, ...common })
      return
    }
    const courseId = address.course
    setDialog({ kind: 'course', courseId, record: null, loading: true, draft: emptyCourseDraft(), preview: null, ...common })
    let alive = true
    getCourse(api, courseId).then(
      (record) => alive && setDialog((current) => (current?.kind === 'course' && current.courseId === courseId ? { ...current, record, loading: false, draft: courseDraftOf(record.course) } : current)),
      (error: unknown) => alive && setDialog((current) => (current?.kind === 'course' && current.courseId === courseId ? { ...current, loading: false, problem: trainingProblem(error) } : current)),
    )
    return () => {
      alive = false
    }
  }, [api, address.course, companyId])

  useEffect(() => {
    const ref = needOf(address.need)
    if (!ref) {
      setDialog((current) => (current?.kind === 'need' ? null : current))
      return
    }
    setDialog({ kind: 'need', ref, role: null, machine: null, ...common })
    let alive = true
    const read = ref.kind === 'role' ? getRoleNeeds(api, ref.id).then((role) => ({ role })) : getClassNeeds(api, ref.id).then((machine) => ({ machine }))
    read.then(
      (value) => alive && setDialog((current) => (current?.kind === 'need' && current.ref.id === ref.id ? { ...current, ...value } : current)),
      (error: unknown) => alive && setDialog((current) => (current?.kind === 'need' && current.ref.id === ref.id ? { ...current, problem: trainingProblem(error) } : current)),
    )
    return () => {
      alive = false
    }
  }, [api, address.need])

  const close = useCallback(() => {
    if (dialog?.kind === 'course') return go({ course: null })
    if (dialog?.kind === 'need') return go({ need: null })
    setDialog(null)
  }, [dialog, go])

  // The courses a dialog offers (Record training, a machine type's lines): the catalogue's ACTIVE ones, read once when needed.
  const [activeCourses, setActiveCourses] = useState<Courses['courses'] | null>(null)
  const needCourses = useCallback(() => {
    if (activeCourses) return
    listCourses(api, { companyId, status: 'ACTIVE' }).then(
      (answer) => setActiveCourses(answer.courses),
      () => setActiveCourses([]),
    )
  }, [api, companyId, activeCourses])
  useEffect(() => {
    if (courses.status === 'ready' && address.status === 'ACTIVE' && !address.q) setActiveCourses(courses.value.courses)
  }, [courses, address.status, address.q])

  const open = {
    course: (courseId: string | 'new') => go({ course: courseId }),
    need: (id: string) => go({ need: id }),
    standard: () => {
      setDialog({ kind: 'standard', list: null, rows: [], groupWide: companyId === null, ...common })
      getStandardList(api, companyId).then(
        (list) => patch({ list, rows: standardRowsOf(list.courses) }),
        (error: unknown) => patch({ problem: trainingProblem(error) }),
      )
    },
    record: (people: readonly PersonOption[] = [], courseId: string | null = null) => {
      needCourses()
      setDialog({ kind: 'record', way: 'elsewhere', draft: emptyRecordDraft(facts.today, people.map(recordPerson), courseId), sessions: null, sessionId: null, session: null, results: {}, certificateFailed: 0, ...common })
    },
    instruction: (employeeId: string | null = null) => {
      if (requirements.status === 'idle') void readRequirements()
      setDialog({ kind: 'instruction', draft: emptyInstructionDraft(facts.today, employeeId), ...common })
    },
    entry: (entry: InstructionEntry) => setDialog({ kind: 'voidEntry', entry, reason: '', ...common }),
  }

  /** Archive N (the catalogue's bulk action): one command per course, with its version; what was refused is said. */
  const archiveMany = useCallback(
    async (rows: readonly Course[]) => {
      let archived = 0
      let refused = 0
      for (const row of rows) {
        try {
          await setCourseStatus(api, row.id, 'archive', row.version)
          archived += 1
        } catch {
          refused += 1
        }
      }
      done(refused > 0 ? 'done.archivedSome' : 'done.archivedMany', { count: archived, refused }, [readCourses])
      setActiveCourses(null)
    },
    [api, done, readCourses],
  )

  /** "Signed on paper" for N entries waiting (the bulk action of the register). */
  const paperMany = useCallback(
    async (rows: readonly InstructionEntry[]) => {
      let marked = 0
      let refused = 0
      for (const row of rows) {
        try {
          await paperInstruction(api, row.id, row.version)
          marked += 1
        } catch {
          refused += 1
        }
      }
      done(refused > 0 ? 'done.paperSome' : 'done.paperMany', { count: marked, refused }, [readInstruction])
    },
    [api, done, readInstruction],
  )

  const actions: TrainingDialogActions = {
    onClose: close,
    onPatch: patch,
    onCoursePreview: () => {
      if (dialog?.kind !== 'course' || dialog.busy) return
      const held = courseHeld(dialog.draft, dialog.courseId === null)
      if (held) return
      if (dialog.courseId === null) {
        patch({ busy: true, problem: null })
        createCourse(api, { ...newCourseBody(dialog.draft), companyId: dialog.draft.groupWide ? null : companyId }).then((course) => {
          setDialog(null)
          go({ course: null })
          done('done.courseAdded', { course: course.code }, [readCourses])
          setActiveCourses(null)
        }, fail)
        return
      }
      if (!dialog.record) return
      const body = courseChanges(dialog.record.course, dialog.draft)
      if (nothingChanges(body)) return patch({ problem: { key: 'held.nothing' } })
      patch({ busy: true, problem: null })
      previewCourse(api, dialog.courseId, body).then((preview) => patch({ busy: false, preview }), fail)
    },
    onCourseBack: () => patch({ preview: null, problem: null }),
    onCourseSave: () => {
      if (dialog?.kind !== 'course' || !dialog.record || !dialog.courseId || dialog.busy) return
      const body = courseChanges(dialog.record.course, dialog.draft)
      patch({ busy: true, problem: null })
      saveCourse(api, dialog.courseId, { ...body, version: dialog.record.course.version, ...(dialog.preview ? { impactFingerprint: dialog.preview.fingerprint } : {}) }).then(
        (answer) => {
          go({ course: null })
          done(answer.changed ? 'done.courseSaved' : 'done.courseSame', { course: answer.course.code }, [readCourses])
          setActiveCourses(null)
        },
        (error: unknown) => {
          const problem = trainingProblem(error)
          // A change made meanwhile: back to the form, the preview read again.
          patch({ busy: false, problem, ...(problem.key === 'refusal.IMPACT_CHANGED' ? { preview: null } : {}) })
        },
      )
    },
    onCourseStatus: (to) => {
      if (dialog?.kind !== 'course' || !dialog.record || !dialog.courseId || dialog.busy) return
      patch({ busy: true, problem: null })
      setCourseStatus(api, dialog.courseId, to, dialog.record.course.version).then((course) => {
        go({ course: null })
        done(to === 'archive' ? 'done.courseArchived' : 'done.courseRestored', { course: course.code }, [readCourses])
        setActiveCourses(null)
      }, fail)
    },
    onStandardAdd: () => {
      if (dialog?.kind !== 'standard' || dialog.busy || standardHeld(dialog.rows)) return
      patch({ busy: true, problem: null })
      addStandardCourses(api, { companyId: dialog.groupWide ? null : companyId, courses: standardBody(dialog.rows) }).then((added) => {
        setDialog(null)
        done('done.standardAdded', { count: added.length }, [readCourses])
        setActiveCourses(null)
      }, fail)
    },
    onClassCourses: (classId) => {
      needCourses()
      go({ need: null })
      setDialog({ kind: 'classCourses', classId, needs: null, lines: [], preview: null, ...common })
      getClassNeeds(api, classId).then(
        (needs) => patch({ needs, lines: classLinesOf(needs.courses) }),
        (error: unknown) => patch({ problem: trainingProblem(error) }),
      )
    },
    onClassPreview: () => {
      if (dialog?.kind !== 'classCourses' || dialog.busy || classLinesHeld(dialog.lines)) return
      patch({ busy: true, problem: null })
      previewClassCourses(api, dialog.classId, classBody(dialog.lines)).then((preview) => patch({ busy: false, preview }), fail)
    },
    onClassBack: () => patch({ preview: null, problem: null }),
    onClassApply: () => {
      if (dialog?.kind !== 'classCourses' || !dialog.preview || dialog.busy) return
      patch({ busy: true, problem: null })
      applyClassCourses(api, dialog.classId, classBody(dialog.lines), dialog.preview.fingerprint).then(
        (answer) => {
          setDialog(null)
          done(answer.applied ? 'done.classApplied' : 'done.classSame', { count: answer.people }, [readRequirements])
        },
        (error: unknown) => {
          const problem = trainingProblem(error)
          patch({ busy: false, problem, ...(problem.key === 'refusal.IMPACT_CHANGED' ? { preview: null } : {}) })
        },
      )
    },
    onRecordWay: (way) => {
      if (dialog?.kind !== 'record') return
      patch({ way, problem: null })
      if (way === 'session' && dialog.sessions === null) {
        listOpenSessions(api, { companyId, siteId }).then(
          (answer) => patch({ sessions: answer.sessions }),
          (error: unknown) => patch({ sessions: [], problem: trainingProblem(error) }),
        )
      }
    },
    onSession: (sessionId) => {
      patch({ sessionId, session: null, results: {}, problem: null })
      if (!sessionId) return
      getSession(api, sessionId).then(
        (answer) => setDialog((current) => (current?.kind === 'record' && current.sessionId === sessionId ? { ...current, session: { session: answer.session, attendances: answer.attendances }, results: Object.fromEntries(closable(answer.attendances).map((entry) => [entry.id, entry.languageUnderstood === false ? 'FAILED' : 'PASSED'])) } : current)),
        (error: unknown) => patch({ problem: trainingProblem(error) }),
      )
    },
    onRecord: () => {
      if (dialog?.kind !== 'record' || dialog.busy) return
      const course = activeCourses?.find((entry) => entry.id === dialog.draft.courseId) ?? null
      if (!course || recordHeld(dialog.draft, course, facts.today)) return
      patch({ busy: true, problem: null })
      const certificate = dialog.draft.certificate
      recordTraining(api, recordBody(dialog.draft, course), newIdempotencyKey()).then(async (answer) => {
        let failed = 0
        if (certificate && can.upload) {
          for (const record of answer.records) {
            try {
              await uploadCertificate(api, { id: record.id, companyId: record.companyId }, certificate)
            } catch {
              failed += 1
            }
          }
        }
        setDialog(null)
        done(failed > 0 ? 'done.recordedNoCertificate' : 'done.recorded', { count: answer.records.length, failed }, [lens === 'courses' ? readCourses : () => undefined])
      }, fail)
    },
    onCloseSession: () => {
      if (dialog?.kind !== 'record' || !dialog.session || dialog.busy) return
      if (closeHeld(dialog.session.session, dialog.session.attendances, facts.today)) return
      patch({ busy: true, problem: null })
      const results = closable(dialog.session.attendances).map((entry) => ({ attendanceId: entry.id, result: dialog.results[entry.id] ?? 'PASSED' }))
      closeSession(api, dialog.session.session.id, { version: dialog.session.session.version, results }).then((answer) => {
        setDialog(null)
        done('done.sessionClosed', { count: answer.records.length })
      }, fail)
    },
    onInstruction: () => {
      if (dialog?.kind !== 'instruction' || dialog.busy || instructionHeld(dialog.draft, facts.today)) return
      patch({ busy: true, problem: null })
      const person = facts.people.find((entry) => entry.employeeId === dialog.draft.employeeId)
      addInstruction(api, { ...instructionBody(dialog.draft), ...(person && !siteId ? { siteId: person.siteId } : siteId ? { siteId } : {}) }).then((entry) => {
        setDialog(null)
        done(entry.signed ? 'done.entryPaper' : 'done.entryFloor', { name: entry.employee.name }, [readInstruction])
      }, fail)
    },
    onPaper: (entry) => {
      paperInstruction(api, entry.id, entry.version).then(
        () => done('done.entryPaper', { name: entry.employee.name }, [readInstruction]),
        (error: unknown) => onDone(trainingProblem(error).key),
      )
    },
    onVoid: () => {
      if (dialog?.kind !== 'voidEntry' || dialog.busy || dialog.reason.trim().length < 3) return
      patch({ busy: true, problem: null })
      voidInstruction(api, dialog.entry.id, { version: dialog.entry.version, reason: dialog.reason.trim() }).then(() => {
        setDialog(null)
        done('done.entryVoided', { name: dialog.entry.employee.name }, [readInstruction])
      }, fail)
    },
  }

  const retry = useMemo(() => ({ courses: () => void readCourses(), needs: () => void readRequirements(), instruction: () => void readInstruction() }), [readCourses, readRequirements, readInstruction])

  return { courses, requirements, instruction, dialog, open, actions, archiveMany, paperMany, activeCourses, live, retry }
}
