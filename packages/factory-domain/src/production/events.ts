import { z } from 'zod'
import { defineEvent } from '../events/define'
import { SCAN_SUBJECTS } from './settings/monitoring'

/**
 * The production module's events (plan A1 §3.4; MES-278). apps/factory-api's modules/production emits them in the
 * commands that make the change. No legal-basis text, no reason, no person's name in a payload.
 *
 *   production.monitoring_changed   a site's floor rules changed: who floor records name (WIDENED: the station → the
 *                                   worker; NARROWED: the worker → the station) or the legal basis on record
 *                                   (BASIS_RECORDED, BASIS_REPLACED) (B-W1-37; office screens)
 */
export const MONITORING_CHANGES = ['WIDENED', 'NARROWED', 'BASIS_RECORDED', 'BASIS_REPLACED'] as const

const subject = z.enum(SCAN_SUBJECTS)

export const events = [
  defineEvent({
    type: 'production.monitoring_changed',
    context: 'production',
    description: "A site's floor rules changed: who scans and cut logs name (the worker or the station), or the legal basis on record.",
    payload: z.strictObject({ siteId: z.uuid(), scanSubject: subject, previous: subject, change: z.enum(MONITORING_CHANGES), basisOnRecord: z.boolean() }),
    live: { permission: 'production.settings.view', fields: ['siteId', 'scanSubject', 'change'] },
  }),
] as const
