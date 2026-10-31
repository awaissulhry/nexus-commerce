import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The Owner's switch for automatic PO confirmation reminders (B-W2b-14; B-W2a-52's follow-up; W2b plan §3 "Owner switch":
 * mail to real suppliers, off by default, turned on per company after GATE-GOLIVE; apps/factory-api
 * modules/purchasing/reminders/settings.ts). Reading where the switch stands is purchasing.view (the reminders card and
 * the due list say it); changing it is reminders.switch, a step-up permission no template lists: the owner holds it
 * through every office permission, and turning reminders ON asks a fresh step-up (turning them off never does).
 */
export const PURCHASING_REMINDERS_DEFINITIONS = definePermissions('purchasing', {
  'reminders.switch': {
    risk: 'stepUp',
    description: "Switch a company's automatic purchase order confirmation reminders on or off: while off, the daily run sends no reminder to any supplier.",
  },
})

export const PURCHASING_REMINDERS_SWITCH = 'purchasing.reminders.switch' satisfies Permission

export const PURCHASING_REMINDERS_PERMISSIONS: readonly Permission[] = Object.freeze([PURCHASING_REMINDERS_SWITCH])
