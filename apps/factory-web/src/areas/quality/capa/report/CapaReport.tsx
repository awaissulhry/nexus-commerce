'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { getCapa, keepReport, newIdempotencyKey, reportPreview, type ReportLanguage } from '../api'
import { capaCan, readProblem, refusalOf } from '../model'
import { CapaReportView, type CapaReportModel } from './view/CapaReportView'

/**
 * `/w/<company>/quality/capa/report?capa=<id>&language=it|en` (SCR-146-report, design tab:capa-pdf, a window page opened from the
 * record's Report tab, its ⋯ and the list's "Print 8D"): the CAPA read for its title, then the 8D preview (GET
 * /quality/capa/:id/report, quality.capa.view; stored nowhere). A plain link cannot send the company header, so this page
 * reads the bytes with the client. Keep a version = POST …/report (quality.capa.manage).
 */
export function CapaReport() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const pageLocale = useLocale()
  const can = useMemo(() => capaCan(session.permissions), [session.permissions])
  const capaId = params.get('capa') ?? ''
  const asked = params.get('language')
  const language: ReportLanguage = asked === 'it' || asked === 'en' ? asked : pageLocale === 'en' ? 'en' : 'it'
  const [model, setModel] = useState<CapaReportModel>({ allowed: can.view, canKeep: can.manage, language, capa: null, pdf: null, problem: null, keeping: false, notice: null })
  const keepKey = useRef<string | null>(null)

  const read = useCallback(async () => {
    if (!can.view) return
    if (!capaId) {
      setModel((now) => ({ ...now, problem: 'problem.notFound' }))
      return
    }
    setModel((now) => ({ ...now, pdf: null, problem: null }))
    try {
      const record = await getCapa(api, capaId)
      setModel((now) => ({ ...now, capa: { number: record.capa.number, title: record.capa.title, type: record.capa.type } }))
      const pdf = await reportPreview(api, capaId, language)
      setModel((now) => ({ ...now, pdf }))
    } catch (error) {
      setModel((now) => ({ ...now, problem: readProblem(error) }))
    }
  }, [api, can.view, capaId, language])

  useEffect(() => {
    void read()
  }, [read])

  const keep = () => {
    if (!can.manage || model.keeping) return
    setModel((now) => ({ ...now, keeping: true, notice: null }))
    keepKey.current ??= newIdempotencyKey()
    keepReport(api, capaId, language, keepKey.current).then(
      (answer) => {
        keepKey.current = null
        setModel((now) => ({ ...now, keeping: false, notice: { say: { key: answer.made ? 'report.kept' : 'report.same', params: { version: answer.report.version } }, tone: 'success' } }))
      },
      (error: unknown) => {
        keepKey.current = null
        const refusal = refusalOf(error)
        setModel((now) => ({ ...now, keeping: false, notice: { say: refusal.say, tone: 'danger', lines: refusal.lines } }))
      },
    )
  }

  return (
    <CapaReportView
      model={{ ...model, allowed: can.view, canKeep: can.manage, language }}
      actions={{
        onLanguage: (next) => router.replace(`${pathname}?capa=${encodeURIComponent(capaId)}&language=${next}`, { scroll: false }),
        onKeep: keep,
        onRetry: () => void read(),
      }}
    />
  )
}
