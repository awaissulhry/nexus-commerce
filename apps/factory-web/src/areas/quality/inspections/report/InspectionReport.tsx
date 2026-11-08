'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { failedRead, problemKey, qualityCan, ready, reading, type Read } from '../../_shared/model'
import { fileAddress, getReports, keepReport, previewReport, shareReport, type Reports } from '../depth/api'
import { depthCan } from '../depth/model'
import { InspectionReportView, type ReportModel } from './view/InspectionReportView'

const SHARE_REFUSALS = ['NOT_ON_SHIPMENT', 'NO_VERSION', 'NO_SUCH_VERSION', 'NO_SHIPMENT'] as const

/** A share's refusal in our words: `held/<CODE>` by its code, else by the kind (the API's lines kept as facts). */
function shareRefusal(error: unknown): { key: string; lines: string[] } {
  if (!isApiError(error)) return { key: 'share.refused', lines: [] }
  const path = String(error.issues[0]?.path ?? '')
  const code = path.startsWith('held/') ? path.slice('held/'.length) : null
  const lines = error.issues.map((issue) => issue.message ?? '').filter(Boolean)
  if (code && (SHARE_REFUSALS as readonly string[]).includes(code)) return { key: `share.held.${code}`, lines }
  if (error.kind === 'forbidden') return { key: 'share.held.noRight', lines: [] }
  return { key: 'share.refused', lines }
}

/**
 * `/w/<company>/quality/inspections/report?id=<inspection>&language=it|en&share=1` (SCR-076-report, design tab:qi-report-pdf, a new
 * tab from the record's band and the list's row verbs): the versions and where they are shared (GET …/reports), then the
 * preview in the language asked (GET …/report, kept nowhere); Keep (POST …/reports); Share report link (POST
 * …/reports/share with the shipment, the version, `send` with shipping.manage); a kept version downloads through the
 * generic files route. A plain link cannot send the company header, so this page reads the PDF.
 */
export function InspectionReport() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const pageLocale = useLocale()
  const can = useMemo(() => qualityCan(session.permissions), [session.permissions])
  const depth = useMemo(() => depthCan(session.permissions), [session.permissions])
  const asked = params.get('language')
  const language: 'it' | 'en' = asked === 'it' || asked === 'en' ? asked : pageLocale === 'en' ? 'en' : 'it'
  const shareFirst = params.get('share') === '1'
  const inspectionId = params.get('id') ?? ''
  const [reports, setReports] = useState<Read<Reports>>(reading())
  const [pdf, setPdf] = useState<Uint8Array | null>(null)
  const [pdfProblem, setPdfProblem] = useState<string | null>(null)
  const [keeping, setKeeping] = useState(false)
  const [kept, setKept] = useState<ReportModel['kept']>(null)
  const [keepProblem, setKeepProblem] = useState<string | null>(null)
  const [share, setShare] = useState<ReportModel['share']>({ shipmentId: null, version: null, send: false, busy: false, problem: null, lines: [], done: null })
  const keepKey = useRef<string | null>(null)
  const shareKey = useRef<string | null>(null)

  const loadReports = useCallback(async () => {
    if (!can.inspectionsView) return null
    try {
      const answer = await getReports(api, inspectionId)
      setReports(ready(answer))
      setShare((current) => ({ ...current, shipmentId: current.shipmentId ?? answer.shipments.find((entry) => entry.shareable)?.id ?? null }))
      return answer
    } catch (error) {
      setReports(failedRead(problemKey(error)))
      return null
    }
  }, [api, can.inspectionsView, inspectionId])

  const loadPdf = useCallback(async () => {
    setPdf(null)
    setPdfProblem(null)
    try {
      setPdf(await previewReport(api, inspectionId, language))
    } catch (error) {
      setPdfProblem(problemKey(error))
    }
  }, [api, inspectionId, language])

  useEffect(() => {
    let gone = false
    void loadReports().then((answer) => {
      if (!gone && answer?.inspection.signed) void loadPdf()
    })
    return () => {
      gone = true
    }
  }, [loadPdf, loadReports])

  const keep = useCallback(async () => {
    setKeeping(true)
    setKeepProblem(null)
    keepKey.current ??= newIdempotencyKey()
    try {
      const answer = await keepReport(api, inspectionId, language, keepKey.current)
      keepKey.current = null
      setKept({ version: answer.report.version, language: answer.report.language, made: answer.made })
      void loadReports()
    } catch (error) {
      if (!isApiError(error) || error.kind !== 'conflict') keepKey.current = null
      setKeepProblem(problemKey(error))
    } finally {
      setKeeping(false)
    }
  }, [api, inspectionId, language, loadReports])

  const doShare = useCallback(async () => {
    const value = reports.value
    if (!value || !share.shipmentId) return
    const shipment = value.shipments.find((entry) => entry.id === share.shipmentId)
    const version = share.version ?? value.versions[0]?.version
    setShare((current) => ({ ...current, busy: true, problem: null, lines: [], done: null }))
    shareKey.current ??= newIdempotencyKey()
    try {
      const answer = await shareReport(api, inspectionId, { shipmentId: share.shipmentId, ...(version ? { version } : {}), ...(share.send && depth.shippingManage ? { send: {} } : {}) }, shareKey.current)
      shareKey.current = null
      setShare((current) => ({ ...current, busy: false, done: { shipment: answer.shared.shipmentNumber || shipment?.number || '', version: answer.shared.version, sent: answer.link !== null, withdrawn: answer.shared.withdrawn } }))
      void loadReports()
    } catch (error) {
      if (!isApiError(error) || error.kind !== 'conflict') shareKey.current = null
      const refusal = shareRefusal(error)
      setShare((current) => ({ ...current, busy: false, problem: refusal.key, lines: refusal.lines }))
    }
  }, [api, depth.shippingManage, inspectionId, loadReports, reports.value, share.send, share.shipmentId, share.version])

  return (
    <InspectionReportView
      model={{ allowed: can.inspectionsView, language, reports, pdf, pdfProblem, keeping, kept, keepProblem, canSend: depth.shippingManage, shareFirst, share }}
      actions={{
        onLanguage: (next) => router.replace(`${pathname}?id=${encodeURIComponent(inspectionId)}&language=${next}${shareFirst ? '&share=1' : ''}`, { scroll: false }),
        onKeep: () => void keep(),
        onRetry: () => {
          void loadReports().then((answer) => {
            if (answer?.inspection.signed) void loadPdf()
          })
        },
        onDownload: (fileId) => {
          fileAddress(api, fileId).then(
            (url) => window.open(url, '_blank', 'noopener'),
            (error: unknown) => setKeepProblem(problemKey(error)),
          )
        },
        onShareDraft: (draft) => {
          shareKey.current = null
          setShare((current) => ({ ...current, ...draft, problem: null, lines: [], done: null }))
        },
        onShare: () => void doShare(),
      }}
    />
  )
}
