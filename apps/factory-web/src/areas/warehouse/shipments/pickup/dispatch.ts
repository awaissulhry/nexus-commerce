import { DEPTH_NS } from '../queue/shared/depth'

/**
 * Pickups, the day's close, export and shipping settings on screen (B-W2b-412; SCR-650 … SCR-659): what every part of this
 * step shares. The words live in this step's catalogue (`messages/<locale>/warehouse-dispatch.json`); the parts B-W2b-410
 * made and this step reuses (DepthDialog, PartRead, the Read state, `readWords` / `writeWords`) say their own frame words
 * (Cancel, Done, Try again, "… could not be read") from B-W2b-410's catalogue, so both are loaded together.
 */

/** This step's catalogue. */
export const DISPATCH_NS = 'warehouse-dispatch'
/** The catalogues a part of this step draws with. */
export const DISPATCH_NAMESPACES = [DISPATCH_NS, DEPTH_NS, 'shipments', 'lists'] as const

/** What the person may do in this step's parts (each the permission its route asks). */
export interface DispatchAbilities {
  view: boolean
  manage: boolean
  bookPickups: boolean
  customs: boolean
  settingsView: boolean
  settingsManage: boolean
  packaging: boolean
  price: boolean
  cost: boolean
  readFiles: boolean
  uploadFiles: boolean
  viewParties: boolean
}

export function dispatchAbilitiesOf(permissions: readonly string[]): DispatchAbilities {
  const held = new Set(permissions)
  return {
    view: held.has('shipping.view'),
    manage: held.has('shipping.manage'),
    bookPickups: held.has('shipping.pickups.book'),
    customs: held.has('shipping.customs.manage'),
    settingsView: held.has('shipping.settings.view'),
    settingsManage: held.has('shipping.settings.manage'),
    packaging: held.has('shipping.packaging.manage'),
    price: held.has('money.price'),
    cost: held.has('money.cost'),
    readFiles: held.has('files.read'),
    uploadFiles: held.has('files.upload'),
    viewParties: held.has('parties.view'),
  }
}

/** The wall clock of an instant in a zone: its day (YYYY-MM-DD) and time (HH:MM). */
export function wallOf(instant: string, timeZone = 'Europe/Rome'): { day: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  )
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}

/** Kilograms as the person reads them (3 places at most, no trailing zeros); null for nothing or not a number. */
export function kilograms(value: string | null | undefined, locale: string): string | null {
  if (value === null || value === undefined || value.trim() === '') return null
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(number)
}
