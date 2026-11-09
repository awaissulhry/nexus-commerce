'use client'

import { createContext, useContext } from 'react'
import type { LinkRenew } from './model'

/**
 * B-W2b-169: "Ask for a new link" for every dead link. The link landing (shell/links/LinkLanding.tsx) provides it with
 * the client of the token it opened (renew/LinkRenew.tsx); the frame's dead states and a task page's own ends read it
 * here. Null: nothing to renew (no token in the address, or a design case that shows no button).
 */
export const LinkRenewContext = createContext<LinkRenew | null>(null)

/** The renewal a dead state offers: the one given (a design case), else the landing's. */
export function useLinkRenew(given?: LinkRenew | null): LinkRenew | null {
  const provided = useContext(LinkRenewContext)
  return given === undefined ? provided : given
}
