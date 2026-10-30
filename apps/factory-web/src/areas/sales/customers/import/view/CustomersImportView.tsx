'use client'

import { Upload } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { WizardActions } from '../../../../admin/import/view/ImportWizard'
import type { SheetImport } from '../../../../products/styles/import/sheet-import'
import { SheetImportDialog } from '../../../../products/styles/import/view/SheetImportDialog'

export interface CustomersImportModel {
  /** Why Import is held (a message key of `customer-terms`), or null. */
  held: string | null
  /** The import wizard while it is open (null: closed). */
  sheet: SheetImport | null
  /** Design cases and tests: the wizard drawn in place instead of a dialog. */
  inline?: boolean
}

/**
 * Customers › Import (design sales.customers band "Import (W2a)", pop:customers.import "ImportFlow with the parties
 * importer: upload → dry run → diff → Apply → refused rows"): the band's button (held with its reason) and the ONE import
 * wizard of Admin › Import & export on the customers and suppliers importer (`parties.parties`, keyed by code). It fetches
 * nothing: the container drives the job.
 */
export function CustomersImportView({ model, onOpen, actions }: { model: CustomersImportModel; onOpen?: () => void; actions?: WizardActions }) {
  return (
    <WithMessages namespaces={['customer-terms']}>
      <ImportButton model={model} onOpen={onOpen} actions={actions} />
    </WithMessages>
  )
}

function ImportButton({ model, onOpen, actions }: { model: CustomersImportModel; onOpen?: () => void; actions?: WizardActions }) {
  const t = useT('customer-terms')
  return (
    <>
      <Button size="sm" heldReason={model.held ? t(model.held) : null} onClick={() => onOpen?.()}>
        <Upload size={13} aria-hidden /> {t('import.action')}
      </Button>
      {model.sheet && <SheetImportDialog model={model.sheet} actions={actions} inline={model.inline} />}
    </>
  )
}
