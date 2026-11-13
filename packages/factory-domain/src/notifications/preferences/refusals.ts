/**
 * The notification rules the database holds since W2b-6 schema wave 47/57 (factory-db …_notify_depth_w2b_guards, B-W2b-366)
 * read back from the database's own words, pure: only e-mail has a daily digest, preferences and follows are an office
 * person's, a device turned off changes no more, a view only its owner sees is followed only by them. The routes of
 * apps/factory-api platform/notifications check these first in words; when a write still reaches a rule (a race: the device
 * turned off from another tab, the view made private meanwhile), the API answers 409 in these words (core/errors) instead of
 * a 500.
 */

export const NOTIFICATION_REFUSAL_ISSUES = Object.freeze({
  digest: 'body/cadence',
  office: 'notifications/OFFICE_PERSON',
  deviceOff: 'push/TURNED_OFF',
  viewPrivate: 'views/ONLY_ME',
  kept: 'notifications/KEPT',
} as const)

const DIGEST = /^notifications: only e-mail has a daily digest/
const OFFICE = /^(notifications: (preference|push subscription) \S+ is an office person|notifications: role default \S+ is of an office role|views: follow \S+ is an office person)/
const DEVICE_OFF = /^notifications: push subscription \S+ was turned off at /
const VIEW_PRIVATE = /^views: view \S+ is its owner/
const KEPT = /^notifications: \S+ \S+ is kept, never deleted/

/** The words and issue path of a refusal of the database's notification rules, or null when the message is another one. */
export function databaseNotificationRefusal(message: string): { readonly path: string; readonly message: string } | null {
  if (DIGEST.test(message)) return { path: NOTIFICATION_REFUSAL_ISSUES.digest, message: 'Only e-mail has a daily digest: choose as it happens or off for the app and push.' }
  if (OFFICE.test(message)) return { path: NOTIFICATION_REFUSAL_ISSUES.office, message: 'Notification choices, devices and follows are for office people and office roles only.' }
  if (DEVICE_OFF.test(message)) return { path: NOTIFICATION_REFUSAL_ISSUES.deviceOff, message: 'This device’s push was turned off meanwhile: turn push on again on the device.' }
  if (VIEW_PRIVATE.test(message)) return { path: NOTIFICATION_REFUSAL_ISSUES.viewPrivate, message: 'Only the person who made this view sees it, so only they can follow it.' }
  if (KEPT.test(message)) return { path: NOTIFICATION_REFUSAL_ISSUES.kept, message: 'A device or an inbox is turned off, never deleted.' }
  return null
}
