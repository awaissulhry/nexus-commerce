'use client'

import type { WizardActions } from '../../../../admin/import/view/ImportWizard'
import type { SheetImport } from '../../../../products/styles/import/sheet-import'
import { SheetImportDialog } from '../../../../products/styles/import/view/SheetImportDialog'

/** SCR-429 — Import orders' view model: the wizard while it is open (null: closed); `inline` for the design cases. */
export interface OrdersImportModel {
  sheet: SheetImport | null
  inline?: boolean
}

/**
 * Import orders (SCR-429; design sales.orders pop:orders.import, D14 ImportFlow): the one import wizard on the orders importer
 * (`sales.orders`, keyed by the order reference, style, colour and size): upload a sheet, the dry run (what would be made, the
 * refused rows with their reasons, nothing written), Apply (every order or none), the result. Opened from the band's ⋯
 * "Import orders"; it fetches nothing.
 */
export function OrdersImportView({ model, actions }: { model: OrdersImportModel; actions?: WizardActions }) {
  if (!model.sheet) return null
  return <SheetImportDialog model={model.sheet} actions={actions} inline={model.inline} />
}
