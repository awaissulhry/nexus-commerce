'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi } from '../../../../lib/session/context'
import { storeUrl } from '../../../../record-panels/store'
import type { SubcontractOrder } from '../api'
import { words, type Words } from '../model'
import type { Loaded } from '../record/record-model'
import { orderTerms, termsDownload, type OrderTerms } from './api'
import { readProblem, type DepthCan } from './model'
import { TermsLinkView } from './view/TermsLinkView'

/**
 * The written terms link on Operations & quantities (B-W2b-344; SCM-049): reads GET …/orders/:id/terms when the tab shows
 * and again when the order's date or workshop changed (a draft may move both), and opens the signed file through a
 * 60-second presigned GET (files.read). Nothing is written here: the terms are written and signed with the workshop.
 */
export function TermsLink({ order, can, timeZone }: { order: Pick<SubcontractOrder, 'id' | 'orderDate' | 'workshop'>; can: DepthCan; timeZone: string }) {
  const api = useOfficeApi()
  const [terms, setTerms] = useState<Loaded<OrderTerms>>({ status: 'loading' })
  const [slow, setSlow] = useState(false)
  const busy = useRef(false)
  const [problem, setProblem] = useState<Words | null>(null)

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const timer = setTimeout(() => setSlow(true), 1000)
      try {
        setTerms({ status: 'ready', value: await orderTerms(api, order.id, signal) })
      } catch (error) {
        if (signal?.aborted) return
        if (isApiError(error) && error.kind === 'not_found') setTerms({ status: 'not_found' })
        else if (isApiError(error) && error.kind === 'forbidden') setTerms({ status: 'forbidden' })
        else setTerms({ status: 'error', problem: readProblem(error) })
      } finally {
        clearTimeout(timer)
        setSlow(false)
      }
    },
    [api, order.id],
  )

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, order.orderDate, order.workshop.id])

  const download = useCallback(
    async (fileId: string) => {
      if (busy.current) return
      busy.current = true
      setProblem(null)
      try {
        const link = await termsDownload(api, fileId)
        const anchor = document.createElement('a')
        anchor.href = storeUrl(link.url)
        anchor.rel = 'noopener'
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
      } catch (error) {
        setProblem(words(isApiError(error) && error.kind === 'not_found' ? 'terms.fileGone' : readProblem(error)))
      } finally {
        busy.current = false
      }
    },
    [api],
  )

  return <TermsLinkView model={{ terms, can, problem, timeZone, slow }} actions={{ onRetry: () => void load(), onDownload: (fileId) => void download(fileId) }} />
}
