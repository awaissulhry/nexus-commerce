import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The metric layer (B-W2b-428; ANA-012, ANA-028, ANA-069, ANA-070; design home.kpis, SCR-249), in the home area, office
 * only. A KPI's definition is read by everyone who works with business numbers; its VALUE is what the person's other
 * permissions reach (each measure needs its records' own view permission, e.g. orders.view for the orders, and its money
 * grain): the facts are kept per company, site and line, and a person limited to some customers gets the same calculation
 * on their own records. Nothing here is per person.
 *
 *   kpis.view     the KPI library: every KPI's definition in force (name, plain words, formula, source records, owner,
 *                 unit, version), its history of versions, where it is used, its value in my scope with its trend and how
 *                 fresh it is; the facts (daily and hourly numbers per company, site and line) and the measures
 *   kpis.manage   write a new version of a KPI (a draft made from the one in force, with what changed), change and delete
 *                 a draft, put a version in force (the one before it is superseded), withdraw a KPI, install the standard
 *                 KPIs and keep where each is used, and rebuild the facts of some days from the records
 */
export const HOME_KPIS_DEFINITIONS = definePermissions('home', {
  'kpis.view': {
    risk: 'read',
    description:
      'See the KPI library: what each KPI means in plain words, its formula, the records it is made from, who owns it, its versions and where it is used, and its value over the records your other permissions reach (money only with its rights). Figures are per company, site and line, never per person.',
  },
  'kpis.manage': {
    risk: 'write',
    description:
      'Write a new version of a KPI and put it in force (the old one is kept to explain old numbers), withdraw a KPI, install the standard KPIs, and rebuild the daily and hourly figures of some days from the records.',
  },
})

export const HOME_KPIS_VIEW = 'home.kpis.view' satisfies Permission
export const HOME_KPIS_MANAGE = 'home.kpis.manage' satisfies Permission

export const HOME_KPIS_PERMISSIONS: readonly Permission[] = Object.freeze([HOME_KPIS_VIEW, HOME_KPIS_MANAGE])

/**
 * The role templates that get them (owner: every(); read-only reads through the registry): every office template that works
 * with business numbers reads the library (the report library's set, B-W2a-79; not the administrator, who keeps no business
 * data); the definitions are the Owner's to change.
 */
export const HOME_KPIS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [HOME_KPIS_VIEW],
  sales: [HOME_KPIS_VIEW],
  planner: [HOME_KPIS_VIEW],
  buyer: [HOME_KPIS_VIEW],
  warehouse: [HOME_KPIS_VIEW],
  production_manager: [HOME_KPIS_VIEW],
  quality_inspector: [HOME_KPIS_VIEW],
  floor_supervisor: [HOME_KPIS_VIEW],
})
