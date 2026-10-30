import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * The plant's permissions (apps/factory-api modules/plant; B-W2a-35; QHS-162, QHS-178, QHS-184; Owner answer H1; design
 * plant.machines, plant.requests, plant.jobs, floor.machine), in the plant area. Each is checked with can() against the
 * machine's company and site; a floor device works at its own site only (can() pins it, row-level security too). The
 * machine classes and the symptoms are the whole group's (tenant-wide): keeping them needs plant.machines.manage over
 * every company.
 *
 * H1: anyone at the station marks a machine unsafe AT ONCE (plant.report: every floor role holds it), and only a
 * technician signs it safe again (plant.signSafe, the technicians' templates only; a signing act: the office's fresh
 * code or the floor's PIN). Nothing here measures a person (Statuto dei Lavoratori art. 4): a request names its reporter
 * and a job its technician only inside the one record; the purchase cost of a machine also needs the cost grain.
 */
export const PLANT_DEFINITIONS = definePermissions('plant', {
  view: {
    risk: 'read',
    description:
      'See the machines and equipment of the sites with their class, place and status now, the machine classes and the symptoms the floor reports, the machine requests and the maintenance jobs (the purchase cost of a machine only with the cost grain).',
  },
  'machines.manage': {
    risk: 'write',
    description:
      'Register machines and equipment (class, make, model, serial, year, station, work centre, supplier, cost), change and retire them, and keep the machine classes and the symptoms the floor reports for each class (the whole group\'s: over every company).',
  },
  report: {
    risk: 'write',
    description:
      "Report a machine problem from the station or the office: the machine (its tag scanned), the symptom, what is wrong, whether the machine is down; marking it unsafe stops it at once until a technician signs it safe (a floor device: at its own site).",
  },
  'requests.triage': {
    risk: 'write',
    description: 'Triage the machine requests: acknowledge them, make a maintenance job of one (or add it to an open job of the machine), merge a duplicate into another request of the machine, or close one without a job with the reason.',
  },
  'jobs.manage': {
    risk: 'write',
    description: 'Make maintenance jobs (by hand or from a request), plan, assign and reschedule them, change their problem, type and priority, close a job the technician handed back, and cancel one with the reason.',
  },
  'jobs.work': {
    risk: 'write',
    description:
      "Work a maintenance job as its technician: start it, wait for parts, hand the machine back with what was done and its state after (running only once a locked machine is signed safe), and take the work back (a floor device: at its own site, the jobs given to you or to nobody).",
  },
  signSafe: {
    risk: 'write',
    description:
      'Sign a machine that was marked unsafe safe again after checking it, with what was checked: only a technician (D.Lgs. 81/2008 art. 71; Owner answer H1); a signing act (the office\'s fresh code, the floor\'s PIN).',
  },
})

export const PLANT_VIEW = 'plant.view' satisfies Permission
export const PLANT_MACHINES_MANAGE = 'plant.machines.manage' satisfies Permission
export const PLANT_REPORT = 'plant.report' satisfies Permission
export const PLANT_REQUESTS_TRIAGE = 'plant.requests.triage' satisfies Permission
export const PLANT_JOBS_MANAGE = 'plant.jobs.manage' satisfies Permission
export const PLANT_JOBS_WORK = 'plant.jobs.work' satisfies Permission
export const PLANT_SIGN_SAFE = 'plant.signSafe' satisfies Permission

export const PLANT_PERMISSIONS: readonly Permission[] = Object.freeze([PLANT_VIEW, PLANT_MACHINES_MANAGE, PLANT_REPORT, PLANT_REQUESTS_TRIAGE, PLANT_JOBS_MANAGE, PLANT_JOBS_WORK, PLANT_SIGN_SAFE])

/**
 * What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): reporting a problem at its own site (every floor role:
 * H1 "anyone at the station"), and the technician's work on its jobs and the sign-safe with the PIN.
 */
export const PLANT_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([PLANT_REPORT, PLANT_JOBS_WORK, PLANT_SIGN_SAFE])
