'use client'

import { useCallback, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'
import type { Locale } from '../../../../lib/i18n/locales'
import { labelOf, readProblem } from '../../_shared/model'
import type { Machine } from '../../_shared/api'
import { printTags, readTagJobs, readTagPrinters, retryTagJob, type TagJob } from './api'
import { depthProblemOf } from './model'
import type { TagMachine, TagsDialogState } from './view/TagsDialog'

/** A machine as its tag prints it, in the person's language. */
export const tagMachineOf = (machine: Pick<Machine, 'id' | 'assetNumber' | 'class' | 'siteCode' | 'station' | 'siteId' | 'status'>, locale: Locale): TagMachine => ({
  id: machine.id,
  assetNumber: machine.assetNumber,
  typeWords: labelOf(machine.class, locale),
  placeWords: [machine.siteCode, machine.station?.code].filter(Boolean).join(' · '),
  siteId: machine.siteId,
  retired: machine.status === 'RETIRED',
})

/**
 * Print QR tags (pop:tags), ONE hook for the register (the band, the bulk bar, `t`) and a machine's Tag tab: the label
 * printers read when it opens (the first of the machines' site chosen), one Print for every machine (one key: a repeat
 * after a lost answer queues nothing twice), Retry of a failed job, and `onPrinted` so the page reads its tag column again.
 */
export function useTags(api: ApiClient, locale: Locale, onPrinted?: () => void) {
  const [state, setState] = useState<TagsDialogState | null>(null)
  const key = useRef<string>(newIdempotencyKey())

  const open = useCallback(
    (machines: TagMachine[], canPrint: boolean) => {
      key.current = newIdempotencyKey()
      setState({ machines, printers: canPrint ? { status: 'loading' } : { status: 'forbidden' }, printerId: null, copies: 1, busy: false, problem: null, result: null, retrying: null })
      if (!canPrint) return
      const site = machines.find((machine) => !machine.retired)?.siteId ?? null
      readTagPrinters(api, null)
        .then((printers) => {
          const first = printers.find((printer) => printer.siteId === site) ?? null
          setState((current) => (current ? { ...current, printers: { status: 'ready', value: printers }, printerId: first?.id ?? null } : current))
        })
        .catch((error: unknown) => setState((current) => (current ? { ...current, printers: { status: 'error', problem: { key: readProblem(error) } } } : current)))
    },
    [api],
  )

  const print = useCallback(async () => {
    const current = state
    if (!current || !current.printerId || current.busy) return
    const printer = current.printers.status === 'ready' ? current.printers.value.find((entry) => entry.id === current.printerId) : null
    const ids = current.machines.filter((machine) => !machine.retired && (!printer || machine.siteId === printer.siteId)).map((machine) => machine.id)
    setState({ ...current, busy: true, problem: null })
    try {
      const answer = await printTags(api, { printerId: current.printerId, machineIds: ids, copies: current.copies, language: locale === 'en' ? 'en' : 'it' }, key.current)
      setState((now) => (now ? { ...now, busy: false, result: answer } : now))
      key.current = newIdempotencyKey()
      onPrinted?.()
    } catch (error) {
      setState((now) => (now ? { ...now, busy: false, problem: depthProblemOf(error) } : now))
    }
  }, [api, state, locale, onPrinted])

  const retry = useCallback(
    async (job: TagJob) => {
      setState((now) => (now ? { ...now, retrying: job.jobId, problem: null } : now))
      try {
        await retryTagJob(api, job.jobId, job.version)
        const fresh = await readTagJobs(api, [job.machineId])
        setState((now) => (now && now.result ? { ...now, retrying: null, result: { ...now.result, jobs: now.result.jobs.map((entry) => fresh.find((row) => row.machineId === entry.machineId) ?? entry) } } : now ? { ...now, retrying: null } : now))
        onPrinted?.()
      } catch (error) {
        setState((now) => (now ? { ...now, retrying: null, problem: depthProblemOf(error) } : now))
      }
    },
    [api, onPrinted],
  )

  return {
    tags: state,
    openTags: open,
    closeTags: useCallback(() => setState(null), []),
    setPrinter: useCallback((printerId: string) => setState((now) => (now ? { ...now, printerId: printerId || null, result: null } : now)), []),
    setCopies: useCallback((copies: number) => setState((now) => (now ? { ...now, copies: Math.max(1, Math.min(5, Math.round(copies) || 1)) } : now)), []),
    printTagsNow: print,
    retryTag: retry,
  }
}
