'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { isActiveJob } from '../../../../list-frame/tools/model'
import { problemOf, useListToolsTransport, type ExportJob, type ToolsProblem } from '../../../../list-frame/tools/transport'
import { EXPORT_COLUMNS, EXPORT_LIST_KEY } from './model'

/**
 * Export board (XLSX, design planning.board ⋯ "Export board (XLSX, W2b)"; B-W2b-329's export source `planning.board`): the list
 * frame's own export job through the Office's list tools (an Export job, its progress, then the file), for the board's window
 * or a published version. Null transport (a design case, a page outside the Office): no export, the button says why.
 */
export function useBoardExport(title: string, labels: (column: (typeof EXPORT_COLUMNS)[number]) => string) {
  const transport = useListToolsTransport()
  const [state, setState] = useState<{ job: ExportJob | null; problem: ToolsProblem | null } | null>(null)
  const last = useRef<string | null>(null)

  const start = useCallback(
    async (query: string) => {
      if (!transport) return
      last.current = query
      setState({ job: null, problem: null })
      try {
        const job = await transport.startExport({ listKey: EXPORT_LIST_KEY, format: 'XLSX', query, title, columns: EXPORT_COLUMNS.map((key) => ({ key, label: labels(key) })) }, transport.newKey())
        setState({ job, problem: null })
      } catch (error) {
        setState({ job: null, problem: problemOf(error) })
      }
    },
    [transport, title, labels],
  )

  // The job runs in the worker: read it again until it is done (or failed), while the dialog is open.
  const jobId = state?.job?.id ?? null
  const active = state?.job ? isActiveJob(state.job.status) : false
  useEffect(() => {
    if (!transport || !jobId || !active) return
    const timer = setTimeout(() => {
      transport
        .readExport(jobId)
        .then((job) => setState((current) => (current?.job?.id === job.id ? { job, problem: null } : current)))
        .catch((error) => setState((current) => (current ? { ...current, problem: problemOf(error) } : current)))
    }, 1500)
    return () => clearTimeout(timer)
  }, [transport, jobId, active, state])

  const download = useCallback(async () => {
    if (!transport || !state?.job) return
    try {
      await transport.download(state.job)
    } catch (error) {
      setState((current) => (current ? { ...current, problem: problemOf(error) } : current))
    }
  }, [transport, state])

  return {
    available: transport !== null,
    state,
    start,
    again: () => (last.current ? void start(last.current) : undefined),
    download: () => void download(),
    close: () => setState(null),
  }
}
