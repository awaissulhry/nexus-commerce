import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The owner digest and report e-mails (B-W2b-435; ANA-032, follow-up DG1:01; apps/factory-api modules/insights/digest and
 * modules/insights/reports/subscriptions.ts). Ids, codes and counts only: no figure, no amount, no address.
 *
 *   digest.changed                 a person's morning e-mail saved: turned on, turned off, or its time, days, language,
 *                                  sections or company changed. It names the person: never on a live screen.
 *   digest.switch_changed          a company's morning e-mail switched on or off (the owner's switch, OFF by default): the
 *                                  digest panels read again.
 *   digest.sent                    a person's morning e-mail went out (FAKE SES locally and in tests), or a test of it they
 *                                  asked for. It names the person: never on a live screen.
 *   report_subscription.changed    a person's "E-mail me this" of a report made, changed, turned off or removed.
 *   report_subscription.sent       a report's e-mail went out to the person who asked for it.
 */
export const events = [
  defineEvent({
    type: 'digest.changed',
    context: 'insights-digest',
    description: "A person's morning e-mail (the owner digest) was saved: turned on, turned off, or its time, days, language, sections or company changed.",
    payload: z.strictObject({ digestId: z.uuid(), userId: z.uuid(), enabled: z.boolean(), change: z.enum(['CREATED', 'TURNED_ON', 'TURNED_OFF', 'CHANGED']) }),
  }),
  defineEvent({
    type: 'digest.switch_changed',
    context: 'insights-digest',
    description: "A company's morning e-mail was switched on or off: while off, no owner digest about the company goes out.",
    payload: z.strictObject({ settingsId: z.uuid(), companyId: z.uuid(), on: z.boolean() }),
    live: { permission: 'home.view', fields: ['companyId', 'on'] },
  }),
  defineEvent({
    type: 'digest.sent',
    context: 'insights-digest',
    description: "A person's morning e-mail went out, or a test of it they asked for.",
    // A test of a digest never saved names no digest.
    payload: z.strictObject({ digestId: z.uuid().nullable(), userId: z.uuid(), emailOutboundId: z.uuid(), day: z.string(), test: z.boolean(), sections: z.number().int().min(0) }),
  }),
  defineEvent({
    type: 'report_subscription.changed',
    context: 'insights-digest',
    description: 'A person\'s "E-mail me this" of a report was made, changed, turned off or removed.',
    payload: z.strictObject({ subscriptionId: z.uuid(), reportKey: z.string(), userId: z.uuid(), change: z.enum(['SUBSCRIBED', 'CHANGED', 'TURNED_OFF', 'REMOVED']) }),
  }),
  defineEvent({
    type: 'report_subscription.sent',
    context: 'insights-digest',
    description: "A report's e-mail went out to the person who asked for it.",
    payload: z.strictObject({ subscriptionId: z.uuid(), reportKey: z.string(), userId: z.uuid(), emailOutboundId: z.uuid(), rows: z.number().int().min(0) }),
  }),
] as const
