'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { isApiError } from '../../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { downloadLink } from '../../../../../record-panels/api'
import { readFromStore, storeUrl } from '../../../../../record-panels/store'
import { readProblem } from '../../../_shared/model'
import { ribaBatch } from '../api'
import { cbiRecords } from '../model'
import { RibaFileView, type FileLoaded, type RibaFileModel } from './view/RibaFileView'

/**
 * `/w/<company>/finance/payments/riba/<batch id>/file` (SCR-511, the new tab "Ri.Ba. file download"): reads the batch
 * (receivables.view), then its CBI file from the store once (GET /files/:id/download, a link that lives a minute) to show it
 * record by record; Download asks a fresh link and hands the browser the file with its name. Nothing is sent anywhere.
 */
export function RibaFilePage({ batchId }: { batchId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const prefix = pathname.replace(/\/finance\/payments\/riba\/[^/]+\/file\/?$/, '')
  const price = session.permissions.includes('money.price')
  const [batch, setBatch] = useState<FileLoaded>({ status: 'loading' })
  const [records, setRecords] = useState<RibaFileModel['records']>({ value: null, problem: null })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBatch({ status: 'loading' })
    try {
      const value = await ribaBatch(api, batchId)
      setBatch({ status: 'ready', value })
      if (!value.file) return
      setRecords({ value: null, problem: null })
      try {
        const link = await downloadLink(api, value.file.id)
        const bytes = await readFromStore(link.download)
        setRecords({ value: cbiRecords(new TextDecoder('iso-8859-1').decode(bytes)), problem: null })
      } catch (error) {
        setRecords({ value: null, problem: readProblem(error) })
      }
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setBatch({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setBatch({ status: 'forbidden' })
      else setBatch({ status: 'error', problem: readProblem(error) })
    }
  }, [api, batchId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <RibaFileView
      model={{ prefix, price, batch, records, busy, problem }}
      actions={{
        onRetry: () => void load(),
        onDownload: () => {
          if (batch.status !== 'ready' || !batch.value.file || busy) return
          const file = batch.value.file
          setBusy(true)
          setProblem(null)
          void (async () => {
            try {
              const link = await downloadLink(api, file.id)
              const anchor = document.createElement('a')
              anchor.href = storeUrl(link.download.url)
              anchor.download = file.name
              anchor.rel = 'noopener'
              document.body.append(anchor)
              anchor.click()
              anchor.remove()
            } catch (error) {
              setProblem(readProblem(error))
            } finally {
              setBusy(false)
            }
          })()
        },
      }}
    />
  )
}
