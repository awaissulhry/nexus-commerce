import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Notification defaults per role (B-W2b-385; PLT-141 "admins set defaults per role"), in the home area, office only. A
 * person's own matrix, push devices and followed views need no permission of their own (home.view: their own); the defaults
 * of a role, which every holder of that role inherits until they choose, are this one.
 *
 *   notifications.manage   set and remove the notification defaults of an office role (each kind of news × in the app,
 *                          e-mail, push × as it happens, daily digest, off)
 */
export const NOTIFICATION_DEFAULTS_DEFINITIONS = definePermissions('home', {
  'notifications.manage': {
    risk: 'write',
    description:
      'Set what each office role hears by default: per kind of news (mentioned, assigned, approvals, records and views followed, alerts, mail) in the app, by e-mail and on the phone, as it happens, in the daily digest or not at all. A person’s own choice still wins.',
  },
})

export const HOME_NOTIFICATIONS_MANAGE = 'home.notifications.manage' satisfies Permission

export const NOTIFICATION_DEFAULTS_PERMISSIONS: readonly Permission[] = Object.freeze([HOME_NOTIFICATIONS_MANAGE])

/** The role templates that get it (owner: every()): the administrators. */
export const NOTIFICATION_DEFAULTS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({ admin: [HOME_NOTIFICATIONS_MANAGE] })
