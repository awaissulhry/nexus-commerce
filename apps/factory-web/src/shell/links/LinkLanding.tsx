'use client'

import { useEffect, useState } from 'react'
import { browserApi } from '../../lib/api/browser'
import { isApiError } from '../../lib/api/errors'
import { openLink, type OpenedLink } from '../../lib/api/links'
import { takeLinkTokenFromLocation } from '../../lib/links/token'
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
 * link's task (accept a quote, confirm a PO) is its module's page, W1; W0 has no linkable record yet, so a real link
 * shows what it opens and when it expires.
 */
export function LinkLanding() {
  const [model, setModel] = useState<LinkFrameViewModel>({ sender: null, title: null, body: linkBody('loading') })

  useEffect(() => {
    let attempt = 0
    // Reads the token (and takes it out of the address bar), then opens the link. Runs on arrival, and again when a
    // link is pasted into this same tab (only the fragment changes: no new page load).
    const open = (arrival: boolean) => {
      const token = takeLinkTokenFromLocation()
      if (!token) {
        if (arrival) setModel({ sender: null, title: null, body: linkBody('missing') })
        return
      }
      const mine = ++attempt
      setModel({ sender: null, title: null, body: linkBody('loading') })
      openLink(browserApi({ linkToken: token }))
        .then((link) => {
          if (mine === attempt) setModel({ sender: null, title: null, body: linkBody(linkStateOfOpened(link, new Date()), link) })
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

  return <LinkFrameView model={model} />
}
