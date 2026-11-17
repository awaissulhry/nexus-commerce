'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import type { OfficeSession } from '../../../../lib/session/session'
import { useSheetImport, type SheetImport } from '../../../products/styles/import/sheet-import'
import type { WizardActions } from '../../../admin/import/view/ImportWizard'
import { asksMemory, memoryOf, rememberedMapping, type ImportMemory, type Remembered } from './memory' // B-TH-293

/** The importer of B-W2b-303 (platform imports: one order per `order` reference, CREATE only, every order or none). */
export const ORDERS_IMPORTER = 'sales.orders'

/** Why Import orders is held (a `sales-orders-depth` key), or null: orders.manage, and imports.run + files.upload. */
export function importHeldOf(permissions: readonly string[]): string | null {
  const held = new Set(permissions)
  if (!held.has('orders.manage')) return 'import.held.manage'
  if (!held.has('imports.run') || !held.has('files.upload')) return 'import.held.run'
  return null
}

/** B-TH-293: Import orders' own actions beside the wizard's: check the sheet again with the customer's remembered columns. */
export interface OrdersImportActions extends WizardActions {
  onUseMemory?: () => void
}

/** B-TH-293: the customer the Orders sheet is on (the Customer switcher), whose remembered columns an import may be offered. */
export interface ImportCustomer {
  readonly id: string
  readonly name: string | null | undefined
}

/**
 * Import orders' container (B-W2b-323; design sales.orders pop:orders.import "ImportFlow: upload → dry run → diff with counts and
 * reasons → Apply", band overflow "Import orders (W2b, dry run)"): one import job on the orders importer through the shared sheet
 * import (the ONE import wizard of Admin › Import & export: upload, the dry run that writes nothing, apply what was seen, the
 * refused rows). The job belongs to the company the orders are for (the current one; a person in several picks it). Applying
 * needs imports.apply (the wizard holds it); the orders it makes may wait for a yes like a typed order.
 * B-TH-293 (SHEET-G13, W17): on one customer's sheet, once the dry run read the headers, the columns of that customer's last
 * import of the same headers are asked for (only that customer's: never another's) and said in one line; "Use them" checks
 * the sheet again with them.
 */
export function useOrdersImport(api: ApiClient, session: OfficeSession, locale: 'it' | 'en', onApplied: () => void, customer: ImportCustomer | null = null): { held: string | null; model: SheetImport | null; memory: ImportMemory | null; open: () => void; actions: OrdersImportActions } {
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

  // ── B-TH-293 ──
  const job = sheet.model?.wizard.job ?? null
  const partyId = customer?.id ?? null
  const asking = asksMemory(job, partyId, rights.run)
  const [remembered, setRemembered] = useState<{ key: string; value: Remembered | null } | null>(null)
  const key = asking && job && partyId ? `${job.id}:${partyId}` : null
  useEffect(() => {
    if (!key || !job || !partyId) return
    const abort = new AbortController()
    rememberedMapping(api, job.id, partyId, abort.signal)
      .then((value) => !abort.signal.aborted && setRemembered({ key, value }))
      // A failed read offers nothing: the import works as before.
      .catch(() => !abort.signal.aborted && setRemembered({ key, value: null }))
    return () => abort.abort()
  }, [api, key]) // eslint-disable-line react-hooks/exhaustive-deps -- the key names the job and the customer
  const memory = key && job && remembered?.key === key ? memoryOf(job, remembered.value, customer?.name ?? null, sheet.model?.wizard.busy ?? false) : null
  const actions: OrdersImportActions = { ...sheet.actions, onUseMemory: () => memory && !memory.same && sheet.checkAgainWith(memory.mapping) }
  // ── end B-TH-293 ──

  return { held, model: sheet.model, memory, open: () => !held && sheet.open(), actions }
}
