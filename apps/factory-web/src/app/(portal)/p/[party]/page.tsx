import { PortalHome } from '../../../../portal/shell/home/PortalHome'

/**
 * `/p/<party code>` — Home. One thin route file picks the page by the person's kind (plan §12, a merge point of the Home
 * steps B-W2b-187 customer and B-W2b-179 supplier); until they land, the frame's own Home: what waits for you.
 */
export default function PortalHomePage() {
  return <PortalHome />
}
