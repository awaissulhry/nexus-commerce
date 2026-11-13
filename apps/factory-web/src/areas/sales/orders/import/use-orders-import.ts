'use client'

import { useMemo } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import type { OfficeSession } from '../../../../lib/session/session'
import { useSheetImport, type SheetImport } from '../../../products/styles/import/sheet-import'
import type { WizardActions } from '../../../admin/import/view/ImportWizard'

/** The importer of B-W2b-303 (platform imports: one order per `order` reference, CREATE only, every order or none). */
export const ORDERS_IMPORTER = 'sales.orders'

/** Why Import orders is held (a `sales-orders-depth` key), or null: orders.manage, and imports.run + files.upload. */
export function importHeldOf(permissions: readonly string[]): string | null {
  const held = new Set(permissions)
  if (!held.has('orders.manage')) return 'import.held.manage'
  if (!held.has('imports.run') || !held.has('files.upload')) return 'import.held.run'
  return null
}

/**
 * Import orders' container (B-W2b-323; design sales.orders pop:orders.import "ImportFlow: upload → dry run → diff with counts and
 * reasons → Apply", band overflow "Import orders (W2b, dry run)"): one import job on the orders importer through the shared sheet
 * import (the ONE import wizard of Admin › Import & export: upload, the dry run that writes nothing, apply what was seen, the
 * refused rows). The job belongs to the company the orders are for (the current one; a person in several picks it). Applying
 * needs imports.apply (the wizard holds it); the orders it makes may wait for a yes like a typed order.
 */
export function useOrdersImport(api: ApiClient, session: OfficeSession, locale: 'it' | 'en', onApplied: () => void): { held: string | null; model: SheetImport | null; open: () => void; actions: WizardActions } {
  const held = useMemo(() => importHeldOf(session.permissions), [session.permissions])
  const rights = useMemo(() => {
    const has = new Set(session.permissions)
    return { view: has.has('imports.view'), run: has.has('imports.run') && has.has('files.upload'), apply: has.has('imports.apply'), people: false }
  }, [session.permissions])
  const companies = useMemo(() => session.companies.map((company) => ({ id: company.id, name: company.name })), [session.companies])
  const sheet = useSheetImport(api, {
    importerKey: ORDERS_IMPORTER,
    companyId: session.company?.id ?? companies[0]?.id ?? '',
    companies,
    everyCompany: null,
    rights,
    locale,
    onApplied,
  })
  return { held, model: sheet.model, open: () => !held && sheet.open(), actions: sheet.actions }
}
