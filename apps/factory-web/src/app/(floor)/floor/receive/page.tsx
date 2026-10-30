import { FloorReceive } from '../../../../floor/tasks/receive/Receive'

/** `/floor/receive` — receive goods against a purchase order: scan the PO, receive hide by hide, print the tags (SCR-092). */
export default function FloorReceivePage() {
  return <FloorReceive />
}
