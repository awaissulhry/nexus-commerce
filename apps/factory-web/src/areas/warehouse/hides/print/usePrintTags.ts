'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import type { Locale } from '../../../../lib/i18n/locales'
import { labelPdf, listLabelPrinters, printJob, queueLabel, retryPrintJob, type HideRow } from '../../../_shared/stock/api'
import { readProblem, writeProblem } from '../../../_shared/stock/model'
import { part, PART_LOADING } from '../../lots/shared/model'
import { hideLabel, jobMoving, type PrintActions, type PrintDialog, type TagPrint } from '../model'

const POLL_MS = 2000
const POLL_TIMES = 30

/**
 * The page side of Print hide tags (Hides list and the hide record): the site's label printers (`GET /print/printers`,
 * print.view), one label job per tag (`POST /print/jobs/label`, kind HIDE, print.labels; one Idempotency-Key per tag per
 * dialog, so a second click never prints twice), the jobs' state read again every 2 s while one moves, Retry of a failed
 * one, and the browser's fallback (`POST /print/labels/pdf`, one PDF per tag, stored nowhere) when the site has no label
 * printer.
 */
export function usePrintTags(api: ApiClient, locale: Locale, unitWord: (uom: HideRow['areaUom']) => string, hidesOf: (ids: readonly string[]) => readonly HideRow[]) {
  const [dialog, setDialog] = useState<PrintDialog | null>(null)
  const keys = useRef(new Map<string, string>())
  const polls = useRef(0)

  const open = useCallback(
    (hideIds: readonly string[]) => {
      const hides = hidesOf(hideIds)
      keys.current = new Map(hides.map((hide) => [hide.id, newIdempotencyKey()]))
      polls.current = 0
      const sites = new Set(hides.map((hide) => hide.siteId))
      setDialog({ hideIds: hides.map((hide) => hide.id), printers: PART_LOADING, printerId: null, copies: 1, busy: false, prints: null, problem: sites.size > 1 ? 'hd.print.oneSite' : null })
      const siteId = hides[0]?.siteId
      if (!siteId) return
      listLabelPrinters(api, siteId)
        .then((printers) => setDialog((current) => (current ? { ...current, printers: part(printers), printerId: printers.length === 1 ? printers[0]!.id : current.printerId } : current)))
        .catch((error: unknown) => setDialog((current) => (current ? { ...current, printers: { value: null, problem: readProblem(error) } } : current)))
    },
    [api, hidesOf],
  )

  const print = useCallback(async () => {
    if (!dialog || !dialog.printerId || dialog.problem === 'hd.print.oneSite') return
    const hides = hidesOf(dialog.hideIds)
    setDialog({ ...dialog, busy: true, problem: null })
    const prints: TagPrint[] = []
    for (const hide of hides) {
      try {
        const answer = await queueLabel(api, { printerId: dialog.printerId, recordType: 'Hide', recordId: hide.id, copies: dialog.copies, label: hideLabel(hide, locale, unitWord) }, keys.current.get(hide.id) ?? newIdempotencyKey())
        prints.push({ hideId: hide.id, code: hide.code, job: answer.job, problem: null })
      } catch (error) {
        prints.push({ hideId: hide.id, code: hide.code, job: null, problem: isApiError(error) && error.kind === 'invalid' ? 'hd.print.refused' : writeProblem(error).key })
      }
    }
    polls.current = 0
    setDialog((current) => (current ? { ...current, busy: false, prints } : current))
  }, [api, dialog, hidesOf, locale, unitWord])

  const pdf = useCallback(async () => {
    if (!dialog) return
    const hides = hidesOf(dialog.hideIds)
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      for (const hide of hides) {
        const bytes = await labelPdf(api, hideLabel(hide, locale, unitWord), dialog.copies)
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
        const link = document.createElement('a')
        link.href = url
        link.download = `${hide.code}.pdf`
        document.body.append(link)
        link.click()
        link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      setDialog(null)
    } catch (error) {
      setDialog((current) => (current ? { ...current, busy: false, problem: isApiError(error) && error.kind === 'invalid' ? 'hd.print.refused' : writeProblem(error).key } : current))
    }
  }, [api, dialog, hidesOf, locale, unitWord])

  const retry = useCallback(
    async (jobId: string) => {
      const current = dialog?.prints?.find((entry) => entry.job?.id === jobId)?.job
      if (!current) return
      try {
        const answer = await retryPrintJob(api, jobId, current.version)
        polls.current = 0
        setDialog((state) => (state?.prints ? { ...state, prints: state.prints.map((entry) => (entry.job?.id === jobId ? { ...entry, job: answer.job, problem: null } : entry)) } : state))
      } catch (error) {
        setDialog((state) => (state?.prints ? { ...state, prints: state.prints.map((entry) => (entry.job?.id === jobId ? { ...entry, problem: writeProblem(error).key } : entry)) } : state))
      }
    },
    [api, dialog],
  )

  // While a job moves, read its state again (queued → sent → printed, or failed).
  const moving = dialog?.prints?.some((entry) => jobMoving(entry.job)) ?? false
  useEffect(() => {
    if (!moving || polls.current >= POLL_TIMES) return
    const timer = setTimeout(async () => {
      polls.current += 1
      const prints = dialog?.prints ?? []
      const next = await Promise.all(prints.map(async (entry) => (entry.job && jobMoving(entry.job) ? { ...entry, job: (await printJob(api, entry.job.id).catch(() => ({ job: entry.job! }))).job } : entry)))
      setDialog((state) => (state?.prints ? { ...state, prints: next } : state))
    }, POLL_MS)
    return () => clearTimeout(timer)
  }, [api, dialog?.prints, moving])

  const actions: PrintActions = {
    onOpen: open,
    onClose: () => setDialog(null),
    onPrinter: (printerId) => setDialog((current) => (current ? { ...current, printerId } : current)),
    onCopies: (copies) => setDialog((current) => (current ? { ...current, copies } : current)),
    onPrint: () => void print(),
    onPdf: () => void pdf(),
    onRetry: (jobId) => void retry(jobId),
  }
  return { dialog, actions }
}
