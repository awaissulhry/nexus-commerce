'use client'

import { useEffect, useRef, useState } from 'react'
import { browserApi } from '../../lib/api/browser'
import type { ApiClient } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import { openLink, type OpenedLink } from '../../lib/api/links'
import { takeLinkTokenFromLocation } from '../../lib/links/token'
import { DepositPay } from '../../links/deposit-pay/DepositPay'
import { DocumentLink } from '../../links/document/DocumentLink'
import { QuoteAccept } from '../../links/quote-accept/QuoteAccept'
import { linkStateFromError, linkStateOfOpened, type LinkState } from './link-state'
import { LinkFrameView, type LinkFrameViewModel } from './view/LinkFrameView'

const linkBody = (state: LinkState, link?: OpenedLink): LinkFrameViewModel['body'] => ({
  kind: 'link',
  state,
  purpose: link?.purpose ?? null,
  expiresAt: link?.expiresAt ?? null,
  usesLeft: link?.usesLeft ?? null,
})

/**
 * `/l#token=…` — where every one-off link lands. It takes the token from the fragment (and out of the address bar),
 * opens the link (`POST /link/open`, token in `x-factory-link`, never in a URL), and shows the link's state. A valid
 * link's task is its module's page: a QUOTE_ACCEPT link opens the quote to accept (links/quote-accept, SCR-099), a
 * DEPOSIT_INFO link the deposit to pay by bank transfer (links/deposit-pay, SCR-199), a DOCUMENT_VIEW link of a
 * Shipment its documents (links/document, SCR-101), each with the same client (the token stays in memory, in its
 * header); any other purpose shows what it opens and when it expires.
 */
export function LinkLanding() {
  const [model, setModel] = useState<LinkFrameViewModel>({ sender: null, title: null, body: linkBody('loading') })
  const [task, setTask] = useState<{ purpose: string; api: ApiClient } | null>(null)
  // The token taken from the address on arrival. React runs an effect twice in development (StrictMode): the second run
  // finds the address already clean, so it opens the token the first run took instead of saying the link is missing.
  const arrived = useRef<string | null>(null)

  useEffect(() => {
    let attempt = 0
    // Reads the token (and takes it out of the address bar), then opens the link. Runs on arrival, and again when a
    // link is pasted into this same tab (only the fragment changes: no new page load).
    const open = (arrival: boolean) => {
      const taken = takeLinkTokenFromLocation()
      if (taken && arrival) arrived.current = taken
      const token = taken ?? (arrival ? arrived.current : null)
      if (!token) {
        if (arrival) setModel({ sender: null, title: null, body: linkBody('missing') })
        return
      }
      const mine = ++attempt
      setTask(null)
      setModel({ sender: null, title: null, body: linkBody('loading') })
      const api = browserApi({ linkToken: token })
      openLink(api)
        .then((link) => {
          if (mine !== attempt) return
          const state = linkStateOfOpened(link, new Date())
          if (state === 'valid' && (link.purpose === 'QUOTE_ACCEPT' || link.purpose === 'DEPOSIT_INFO')) setTask({ purpose: link.purpose, api })
          // A shipment's documents (SCR-101); a DOCUMENT_VIEW link of one file stays the frame's.
          if (state === 'valid' && link.purpose === 'DOCUMENT_VIEW' && link.record.type === 'Shipment') setTask({ purpose: 'SHIPMENT_DOCUMENTS', api })
          setModel({ sender: null, title: null, body: linkBody(state, link) })
        })
        .catch((error: unknown) => {
          if (mine === attempt) setModel({ sender: null, title: null, body: linkBody(isApiError(error) ? linkStateFromError(error) : 'error') })
        })
    }
    const onHashChange = () => open(false)
    open(true)
    window.addEventListener('hashchange', onHashChange)
    return () => {
      attempt++
      window.removeEventListener('hashchange', onHashChange)
    }
  }, [])

  if (task?.purpose === 'QUOTE_ACCEPT') return <QuoteAccept api={task.api} />
  if (task?.purpose === 'DEPOSIT_INFO') return <DepositPay api={task.api} />
  if (task?.purpose === 'SHIPMENT_DOCUMENTS') return <DocumentLink api={task.api} />
  return <LinkFrameView model={model} />
}
