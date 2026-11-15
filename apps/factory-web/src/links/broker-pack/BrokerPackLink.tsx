'use client'

import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { brandPortals, checkBranding } from '@nexus/ui/tokens/branding'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { readRefusal } from '../job/model'
import { storeUrl } from '../../record-panels/store'
import { LinkBrandingContext } from '../../shell/links/view/LinkFrameView'
import { downloadPaper, readBrokerPack, sendMrn } from './api'
import { initialBrokerModel, pressProblem, type BrokerPackLinkModel } from './model'
import { BrokerPackLinkView } from './view/BrokerPackLinkView'

/**
 * A BROKER_PACK link, once it opened (the link landing did `POST /link/open`): reads the page (`GET /link/broker-pack`),
 * downloads a paper at the press (a presigned address opened in a new tab), sends the MRN once (one Idempotency-Key per typed
 * value). Offline, the presses are held with the reason. The tenant's colour goes on the page's pop-ups too. The token stays in
 * the client's `x-factory-link` header.
 */
export function BrokerPackLink({ api }: { api: ApiClient }) {
  const [model, setModel] = useState<BrokerPackLinkModel>(initialBrokerModel)
  const sendKey = useRef<{ mrn: string; key: string } | null>(null)

  const branding = useContext(LinkBrandingContext)
  useEffect(() => brandPortals(branding ? checkBranding(branding) : null), [branding])

  const load = useCallback(async () => {
    try {
      const page = await readBrokerPack(api)
      setModel((current) => ({ ...current, link: 'valid', page, problem: null }))
    } catch (error) {
      const state = readRefusal(error)
      if (state === 'error') setModel((current) => (current.page ? current : { ...current, problem: 'problem.read' }))
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

  const onSend = () => {
    const mrn = model.mrn.trim()
    if (sendKey.current?.mrn !== mrn) sendKey.current = { mrn, key: newIdempotencyKey() }
    setModel((state) => ({ ...state, busy: 'mrn', problem: null }))
    sendMrn(api, mrn, sendKey.current.key)
      .then((page) => setModel((state) => ({ ...state, busy: null, page })))
      .catch((error: unknown) => {
        const problem = pressProblem(error)
        setModel((state) => ({ ...state, busy: null, problem: problem.key, ...(problem.link ? { link: problem.link } : {}) }))
      })
  }

  const onDownload = (fileId: string) => {
    // The tab opens at the press (a browser opens no window after an await), then goes to the address.
    const tab = window.open('', '_blank')
    if (tab) tab.opener = null
    setModel((state) => ({ ...state, busy: { download: fileId }, problem: null }))
    downloadPaper(api, fileId, newIdempotencyKey())
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

  return <BrokerPackLinkView model={model} actions={{ onRetry: () => void load(), onMrn: (value) => setModel((state) => ({ ...state, mrn: value, problem: null })), onSend, onDownload }} />
}
