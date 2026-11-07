'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { useOfficeScope } from '../../../../../shell/scope/scope-context'
import { dueListPdf, listCourses, type CourseRef, type DueView } from '../api'
import { DUE_VIEWS } from '../constants'
import { readProblemOf, trainingCan } from '../model'
import { DueListView, type DueListModel } from './view/DueListView'

/**
 * `/w/<company>/people/skills/due?view=&course=&language=` (design people.skills tab:due-pdf, from the band's ⋯): the training
 * due list the API makes for the RSPP (GET /safety/training/due/pdf, safety.view) of the company on screen and the top bar's
 * site, as filtered here; the catalogue's courses to narrow it. Nothing is kept in the browser.
 */
export function DueListTab() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const pageLocale = useLocale()
  const can = useMemo(() => trainingCan(session.permissions), [session.permissions])
  const askedView = params.get('view')
  const view: DueView = (DUE_VIEWS as readonly string[]).includes(askedView ?? '') ? (askedView as DueView) : 'due'
  const courseId = params.get('course') || null
  const asked = params.get('language')
  const language: 'it' | 'en' = asked === 'it' || asked === 'en' ? asked : pageLocale === 'en' ? 'en' : 'it'
  const companyId = session.company?.id ?? null
  const siteId = scope.siteId
  const [pdf, setPdf] = useState<Uint8Array | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [courses, setCourses] = useState<CourseRef[]>([])

  useEffect(() => {
    if (!can.view) return
    listCourses(api, { companyId, status: 'ACTIVE' }).then(
      (answer) => setCourses(answer.courses),
      () => setCourses([]),
    )
  }, [api, can.view, companyId])

  const read = useCallback(async () => {
    if (!can.view) return
    setPdf(null)
    setProblem(null)
    try {
      setPdf(await dueListPdf(api, { companyId, siteId, courseId, view, language }))
    } catch (error) {
      setProblem(readProblemOf(error))
    }
  }, [api, can.view, companyId, siteId, courseId, view, language])

  useEffect(() => {
    void read()
  }, [read])

  const siteName = siteId ? (session.sites.find((site) => site.id === siteId)?.name ?? '') : null
  const model: DueListModel = {
    allowed: can.view,
    language,
    view,
    courseId,
    courses,
    scope: [session.company?.code ?? '', siteName].filter(Boolean).join(' · '),
    pdf,
    problem,
  }
  return (
    <DueListView
      model={model}
      actions={{
        onTerms: (change) => {
          const next = { view, courseId, language, ...change }
          const query = new URLSearchParams()
          if (next.view !== 'due') query.set('view', next.view)
          if (next.courseId) query.set('course', next.courseId)
          query.set('language', next.language)
          router.replace(`${pathname}?${query.toString()}`, { scroll: false })
        },
        onRetry: () => void read(),
      }}
    />
  )
}
