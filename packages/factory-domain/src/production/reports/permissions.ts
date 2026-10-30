import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Production reports (apps/factory-api modules/production/reports; features MES-301 daily production report, MES-160
 * the floor overview by line; design production.reports, production.floor "Lines"), in the production area, office
 * only. Checked with can() against the site's company and site. Nothing here carries money, and no figure is per person
 * (Statuto dei Lavoratori art. 4; Owner answers W1, F2): every number is per line, work centre, style and size.
 */
export const PRODUCTION_REPORTS_DEFINITIONS = definePermissions('production', {
  'reports.view': {
    risk: 'read',
    description:
      "See the production reports of the sites: each day's good, scrapped and reworked garments and the line efficiency, per line, style and size (never per person); and have the daily report e-mailed to oneself each morning.",
  },
  'reports.subscribe': {
    risk: 'write',
    description: 'Have a production report e-mailed each morning to colleagues who may read it themselves, at a time, on weekdays and in a language.',
  },
})

export const PRODUCTION_REPORTS_VIEW = 'production.reports.view' satisfies Permission
export const PRODUCTION_REPORTS_SUBSCRIBE = 'production.reports.subscribe' satisfies Permission

export const PRODUCTION_REPORTS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_REPORTS_VIEW, PRODUCTION_REPORTS_SUBSCRIBE])
