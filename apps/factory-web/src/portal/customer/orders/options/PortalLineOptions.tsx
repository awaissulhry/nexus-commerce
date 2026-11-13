'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { readFromStore, storeUrl } from '../../../../record-panels/store'
import { openLater, saveBytes } from '../hooks'
import { openPortalArtwork, readPortalOptions, type PortalArtwork } from './api'
import { OptionsSection, type OptionsSectionModel } from './view/OptionsSection'

/**
 * The options and artwork of the customer's order (B-W2b-374; XF3:04), on the portal's Order › Lines: reads GET
 * /portal/sales-orders/:orderId/options; Open asks a logged preview (a new tab), Download a logged download (the bytes saved).
 * An office preview of the portal and an offline device hold both with why (`fileHeld`, the page's).
 */
export function PortalLineOptions({ api, orderId, fileHeld, refreshKey }: { api: ApiClient; orderId: string; fileHeld: string | null; /** The order's read: a change reads it again. */ refreshKey: string }) {
  const [read, setRead] = useState<OptionsSectionModel['read']>({ status: 'loading' })
  const [problem, setProblem] = useState<OptionsSectionModel['problem']>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [tries, setTries] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    readPortalOptions(api, orderId, controller.signal)
      .then((value) => setRead({ status: 'ready', value }))
      .catch(() => !controller.signal.aborted && setRead({ status: 'error' }))
    return () => controller.abort()
  }, [api, orderId, refreshKey, tries])

  const open = useCallback(
    async (file: PortalArtwork) => {
      setProblem(null)
      setOpening(file.fileId)
      const tab = openLater()
      try {
        const answer = await openPortalArtwork(api, orderId, file.fileId, 'preview')
        if (Object.keys(answer.download.headers).length === 0) tab.go(storeUrl(answer.download.url))
        else {
          const bytes = await readFromStore({ method: 'GET', url: answer.download.url, headers: answer.download.headers, expiresAt: answer.download.expiresAt })
          tab.go(URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.contentType })))
        }
      } catch {
        tab.fail()
        setProblem({ key: 'portal.openProblem' })
      } finally {
        setOpening(null)
      }
    },
    [api, orderId],
  )

  const download = useCallback(
    async (file: PortalArtwork) => {
      setProblem(null)
      try {
        const answer = await openPortalArtwork(api, orderId, file.fileId, 'download')
        const bytes = await readFromStore({ method: 'GET', url: answer.download.url, headers: answer.download.headers, expiresAt: answer.download.expiresAt })
        saveBytes(file.name, bytes, file.contentType)
      } catch {
        setProblem({ key: 'portal.openProblem' })
      }
    },
    [api, orderId],
  )

  return <OptionsSection model={{ read, fileHeld: fileHeld ? { words: { it: fileHeld, en: fileHeld } } : null, problem, opening }} actions={{ onOpen: (file) => void open(file), onDownload: (file) => void download(file), onRetry: () => setTries((value) => value + 1) }} />
}
