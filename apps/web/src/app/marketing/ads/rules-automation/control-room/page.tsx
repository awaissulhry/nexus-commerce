/** ACR.1 — the Control Room: every automation that can change this account, in one place. */
import { ControlRoomClient } from './ControlRoomClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return <ControlRoomClient />
}
