'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { fileBytes, keepSeal, readAssessment, sealPreview } from '../api'
import { problemOf, readProblemOf, riskCan } from '../model'
import { DvrTabView, type DvrTabModel } from './view/DvrTabView'

/**
 * `/w/<company>/plant/risk/dvr?assessment=<id>&version=<id>&show=seal` (SCR-209-dvr, a new tab): the assessment read for the
 * version (GET /safety/risk/assessments/:id, safety.view), then the frozen PDF (GET /files/:fileId/download, files.read) or
 * the seal — the kept one (its file), else the preview the API makes in the page's language (GET …/versions/:id/seal).
 * Keep the seal: POST …/seal (safety.risk.manage).
 */
export function DvrTab() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const can = useMemo(() => riskCan(session.permissions), [session.permissions])
  const assessmentId = params.get('assessment') ?? ''
  const versionId = params.get('version') ?? ''
  const show: 'pdf' | 'seal' = params.get('show') === 'seal' ? 'seal' : 'pdf'
  const [model, setModel] = useState<Omit<DvrTabModel, 'canView' | 'canReadFiles' | 'canKeep' | 'show'>>({ assessment: null, version: null, bytes: null, problem: null, keeping: false, keepProblem: null })

  const read = useCallback(async () => {
    if (!can.view) return
    setModel((current) => ({ ...current, bytes: null, problem: null }))
    try {
      const record = await readAssessment(api, assessmentId)
      const version = record.versions.find((row) => row.id === versionId) ?? null
      setModel((current) => ({ ...current, assessment: record.assessment, version }))
      if (!version) return setModel((current) => ({ ...current, problem: 'problem.notFound' }))
      if (show === 'pdf' && !can.readFiles) return
      const bytes = show === 'pdf' ? await fileBytes(api, version.file.fileId) : version.sealed && can.readFiles ? await fileBytes(api, version.sealed.fileId) : await sealPreview(api, version.id, locale === 'en' ? 'en' : 'it')
      setModel((current) => ({ ...current, bytes }))
    } catch (error) {
      setModel((current) => ({ ...current, problem: readProblemOf(error) }))
    }
  }, [api, assessmentId, can.readFiles, can.view, locale, show, versionId])

  useEffect(() => {
    void read()
  }, [read])

  const keep = async () => {
    if (!can.manage || model.keeping || !model.version) return
    setModel((current) => ({ ...current, keeping: true, keepProblem: null }))
    try {
      await keepSeal(api, model.version.id, locale === 'en' ? 'en' : 'it', newIdempotencyKey())
      setModel((current) => ({ ...current, keeping: false }))
      await read()
    } catch (error) {
      setModel((current) => ({ ...current, keeping: false, keepProblem: problemOf(error) }))
    }
  }

  return (
    <DvrTabView
      model={{ ...model, canView: can.view, canReadFiles: can.readFiles, canKeep: can.manage, show }}
      actions={{
        onShow: (next) => router.replace(`${pathname}?assessment=${encodeURIComponent(assessmentId)}&version=${encodeURIComponent(versionId)}${next === 'seal' ? '&show=seal' : ''}`, { scroll: false }),
        onKeep: () => void keep(),
        onRetry: () => void read(),
      }}
    />
  )
}
