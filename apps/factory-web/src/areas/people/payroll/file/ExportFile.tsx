'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { readFromStore } from '../../../../record-panels/store'
import { downloadStored } from '../../../finance/accounting/download'
import type { Loaded } from '../../_shared/parts'
import { getExport, openFile, type ExportRecord } from '../api'
import { fileHeld, fileKindOf, fileOf, NAMESPACE, payrollCan, payrollProblem, type Words } from '../model'
import { ExportFileView, type ExportFileModel } from './view/ExportFileView'

/**
 * `/w/<company>/people/payroll/<id>/file?kind=summary|data` (SCR-159-file, the design's tab:summary-pdf and tab:file): opened in a
 * new tab by a person's click. The summary reads its PDF once (the opening is recorded, a reload is another opening), through
 * the store's 60-second link, kept in this tab's memory alone. The data file waits for Download.
 */
export function ExportFile({ exportId }: { exportId: string }) {
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Page exportId={exportId} />
    </WithMessages>
  )
}

function Page({ exportId }: { exportId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const kind = fileKindOf(params)
  const can = useMemo(() => payrollCan(session.permissions), [session.permissions])
  const [loaded, setLoaded] = useState<Loaded<ExportRecord>>({ status: 'loading' })
  const [pdf, setPdf] = useState<Uint8Array | null>(null)
  const [problem, setProblem] = useState<Words | null>(null)
  const opened = useRef(false)

  const read = useCallback(async () => {
    if (!can.view) return
    try {
      setLoaded({ status: 'ready', value: await getExport(api, exportId) })
    } catch (error) {
      const words = payrollProblem(error)
      setLoaded(words.key === 'problem.notFound' ? { status: 'notFound' } : words.key === 'problem.forbidden' ? { status: 'forbidden' } : { status: 'error', problem: words.key })
    }
  }, [api, can.view, exportId])

  useEffect(() => {
    void read()
  }, [read])

  const openPdf = useCallback(
    (record: ExportRecord) => {
      const file = fileOf(record, 'summary')
      if (!file) return
      setProblem(null)
      openFile(api, record.id, file.id)
        .then((link) => readFromStore(link))
        .then(setPdf)
        .catch((error: unknown) => setProblem(payrollProblem(error)))
    },
    [api],
  )

  const record = loaded.status === 'ready' ? loaded.value : null
  useEffect(() => {
    if (kind !== 'summary' || !record || opened.current || fileHeld(record, can)) return
    opened.current = true
    openPdf(record)
  }, [kind, record, can, openPdf])

  const model: ExportFileModel = { can, kind, loaded, pdf, problem }
  return (
    <ExportFileView
      model={model}
      onRetry={() => {
        if (record && kind === 'summary') openPdf(record)
        else void read()
      }}
      onDownload={(target, file) => {
        setProblem(null)
        void downloadStored(() => openFile(api, target.id, file.id), file.name).catch((error: unknown) => setProblem(payrollProblem(error)))
      }}
    />
  )
}
