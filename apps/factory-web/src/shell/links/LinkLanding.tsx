'use client'

import { useEffect, useRef, useState } from 'react'
import { browserApi } from '../../lib/api/browser'
import type { ApiClient } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import { openLink, type OpenedLink } from '../../lib/api/links'
import { brandingTokensOf, readLinkBranding } from '../../lib/api/branding'
import { takeLinkTokenFromLocation } from '../../lib/links/token'
import { DepositPay } from '../../links/deposit-pay/DepositPay'
import { PoConfirm } from '../../links/po-confirm/PoConfirm'
import { DocumentLink } from '../../links/document/DocumentLink'
import { QuoteAccept } from '../../links/quote-accept/QuoteAccept'
// B-W2b-188: an APPROVAL link's request (SCR-198).
import { Approve } from '../../links/approve/Approve'
// B-W2b-181: a JOB_ACCEPT link's job (SCR-196).
import { JobLink } from '../../links/job/JobLink'
// B-W2b-198: a CLAIM link's report-a-problem page (SCR-197).
import { ReportProblem } from '../../links/claim/ReportProblem'
// B-W2b-169: a set of files (DOCUMENT_VIEW / SECURE_FILE, SCR-272 and links.document's set) and the payroll file.
import { FileLink } from '../../links/file/FileLink'
// B-W2b-169: "Ask for a new link" on every dead link, with the token this page opened.
import { LinkRenewProvider } from './renew/LinkRenew'
import { linkTaskOf, type LinkTask } from '../../links/_nav/link-types'
import { linkStateFromError, linkStateOfOpened, type LinkState } from './link-state'
import { LinkBrandingContext, LinkFrameView, type LinkFrameViewModel, type LinkSender } from './view/LinkFrameView'

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
 * link's task is its module's page, as the link-type registry says (links/_nav/link-types.ts): a QUOTE_ACCEPT link opens
 * the quote to accept (links/quote-accept, SCR-099), a DEPOSIT_INFO link the deposit to pay by bank transfer
 * (links/deposit-pay, SCR-199), a PO_CONFIRM link the purchase order its supplier confirms (links/po-confirm, SCR-100), a
 * DOCUMENT_VIEW link of a Shipment its documents (links/document, SCR-101), each with the same client (the token stays
 * in memory, in its header); any other link shows what it opens and when it expires.
 */
export function LinkLanding() {
  const [model, setModel] = useState<LinkFrameViewModel>({ sender: null, title: null, body: linkBody('loading') })
  const [task, setTask] = useState<{ task: LinkTask; api: ApiClient } | null>(null)
  // B-W2b-161: the sender's branding (logo, colour) for the frame and every task page; null until read, or when it fails.
  const [branding, setBranding] = useState<LinkSender | null>(null)
  // B-W2b-169: the client of the token this page opened (null: no token), for "Ask for a new link" once it is dead.
  const [renew, setRenew] = useState<{ api: ApiClient; attempt: number } | null>(null)
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
      setBranding(null)
      setModel({ sender: null, title: null, body: linkBody('loading') })
      const api = browserApi({ linkToken: token })
      setRenew({ api, attempt: mine }) // B-W2b-169
      openLink(api)
        .then((link) => {
          if (mine !== attempt) return
          const state = linkStateOfOpened(link, new Date())
          // A link no page takes yet stays the frame's (B-W2b-169: a set of files and the payroll file have theirs).
          const opens = state === 'valid' ? linkTaskOf(link) : null
          if (opens) setTask({ task: opens, api })
          setModel({ sender: null, title: null, body: linkBody(state, link) })
          if (state === 'valid')
            readLinkBranding(api)
              .then((read) => mine === attempt && setBranding(brandingTokensOf(read, 'company')))
              .catch(() => undefined)
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

  return (
    <LinkBrandingContext.Provider value={branding}>
      {/* B-W2b-169: keyed by the opening, so a link pasted into this tab asks afresh. */}
      <LinkRenewProvider key={renew?.attempt ?? 0} api={renew?.api ?? null}>
        {page(task, model)}
      </LinkRenewProvider>
    </LinkBrandingContext.Provider>
  )
}

function page(task: { task: LinkTask; api: ApiClient } | null, model: LinkFrameViewModel) {
  switch (task?.task) {
    case 'quote-accept':
      return <QuoteAccept api={task.api} />
    case 'deposit-pay':
      return <DepositPay api={task.api} />
    case 'po-confirm':
      return <PoConfirm api={task.api} />
    case 'shipment-documents':
      return <DocumentLink api={task.api} />
    // B-W2b-188
    case 'approve':
      return <Approve api={task.api} />
    // B-W2b-181
    case 'job':
      return <JobLink api={task.api} />
    // B-W2b-198
    case 'report-problem':
      return <ReportProblem api={task.api} />
    // B-W2b-169
    case 'files':
      return <FileLink api={task.api} source="set" />
    case 'payroll-file':
      return <FileLink api={task.api} source="payroll" />
    default:
      return <LinkFrameView model={model} />
  }
}
