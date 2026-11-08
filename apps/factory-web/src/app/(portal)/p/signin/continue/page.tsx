import { PortalSignIn } from '../../../../../portal/signin/PortalSignIn'

/**
 * `/p/signin/continue#token=…` — the sign-in e-mail's link (B-W2b-159). The page reads the link without using it and signs
 * in only when the person presses Continue, so a mail scanner that opens the link first cannot burn it.
 */
export default function PortalSignInContinuePage() {
  return <PortalSignIn start={{ kind: 'link' }} />
}
