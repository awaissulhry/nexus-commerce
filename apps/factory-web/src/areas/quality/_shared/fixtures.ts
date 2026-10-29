import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import { qualityCan, type QualityCan } from './model'

/**
 * Design-only made-up data shared by the quality screens' fixtures (SCR-054, SCR-075, SCR-076, SCR-113): ids, instants,
 * the role cases the Owner reviews, and the Office shell around a page. Nothing here is a real company, person, number
 * or result: "Demo" names, example codes (DEMO-…), made-up values.
 */

export const PREFIX = '/w/DEMO'
export const COMPANY_ID = DEMO_COMPANIES[0].id
export const SITE_ID = '0190f0e2-2222-7000-8000-000000000001'
export const ME = DEMO_USER.id

/** A made-up uuid in a family (`uid('4501', 3)`). */
export const uid = (family: string, n: number): string => `0190f0e2-${family.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`

/** A made-up instant in October 2026 (UTC). */
export const at = (day: number, hour = 9, minute = 0): string => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
/** A made-up business day in October 2026. */
export const day = (n: number): string => `2026-10-${String(n).padStart(2, '0')}`
export const NOW = at(29, 9, 42)

/** The office permissions of a role template (factory-domain), plus Home: what that role's person holds. */
const templatePermissions = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/**
 * The role cases of the review: the owner (every permission of these screens), the quality inspector, the production
 * manager (sees inspections, decides nothing), a read-only person (sees, changes nothing) and a sales person (none of
 * these pages).
 */
export const ROLE_PERMISSIONS = {
  owner: [
    ...OWNER_PERMISSIONS,
    ...templatePermissions('quality_inspector'),
    'quality.settings.manage',
    'workorders.view',
    'parties.view',
  ],
  inspector: templatePermissions('quality_inspector'),
  production: templatePermissions('production_manager'),
  readOnly: [
    'home.view',
    'quality.inspections.view',
    'quality.lots.view',
    'compliance.register.view',
    'compliance.certificates.view',
    'workorders.view',
    'parties.view',
    'files.read',
    'threads.read',
  ],
  sales: templatePermissions('sales'),
} as const

export type RoleCase = keyof typeof ROLE_PERMISSIONS

export const canFor = (role: RoleCase): QualityCan => qualityCan(ROLE_PERMISSIONS[role])

/** The Office shell around a page (the role's navigation, this page's place), as the page sees it. */
export function inShell(path: string, page: ReactNode, role: RoleCase = 'owner'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...ROLE_PERMISSIONS[role]])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}
