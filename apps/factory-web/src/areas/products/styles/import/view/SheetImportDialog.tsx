'use client'

import { WithMessages } from '../../../../../record-panels/i18n'
import { ImportWizard, ImportWizardInline, type WizardActions } from '../../../../admin/import/view/ImportWizard'
import type { SheetImport } from '../sheet-import'
import '../../../../admin/shared/admin.css'
import '../../../../admin/import/import.css'

/**
 * Import BOM / Import operations (W2a; design pop:styles.importBom "ImportFlow with column mapping and an error
 * preview", products.operations Import): the import wizard of Admin › Import & export (the app's stand-in for DS gap
 * D14 ImportFlow) on one importer. `inline` draws it in place (the design cases and the tests: a dialog opens only in a
 * browser). It fetches nothing.
 */
export function SheetImportDialog({ model, actions, inline }: { model: SheetImport; actions?: WizardActions; inline?: boolean }) {
  const Wizard = inline ? ImportWizardInline : ImportWizard
  return (
    <WithMessages namespaces={['admin-import', 'admin']}>
      <Wizard model={model.wizard} importers={model.importers} companies={model.companies} can={model.rights} actions={actions} />
    </WithMessages>
  )
}
