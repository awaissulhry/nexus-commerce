'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { storeUrl } from '../../../../record-panels/store'
import { getProfile, makeWorksheet, openWorksheet } from '../api'
import { mtmCan, readProblem, writeProblem, type Phrase } from '../model'
import { WorksheetView, type WorksheetModel } from './view/WorksheetView'

/**
 * `/w/<company>/sales/made-to-measure/<profileId>/worksheet` (SCR-431, tab:mtm.worksheet; the list's and the record's "Print
 * worksheet"): reads the profile (its worksheets), keeps the newest revision's worksheet as a version when the person may
 * (sales.mtm.record; the same contents answer the newest: nothing written), then opens it (a 60-second address; the opening is
 * recorded on the profile) in the PDF viewer. Without the right to keep one, the newest kept version opens.
 */
export function WorksheetTab({ profileId }: { profileId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? null
  const can = useMemo(() => mtmCan(session.permissions), [session.permissions])
  const [title, setTitle] = useState<WorksheetModel['title']>(null)
  const [versions, setVersions] = useState<WorksheetModel['versions']>({ status: 'loading' })
  const [mayMake, setMayMake] = useState(false)
  const [shown, setShown] = useState<string | null>(null)
  const [pdf, setPdf] = useState<string | null>(null)
  const [pdfProblem, setPdfProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Phrase | null>(null)
  const [sameAsNewest, setSame] = useState(false)
  const makeKey = useRef<string | null>(null)
  const latestId = useRef<string | null>(null)
  const started = useRef(false)

  const show = useCallback(
    async (documentId: string, profile: string) => {
      setShown(documentId)
      setPdf(null)
      setPdfProblem(null)
      try {
        const answer = await openWorksheet(api, profile, documentId, newIdempotencyKey())
        setPdf(storeUrl(answer.download.url))
      } catch (error) {
        setPdfProblem(readProblem(error))
      }
    },
    [api],
  )

  const make = useCallback(async () => {
    const profile = latestId.current
    if (!profile || !companyId || busy) return
    setBusy(true)
    setProblem(null)
    makeKey.current ??= newIdempotencyKey()
    try {
      const answer = await makeWorksheet(api, profile, { companyId, language: locale === 'en' ? 'en' : 'it' }, makeKey.current)
      makeKey.current = null
      setVersions({ status: 'ready', items: answer.worksheets })
      setSame(!answer.worksheet.made)
      void show(answer.worksheet.id, profile)
    } catch (error) {
      setProblem(writeProblem(error))
    } finally {
      setBusy(false)
    }
  }, [api, busy, companyId, locale, show])

  const read = useCallback(async () => {
    if (!can.view) return
    setVersions({ status: 'loading' })
    try {
      const record = await getProfile(api, profileId)
      latestId.current = record.latestId
      setTitle({ rider: record.riderName, garment: record.garmentType, revision: record.revisions[0]?.revision ?? 0 })
      setMayMake(record.may.worksheet)
      setVersions({ status: 'ready', items: record.worksheets })
      if (!started.current) {
        started.current = true
        if (record.may.worksheet && companyId) {
          void make()
          return
        }
      }
      const newest = record.worksheets[0]
      if (newest) void show(newest.id, newest.profileId)
    } catch (error) {
      setVersions({ status: 'error', problem: readProblem(error) })
    }
    // `make` reads the refs it needs.
  }, [api, profileId, can.view, companyId, show])

  useEffect(() => {
    void read()
  }, [read])

  const model: WorksheetModel = { prefix, profileId, allowed: can.view, mayMake: mayMake && !!companyId, title, versions, shown, pdf, pdfProblem, busy, problem, sameAsNewest }
  return (
    <WorksheetView
      model={model}
      onMake={() => void make()}
      onShow={(documentId) => {
        const sheet = versions.status === 'ready' ? versions.items.find((entry) => entry.id === documentId) : undefined
        if (sheet) void show(sheet.id, sheet.profileId)
      }}
      onRetry={() => void read()}
    />
  )
}
