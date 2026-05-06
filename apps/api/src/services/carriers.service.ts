/**
 * H.15 — Centralized carrier tracking URL registry for inbound
 * shipments. Server-side mirror of the frontend's CARRIER_TRACKING_URL
 * + CARRIER_OPTIONS so any non-frontend surface (PDF discrepancy
 * report, email notification, future webhook integrations) can
 * resolve a shipment's tracking URL without duplicating the map.
 *
 * Hardcoded URL templates per the user's H.15 directive — no paid
 * carrier API integrations. The templates are the public deeplinks
 * each carrier publishes for retail tracking; they don't require
 * any auth and don't break when the underlying tracking API
 * version bumps.
 *
 * Pattern field: a regex describing the tracking number format,
 * mostly informational. Used by the create form to nudge the
 * operator toward the right carrier when they paste a tracking
 * number that obviously doesn't match (e.g. UPS-shaped string but
 * BRT selected). Not enforced — operators can always force-save.
 */

export interface CarrierEntry {
  /** Stable code stored on InboundShipment.carrierCode */
  code: string
  /** Human-readable name for dropdowns */
  label: string
  /** ISO country where this carrier is most relevant (informational) */
  country?: string
  /** Build the public tracking URL for a given tracking number */
  trackingUrl(trackingNumber: string): string
  /** Optional pattern hint (informational) */
  pattern?: string
}

const REGISTRY: CarrierEntry[] = [
  {
    code: 'BRT',
    label: 'BRT (Bartolini)',
    country: 'IT',
    trackingUrl: (n) => `https://www.brt.it/it/myBRT/Home/SpedizioniInArrivo?numericSearch=${encodeURIComponent(n)}`,
    pattern: '^\\d{12}$',
  },
  {
    code: 'POSTE',
    label: 'Poste Italiane',
    country: 'IT',
    trackingUrl: (n) => `https://www.poste.it/cerca/index.html#/risultati-spedizioni/${encodeURIComponent(n)}`,
    pattern: '^[A-Z]{2}\\d{9}[A-Z]{2}$',
  },
  {
    code: 'GLS',
    label: 'GLS Italy',
    country: 'IT',
    trackingUrl: (n) => `https://www.gls-italy.com/it/per-il-destinatario/segui-la-tua-spedizione?match=${encodeURIComponent(n)}`,
  },
  {
    code: 'SDA',
    label: 'SDA',
    country: 'IT',
    trackingUrl: (n) => `https://www.sda.it/wps/portal/Servizi_online/RicercaSpedizioni?locale=it&tracing.letteraVettura=${encodeURIComponent(n)}`,
  },
  {
    code: 'TNT',
    label: 'TNT (FedEx)',
    trackingUrl: (n) => `https://www.tnt.com/express/it_it/site/shipping-tools/tracking.html?searchType=con&cons=${encodeURIComponent(n)}`,
  },
  {
    code: 'DHL',
    label: 'DHL Express',
    trackingUrl: (n) => `https://www.dhl.com/it-it/home/tracking/tracking-express.html?submit=1&tracking-id=${encodeURIComponent(n)}`,
    pattern: '^\\d{10}$',
  },
  {
    code: 'UPS',
    label: 'UPS',
    trackingUrl: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
    pattern: '^1Z[A-Z0-9]{16}$',
  },
  {
    code: 'FEDEX',
    label: 'FedEx',
    trackingUrl: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
    pattern: '^\\d{12,14}$',
  },
  {
    code: 'DSV',
    label: 'DSV',
    trackingUrl: (n) => `https://www.dsv.com/en/tracking?ref=${encodeURIComponent(n)}`,
  },
  {
    code: 'DPD',
    label: 'DPD',
    trackingUrl: (n) => `https://tracking.dpd.de/parcelstatus?query=${encodeURIComponent(n)}&locale=en_IT`,
    pattern: '^\\d{14}$',
  },
  {
    code: 'CHRONOPOST',
    label: 'Chronopost',
    country: 'FR',
    trackingUrl: (n) => `https://www.chronopost.fr/fr/chrono-tracing/suivi-colis?listeNumeros=${encodeURIComponent(n)}`,
  },
  {
    code: 'OTHER',
    label: 'Other',
    trackingUrl: () => '',
  },
]

const BY_CODE = new Map(REGISTRY.map((c) => [c.code, c]))

/** All carriers in dropdown order. Excludes "OTHER" — call separately. */
export function listCarriers(): Array<Pick<CarrierEntry, 'code' | 'label' | 'country' | 'pattern'>> {
  return REGISTRY.map((c) => ({
    code: c.code,
    label: c.label,
    country: c.country,
    pattern: c.pattern,
  }))
}

/**
 * Resolve a tracking URL for the given carrier code + number. Returns
 * `null` if the carrier code isn't in the registry or the tracking
 * number is empty. OTHER returns null because the registry doesn't
 * know where to point — caller should fall back to the operator-
 * provided trackingUrl override.
 */
export function resolveTrackingUrl(carrierCode: string | null | undefined, trackingNumber: string | null | undefined): string | null {
  if (!carrierCode || !trackingNumber) return null
  const entry = BY_CODE.get(carrierCode.toUpperCase())
  if (!entry) return null
  const url = entry.trackingUrl(trackingNumber.trim())
  return url || null
}

/** True if the tracking number matches the carrier's pattern (when known). */
export function validateTrackingFormat(carrierCode: string | null | undefined, trackingNumber: string | null | undefined): { valid: boolean; pattern?: string; reason?: string } {
  if (!carrierCode || !trackingNumber) return { valid: true }
  const entry = BY_CODE.get(carrierCode.toUpperCase())
  if (!entry || !entry.pattern) return { valid: true }
  const re = new RegExp(entry.pattern)
  if (re.test(trackingNumber.trim())) return { valid: true, pattern: entry.pattern }
  return { valid: false, pattern: entry.pattern, reason: `Tracking number doesn't match ${entry.label} format` }
}
