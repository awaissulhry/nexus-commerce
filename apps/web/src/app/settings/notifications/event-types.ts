/**
 * Settings rebuild — Phase E shared constant.
 *
 * EVENT_TYPES lives in its own module so both the server action
 * (`'use server'` files can only export async functions) and the
 * client + page can pull it from the same place. Update here to
 * surface a new event-type on /settings/notifications.
 */

export const EVENT_TYPES = [
  {
    key: 'NEW_ORDER',
    label: 'New order',
    description: 'A buyer places an order on any channel.',
    defaults: { email: true, sms: false, inApp: true, digestCadence: 'instant' },
  },
  {
    key: 'LOW_STOCK',
    label: 'Low stock',
    description: 'A SKU drops below its low-stock threshold.',
    defaults: { email: true, sms: false, inApp: true, digestCadence: 'hourly' },
  },
  {
    key: 'RETURN_REQUEST',
    label: 'Return request',
    description: 'A buyer files a return / RMA on any channel.',
    defaults: { email: true, sms: false, inApp: true, digestCadence: 'instant' },
  },
  {
    key: 'SYNC_FAILURE',
    label: 'Sync failure',
    description: 'An outbound channel sync errors past its retry window.',
    defaults: { email: true, sms: false, inApp: true, digestCadence: 'instant' },
  },
  {
    key: 'AI_COMPLETE',
    label: 'AI job complete',
    description: 'A bulk AI listing-generate / translation job finishes.',
    defaults: { email: false, sms: false, inApp: true, digestCadence: 'instant' },
  },
] as const

export type EventTypeKey = (typeof EVENT_TYPES)[number]['key']
