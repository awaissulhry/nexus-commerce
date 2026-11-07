'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { downloadLink } from '../../../../../record-panels/api'
import { getPersonTraining, recordPdf } from '../api'
import { readProblemOf, trainingCan } from '../model'
import { CertificateView, type CertificateModel } from './view/CertificateView'

/**
 * `/w/<company>/people/skills/certificate?record=<id>&person=<employee id>&language=it|en` (design people.skills
 * tab:certificate, a new tab from a course cell or a record row): the record PDF the API makes (GET
 * /safety/training/records/:id/pdf, safety.view; stored nowhere) and, when the person is named, their Safety training read
 * for the title and the provider's files (each opened through its 60-second link). Nothing is kept in the browser.
 */
export function CertificateTab() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const pageLocale = useLocale()
  const can = useMemo(() => trainingCan(session.permissions), [session.permissions])
  const recordId = params.get('record') ?? ''
  const personId = params.get('person') ?? ''
  const asked = params.get('language')
  const language: 'it' | 'en' = asked === 'it' || asked === 'en' ? asked : pageLocale === 'en' ? 'en' : 'it'
  const [model, setModel] = useState<CertificateModel>({ allowed: can.view, language, person: null, record: null, pdf: null, problem: null, opening: null })

  const read = useCallback(async () => {
    if (!can.view) return
    if (!recordId) return setModel((current) => ({ ...current, problem: 'problem.notFound' }))
    setModel((current) => ({ ...current, pdf: null, problem: null }))
    try {
      if (personId) {
        const person = await getPersonTraining(api, personId)
        setModel((current) => ({ ...current, person: person.employee.name, record: person.records.find((entry) => entry.id === recordId) ?? null }))
      }
      const pdf = await recordPdf(api, recordId, language)
      setModel((current) => ({ ...current, pdf }))
    } catch (error) {
      setModel((current) => ({ ...current, problem: readProblemOf(error) }))
    }
  }, [api, can.view, recordId, personId, language])

  useEffect(() => {
    void read()
  }, [read])

  const terms = (next: 'it' | 'en') => {
    const query = new URLSearchParams({ record: recordId, ...(personId ? { person: personId } : {}), language: next })
    return `${pathname}?${query.toString()}`
  }

  return (
    <CertificateView
      model={{ ...model, allowed: can.view, language }}
      actions={{
        onLanguage: (next) => router.replace(terms(next), { scroll: false }),
        onRetry: () => void read(),
        onOpenFile: (fileId) => {
          setModel((current) => ({ ...current, opening: fileId }))
          downloadLink(api, fileId).then(
            ({ download }) => {
              setModel((current) => ({ ...current, opening: null }))
              window.open(download.url.startsWith('/') && !download.url.startsWith('//') ? `/api${download.url}` : download.url, '_blank', 'noopener')
            },
            () => setModel((current) => ({ ...current, opening: null, problem: 'problem.file' })),
          )
        },
      }}
    />
  )
}
