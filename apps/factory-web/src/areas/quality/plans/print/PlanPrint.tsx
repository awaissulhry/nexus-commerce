'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../lib/i18n/provider'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { readChecklist, readPlan, type Checklist } from '../api'
import { plansCan, printAskOf, problemOf } from '../model'
import { PlanPrintView, type PlanPrintModel } from './view/PlanPrintView'

type Sheet = PlanPrintModel['sheets'][number]

/**
 * `/w/<company>/quality/plans/print?plans=<id>[,<id>…]&version=<id>&language=` (SCR-077-print, a new tab): each plan's
 * checklist — the version named (one plan), else the version in force, else its latest — read in the bench's language
 * (the person's by default; the API offers Italian, English and the company's floor languages).
 */
export function PlanPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const can = useMemo(() => plansCan(session.permissions), [session.permissions])
  const ask = useMemo(() => printAskOf(params), [params])
  const language = ask.language ?? locale
  const [at] = useState(() => new Date().toISOString())
  const [sheets, setSheets] = useState<readonly Sheet[]>([])
  const [languages, setLanguages] = useState<readonly string[]>(['it', 'en'])
  const planKey = ask.plans.join(',')

  useEffect(() => {
    if (!can.view || ask.plans.length === 0) return
    let live = true
    setSheets(ask.plans.map((planId) => ({ planId, checklist: null, problem: null })))
    const one = async (planId: string): Promise<Sheet> => {
      try {
        const record = await readPlan(api, planId)
        const versionId = ask.version ?? record.versions.find((version) => version.status === 'APPROVED')?.id ?? record.current.id
        const checklist: Checklist = await readChecklist(api, planId, versionId, language)
        return { planId, checklist, problem: null }
      } catch (error) {
        return { planId, checklist: null, problem: problemOf(error) }
      }
    }
    void Promise.all(ask.plans.map(one)).then((done) => {
      if (!live) return
      setSheets(done)
      const offered = done.find((sheet) => sheet.checklist)?.checklist?.languages
      if (offered && offered.length > 0) setLanguages(offered)
    })
    return () => {
      live = false
    }
    // planKey stands for the plans asked.
  }, [api, can.view, planKey, ask.version, language])

  return (
    <PlanPrintView
      model={{
        prefix: companyPrefix(session.company?.code ?? ''),
        person: session.user.displayName,
        at,
        company: session.company?.name ?? '',
        can: can.view,
        sheets,
        language,
        languages: languages.includes(language) ? languages : [language, ...languages],
        nothing: ask.plans.length === 0,
      }}
      actions={{
        onLanguage: (next) => {
          const terms = new URLSearchParams(params?.toString() ?? '')
          terms.set('language', next)
          router.replace(`${pathname}?${terms.toString()}`, { scroll: false })
        },
      }}
    />
  )
}
