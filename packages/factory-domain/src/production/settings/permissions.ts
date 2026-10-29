import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The floor rules' permissions (apps/factory-api modules/production/settings; features MES-278, PLT-208; A2 SCR-074
 * Production › Settings), in the production area. Each is checked with can() against the site's company and the site.
 * Office only: a floor device reads its own site's scan subject with floor.work, never these.
 *
 * Changing the scan subject is not a step-up permission as a whole: narrowing (WORKER → STATION) records less about
 * people and never asks; widening (STATION → WORKER) asks for a fresh code (the API's requireStepUp) and a reason
 * (Statuto dei Lavoratori, L. 300/1970, art. 4 c.1). Only people with settings.manage see who has not acknowledged the
 * information notice by name; settings.view sees the counts.
 */
export const PRODUCTION_SETTINGS_DEFINITIONS = definePermissions('production', {
  'settings.view': { risk: 'read', description: "See each site's floor rules: whether floor records name the worker or the station, the legal basis on record, and how many workers have acknowledged the information notice." },
  'settings.manage': { risk: 'write', description: "Change who a site's floor records name (naming workers again asks for a fresh code and a reason), record the legal basis, and see by name who has not acknowledged the notice." },
})

export const PRODUCTION_SETTINGS_VIEW = 'production.settings.view' satisfies Permission
export const PRODUCTION_SETTINGS_MANAGE = 'production.settings.manage' satisfies Permission

export const PRODUCTION_SETTINGS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_SETTINGS_VIEW, PRODUCTION_SETTINGS_MANAGE])
