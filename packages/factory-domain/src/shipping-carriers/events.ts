import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The events of carriers in depth (B-W2b-390; LOG-035; apps/factory-api modules/shipping/test-mode). Context
 * `shipping-carriers`, its own module folder (the shipping events file is W1's). A switch reaches the office's shipping
 * screens and shell (shipping.view: the TEST MODE banner) and the packing benches of the site (shipping.pack: their TEST MODE
 * pill). No person, no address: ids and the state.
 *
 *   shipping.test_mode_changed   a site switched to live labels (after a step-up; `clearedTestLabels` TEST labels of its
 *                                shipments that had not left were cleared) or back to test mode
 */
export const events = [
  defineEvent({
    type: 'shipping.test_mode_changed',
    context: 'shipping-carriers',
    description: "A site switched to live labels (bought and charged from then on; its open shipments' TEST labels cleared) or back to test mode (a test carrier makes TEST labels and sends nothing).",
    payload: z.strictObject({ siteId: z.uuid(), testMode: z.boolean(), clearedTestLabels: z.number().int().min(0) }),
    live: { permission: 'shipping.view', floor: 'shipping.pack', fields: ['siteId', 'testMode'] },
  }),
] as const
