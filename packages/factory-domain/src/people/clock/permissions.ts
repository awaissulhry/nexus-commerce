import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Clock in and out (B-W2b-33; apps/factory-api modules/people/clock; MES-223, MES-224, MES-227, MES-239, MES-199), in the
 * people area. Clocking itself needs no office permission: on the floor a badge (or a name and PIN) proves the person
 * at an enrolled tablet, and the signed-in worker's own clock is `floor.work`.
 *
 *   people.attendance.view   see attendance at the sites you reach: who clocked in and out, and when (the office's
 *                            live "who is in now" and the day rows, design people.attendance). Every read of it goes
 *                            through the site's ATTENDANCE legal gate (Statuto dei Lavoratori art. 4 c.2, B-W2b-27) and
 *                            never lists, filters or totals by person beyond one record. This step uses it for the live
 *                            message of a clock event; the attendance pages (B-W2b-37, B-W2b-61) give it to the role
 *                            templates with their routes (owner and read-only through the registry until then).
 */
export const PEOPLE_CLOCK_DEFINITIONS = definePermissions('people', {
  'attendance.view': {
    risk: 'read',
    description:
      "See attendance at the sites you reach: clock-ins, clock-outs and breaks, the days they make and who is in now, where the site's attendance purpose is switched on (Statuto dei Lavoratori art. 4 c.2). Never a ranking, list or total by person.",
  },
})

export const PEOPLE_ATTENDANCE_VIEW = 'people.attendance.view' satisfies Permission

export const PEOPLE_CLOCK_PERMISSIONS: readonly Permission[] = Object.freeze([PEOPLE_ATTENDANCE_VIEW])
