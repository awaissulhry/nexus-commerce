'use client'

import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { brandPortals, checkBranding } from '@nexus/ui/tokens/branding'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { readRefusal } from '../job/model'
import { storeUrl } from '../../record-panels/store'
import { LinkBrandingContext } from '../../shell/links/view/LinkFrameView'
import { bookReturnLabel, downloadReturnLabel, readReturnLabelPage } from './api'
import { initialLinkModel, pressProblem, type ReturnLabelLinkModel } from './model'
import { ReturnLabelLinkView } from './view/ReturnLabelLinkView'

/**
 * A RETURN_LABEL link, once it opened (the link landing did `POST /link/open`): reads the page (`GET /link/return-label`),
 * books the carrier when the customer presses Book (once, under one Idempotency-Key), downloads the label (a presigned
 * address opened in a new tab at the press). Offline, both presses are held with the reason. The tenant's colour goes on the
 * page's pop-ups too. The token stays in the client's `x-factory-link` header.
 */
export function ReturnLabelLink({ api }: { api: ApiClient }) {
  const [model, setModel] = useState<ReturnLabelLinkModel>(initialLinkModel)
  const bookKey = useRef(newIdempotencyKey())

  const branding = useContext(LinkBrandingContext)
  useEffect(() => brandPortals(branding ? checkBranding(branding) : null), [branding])

  const load = useCallback(async () => {
    try {
      const page = await readReturnLabelPage(api)
      setModel((current) => ({ ...current, link: 'valid', page, problem: null }))
    } catch (error) {
      const state = readRefusal(error)
      if (state === 'error') setModel((current) => (current.page ? current : { ...current, problem: 'link.problem.read' }))
      else setModel((current) => ({ ...current, link: state }))
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const sync = () => setModel((state) => ({ ...state, offline: !navigator.onLine }))
    sync()
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  const onBook = () => {
    setModel((state) => ({ ...state, busy: 'book', problem: null }))
    bookReturnLabel(api, bookKey.current)
      .then((page) => setModel((state) => ({ ...state, busy: null, page })))
      .catch((error: unknown) => {
        const problem = pressProblem(error)
        setModel((state) => ({ ...state, busy: null, problem: problem.key, ...(problem.link ? { link: problem.link } : {}) }))
      })
  }

  const onDownload = () => {
    // The tab opens at the press (a browser opens no window after an await), then goes to the address.
    const tab = window.open('', '_blank')
    if (tab) tab.opener = null
    setModel((state) => ({ ...state, busy: 'download', problem: null }))
    downloadReturnLabel(api, newIdempotencyKey())
      .then((url) => {
        // A FAKE store's address is the factory API's (local runs): through this app's /api (record-panels storeUrl).
        if (tab) tab.location.href = storeUrl(url)
        else window.location.assign(storeUrl(url))
        setModel((state) => ({ ...state, busy: null }))
      })
      .catch((error: unknown) => {
        tab?.close()
        const problem = pressProblem(error)
        setModel((state) => ({ ...state, busy: null, problem: problem.key, ...(problem.link ? { link: problem.link } : {}) }))
      })
  }

  return <ReturnLabelLinkView model={model} actions={{ onRetry: () => void load(), onBook, onDownload }} />
}
