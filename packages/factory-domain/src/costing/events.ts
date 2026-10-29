import { z } from 'zod'
import { defineEvent } from '../events/define'
import { WORK_CENTRE_KINDS } from '../product/routing/operations'
import { LABOUR_RATE_STATUSES } from './rates'

/**
 * Costing's events (plan A1 §3.4, §3.5; B-W1-16). apps/factory-api's modules/costing emits them in the command that
 * changes a labour rate or the costing settings; the office screens that may see costs (costing.view) refetch the rate
 * list and every open Cost tab (a sheet is computed on read, so it follows). Ids, kinds and fields only: never a figure
 * (a screen refetches what it shows, with its viewer's grains).
 */
const rateLive = { permission: 'costing.view', fields: ['rateId', 'workCentreKind'] } as const
const kind = z.enum(WORK_CENTRE_KINDS)

export const events = [
  defineEvent({
    type: 'labour_rate.created',
    context: 'costing',
    description: 'A cost per standard minute was added for a kind of work centre, from a day.',
    payload: z.strictObject({ rateId: z.uuid(), workCentreKind: kind, validFrom: z.string() }),
    live: rateLive,
  }),
  defineEvent({
    type: 'labour_rate.updated',
    context: 'costing',
    description: 'A labour rate was corrected: its cost per minute, currency, planned efficiency, first day or note.',
    payload: z.strictObject({ rateId: z.uuid(), workCentreKind: kind, fields: z.array(z.string()) }),
    live: rateLive,
  }),
  defineEvent({
    type: 'labour_rate.status_changed',
    context: 'costing',
    description: 'A labour rate was archived: cost sheets no longer use it.',
    payload: z.strictObject({ rateId: z.uuid(), workCentreKind: kind, status: z.enum(LABOUR_RATE_STATUSES) }),
    live: rateLive,
  }),
  defineEvent({
    type: 'costing_settings.changed',
    context: 'costing',
    description: "A company's (or the tenant-wide) costing settings changed: the overhead percentage.",
    payload: z.strictObject({ settingsId: z.uuid(), fields: z.array(z.string()) }),
    live: { permission: 'costing.view', fields: ['settingsId'] },
  }),
] as const
