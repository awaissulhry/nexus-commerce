'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { problemKey, qualityCan } from '../../_shared/model'
import { getReports, previewReport } from '../depth/api'
import { idsFromAddress } from '../depth/model'
import { InspectionReportsView, type BulkReport } from './view/InspectionReportsView'

/**
 * `/w/<company>/quality/inspections/reports?ids=a,b,c&language=` (SCR-076-reports, "Print N reports"): each inspection's
 * number (GET …/reports) and its report preview (GET …/report), one after the other — never all at once, so a long
 * selection does not load the machine; a failed one says so in its place and is tried again alone.
 */
export function InspectionReports() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const pageLocale = useLocale()
  const can = useMemo(() => qualityCan(session.permissions), [session.permissions])
  const ids = useMemo(() => idsFromAddress(params), [params])
  const asked = params.get('language')
  const language: 'it' | 'en' = asked === 'it' || asked === 'en' ? asked : pageLocale === 'en' ? 'en' : 'it'
  const [reports, setReports] = useState<BulkReport[]>(() => ids.map((id) => ({ id, number: null, pdf: null, problem: null })))

  const readOne = useCallback(
    async (id: string) => {
      setReports((current) => current.map((entry) => (entry.id === id ? { ...entry, pdf: null, problem: null } : entry)))
      try {
        const { inspection } = await getReports(api, id)
        setReports((current) => current.map((entry) => (entry.id === id ? { ...entry, number: inspection.number } : entry)))
        const pdf = await previewReport(api, id, language)
        setReports((current) => current.map((entry) => (entry.id === id ? { ...entry, pdf } : entry)))
      } catch (error) {
        setReports((current) => current.map((entry) => (entry.id === id ? { ...entry, problem: problemKey(error) } : entry)))
      }
    },
    [api, language],
  )

  useEffect(() => {
    if (!can.inspectionsView) return
    let gone = false
    setReports(ids.map((id) => ({ id, number: null, pdf: null, problem: null })))
    void (async () => {
      for (const id of ids) {
        if (gone) return
        await readOne(id)
      }
    })()
    return () => {
      gone = true
    }
  }, [can.inspectionsView, ids, readOne])

  return (
    <InspectionReportsView
      model={{ allowed: can.inspectionsView, language, reports }}
      onLanguage={(next) => router.replace(`${pathname}?ids=${ids.map(encodeURIComponent).join(',')}&language=${next}`, { scroll: false })}
      onRetry={(id) => void readOne(id)}
    />
  )
}
