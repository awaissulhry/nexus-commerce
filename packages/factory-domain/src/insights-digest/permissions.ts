import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * The owner digest (B-W2b-435; ANA-032; design home.reports `digest`, home.today ⋯ "Daily digest by e-mail"), in the home area,
 * office only. A person's own morning e-mail (on or off, its time, weekdays, language and sections) is theirs with home.view, as
 * their notification preferences are: what it lists is what their other permissions read. A company's morning e-mail goes out
 * only while its switch is on (the Owner's rule of 11-13: OFF by default); switching it is the owner's alone — no role template
 * lists it, the owner holds it through every office permission:
 *
 *   digest.switch   switch a company's morning e-mail on or off, and see who gets it there (their names, time and language)
 */
export const HOME_DIGEST_DEFINITIONS = definePermissions('home', {
  'digest.switch': {
    risk: 'write',
    description:
      "Switch a company's owner digest (the morning e-mail) on or off and see who gets it there. While it is off, no morning e-mail about the company goes out, whoever turned their own on.",
  },
})

export const HOME_DIGEST_SWITCH = 'home.digest.switch' satisfies Permission

export const HOME_DIGEST_PERMISSIONS: readonly Permission[] = Object.freeze([HOME_DIGEST_SWITCH])
