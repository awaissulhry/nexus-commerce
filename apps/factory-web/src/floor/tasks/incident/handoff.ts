import type { IncidentKind } from '@nexus/factory-domain/safety/incidents/rules'

/**
 * What another floor screen passes on when it opens Report an incident (B-W2b-137): the machine report's "Guard missing"
 * hands over its machine (and a hazard as the likely kind), so Where? offers that machine first. Kept in this page's memory
 * for one move, never in the address: a floor page with search terms is another page to Next's cache, and the tablet holds
 * `/floor/incident` itself for offline use (B-W2b-F6). Taken once by the screen that opens.
 */

export interface IncidentOffer {
  readonly machine: { readonly id: string; readonly assetNumber: string } | null
  readonly kind?: IncidentKind
}

let offer: IncidentOffer | null = null

export function offerIncident(next: IncidentOffer): void {
  offer = next
}

export function takeIncidentOffer(): IncidentOffer | null {
  const taken = offer
  offer = null
  return taken
}
