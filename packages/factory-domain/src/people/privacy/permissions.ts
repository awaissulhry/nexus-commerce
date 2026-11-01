import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Privacy of people data (B-W2b-27; apps/factory-api modules/people/privacy; features PLT-207, PLT-209, ANA-075,
 * MES-249, MES-281, MES-282; design people.settings "Privacy of people data", people.efficiency "One person's figures",
 * admin.privacy "People data rules"), in the people area. Each is checked with can() against the site's or the person's
 * company and site.
 *
 *   people.privacy.view    the legal gate of each site and purpose, the minimum group size, who sees one person's
 *                          figures, the people data rules (administrator, production manager; owner and read-only
 *                          through the registry)
 *   people.privacy.manage  switching a purpose on (step-up) or off (never asks), leads (widening: step-up), the minimum
 *                          group size and the roles that see one person's figures (widening: step-up). No template lists
 *                          it: the Owner records the basis per site and purpose (W2b plan §3 GATE-LABOUR) and holds it
 *                          through every office permission.
 *   people.figures.view    opening one person's work figures on request, with a reason, where the site's gate is open
 *                          and the person's role is named in People settings (Owner answer H3: the worker and HR) or
 *                          the person leads the worker's team where the site lets leads see them. Every opening is
 *                          written down (who, whose, which purpose, why), so it is a write. No template lists it but
 *                          the owner's every(): an HR role (a custom one, or the HR template when it comes) gets it.
 */
export const PEOPLE_PRIVACY_DEFINITIONS = definePermissions('people', {
  'privacy.view': {
    risk: 'read',
    description:
      "See the legal gate of each site for people data (attendance, one person's work figures): whether it is on, the legal basis on record, the worker notice and the impact assessment that cover it, who switched it and when; the minimum group size, which roles see one person's figures, and the people data rules.",
  },
  'privacy.manage': {
    risk: 'stepUp',
    description:
      "Switch a purpose of people data on at a site with its legal basis, the worker notice and the impact assessment on record (asks for a fresh code), or off (never asks); let team leads see one person's figures where the basis covers them; set the minimum group size and the roles that see one person's figures (widening asks for a fresh code, narrowing never does).",
  },
  'figures.view': {
    risk: 'write',
    description:
      "Open one person's work figures on request, with a reason, where the site's legal gate is open and your role is named in People settings (the worker and HR) or you lead the worker's team where the site lets leads see them. Every opening is recorded for HR and the data protection officer; never a list, ranking or total of people.",
  },
})

export const PEOPLE_PRIVACY_VIEW = 'people.privacy.view' satisfies Permission
export const PEOPLE_PRIVACY_MANAGE = 'people.privacy.manage' satisfies Permission
export const PEOPLE_FIGURES_VIEW = 'people.figures.view' satisfies Permission

export const PEOPLE_PRIVACY_PERMISSIONS: readonly Permission[] = Object.freeze([PEOPLE_PRIVACY_VIEW, PEOPLE_PRIVACY_MANAGE, PEOPLE_FIGURES_VIEW])
