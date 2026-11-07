'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useCoalesced, useLive } from '../_shared/hooks'
import { listAssessments, listMeasures, listSheets, readCounts, readMeasure, type AssessmentsAnswer, type CountsAnswer, type Measure, type MeasuresAnswer, type SheetsAnswer } from './api'
import { addressOf, addressText, isRiskChange, readProblemOf, recordHref, riskCan, todayInRome, withAddress, type RiskAddress } from './model'
import { useMeasureDesk } from './use-measures'
import { useSheetDesk } from './use-sheet'
import { useVersionDesk } from './use-version'
import type { ListSelection, PageNotice, Read } from './view-model'
import { RiskPageView } from './view/RiskPageView'

type Section = 'counts' | 'assessments' | 'measures' | 'sheets'

/**
 * `/w/<company>/plant/risk` (SCR-209; B-W2b-144; design plant.risk): four reads — the tiles (GET /safety/risk/counts), the
 * assessments (GET /safety/risk/assessments), the improvement plan (GET /safety/risk/measures, the address's view) and the
 * role sheets (GET /safety/rolesheets, `?q=`) — each loading and failing on its own, all with the top bar's site. Every
 * dialog lives in the address (`model.ts` addressOf): Add measure (`?new=measure`), New DVR version (`?new=version`), Add
 * role (`?new=role`), a role sheet's window (`?sheet=<id>&do=edit`); `?measure=<id>` (a measure's own address) goes to its
 * assessment's plan tab. Live: the five risk and role sheet events read the parts they move again (coalesced).
 */
export function RiskPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = pathname.replace(/\/plant\/risk\/?$/, '')
  const can = useMemo(() => riskCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const siteId = scope.siteId
  const companyId = session.company?.id ?? null
  const [today] = useState(todayInRome)

  const [counts, setCounts] = useState<Read<CountsAnswer>>({ status: 'loading' })
  const [assessments, setAssessments] = useState<Read<AssessmentsAnswer>>({ status: 'loading' })
  const [measures, setMeasures] = useState<Read<MeasuresAnswer>>({ status: 'loading' })
  const [sheets, setSheets] = useState<Read<SheetsAnswer>>({ status: 'loading' })
  const [readAt, setReadAt] = useState<string | null>(null)
  const [notice, setNotice] = useState<PageNotice | null>(null)
  const [selected, setSelected] = useState<ListSelection>({ assessments: [], measures: [], sheets: [] })
  const turns = useRef<Record<Section, number>>({ counts: 0, assessments: 0, measures: 0, sheets: 0 })

  const settle = useCallback(<T,>(section: Section, set: (read: Read<T>) => void, reading: Promise<T>) => {
    const turn = ++turns.current[section]
    return reading.then(
      (value) => {
        if (turn === turns.current[section]) set({ status: 'ready', value })
      },
      (error: unknown) => {
        if (turn === turns.current[section]) set({ status: 'error', problem: readProblemOf(error) })
      },
    )
  }, [])

  const readCountsNow = useCallback(() => (can.view ? settle('counts', setCounts, readCounts(api, siteId)) : Promise.resolve()), [api, can.view, settle, siteId])
  const readAssessmentsNow = useCallback(
    () =>
      can.view
        ? settle('assessments', setAssessments, listAssessments(api, siteId).then((answer) => {
            setReadAt(new Date().toISOString())
            return answer
          }))
        : Promise.resolve(),
    [api, can.view, settle, siteId],
  )
  const view = address.view
  const readMeasuresNow = useCallback(() => (can.view ? settle('measures', setMeasures, listMeasures(api, { siteId, view })) : Promise.resolve()), [api, can.view, settle, siteId, view])
  const q = address.q
  const readSheetsNow = useCallback(() => (can.view ? settle('sheets', setSheets, listSheets(api, { siteId, q })) : Promise.resolve()), [api, can.view, settle, siteId, q])

  useEffect(() => {
    setCounts({ status: 'loading' })
    void readCountsNow()
  }, [readCountsNow])
  useEffect(() => {
    setAssessments({ status: 'loading' })
    void readAssessmentsNow()
  }, [readAssessmentsNow])
  useEffect(() => {
    setMeasures({ status: 'loading' })
    void readMeasuresNow()
  }, [readMeasuresNow])
  useEffect(() => {
    setSheets({ status: 'loading' })
    void readSheetsNow()
  }, [readSheetsNow])

  const go = useCallback((change: Partial<RiskAddress>) => router.replace(`${pathname}${addressText(withAddress(address, change))}`, { scroll: false }), [router, pathname, address])

  // A measure's own address (RECORD_PAGES.RiskMeasure) goes to its assessment's plan tab.
  useEffect(() => {
    if (!address.measure || !can.view) return
    const id = address.measure
    readMeasure(api, id).then(
      (answer) => router.replace(recordHref(prefix, answer.measure.assessmentId, { tab: 'plan', measure: id })),
      () => {
        setNotice({ tone: 'warning', key: 'notice.measureGone' })
        go({ measure: null })
      },
    )
  }, [address.measure, can.view])

  const rereadAll = useCallback(() => {
    void readCountsNow()
    void readAssessmentsNow()
    void readMeasuresNow()
    void readSheetsNow()
  }, [readCountsNow, readAssessmentsNow, readMeasuresNow, readSheetsNow])

  const assessmentRows = assessments.status === 'ready' ? assessments.value.assessments : null
  const assessmentRowsRef = useRef(assessmentRows)
  assessmentRowsRef.current = assessmentRows

  // ---- the improvement plan's writes -----------------------------------------------------------------------------------------

  const desk = useMeasureDesk({
    api,
    can,
    companyId,
    locale,
    onMeasure: (measure: Measure) => setMeasures((current) => (current.status === 'ready' ? { status: 'ready', value: { ...current.value, measures: current.value.measures.some((row) => row.id === measure.id) ? current.value.measures.map((row) => (row.id === measure.id ? measure : row)) : current.value.measures } } : current)),
    onWritten: () => {
      void readCountsNow()
      void readAssessmentsNow()
      void readMeasuresNow()
    },
    onNotice: setNotice,
    assessmentOf: (id) => assessmentRowsRef.current?.find((row) => row.id === id) ?? null,
  })

  useEffect(() => {
    if (address.add !== 'measure' || !can.manage) {
      if (desk.dialog?.mode === 'add') desk.close()
      return
    }
    const rows = assessmentRowsRef.current
    const only = address.assessment ?? (rows && rows.length === 1 ? rows[0]!.id : rows && scope.site ? (rows.find((row) => row.siteId === scope.site!.id)?.id ?? null) : null)
    desk.openAdd(only)
  }, [address.add, can.manage, assessmentRows === null])

  // ---- New DVR version ---------------------------------------------------------------------------------------------------------

  const version = useVersionDesk({
    api,
    companyId,
    today,
    canManage: can.manage,
    onFrozen: () => rereadAll(),
    onAssessment: () => void readAssessmentsNow(),
    onNotice: setNotice,
  })
  useEffect(() => {
    if (address.add !== 'version' || !can.manage) return version.close()
    version.open(address.assessment)
  }, [address.add, can.manage])

  // ---- role sheets -------------------------------------------------------------------------------------------------------------

  const sheet = useSheetDesk({
    api,
    companyId,
    canManage: can.sheets,
    onWritten: () => {
      void readSheetsNow()
      void readCountsNow()
      void readAssessmentsNow()
    },
    onNotice: setNotice,
    onGoSheet: (id, mode) => go({ add: null, sheet: id, mode }),
    onCloseNew: () => go({ add: null }),
  })
  useEffect(() => {
    sheet.show(can.view ? address.sheet : null, address.mode)
  }, [address.sheet, address.mode, can.view])
  useEffect(() => {
    if (address.add !== 'role' || !can.sheets) return sheet.closeNew()
    sheet.openNew(siteId)
  }, [address.add, can.sheets])

  // ---- live ------------------------------------------------------------------------------------------------------------------

  const flush = useCoalesced(rereadAll, 800)
  const sheetRef = useRef(sheet)
  sheetRef.current = sheet
  useLive(
    (change) => {
      if (!isRiskChange(change)) return
      flush()
      if (change.type === 'role_sheet.changed' && change.fields.roleSheetId === sheetRef.current.state?.id) sheetRef.current.reread()
    },
    flush,
    can.view,
  )

  const closeDialog = () => go({ add: null })

  return (
    <RiskPageView
      model={{
        prefix,
        can,
        scope,
        companyId,
        today,
        address,
        counts: can.view ? counts : { status: 'loading' },
        assessments: can.view ? assessments : { status: 'loading' },
        measures: can.view ? measures : { status: 'loading' },
        sheets: can.view ? sheets : { status: 'loading' },
        readAt,
        notice,
        selected,
        cells: desk.cells,
        owners: desk.owners,
        measure: desk.dialog,
        move: desk.move,
        version: version.state,
        sheet: sheet.state,
        newSheet: sheet.fresh,
      }}
      actions={{
        ...desk.actions,
        ...version.actions,
        ...sheet.actions,
        onMeasureClose: closeDialog,
        onVersionClose: closeDialog,
        onAddress: go,
        onGo: (href) => router.push(href),
        onRetryCounts: () => {
          setCounts({ status: 'loading' })
          void readCountsNow()
        },
        onRetryAssessments: () => {
          setAssessments({ status: 'loading' })
          void readAssessmentsNow()
        },
        onRetryMeasures: () => {
          setMeasures({ status: 'loading' })
          void readMeasuresNow()
        },
        onRetrySheets: () => {
          setSheets({ status: 'loading' })
          void readSheetsNow()
        },
        onDismissNotice: () => setNotice(null),
        onSelected: (change) => setSelected((current) => ({ ...current, ...change })),
      }}
    />
  )
}
