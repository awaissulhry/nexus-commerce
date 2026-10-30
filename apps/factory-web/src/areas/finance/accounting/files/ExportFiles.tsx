'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { fileLink, getExport, type ExportRecord } from '../api'
import { downloadStored } from '../download'
import { accountingCanOf, filesAddressOf, readProblem, writeProblem, type WriteProblem } from '../model'
import { ExportFilesView } from './view/ExportFilesView'

/**
 * `/w/<company>/finance/accounting/files?export=<id>` (or `?exports=a,b`: several batches; design finance.accounting
 * tab:files "Export files (download)"): each batch read once with its files, the checks as they stood when it was made
 * and their explanations; a file is downloaded from its 60-second link (its package's grain). Opened in a new tab from
 * the Exports, the batch just made, and "Files of N batches".
 */
export function ExportFiles() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const ids = useMemo(() => filesAddressOf(params), [params])
  const can = useMemo(() => accountingCanOf(session.permissions), [session.permissions])
  const [batches, setBatches] = useState<Record<string, { value: ExportRecord | null; problem: string | null }>>({})
  const [problem, setProblem] = useState<WriteProblem | null>(null)
  const key = ids.join(',')

  useEffect(() => {
    if (!can.view) return
    let live = true
    for (const id of key ? key.split(',') : []) {
      getExport(api, id)
        .then((value) => live && setBatches((current) => ({ ...current, [id]: { value, problem: null } })))
        .catch((error: unknown) => live && setBatches((current) => ({ ...current, [id]: { value: null, problem: readProblem(error) } })))
    }
    return () => {
      live = false
    }
  }, [api, can.view, key])

  return (
    <ExportFilesView
      model={{ can, ids, batches, problem }}
      actions={{
        onDownload: (exportId, file) => {
          setProblem(null)
          void downloadStored(() => fileLink(api, exportId, file.file.id), file.file.name).catch((error: unknown) => setProblem(writeProblem(error)))
        },
      }}
    />
  )
}
