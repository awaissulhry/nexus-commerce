'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { isStepUpCancelled, useCoalesced, useLive, useStepUp } from '../../_shared/hooks'
import { editAssessment, keepSeal, listMeasures, listSheets, paperSignature, readAssessment, signVersion, uploadFile, withdrawVersion, type AssessmentRecord, type Measure, type MeasuresAnswer, type SheetsAnswer } from '../api'
import { paperDraftOf, problemOf, readProblemOf, recordAddressOf, recordAddressText, recordChangeOf, riskCan, todayInRome, withRecordAddress, type RecordAddress } from '../model'
import { useMeasureDesk } from '../use-measures'
import { useSheetDesk } from '../use-sheet'
import { useVersionDesk } from '../use-version'
import type { EditAssessmentState, PageNotice, Read, SignState, WithdrawState } from '../view-model'
import { RecordView } from './view/RecordView'

/**
 * `/w/<company>/plant/risk/<id>` (SCR-209-record; B-W2b-144; design plant.risk rec "Risk assessment"): the assessment (GET
 * /safety/risk/assessments/:id: its versions with their signers and seal, who signs next, the plan's figures, what the caller
 * may do), the plan tab's measures (GET /safety/risk/measures?assessmentId, the tab's view) and the roles of its site (GET
 * /safety/rolesheets?siteId). Every dialog lives in the address (`model.ts` recordAddressOf): New DVR version, Add measure,
 * Add role, the assessment's facts (`?new=`), Sign version (`?sign=<version>&role=&method=`), Withdraw (`?withdraw=`), a
 * measure's window (`?measure=`), a role's sheet (`?sheet=&do=edit`). Signing in the office asks a fresh code (403 stepUp →
 * the code → the same request again, same key). Live: the assessment's events read it again; a measure's, the plan; a role
 * sheet's, the roles.
 */
export function RiskRecord() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const route = useParams<{ id: string }>()
  const locale = useLocale()
  const id = decodeURIComponent(route.id ?? '')
  const prefix = pathname.replace(/\/plant\/risk\/[^/]+\/?$/, '')
  const can = useMemo(() => riskCan(session.permissions), [session.permissions])
  const address = useMemo(() => recordAddressOf(params), [params])
  const companyId = session.company?.id ?? null
  const [today] = useState(todayInRome)

  const [record, setRecord] = useState<Read<AssessmentRecord>>({ status: 'loading' })
  const [measures, setMeasures] = useState<Read<MeasuresAnswer>>({ status: 'loading' })
  const [sheets, setSheets] = useState<Read<SheetsAnswer>>({ status: 'loading' })
  const [readAt, setReadAt] = useState<string | null>(null)
  const [notice, setNotice] = useState<PageNotice | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [sign, setSign] = useState<SignState | null>(null)
  const [withdraw, setWithdraw] = useState<WithdrawState | null>(null)
  const [edit, setEdit] = useState<EditAssessmentState | null>(null)
  const [keeping, setKeeping] = useState<string | null>(null)
  const scan = useRef<File | null>(null)
  const signKey = useRef<string | null>(null)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)

  const go = useCallback((change: Partial<RecordAddress>) => router.replace(`${pathname}${recordAddressText(withRecordAddress(address, change))}`, { scroll: false }), [router, pathname, address])

  const readRecordNow = useCallback(async () => {
    if (!can.view || !id) return null
    try {
      const value = await readAssessment(api, id)
      setRecord({ status: 'ready', value })
      setReadAt(new Date().toISOString())
      return value
    } catch (error) {
      setRecord({ status: 'error', problem: readProblemOf(error) })
      return null
    }
  }, [api, can.view, id])
  useEffect(() => {
    setRecord({ status: 'loading' })
    void readRecordNow()
  }, [readRecordNow])

  const view = address.view
  const measuresTurn = useRef(0)
  const readMeasuresNow = useCallback(() => {
    if (!can.view || !id) return
    const turn = ++measuresTurn.current
    listMeasures(api, { assessmentId: id, view }).then(
      (value) => turn === measuresTurn.current && setMeasures({ status: 'ready', value }),
      (error: unknown) => turn === measuresTurn.current && setMeasures({ status: 'error', problem: readProblemOf(error) }),
    )
  }, [api, can.view, id, view])
  useEffect(() => {
    setMeasures({ status: 'loading' })
    readMeasuresNow()
  }, [readMeasuresNow])

  const siteId = record.status === 'ready' ? record.value.assessment.siteId : null
  const readSheetsNow = useCallback(() => {
    if (!can.view || !siteId) return
    listSheets(api, { siteId }).then(
      (value) => setSheets({ status: 'ready', value }),
      (error: unknown) => setSheets({ status: 'error', problem: readProblemOf(error) }),
    )
  }, [api, can.view, siteId])
  useEffect(() => {
    readSheetsNow()
  }, [readSheetsNow])

  const recordRef = useRef(record)
  recordRef.current = record

  // ---- measures --------------------------------------------------------------------------------------------------------------

  const desk = useMeasureDesk({
    api,
    can,
    companyId,
    locale,
    onMeasure: (measure: Measure) => setMeasures((current) => (current.status === 'ready' ? { status: 'ready', value: { ...current.value, measures: current.value.measures.some((row) => row.id === measure.id) ? current.value.measures.map((row) => (row.id === measure.id ? measure : row)) : [...current.value.measures, measure] } } : current)),
    onWritten: () => {
      void readRecordNow()
      readMeasuresNow()
    },
    onNotice: setNotice,
    assessmentOf: (assessmentId) => (recordRef.current.status === 'ready' && recordRef.current.value.assessment.id === assessmentId ? recordRef.current.value.assessment : null),
  })
  const recordReady = record.status === 'ready'
  useEffect(() => {
    if (address.add === 'measure' && can.manage && recordReady) desk.openAdd(id)
    else if (address.measure && can.view) desk.openEdit(address.measure)
    else desk.close()
  }, [address.add, address.measure, can.manage, recordReady])

  // ---- New DVR version ---------------------------------------------------------------------------------------------------------

  const version = useVersionDesk({
    api,
    companyId,
    today,
    canManage: can.manage,
    onFrozen: () => void readRecordNow(),
    onAssessment: () => void readRecordNow(),
    onNotice: setNotice,
  })
  useEffect(() => {
    if (address.add !== 'version' || !can.manage) return version.close()
    version.open(id)
  }, [address.add, can.manage, id])

  // ---- role sheets -------------------------------------------------------------------------------------------------------------

  const sheet = useSheetDesk({
    api,
    companyId,
    canManage: can.sheets,
    onWritten: () => {
      readSheetsNow()
      void readRecordNow()
    },
    onNotice: setNotice,
    onGoSheet: (sheetId, mode) => go({ add: null, tab: 'roles', sheet: sheetId, mode }),
    onCloseNew: () => go({ add: null }),
  })
  useEffect(() => {
    sheet.show(can.view && address.tab === 'roles' ? address.sheet : null, address.mode)
  }, [address.sheet, address.mode, address.tab, can.view])
  useEffect(() => {
    if (address.add !== 'role' || !can.sheets) return sheet.closeNew()
    sheet.openNew(siteId)
  }, [address.add, can.sheets, siteId])

  // ---- Sign version, Withdraw, the assessment's facts --------------------------------------------------------------------------

  useEffect(() => {
    if (!address.sign || !address.role || record.status !== 'ready') {
      if (!address.sign) {
        setSign(null)
        scan.current = null
        signKey.current = null
      }
      return
    }
    const signer = record.value.versions.find((row) => row.id === address.sign)?.signers.find((row) => row.role === address.role) ?? null
    setSign((current) =>
      current && current.versionId === address.sign && current.role === address.role
        ? { ...current, method: address.method, problem: null }
        : { versionId: address.sign!, role: address.role!, method: address.method, paper: paperDraftOf(signer, today), busy: false, problem: null, done: null },
    )
  }, [address.sign, address.role, address.method, record.status])

  useEffect(() => {
    setWithdraw(address.withdraw ? { versionId: address.withdraw, reason: '', busy: false, problem: null } : null)
  }, [address.withdraw])

  useEffect(() => {
    if (address.add !== 'edit' || record.status !== 'ready') return setEdit(null)
    const a = record.value.assessment
    setEdit((current) => current ?? { name: a.name, nextReviewOn: a.nextReviewOn ?? '', note: a.note ?? '', busy: false, problem: null })
  }, [address.add, record.status])

  const signOffice = async (name: string) => {
    if (!sign || sign.busy) return
    setSign({ ...sign, busy: true, problem: null })
    signKey.current = signKey.current ?? newIdempotencyKey()
    const key = signKey.current
    try {
      const answer = await guard('stepUp.sentence', () => signVersion(api, sign.versionId, { role: sign.role, signerName: name.trim() }, key))
      signKey.current = null
      setSign((current) => (current ? { ...current, busy: false, done: answer } : current))
      setNotice({ tone: 'success', key: answer.complete ? 'notice.signedComplete' : 'notice.signed', params: { version: `v${answer.version.versionNo}` } })
      void readRecordNow()
    } catch (error) {
      if (isStepUpCancelled(error)) return setSign((current) => (current ? { ...current, busy: false, problem: { key: 'stepUp.cancelled', field: null } } : current))
      const problem = problemOf(error)
      setSign((current) => (current ? { ...current, busy: false, problem: problem.key === 'refusal.NAME_MISMATCH' ? { ...problem, field: 'signerName' } : problem } : current))
    }
  }

  const signPaper = async () => {
    if (!sign || sign.busy || record.status !== 'ready') return
    const file = scan.current
    const version = record.value.versions.find((row) => row.id === sign.versionId)
    const signer = version?.signers.find((row) => row.role === sign.role)
    if (!file || !version || !signer) return
    setSign({ ...sign, busy: true, problem: null })
    try {
      await uploadFile(api, { type: 'RiskAssessmentSignature', id: signer.signatureId, companyId: record.value.assessment.companyId }, file)
      const answer = await paperSignature(api, sign.versionId, { role: sign.role, signerName: sign.paper.signerName.trim(), signedOn: sign.paper.signedOn }, newIdempotencyKey())
      scan.current = null
      setSign((current) => (current ? { ...current, busy: false, done: answer } : current))
      setNotice({ tone: 'success', key: answer.complete ? 'notice.signedComplete' : 'notice.paperRecorded', params: { version: `v${answer.version.versionNo}` } })
      void readRecordNow()
    } catch (error) {
      setSign((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  const doWithdraw = async () => {
    if (!withdraw || withdraw.busy || record.status !== 'ready') return
    const version = record.value.versions.find((row) => row.id === withdraw.versionId)
    if (!version) return
    setWithdraw({ ...withdraw, busy: true, problem: null })
    try {
      await withdrawVersion(api, version.id, { version: version.version, reason: withdraw.reason.trim() }, newIdempotencyKey())
      setNotice({ tone: 'success', key: 'notice.withdrawn', params: { version: `v${version.versionNo}` } })
      go({ withdraw: null })
      void readRecordNow()
    } catch (error) {
      setWithdraw((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  const saveEdit = async () => {
    if (!edit || edit.busy || record.status !== 'ready') return
    const a = record.value.assessment
    setEdit({ ...edit, busy: true, problem: null })
    try {
      await editAssessment(api, a.id, { version: a.version, name: edit.name.trim(), nextReviewOn: edit.nextReviewOn || null, note: edit.note.trim() || null }, newIdempotencyKey())
      setNotice({ tone: 'success', key: 'notice.assessmentSaved' })
      go({ add: null })
      void readRecordNow()
    } catch (error) {
      setEdit((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  const keep = async (versionId: string) => {
    if (keeping) return
    setKeeping(versionId)
    try {
      const kept = await keepSeal(api, versionId, locale === 'en' ? 'en' : 'it', newIdempotencyKey())
      setNotice({ tone: 'success', key: kept.made ? 'notice.sealKept' : 'notice.sealSame', params: { number: kept.document.version } })
      await readRecordNow()
    } catch (error) {
      setNotice({ tone: 'danger', key: problemOf(error).key })
    } finally {
      setKeeping(null)
    }
  }

  // ---- live ------------------------------------------------------------------------------------------------------------------

  const flushRecord = useCoalesced(() => void readRecordNow(), 800)
  const flushPlan = useCoalesced(() => {
    void readRecordNow()
    readMeasuresNow()
  }, 800)
  const flushRoles = useCoalesced(() => {
    readSheetsNow()
    sheetRef.current.reread()
  }, 800)
  const sheetRef = useRef(sheet)
  sheetRef.current = sheet
  useLive(
    (change) => {
      const part = recordChangeOf(change, id)
      if (part === 'record') flushRecord()
      else if (part === 'plan') flushPlan()
      else if (part === 'roles') flushRoles()
    },
    () => {
      flushRecord()
      flushPlan()
      flushRoles()
    },
    can.view,
  )

  return (
    <RecordView
      model={{
        prefix,
        can,
        scope,
        companyId,
        today,
        id,
        address,
        record: can.view ? record : { status: 'error', problem: 'problem.forbidden' },
        measures,
        sheets,
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
        sign,
        withdraw,
        edit,
        keeping,
        stepUp,
      }}
      actions={{
        ...desk.actions,
        ...version.actions,
        ...sheet.actions,
        onMeasureClose: () => go({ add: null, measure: null }),
        onVersionClose: () => go({ add: null }),
        onAddress: go,
        onRetry: () => {
          setRecord({ status: 'loading' })
          void readRecordNow()
        },
        onRetryMeasures: () => {
          setMeasures({ status: 'loading' })
          readMeasuresNow()
        },
        onRetrySheets: () => {
          setSheets({ status: 'loading' })
          readSheetsNow()
        },
        onDismissNotice: () => setNotice(null),
        onSelected: setSelected,
        onSignDraft: (paper) => setSign((current) => (current ? { ...current, paper, problem: null } : current)),
        onSignScan: (file) => {
          scan.current = file
          setSign((current) => (current ? { ...current, problem: null, paper: { ...current.paper, scan: file ? { name: file.name, type: file.type, size: file.size } : null } } : current))
        },
        onSignOffice: (name) => void signOffice(name),
        onSignPaper: () => void signPaper(),
        onWithdrawReason: (reason) => setWithdraw((current) => (current ? { ...current, reason, problem: null } : current)),
        onWithdraw: () => void doWithdraw(),
        onEditDraft: setEdit,
        onEditSave: () => void saveEdit(),
        onKeepSeal: (versionId) => void keep(versionId),
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
      }}
    />
  )
}
