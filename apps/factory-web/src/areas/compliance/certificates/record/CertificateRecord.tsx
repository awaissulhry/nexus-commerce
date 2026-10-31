'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { liveMatches, useLive, useRecordTab } from '../../../quality/_shared/hooks'
import { failedRead, problemKey, reading, ready, type Notice, type Read } from '../../../quality/_shared/model'
import {
  addCoverage,
  archiveCoverage,
  checkGarment,
  downloadAddress,
  getCertificate,
  getStyleFacts,
  listBrands,
  listCertificateFiles,
  listCertificates,
  moveCertificate,
  pickedFile,
  searchMaterials,
  searchStyles,
  updateCertificate,
  uploadPdf,
  type BrandOption,
  type Certificate,
  type CertificateDetail,
  type CertificateFile,
  type StyleFacts,
} from '../api'
import {
  blankCheck,
  blankCoverage,
  certCan,
  defaultLapseDate,
  draftOf,
  inputOf,
  lapseCells,
  lapseSummary,
  RECORD_TABS,
  todayInRome,
  type CertificateDraft,
  type CheckModel,
  type CoverageDraft,
  type DraftField,
  type LapseAnswer,
  type LapseModel,
  type RecordDialog,
} from '../model'
import { CertMessages } from '../view/parts'
import { reviewsCsv, RENEWAL_ACTS, type RenewalAct } from '../renewals/model'
import { useRenewals } from '../renewals/use-renewals'
import type { Review } from '../renewals/api'
import { csvLine, downloadText } from '../../../quality/_shared/hooks'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { CertificateRecordView } from './view/CertificateRecordView'

const WIDE = '(min-width: 1280px)'
const DOCK_KEY = 'fw.ce.dock'
const ACTS = ['check', 'register', 'coverage', 'suspend', 'withdraw', 'reinstate'] as const

/** The API's sentences of a refusal (data, English) for the lines under our words. */
const issueLines = (error: unknown): string[] => (isApiError(error) ? [...error.issues.map((issue) => issue.message ?? '').filter(Boolean), ...(error.issues.length === 0 && error.kind === 'conflict' ? [error.message] : [])] : [])

/** Our words for a refused write, by the API's kind. */
function writeProblem(error: unknown): string {
  if (!isApiError(error)) return 'write.failed'
  switch (error.kind) {
    case 'conflict':
      return 'write.conflict'
    case 'forbidden':
      return 'held.manage'
    case 'invalid':
      return 'write.invalid'
    case 'not_found':
      return 'write.notFound'
    default:
      return 'write.failed'
  }
}

/**
 * The certificate record container (`/w/<company>/compliance/certificates/<id>?tab=coverage|body|files|activity`,
 * SCR-051): reads the certificate (its coverage, whether its PDF is on file), each covered style's colourways and sizes
 * (product.styles.view), the same notified body's other certificates (the Notified body tab) and the files (files.read);
 * edits a draft (PATCH with the version), registers it, suspends, withdraws or reinstates it, adds and ends coverage,
 * sends the PDF (announce → store → confirm), asks the gate for a garment or for every garment it covers on a later day
 * (the lapse check), and re-reads on the certificate's live events. `?act=check|register|…` opens that dialog once.
 */
export function CertificateRecord({ certificateId }: { certificateId: string }) {
  return (
    <CertMessages>
      <CertificateRecordContainer certificateId={certificateId} />
    </CertMessages>
  )
}

function CertificateRecordContainer({ certificateId }: { certificateId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const params = useSearchParams()
  const can = useMemo(() => certCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const companies = useMemo(() => session.companies.map((company) => ({ id: company.id, name: company.name })), [session.companies])
  const tab = useRecordTab(RECORD_TABS)
  const today = useMemo(() => todayInRome(), [])
  const locale = useLocale()
  const t = useT('certificates')
  const [detail, setDetail] = useState<Read<CertificateDetail>>(reading())
  const [styles, setStyles] = useState<Record<string, StyleFacts | null | undefined>>({})
  const [sameBody, setSameBody] = useState<Read<Certificate[]> | null>(null)
  const [files, setFiles] = useState<Read<CertificateFile[]> | null>(null)
  const [brands, setBrands] = useState<BrandOption[] | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [edit, setEdit] = useState<{ draft: CertificateDraft; touched: readonly DraftField[]; busy: boolean; problem: string | null; lines: readonly string[] } | null>(null)
  const [statusReason, setStatusReason] = useState('')
  const [coverageDraft, setCoverageDraft] = useState<CoverageDraft>(blankCoverage())
  const [endReason, setEndReason] = useState('')
  const [check, setCheck] = useState<CheckModel | null>(null)
  const [lapse, setLapse] = useState<LapseModel>({ date: today, state: 'idle', done: 0, total: 0, capped: false, summary: null })
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [dialogLines, setDialogLines] = useState<readonly string[]>([])
  const [dockOpen, setDockOpen] = useState(false)
  const acted = useRef(false)
  const lapseDated = useRef(false)
  const search = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    if (!can.view) return
    try {
      const read = await getCertificate(api, certificateId)
      setDetail(ready(read))
      setAsOf(new Date().toISOString())
      if (!lapseDated.current) {
        lapseDated.current = true
        setLapse((current) => ({ ...current, date: defaultLapseDate(read.validTo) }))
      }
    } catch (error) {
      setDetail(failedRead(problemKey(error)))
    }
  }, [api, can.view, certificateId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!can.parties) return
    listBrands(api)
      .then(setBrands)
      .catch(() => setBrands(null))
  }, [api, can.parties])

  // The covered styles' colourways and sizes (each read once; a failed read draws its words, not an empty grid).
  const value = detail.value
  const styleIds = useMemo(() => [...new Set((value?.coverage ?? []).filter((entry) => entry.status === 'ACTIVE' && entry.styleId).map((entry) => entry.styleId!))].sort().join(','), [value])
  useEffect(() => {
    if (!styleIds || !can.styles) {
      if (styleIds && !can.styles) setStyles(Object.fromEntries(styleIds.split(',').map((id) => [id, null])))
      return
    }
    for (const id of styleIds.split(',')) {
      getStyleFacts(api, id)
        .then((facts) => setStyles((current) => ({ ...current, [id]: facts })))
        .catch(() => setStyles((current) => ({ ...current, [id]: null })))
    }
  }, [api, can.styles, styleIds])

  // The Notified body tab: the register's other certificates from the same body.
  useEffect(() => {
    if (tab !== 'body' || !value || sameBody) return
    setSameBody(reading())
    listCertificates(api)
      .then((register) => setSameBody(ready(register.certificates.filter((entry) => entry.notifiedBodyNumber === value.notifiedBodyNumber && entry.id !== value.id))))
      .catch((error) => setSameBody(failedRead(problemKey(error))))
  }, [api, sameBody, tab, value])

  const loadFiles = useCallback(() => {
    if (!can.filesRead) return
    setFiles((current) => current ?? reading())
    listCertificateFiles(api, certificateId)
      .then((list) => setFiles(ready(list)))
      .catch((error) => setFiles(failedRead(problemKey(error))))
  }, [api, can.filesRead, certificateId])
  useEffect(() => {
    if (tab === 'files' || value?.hasPdf !== undefined) loadFiles()
  }, [loadFiles, tab, value?.hasPdf])

  useEffect(() => {
    try {
      setDockOpen(window.localStorage.getItem(DOCK_KEY) === '1' && window.matchMedia(WIDE).matches)
    } catch {
      setDockOpen(false)
    }
  }, [])

  // A failed PDF upload right after Add certificate comes back here with `?pdf=failed`.
  useEffect(() => {
    if (params?.get('pdf') === 'failed') setNotice({ key: 'files.uploadFailedAfterCreate', tone: 'warning' })
  }, [params])

  // W2a (B-W2a-66): the Renewals tab (read while open; its writes move the certificate's version: read it again).
  const askedAct = params?.get('act') ?? ''
  const exportReviews = (reviews: readonly Review[]) => {
    const header = [t('ren.csv.style'), t('ren.csv.revision'), t('ren.csv.compared'), t('ren.csv.kind'), t('ren.csv.before'), t('ren.csv.after'), t('ren.csv.status'), t('ren.csv.answered'), t('ren.csv.reference')]
    const lines = reviewsCsv(reviews, header, { status: (review) => t(`ren.status.${review.status}`), kind: (kind) => t(`ren.kind.${kind}`) }).map(csvLine)
    downloadText(`type-changes-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\r\n'))
    setNotice({ key: 'ren.done.exported', params: { count: reviews.length }, tone: 'success' })
  }
  const renewals = useRenewals({
    api,
    certificateId,
    can,
    active: tab === 'renewals',
    today,
    locale: locale === 'en' ? 'en' : 'it',
    act: tab === 'renewals' && (RENEWAL_ACTS as readonly string[]).includes(askedAct) ? (askedAct as RenewalAct) : null,
    onCertificateChanged: () => void load(),
    onExport: exportReviews,
  })

  const live = useLive(
    (change) => {
      if (liveMatches(change, ['compliance.certificate_', 'compliance.renewal_']) && change.fields.certificateId === certificateId && !dialog) void load()
      if (tab === 'renewals' && liveMatches(change, ['compliance.renewal_', 'compliance.certificate_renewed', 'compliance.type_change_']) && change.fields.certificateId === certificateId && !renewals.model.dialog) void renewals.reload()
    },
    () => void load(),
  )

  const openDialog = useCallback(
    (next: RecordDialog | null) => {
      setDialog(next)
      setDialogProblem(null)
      setDialogLines([])
      if (next?.kind === 'status') setStatusReason('')
      if (next?.kind === 'coverage') setCoverageDraft({ ...blankCoverage(), target: can.styles ? 'style' : 'item' })
      if (next?.kind === 'endCoverage') setEndReason('')
      if (next?.kind === 'check') {
        // From a certificate: the first covered style is already picked (another one is a search away).
        const first = value?.coverage.find((entry) => entry.status === 'ACTIVE' && entry.styleId && styles[entry.styleId])
        const facts = first?.styleId ? styles[first.styleId] : null
        setCheck(facts ? { ...blankCheck(today), style: ready(facts), colourwayId: facts.colourways.find((entry) => entry.status === 'ACTIVE')?.id ?? '' } : blankCheck(today))
      }
      if (next?.kind !== 'check') setCheck(null)
    },
    [can.styles, styles, today, value],
  )

  // `?act=` from the register's row verbs: open that dialog once, when the certificate is read.
  useEffect(() => {
    if (acted.current || !value) return
    const act = params?.get('act') ?? ''
    if (!(ACTS as readonly string[]).includes(act)) return
    acted.current = true
    if (act === 'check') openDialog({ kind: 'check' })
    else if (act === 'register' && value.status === 'DRAFT') openDialog({ kind: 'register' })
    else if (act === 'coverage') openDialog({ kind: 'coverage' })
    else if (act === 'suspend' || act === 'withdraw' || act === 'reinstate') openDialog({ kind: 'status', move: act })
  }, [openDialog, params, value])

  const refused = (error: unknown) => {
    setDialogProblem(writeProblem(error))
    setDialogLines(issueLines(error))
    if (isApiError(error) && error.kind === 'conflict') void load()
  }

  const register = async () => {
    if (!value) return
    setBusy(true)
    try {
      setDetail(ready(await moveCertificate(api, value, 'issue', null)))
      setDialog(null)
      setNotice({ key: 'done.registered', params: { number: value.number }, tone: 'success' })
    } catch (error) {
      refused(error)
    } finally {
      setBusy(false)
    }
  }

  const move = async (to: 'suspend' | 'withdraw' | 'reinstate') => {
    if (!value) return
    setBusy(true)
    try {
      setDetail(ready(await moveCertificate(api, value, to, statusReason)))
      setDialog(null)
      setNotice({ key: `done.${to}`, params: { number: value.number }, tone: to === 'reinstate' ? 'success' : 'warning' })
    } catch (error) {
      refused(error)
    } finally {
      setBusy(false)
    }
  }

  const saveEdit = async () => {
    if (!value || !edit) return
    setEdit({ ...edit, busy: true, problem: null, lines: [] })
    try {
      setDetail(ready(await updateCertificate(api, value, inputOf(edit.draft))))
      setEdit(null)
      setNotice({ key: 'done.saved', tone: 'success' })
    } catch (error) {
      setEdit((current) => (current ? { ...current, busy: false, problem: writeProblem(error), lines: issueLines(error) } : current))
      if (isApiError(error) && error.kind === 'conflict') void load()
    }
  }

  // Coverage search (styles or materials): waits for a pause in typing.
  const coverageSearch = (query: string) => {
    const target = coverageDraft.target
    setCoverageDraft((current) => ({ ...current, query, ...(target === 'style' ? { styles: query.trim() ? reading() : null } : { materials: query.trim() ? reading() : null }) }))
    search.current?.abort()
    if (!query.trim()) return
    const controller = new AbortController()
    search.current = controller
    setTimeout(() => {
      if (controller.signal.aborted) return
      if (target === 'style')
        searchStyles(api, query, controller.signal)
          .then((found) => !controller.signal.aborted && setCoverageDraft((current) => ({ ...current, styles: ready(found) })))
          .catch((error) => !controller.signal.aborted && setCoverageDraft((current) => ({ ...current, styles: failedRead(problemKey(error)) })))
      else
        searchMaterials(api, query, controller.signal)
          .then((found) => !controller.signal.aborted && setCoverageDraft((current) => ({ ...current, materials: ready(found) })))
          .catch((error) => !controller.signal.aborted && setCoverageDraft((current) => ({ ...current, materials: failedRead(problemKey(error)) })))
    }, 250)
  }

  const saveCoverage = async () => {
    if (!value) return
    const draft = coverageDraft
    setBusy(true)
    setDialogProblem(null)
    setDialogLines([])
    try {
      const style = draft.target === 'style' ? draft.style?.value : null
      const next = await addCoverage(api, value, {
        ...(style ? { styleId: style.id } : { itemId: draft.item!.id }),
        colourwayIds: style && !draft.allColours ? draft.colourwayIds : [],
        sizes: style && !draft.wholeRange ? draft.sizes : [],
        allowsMadeToMeasure: style ? draft.allowsMadeToMeasure : false,
        note: draft.note.trim() || null,
      })
      setDetail(ready(next))
      if (style) setStyles((current) => ({ ...current, [style.id]: style }))
      setDialog(null)
      setNotice({ key: 'done.coverageAdded', params: { code: style?.code ?? draft.item?.code ?? '' }, tone: 'success' })
    } catch (error) {
      refused(error)
    } finally {
      setBusy(false)
    }
  }

  const endCoverage = async () => {
    if (!value || dialog?.kind !== 'endCoverage') return
    const coverage = value.coverage.find((entry) => entry.id === dialog.coverageId)
    if (!coverage) return
    setBusy(true)
    try {
      await archiveCoverage(api, value.id, coverage, endReason)
      await load()
      setDialog(null)
      setNotice({ key: 'done.coverageEnded', params: { code: coverage.style?.code ?? coverage.item?.code ?? '' }, tone: 'success' })
    } catch (error) {
      refused(error)
    } finally {
      setBusy(false)
    }
  }

  // The lapse check: every covered garment asked of the gate on the chosen day, four at a time.
  const runLapse = async () => {
    if (!value) return
    const { cells, capped } = lapseCells(value, Object.fromEntries(Object.entries(styles).map(([id, style]) => [id, style ?? undefined])))
    const date = lapse.date
    setLapse({ date, state: 'running', done: 0, total: cells.length, capped, summary: null })
    const answers: LapseAnswer[] = new Array(cells.length)
    let next = 0
    let done = 0
    let failures = 0
    const worker = async () => {
      while (next < cells.length) {
        const index = next++
        const cell = cells[index]!
        try {
          answers[index] = { cell, result: await checkGarment(api, { styleId: cell.styleId, colourwayId: cell.colourwayId, size: cell.size, date }) }
        } catch {
          failures++
          answers[index] = { cell, result: null }
        }
        done++
        setLapse((current) => ({ ...current, done }))
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, cells.length) }, worker))
    setLapse({ date, state: failures === cells.length && cells.length > 0 ? 'failed' : 'done', done, total: cells.length, capped, summary: lapseSummary(answers) })
  }

  const sendPdf = async (chosen: File) => {
    if (!value) return
    setBusy(true)
    try {
      const picked = await pickedFile(chosen)
      if (picked.contentType !== 'application/pdf') {
        setNotice({ key: 'files.onlyPdf', tone: 'warning' })
        return
      }
      setDetail(ready(await uploadPdf(api, value.id, picked)))
      loadFiles()
      setNotice({ key: 'done.pdf', params: { name: picked.name }, tone: 'success' })
    } catch (error) {
      setNotice({ key: isApiError(error) ? writeProblem(error) : 'files.uploadFailed', tone: 'danger', detail: issueLines(error) })
    } finally {
      setBusy(false)
    }
  }

  const download = async (fileId: string) => {
    try {
      window.open(await downloadAddress(api, fileId), '_blank', 'noopener')
    } catch (error) {
      setNotice({ key: 'files.downloadFailed', tone: 'danger', detail: issueLines(error) })
    }
  }

  // Check a garment (the same dialog as the register's).
  const checkSearch = (query: string) => {
    setCheck((current) => (current ? { ...current, query, styles: query.trim() ? reading() : null } : current))
    search.current?.abort()
    if (!query.trim()) return
    const controller = new AbortController()
    search.current = controller
    setTimeout(() => {
      if (controller.signal.aborted) return
      searchStyles(api, query, controller.signal)
        .then((found) => !controller.signal.aborted && setCheck((current) => (current ? { ...current, styles: ready(found) } : current)))
        .catch((error) => !controller.signal.aborted && setCheck((current) => (current ? { ...current, styles: failedRead(problemKey(error)) } : current)))
    }, 250)
  }
  const pickCheckStyle = (styleId: string) => {
    const known = styles[styleId]
    if (known) {
      setCheck((current) => (current ? { ...current, style: ready(known), colourwayId: known.colourways.find((entry) => entry.status === 'ACTIVE')?.id ?? '', size: '', result: null } : current))
      return
    }
    setCheck((current) => (current ? { ...current, style: reading(), colourwayId: '', size: '', result: null } : current))
    getStyleFacts(api, styleId)
      .then((facts) => setCheck((current) => (current ? { ...current, style: ready(facts), colourwayId: facts.colourways.find((entry) => entry.status === 'ACTIVE')?.id ?? '' } : current)))
      .catch((error) => setCheck((current) => (current ? { ...current, style: failedRead(problemKey(error)) } : current)))
  }
  const runCheck = async () => {
    const model = check
    const style = model?.style?.value
    if (!model || !style) return
    setCheck({ ...model, busy: true, result: null, problem: null })
    try {
      const result = await checkGarment(api, { styleId: style.id, colourwayId: model.colourwayId, size: model.size, date: model.date })
      setCheck((current) => (current ? { ...current, busy: false, result } : current))
    } catch (error) {
      setCheck((current) => (current ? { ...current, busy: false, problem: problemKey(error) } : current))
    }
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setNotice({ key: 'done.copied', params: { number: text }, tone: 'success' })
    } catch {
      setNotice({ key: 'done.copyFailed', tone: 'warning' })
    }
  }

  const panels = value && can.threads ? <RecordPanels record={{ type: 'Certificate', id: value.id, companyId: value.companyId, siteId: null }} title={value.number} /> : null

  return (
    <CertificateRecordView
      model={{
        prefix,
        tab,
        can,
        today,
        companies,
        brands,
        detail,
        styles,
        sameBody,
        files,
        asOf,
        live,
        notice,
        dialog,
        edit,
        statusReason,
        coverageDraft,
        endReason,
        check,
        lapse,
        busy,
        dialogProblem,
        dialogLines,
        dockOpen,
        renewals: renewals.model,
      }}
      panels={panels}
      actions={{
        onDialog: openDialog,
        onRetry: () => void load(),
        onDock: () => {
          if (typeof window !== 'undefined' && !window.matchMedia(WIDE).matches) {
            router.push(`${prefix}/compliance/certificates/${encodeURIComponent(certificateId)}?tab=activity`)
            return
          }
          setDockOpen((open) => {
            try {
              window.localStorage.setItem(DOCK_KEY, open ? '0' : '1')
            } catch {
              // Not kept on this device; the dock still toggles.
            }
            return !open
          })
        },
        onCopy: (text) => void copy(text),
        onDismissNotice: () => setNotice(null),
        onEdit: (open) => setEdit(open && value ? { draft: draftOf(value), touched: [], busy: false, problem: null, lines: [] } : null),
        onEditDraft: (draft) => setEdit((current) => (current ? { ...current, draft } : current)),
        onEditTouch: (field) => setEdit((current) => (current && !current.touched.includes(field) ? { ...current, touched: [...current.touched, field] } : current)),
        onSaveEdit: () => void saveEdit(),
        onRegister: () => void register(),
        onStatusReason: setStatusReason,
        onMove: (to) => void move(to),
        onCoverageDraft: setCoverageDraft,
        onCoverageQuery: coverageSearch,
        onCoverageStyle: (style) => {
          setCoverageDraft((current) => ({ ...current, style: reading() }))
          getStyleFacts(api, style.id)
            .then((facts) => setCoverageDraft((current) => ({ ...current, style: ready(facts), allowsMadeToMeasure: facts.mtmAllowed })))
            .catch((error) => setCoverageDraft((current) => ({ ...current, style: failedRead(problemKey(error)) })))
        },
        onCoverageItem: (item) => setCoverageDraft((current) => ({ ...current, item })),
        onAddCoverage: () => void saveCoverage(),
        onEndReason: setEndReason,
        onEndCoverage: () => void endCoverage(),
        onLapseDate: (date) => setLapse((current) => ({ ...current, date, state: 'idle', summary: null })),
        onLapseRun: () => void runLapse(),
        onPdf: (chosen) => void sendPdf(chosen),
        onDownload: (fileId) => void download(fileId),
        onCheckQuery: checkSearch,
        onCheckStyle: (style) => pickCheckStyle(style.id),
        onCheckClearStyle: () => setCheck((current) => (current ? { ...current, style: null, colourwayId: '', size: '', result: null } : current)),
        onCheckPatch: (patch) => setCheck((current) => (current ? { ...current, ...patch, result: null, problem: null } : current)),
        onCheckRun: () => void runCheck(),
        renewals: renewals.actions,
      }}
    />
  )
}
