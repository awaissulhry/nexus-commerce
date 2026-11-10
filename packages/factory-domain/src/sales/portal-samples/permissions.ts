import type { Permission } from '../../core/permissions'
import { definePartnerPermissions } from '../../auth/partners/permissions'

/**
 * The brand's samples and tech packs in the portal (B-W2b-262; PRD-245 brand collaboration space; design
 * portal.customer.samples, SCR-225; Owner answer T3: the brand's space comes with sample rounds).
 *
 * The PARTNER's (area `portal`, flagged `partner`: held only by partner roles, never by an office or floor role):
 *   samples.view   the organisation's sample rounds with their status and shipment, its own private-label styles in
 *                  development and their stage, and the BRAND tech pack PDFs of those styles (a PDF never carries a cost;
 *                  each open is recorded). What waits for a decision is the organisation's approval requests (B-W2b-184's
 *                  portal.approvals.view); answering one also takes portal.approve.
 *
 * Given in ../../auth/roles/templates PARTNER_ADDS to the customer Buyer, Quality, Designer and Viewer (the roles that read
 * the approvals; the Designer is the brand's product person). Not Finance; never a supplier, workshop or guest role. The
 * customer Admin follows by itself.
 */
export const PORTAL_SAMPLES_DEFINITIONS = definePartnerPermissions('portal', {
  'samples.view': {
    risk: 'read',
    description:
      "See your organisation's sample rounds with their status and shipment, your own styles in development and their stage, and download the tech pack PDF we shared for each of them (never a cost; every download is recorded). Deciding a sample also takes the right to approve.",
  },
})

export const PORTAL_SAMPLES_VIEW = 'portal.samples.view' satisfies Permission
export const PORTAL_SAMPLES_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_SAMPLES_VIEW])

/** The customer roles that see the samples page (template keys; the customer Admin follows). */
export const PORTAL_SAMPLES_READER_TEMPLATES = ['customer-buyer', 'customer-quality', 'customer-designer', 'customer-viewer'] as const

export const PORTAL_SAMPLES_READERS: Readonly<Record<string, readonly Permission[]>> = Object.freeze(
  Object.fromEntries(PORTAL_SAMPLES_READER_TEMPLATES.map((key) => [key, [PORTAL_SAMPLES_VIEW] as readonly Permission[]])),
)
