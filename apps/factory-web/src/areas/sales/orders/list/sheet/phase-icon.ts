import { Ban, CircleCheck, Hourglass, Inbox, Package, Scissors, Truck } from 'lucide-react'
import type { OrderPhase } from '../../api'

/**
 * F-CW-101 (customer Work tab; 10-design §2: "groups are told apart by word, icon and place, never by colour alone") — the ONE mark
 * of each phase: the customer page's band draws it on its group, the sheet's Where it is cell on its first chip (the stage of an
 * order in production carries its group's mark). Lucide, as every other mark of the sheet; always beside the phase's words.
 */
export const PHASE_ICON: Readonly<Record<OrderPhase, typeof Inbox>> = Object.freeze({
  NOT_SENT: Inbox,
  NOT_STARTED: Hourglass,
  IN_PRODUCTION: Scissors,
  READY: Package,
  SHIPPED: Truck,
  DONE: CircleCheck,
  CANCELLED: Ban,
})
