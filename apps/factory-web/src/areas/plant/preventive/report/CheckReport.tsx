'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { keepReport, readFileSeal, readResult, reportAddress, reportPreview } from '../api'
import { preventiveCan, problemOf, readProblemOf } from '../model'
import { CheckReportView, type CheckReportModel } from './view/CheckReportView'

/**
 * `/w/<company>/plant/preventive/report?result=<id>&language=it|en` (SCR-266-report, a new tab from a result): the result
 * read for its title, then the check report preview (GET /plant/checks/results/:id/pdf, plant.view; stored nowhere); Keep
 * in the register (POST …/pdf, plant.checks.manage) answers the kept version, whose fingerprint is read for the seal
 * (GET /files/:id, files.read) and whose copy downloads through the result's own report route.
 */
export function CheckReport() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const pageLocale = useLocale()
  const can = useMemo(() => preventiveCan(session.permissions), [session.permissions])
  const resultId = params.get('result') ?? ''
  const asked = params.get('language')
  const language: 'it' | 'en' = asked === 'it' || asked === 'en' ? asked : pageLocale === 'en' ? 'en' : 'it'
  const [model, setModel] = useState<CheckReportModel>({ allowed: can.view, canKeep: can.manage, language, result: null, pdf: null, problem: null, keeping: false, kept: null, keepProblem: null, seal: null, sealHeld: null })

  const read = useCallback(async () => {
    if (!can.view) return
    if (!resultId) {
      setModel((current) => ({ ...current, problem: 'problem.notFound' }))
      return
    }
    setModel((current) => ({ ...current, pdf: null, problem: null, language }))
    try {
      const record = await readResult(api, resultId)
      setModel((current) => ({ ...current, result: record.result }))
      const pdf = await reportPreview(api, resultId, language)
      setModel((current) => ({ ...current, pdf }))
    } catch (error) {
      setModel((current) => ({ ...current, problem: readProblemOf(error) }))
    }
  }, [api, can.view, resultId, language])

  useEffect(() => {
    void read()
  }, [read])

  const keep = () => {
    if (!can.manage || model.keeping || !resultId) return
    setModel((current) => ({ ...current, keeping: true, keepProblem: null }))
    keepReport(api, resultId, language, newIdempotencyKey()).then(
      async (kept) => {
        setModel((current) => ({ ...current, keeping: false, kept, seal: null, sealHeld: can.readFiles ? null : 'report.sealNoRight' }))
        if (!can.readFiles) return
        try {
          const file = await readFileSeal(api, kept.document.fileId)
          setModel((current) => ({ ...current, seal: { sha256: file.sha256 } }))
        } catch {
          setModel((current) => ({ ...current, sealHeld: 'report.sealFailed' }))
        }
      },
      (error: unknown) => setModel((current) => ({ ...current, keeping: false, keepProblem: problemOf(error) })),
    )
  }

  return (
    <CheckReportView
      model={{ ...model, allowed: can.view, canKeep: can.manage, language }}
      actions={{
        onLanguage: (next) => router.replace(`${pathname}?result=${encodeURIComponent(resultId)}&language=${next}`, { scroll: false }),
        onKeep: keep,
        onRetry: () => void read(),
        onDownload: () => {
          const fileId = model.kept?.document.fileId
          if (!fileId) return
          reportAddress(api, resultId, fileId).then(
            (url) => window.open(url, '_blank', 'noopener'),
            () => setModel((current) => ({ ...current, keepProblem: { key: 'problem.file', field: null } })),
          )
        },
      }}
    />
  )
}
