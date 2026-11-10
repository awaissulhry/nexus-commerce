'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { getInstruction, sheetBytes, type InstructionRecord } from '../api'
import { failed, instructionsCan, NAMESPACES, readProblem, reading, ready, sheetLanguageOf, sheetProblem, valueOf, type Read, type SheetLanguage } from '../model'
import { SheetView } from './view/SheetView'

/**
 * `/w/<company>/production/instructions/<id>/sheet?version=&language=it|en` (SCR-285-pdf, design tab:wi-tab-pdf, a new tab):
 * reads the record, then the version's sheet (GET …/versions/:id/sheet, made now and kept nowhere; a plain link cannot send
 * the company header, so this page reads the PDF) into the viewer.
 */
export function InstructionSheet({ instructionId }: { instructionId: string }) {
  return (
    <WithMessages namespaces={[...NAMESPACES, 'shell']}>
      <Container instructionId={instructionId} />
    </WithMessages>
  )
}

function Container({ instructionId }: { instructionId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const pageLocale = useLocale()
  const can = useMemo(() => instructionsCan(session.permissions), [session.permissions])
  const asked = params.get('version')
  const language = sheetLanguageOf(params.get('language'), pageLocale)
  const [record, setRecord] = useState<Read<InstructionRecord>>(reading())
  const [pdf, setPdf] = useState<Read<Uint8Array> | null>(null)
  const [attempt, setAttempt] = useState(0)

  const go = (next: { version?: string; language?: SheetLanguage }) => {
    const search = new URLSearchParams()
    const versionId = next.version ?? asked
    if (versionId) search.set('version', versionId)
    search.set('language', next.language ?? language)
    router.replace(`${pathname}?${search.toString()}`, { scroll: false })
  }

  useEffect(() => {
    if (!can.view) return
    let gone = false
    setRecord(reading())
    getInstruction(api, instructionId)
      .then((answer) => !gone && setRecord(ready(answer)))
      .catch((error: unknown) => !gone && setRecord(failed(readProblem(error))))
    return () => {
      gone = true
    }
  }, [api, can.view, instructionId])

  const value = valueOf(record)
  const versionId = value ? (asked && value.versions.some((entry) => entry.id === asked) ? asked : (value.currentVersionId ?? value.draftVersionId)) : null
  useEffect(() => {
    if (!versionId) {
      setPdf(null)
      return
    }
    const controller = new AbortController()
    setPdf(reading())
    sheetBytes(api, instructionId, versionId, language, controller.signal)
      .then((bytes) => setPdf(ready(bytes)))
      .catch((error: unknown) => !controller.signal.aborted && setPdf(failed(sheetProblem(error))))
    return () => controller.abort()
  }, [api, instructionId, versionId, language, attempt])

  return (
    <SheetView
      model={{ allowed: can.view, record, versionId, language, pdf }}
      actions={{
        onLanguage: (next) => go({ language: next }),
        onVersion: (next) => go({ version: next }),
        onRetry: () => setAttempt((n) => n + 1),
      }}
    />
  )
}
