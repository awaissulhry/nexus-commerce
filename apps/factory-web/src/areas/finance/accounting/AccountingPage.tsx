'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { isStepUpCancelled, useCoalesced, useLive, useStepUp } from '../_shared/hooks'
import {
  cancelExport,
  createExport,
  fileLink,
  getIntrastat,
  getPeriod,
  getPeriods,
  liftLock,
  listExports,
  listLocks,
  lockMonth,
  type AccountingPackage,
  type CheckCode,
  type ExportFile,
  type ExportRow,
  type LockLevel,
  type PeriodAnswer,
  type PeriodLock,
  type Periods,
} from './api'
import { downloadStored } from './download'
import {
  accountingCanOf,
  accountingHref,
  addressOf,
  askablePackages,
  cancelHeld,
  continueHeld,
  defaultPackages,
  exportBody,
  exportHeld,
  fixedSince,
  liftHeld,
  lockHeld,
  monthWords,
  periodChanged,
  periodTouches,
  historyTouches,
  readProblem,
  recentMonths,
  romeToday,
  showMeStep,
  stepsFor,
  togglePackage,
  wizardHref,
  writeProblem,
  type Explanations,
  type Phrase,
  type WizardFacts,
  type WizardStep,
} from './model'
import { AccountingView } from './view/AccountingView'
import type { AccountingActions, AccountingModel, CancelDialogModel, ExportingState, LockActions, LockDialogModel, LockPanelModel, Part } from './view-model'

const SLOW_MS = 1000
/** Live changes behind the wizard's checks are read again at most this often. */
const RECHECK_MS = 2000

const lockPanel = (month: string | null, current: PeriodLock | null | undefined): LockPanelModel => ({
  month,
  current,
  level: current?.status === 'LOCKED' && current.level === 'SOFT' ? 'HARD' : 'SOFT',
  phrase: '',
  note: '',
  busy: false,
  problem: null,
  done: null,
  liftReason: '',
  liftBusy: false,
  liftProblem: null,
  lifted: null,
})

const EXPORT_IDLE: ExportingState = { busy: false, startedAt: null, problem: null, done: null }

/**
 * `/w/<company>/finance/accounting` (SCR-156): the Exports of the company (`?status=&year=`, 50 a page) and its months'
 * locks (this year and the last); the wizard (`?new=1`, `?month=&step=`) reads the month with every package the person
 * may put in, ticks the default ones, keeps the explanations of the failing checks and the choices until Export, reads
 * the Intrastat rows when Intrastat goes in, makes the batch (one request: files first, then the number), and locks the
 * month (soft, or hard with the typed phrase). Live: a batch or a lock moves the history and the band; anything behind a
 * check reads the month again in the background ("N checks fixed since you opened this · Check again"). Lifting a hard
 * lock asks a fresh authenticator code first. Nothing is sent to the accountant or any authority.
 */
export function AccountingPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/finance\/accounting\/?$/, '')
  const can = useMemo(() => accountingCanOf(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const companyId = session.company?.id ?? null
  const locale = useLocale()
  const today = romeToday()
  const thisYear = Number(today.slice(0, 4))

  // ---- the history and the band ----
  const [history, setHistory] = useState<{ rows: ExportRow[] | null; nextCursor: string | null; problem: string | null; slow: boolean; readAt: number | null }>({ rows: null, nextCursor: null, problem: null, slow: false, readAt: null })
  const [years, setYears] = useState<Record<number, Part<Periods>>>({})
  const yearsRef = useRef(years)
  yearsRef.current = years
  const [updates, setUpdates] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [notice, setNotice] = useState<Phrase | null>(null)

  const cursorRef = useRef<string | null>(null)
  cursorRef.current = history.nextCursor
  const loadHistory = useCallback(
    async (more = false) => {
      if (!can.view || !companyId) return
      const slow = setTimeout(() => setHistory((current) => (current.rows || current.problem ? current : { ...current, slow: true })), SLOW_MS)
      try {
        const cursor = more ? cursorRef.current : null
        const page = await listExports(api, { companyId, status: address.status, year: address.year, cursor })
        setHistory((current) => ({ rows: more && current.rows ? [...current.rows, ...page.rows] : page.rows, nextCursor: page.nextCursor, problem: null, slow: false, readAt: Date.now() }))
        setNow(Date.now())
        if (!more) setUpdates(0)
      } catch (error) {
        setHistory((current) => ({ ...current, rows: more ? current.rows : null, problem: readProblem(error), slow: false }))
      } finally {
        clearTimeout(slow)
      }
    },
    [api, can.view, companyId, address.status, address.year],
  )

  const loadYear = useCallback(
    async (year: number): Promise<Periods | null> => {
      if (!can.view || !companyId) return null
      try {
        const value = await getPeriods(api, companyId, year)
        setYears((current) => ({ ...current, [year]: { value, problem: null } }))
        return value
      } catch (error) {
        setYears((current) => ({ ...current, [year]: { value: current[year]?.value ?? null, problem: readProblem(error) } }))
        return null
      }
    },
    [api, can.view, companyId],
  )

  const periodsOf = useCallback(async (year: number): Promise<Periods | null> => yearsRef.current[year]?.value ?? loadYear(year), [loadYear])

  useEffect(() => {
    setHistory((current) => ({ ...current, rows: null, problem: null }))
    void loadHistory()
  }, [loadHistory])

  useEffect(() => {
    void loadYear(thisYear)
    void loadYear(thisYear - 1)
  }, [loadYear, thisYear])

  // ---- the wizard ----
  const month = address.wizard ? address.month : null
  const [wizardYear, setWizardYear] = useState(() => (month ? Number(month.slice(0, 4)) : thisYear))
  const [period, setPeriod] = useState<Part<PeriodAnswer>>({ value: null, problem: null })
  const [pending, setPending] = useState<{ answer: PeriodAnswer; fixed: CheckCode[]; changed: boolean } | null>(null)
  const [chosen, setChosen] = useState<AccountingPackage[] | null>(null)
  const [explanations, setExplanations] = useState<Explanations>({})
  const [intrastat, setIntrastat] = useState<Part<Awaited<ReturnType<typeof getIntrastat>>>>({ value: null, problem: null })
  const [language, setLanguage] = useState<'it' | 'en'>('it')
  const [note, setNote] = useState('')
  const [exporting, setExporting] = useState<ExportingState>(EXPORT_IDLE)
  const [stepLock, setStepLock] = useState<LockPanelModel>(() => lockPanel(month, null))
  const [heldNote, setHeldNote] = useState<Phrase | null>(null)
  const monthRef = useRef(month)
  monthRef.current = month
  const periodRef = useRef(period)
  periodRef.current = period
  const chosenRef = useRef(chosen)
  chosenRef.current = chosen

  const readPeriod = useCallback(
    async (target: string): Promise<PeriodAnswer> => {
      if (!companyId) throw new Error('no company')
      const periods = await periodsOf(Number(target.slice(0, 4)))
      const yearEnd = periods ? periods.yearEndMonth === target : target.endsWith('-12')
      return getPeriod(api, companyId, target, askablePackages(yearEnd, can))
    },
    [api, can, companyId, periodsOf],
  )

  const showPeriod = useCallback(
    async (target: string) => {
      try {
        const answer = await readPeriod(target)
        if (monthRef.current !== target) return
        setPeriod({ value: answer, problem: null })
        setPending(null)
        setChosen((current) => current ?? defaultPackages(answer, can))
        setStepLock((current) => (current.done || current.busy ? current : lockPanel(target, answer.lock)))
      } catch (error) {
        if (monthRef.current === target) setPeriod({ value: null, problem: readProblem(error) })
      }
    },
    [readPeriod, can],
  )

  // A new month: everything chosen for the one before is forgotten.
  useEffect(() => {
    setPeriod({ value: null, problem: null })
    setPending(null)
    setChosen(null)
    setExplanations({})
    setIntrastat({ value: null, problem: null })
    setExporting(EXPORT_IDLE)
    setStepLock(lockPanel(month, undefined))
    setHeldNote(null)
    if (month) {
      setWizardYear(Number(month.slice(0, 4)))
      void showPeriod(month)
    }
  }, [month, showPeriod])

  useEffect(() => {
    if (address.wizard && !yearsRef.current[wizardYear]) void loadYear(wizardYear)
  }, [address.wizard, wizardYear, loadYear])

  const loadIntrastat = useCallback(async () => {
    const target = monthRef.current
    if (!target || !companyId) return
    setIntrastat({ value: null, problem: null })
    try {
      const value = await getIntrastat(api, companyId, target)
      if (monthRef.current === target) setIntrastat({ value, problem: null })
    } catch (error) {
      if (monthRef.current === target) setIntrastat({ value: null, problem: readProblem(error) })
    }
  }, [api, companyId])

  useEffect(() => {
    if (address.wizard && address.step === 'intrastat' && chosen?.includes('INTRASTAT') && !intrastat.value && !intrastat.problem) void loadIntrastat()
  }, [address.wizard, address.step, chosen, intrastat.value, intrastat.problem, loadIntrastat])

  // ---- live ----
  const recheck = useCoalesced(() => {
    const target = monthRef.current
    if (!target || exporting.busy) return
    readPeriod(target)
      .then((answer) => {
        if (monthRef.current !== target) return
        const shown = periodRef.current.value
        if (!periodChanged(shown, answer)) return
        setPending({ answer, fixed: fixedSince(shown, answer, chosenRef.current ?? []), changed: true })
      })
      .catch(() => undefined)
  }, RECHECK_MS)

  const live = useLive(
    (change) => {
      if (historyTouches(change)) {
        setUpdates((count) => count + 1)
        void loadYear(thisYear)
        void loadYear(thisYear - 1)
      }
      if (monthRef.current && periodTouches(change)) recheck()
    },
    () => {
      void loadHistory()
      if (monthRef.current) void showPeriod(monthRef.current)
    },
    can.view,
  )

  // ---- the lock dialog ----
  const [lockDialog, setLockDialog] = useState<LockDialogModel | null>(null)
  const [locks, setLocks] = useState<PeriodLock[] | null>(null)

  const lockMonths = useCallback(
    (): LockDialogModel['months'] => {
      const all = [yearsRef.current[thisYear]?.value ?? null, yearsRef.current[thisYear - 1]?.value ?? null]
      return recentMonths(today, all, 12).map((entry) => ({ month: entry.month, state: entry.state }))
    },
    [thisYear, today],
  )

  const openLock = useCallback(
    (target: string | null) => {
      const lockOf = (rows: PeriodLock[] | null, wanted: string | null) => (wanted && rows ? (rows.find((row) => row.period.month === wanted) ?? null) : undefined)
      setLockDialog({ ...lockPanel(target, lockOf(locks, target)), months: lockMonths(), readProblem: null })
      if (!companyId) return
      listLocks(api, companyId)
        .then((rows) => {
          setLocks(rows)
          setLockDialog((current) => (current ? { ...current, current: current.month ? (rows.find((row) => row.period.month === current.month) ?? null) : current.current, level: lockPanel(current.month, current.month ? (rows.find((row) => row.period.month === current.month) ?? null) : null).level } : current))
        })
        .catch((error: unknown) => setLockDialog((current) => (current ? { ...current, readProblem: readProblem(error) } : current)))
    },
    [api, companyId, locks, lockMonths],
  )

  useEffect(() => {
    if (address.lock && !lockDialog) openLock(address.lock === '1' ? null : address.lock)
    // Only when the address asks for it.
  }, [address.lock])

  // ---- the cancel dialog ----
  const [cancelDialog, setCancelDialog] = useState<CancelDialogModel | null>(null)

  const stepUpApi = useStepUp(api)

  // ---- writes ----
  const lockWith = (panel: LockPanelModel, set: (update: (current: LockPanelModel) => LockPanelModel) => void) => {
    if (!companyId || !panel.month) return
    const current = panel.current ?? null
    if (lockHeld({ month: panel.month, level: panel.level, phrase: panel.phrase, current, can, busy: panel.busy })) return
    const target = panel.month
    set((state) => ({ ...state, busy: true, problem: null }))
    const note = panel.note.trim()
    lockMonth(api, { companyId, month: target, level: panel.level, ...(panel.level === 'HARD' ? { phrase: panel.phrase } : {}), ...(note ? { note } : {}), ...(current ? { version: current.version } : {}) })
      .then((answer) => {
        set((state) => ({ ...state, busy: false, current: answer.lock, done: { lock: answer.lock, warnings: answer.warnings.map((warning) => warning.code) } }))
        setLocks((rows) => (rows ? [answer.lock, ...rows.filter((row) => row.id !== answer.lock.id)] : rows))
        void loadYear(Number(target.slice(0, 4)))
        if (monthRef.current === target) void showPeriod(target)
      })
      .catch((error: unknown) => set((state) => ({ ...state, busy: false, problem: writeProblem(error) })))
  }

  const liftWith = (panel: LockPanelModel, set: (update: (current: LockPanelModel) => LockPanelModel) => void) => {
    const current = panel.current ?? null
    if (!current || liftHeld(current, panel.liftReason, can, panel.liftBusy)) return
    const key = newIdempotencyKey()
    const work = () => liftLock(api, current.id, { version: current.version, reason: panel.liftReason.trim() }, key)
    set((state) => ({ ...state, liftBusy: true, liftProblem: null }))
    const run = current.level === 'HARD' ? stepUpApi.ensureFresh('stepUp.lift').then(() => stepUpApi.guard('stepUp.lift', work)) : work()
    run
      .then((lock) => {
        set((state) => ({ ...state, liftBusy: false, lifted: lock, current: lock }))
        setLocks((rows) => (rows ? rows.map((row) => (row.id === lock.id ? lock : row)) : rows))
        void loadYear(Number(lock.period.month.slice(0, 4)))
        if (monthRef.current === lock.period.month) void showPeriod(lock.period.month)
      })
      .catch((error: unknown) => set((state) => ({ ...state, liftBusy: false, liftProblem: isStepUpCancelled(error) ? null : writeProblem(error) })))
  }

  const lockActions = (panel: LockPanelModel | null, set: (update: (current: LockPanelModel) => LockPanelModel) => void): LockActions => ({
    onLockLevel: (level: LockLevel) => set((state) => ({ ...state, level, problem: null })),
    onLockPhrase: (text) => set((state) => ({ ...state, phrase: text, problem: null })),
    onLockNote: (text) => set((state) => ({ ...state, note: text })),
    onLiftReason: (text) => set((state) => ({ ...state, liftReason: text, liftProblem: null })),
    onLock: () => panel && lockWith(panel, set),
    onLift: () => panel && liftWith(panel, set),
  })

  const setDialogPanel = (update: (current: LockPanelModel) => LockPanelModel) => setLockDialog((current) => (current ? { ...current, ...update(current) } : current))

  const facts: WizardFacts = { month, answer: period.value, problem: period.problem, chosen, explanations, can }
  const steps = stepsFor(chosen)
  const go = (step: WizardStep) => {
    if (!month) return
    setHeldNote(null)
    router.replace(wizardHref(prefix, month, step), { scroll: false })
  }

  const actions: AccountingActions = {
    onNew: () => router.push(wizardHref(prefix, null)),
    onStatus: (status) => router.replace(accountingHref(prefix, { status, year: address.year ? String(address.year) : null }), { scroll: false }),
    onYear: (year) => router.replace(accountingHref(prefix, { status: address.status, year: year ? String(year) : null }), { scroll: false }),
    onMore: () => void loadHistory(true),
    onRetry: () => void loadHistory(),
    onShowUpdates: () => void loadHistory(),
    onDismissNotice: () => setNotice(null),
    onCancelDraft: (row) => setCancelDialog({ row, reason: '', busy: false, problem: null }),
    onCancelReason: (text) => setCancelDialog((current) => (current ? { ...current, reason: text, problem: null } : current)),
    onCloseCancel: () => setCancelDialog(null),
    onConfirmCancel: () => {
      const dialog = cancelDialog
      if (!dialog || dialog.busy || dialog.reason.trim() === '' || cancelHeld(dialog.row, can)) return
      setCancelDialog({ ...dialog, busy: true, problem: null })
      cancelExport(api, dialog.row.id, { version: dialog.row.version, reason: dialog.reason.trim() })
        .then(() => {
          setCancelDialog(null)
          setNotice({ key: 'notice.cancelled', params: { month: monthWords(dialog.row.period.month, locale) } })
          void loadHistory()
        })
        .catch((error: unknown) => setCancelDialog((current) => (current ? { ...current, busy: false, problem: writeProblem(error) } : current)))
    },
    onStep: (step) => go(step),
    onContinue: () => {
      const held = continueHeld(address.step, facts)
      if (held) {
        setHeldNote(held)
        return
      }
      const next = steps[steps.indexOf(address.step) + 1]
      if (next) go(next)
    },
    onBack: () => {
      const previous = steps[steps.indexOf(address.step) - 1]
      if (previous) go(previous)
    },
    onShowMe: () => {
      const target = showMeStep(address.step, facts)
      if (target) go(target)
    },
    onMonth: (target) => router.replace(wizardHref(prefix, target, 'period'), { scroll: false }),
    onPeriodYear: (year) => {
      setWizardYear(year)
      if (!yearsRef.current[year]?.value) void loadYear(year)
    },
    onRetryPeriods: () => void loadYear(wizardYear),
    onRetryPeriod: () => {
      if (!month) return
      setPeriod({ value: null, problem: null })
      void showPeriod(month)
    },
    onCheckAgain: () => {
      if (!pending) return
      setPeriod({ value: pending.answer, problem: null })
      setPending(null)
      if (chosen?.includes('INTRASTAT')) void loadIntrastat()
    },
    onTogglePackage: (pkg) => setChosen((current) => togglePackage(current ?? [], pkg)),
    onExplain: (code, text) => setExplanations((current) => ({ ...current, [code]: text })),
    onRetryIntrastat: () => void loadIntrastat(),
    onLanguage: setLanguage,
    onNote: setNote,
    onExport: () => {
      const answer = period.value
      if (!companyId || !month || !answer || !chosen || exportHeld({ ...facts, busy: exporting.busy })) return
      setExporting({ busy: true, startedAt: Date.now(), problem: null, done: null })
      createExport(api, exportBody({ companyId, month, answer, chosen, explanations, note, language }))
        .then((record) => {
          setExporting({ busy: false, startedAt: null, problem: null, done: record })
          setStepLock(lockPanel(month, answer.lock))
          void loadHistory()
          void loadYear(Number(month.slice(0, 4)))
        })
        .catch((error: unknown) => {
          const problem = writeProblem(error)
          setExporting({ busy: false, startedAt: null, problem, done: null })
          if (problem.reload) void showPeriod(month)
        })
    },
    onDownload: (exportId: string, file: ExportFile) => {
      void downloadStored(() => fileLink(api, exportId, file.file.id), file.file.name).catch((error: unknown) => setExporting((current) => ({ ...current, problem: writeProblem(error) })))
    },
    stepLock: lockActions(stepLock, (update) => setStepLock((current) => update(current))),
    onOpenLock: (target) => openLock(target),
    onCloseLock: () => {
      setLockDialog(null)
      if (address.lock) router.replace(accountingHref(prefix, { status: address.status, year: address.year ? String(address.year) : null }), { scroll: false })
    },
    dialogLock: {
      ...lockActions(lockDialog, setDialogPanel),
      onLockMonth: (target) => {
        const current = locks ? (locks.find((row) => row.period.month === target) ?? null) : undefined
        setLockDialog((dialog) => (dialog ? { ...dialog, ...lockPanel(target, current) } : dialog))
      },
    },
    onStepUpSubmit: (code) => void stepUpApi.submitStepUp(code),
    onStepUpCancel: () => stepUpApi.cancelStepUp(),
  }

  const recent = years[thisYear]?.value || years[thisYear - 1]?.value ? recentMonths(today, [years[thisYear]?.value ?? null, years[thisYear - 1]?.value ?? null]) : null
  const model: AccountingModel = {
    prefix,
    can,
    today,
    address,
    live,
    now,
    recent,
    history: { rows: history.rows, more: !!history.nextCursor, problem: history.problem, slow: history.slow, readAt: history.readAt },
    updates,
    wizard: address.wizard
      ? {
          step: address.step,
          month,
          year: wizardYear,
          periods: years[wizardYear] ?? { value: null, problem: null },
          period,
          pending: pending ? { fixed: pending.fixed, changed: pending.changed } : null,
          chosen,
          explanations,
          intrastat,
          language,
          note,
          exporting,
          lock: stepLock,
          heldNote,
        }
      : null,
    lockDialog: lockDialog ? { ...lockDialog, months: lockDialog.months.length > 0 ? lockDialog.months : lockMonths() } : null,
    cancelDialog,
    stepUp: stepUpApi.stepUp,
    notice,
  }
  return <AccountingView model={model} actions={actions} />
}
