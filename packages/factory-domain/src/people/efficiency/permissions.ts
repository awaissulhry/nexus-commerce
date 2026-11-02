import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Efficiency (B-W2b-44; apps/factory-api modules/people/efficiency; MES-247, MES-250, MES-251, ANA-016, ANA-017; design
 * people.efficiency), in the people area. The figures are per line and per operation, never per person (Statuto dei
 * Lavoratori art. 4; Owner answers W1, F2): a group under the company's minimum size shows nothing. One person's figures
 * are not these permissions: they open through B-W2b-27's people.figures.view, the site's PERFORMANCE legal gate and the
 * worker and HR only (Owner answer H3).
 *
 *   people.efficiency.view    read earned against attended minutes per line, planned against actual minutes per operation,
 *                             the standard review queue and operation cycle time
 *   people.efficiency.review  decide the standard review: keep a standard, change it or investigate, always with a reason;
 *                             send an operation to the review (c.c. art. 2101: rates change only when conditions change)
 */
export const PEOPLE_EFFICIENCY_DEFINITIONS = definePermissions('people', {
  'efficiency.view': {
    risk: 'read',
    description:
      'Read efficiency per line and per operation: earned against attended minutes, planned against actual minutes, the standard review queue and operation cycle time. Never per person: a group under the minimum size shows nothing.',
  },
  'efficiency.review': {
    risk: 'write',
    description: 'Decide the standard review: keep a standard, change it or investigate, always with a reason; send an operation to the review.',
  },
})

export const PEOPLE_EFFICIENCY_VIEW = 'people.efficiency.view' satisfies Permission
export const PEOPLE_EFFICIENCY_REVIEW = 'people.efficiency.review' satisfies Permission

export const PEOPLE_EFFICIENCY_PERMISSIONS: readonly Permission[] = Object.freeze([PEOPLE_EFFICIENCY_VIEW, PEOPLE_EFFICIENCY_REVIEW])
