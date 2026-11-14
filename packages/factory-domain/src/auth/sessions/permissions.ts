import type { Permission } from '../../core/permissions'
import { definePermissions } from '../permissions/registry'

/**
 * Security in depth (B-W2b-404; PLT-063, PLT-064, PLT-068; design admin.security "Session lengths" and "Actions that ask
 * for a fresh code", admin.users › Sessions & sign-ins "Signed in now"). Both are protected and declared with the write
 * risk, so the read-only role (every `read` permission) never holds them; the administrator template holds them by name,
 * the owner through every().
 *
 *   security.settings.manage   change the session lengths per audience and which risky actions ask for a fresh code;
 *                              a longer session, an action switched off, more wrong codes or a shorter lock ask for a
 *                              fresh code themselves (reading them is security.view)
 *   users.sessions.manage      see where a person is signed in (device, browser, place, started, last used) and end all
 *                              their sessions: never a count or a figure about the person, never anyone's address
 *
 * Each person sees and ends their own sessions without a permission (My profile › Where I'm signed in).
 */
export const SECURITY_SETTINGS_DEFINITIONS = definePermissions('security', {
  'settings.manage': {
    risk: 'write',
    description:
      'Change how long sessions last for the office and the portal and which risky actions ask for a fresh code; a longer session, an action switched off, more wrong codes or a shorter lock ask for a fresh code themselves.',
  },
})
export const USER_SESSIONS_DEFINITIONS = definePermissions('users', {
  'sessions.manage': {
    risk: 'write',
    description: "See where a person is signed in now (device, browser, place, started, last used) and end all their sessions; never their address.",
  },
})

export const SECURITY_SETTINGS_MANAGE = 'security.settings.manage' satisfies Permission
export const USER_SESSIONS_MANAGE = 'users.sessions.manage' satisfies Permission

/** The templates that hold them (one line, given in templates.ts `addedFor`): the administrator; the owner through every(). */
export const SECURITY_DEPTH_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: [SECURITY_SETTINGS_MANAGE, USER_SESSIONS_MANAGE],
})
