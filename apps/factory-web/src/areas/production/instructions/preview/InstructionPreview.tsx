'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { storeUrl } from '../../../../record-panels/store'
import { getInstruction, getVersion, mediaDownload, type InstructionRecord, type VersionAnswer } from '../api'
import { failed, instructionsCan, NAMESPACES, readProblem, reading, ready, valueOf, type Read } from '../model'
import { PreviewView } from './view/PreviewView'

/**
 * `/w/<company>/production/instructions/<id>/preview?version=&language=` (SCR-285-preview, design tab:wi-tab-preview, a new
 * tab from the record's band and the list's row menu): reads the record and the version (asked, else the one in force, else
 * the draft), and the photos and videos through the generic files route (files.read). Records nothing.
 */
export function InstructionPreview({ instructionId }: { instructionId: string }) {
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
  const language = params.get('language') || (pageLocale === 'en' ? 'en' : 'it')
  const [record, setRecord] = useState<Read<InstructionRecord>>(reading())
  const [version, setVersion] = useState<Read<VersionAnswer> | null>(reading())
  const [mediaSrc, setMediaSrc] = useState<Record<string, string | null>>({})
  const [attempt, setAttempt] = useState(0)

  const go = (next: { version?: string | null; language?: string }) => {
    const search = new URLSearchParams()
    const versionId = next.version === undefined ? asked : next.version
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
  }, [api, can.view, instructionId, attempt])

  const value = valueOf(record)
  const versionId = value ? (asked && value.versions.some((entry) => entry.id === asked) ? asked : (value.currentVersionId ?? value.draftVersionId)) : null
  useEffect(() => {
    if (!value) return
    if (!versionId) {
      setVersion(null)
      return
    }
    let gone = false
    setVersion(reading())
    getVersion(api, instructionId, versionId)
      .then((answer) => !gone && setVersion(ready(answer)))
      .catch((error: unknown) => !gone && setVersion(failed(readProblem(error))))
    return () => {
      gone = true
    }
  }, [api, instructionId, versionId, value !== null])

  const answer = valueOf(version)
  useEffect(() => {
    if (!answer || !can.seeMedia) return
    let gone = false
    const ids = [...new Set(answer.steps.flatMap((step) => step.media.filter((medium) => medium.file?.status === 'AVAILABLE').map((medium) => medium.fileId)))]
    void (async () => {
      for (const fileId of ids) {
        try {
          const download = await mediaDownload(api, fileId)
          if (!gone) setMediaSrc((known) => ({ ...known, [fileId]: storeUrl(download.url) }))
        } catch {
          if (!gone) setMediaSrc((known) => ({ ...known, [fileId]: null }))
        }
      }
    })()
    return () => {
      gone = true
    }
  }, [api, answer, can.seeMedia])

  return (
    <PreviewView
      model={{ allowed: can.view, record, version, language, mediaSrc }}
      actions={{
        onLanguage: (next) => go({ language: next }),
        onVersion: (next) => go({ version: next }),
        onRetry: () => setAttempt((n) => n + 1),
      }}
    />
  )
}
