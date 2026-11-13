'use client'

import { Upload } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { WizardActions } from '../../../../admin/import/view/ImportWizard'
import type { SheetImport } from '../../../../products/styles/import/sheet-import'
import { SheetImportDialog } from '../../../../products/styles/import/view/SheetImportDialog'
import { DEPTH_NS } from '../../depth/model'

export interface PriceListImportModel {
  /** Why Import prices is held (a `sales-prices-depth` key), or null. */
  held: string | null
  /** The import wizard while it is open (null: closed). */
  sheet: SheetImport | null
  /** Draw the band's button (the list page). */
  button: boolean
  /** Asked to open (the record's ⋯) while held: the reason in a small dialog. */
  refusedOpen?: boolean
  /** Design cases and tests: the wizard drawn in place instead of a dialog. */
  inline?: boolean
}

/**
 * Import prices (design sales.pricelists band "Import (W2b)", pop:pricelists.import): the band's button (held with its
 * reason) and the ONE import wizard of Admin › Import & export on the price lists importer (`sales.priceLists`: list code,
 * style, colourway or every colourway, first day; last day, unit price, quantity breaks), its dry run listing what each
 * row changes before Apply. It fetches nothing: the container drives the job.
 */
export function PriceListImportView({ model, onOpen, onDismiss, actions }: { model: PriceListImportModel; onOpen?: () => void; onDismiss?: () => void; actions?: WizardActions }) {
  return (
    <WithMessages namespaces={[DEPTH_NS]}>
      <ImportButton model={model} onOpen={onOpen} onDismiss={onDismiss} actions={actions} />
    </WithMessages>
  )
}

function ImportButton({ model, onOpen, onDismiss, actions }: { model: PriceListImportModel; onOpen?: () => void; onDismiss?: () => void; actions?: WizardActions }) {
  const t = useT(DEPTH_NS)
  return (
    <>
      {model.button && (
        <Button size="sm" heldReason={model.held ? t(model.held) : null} onClick={() => onOpen?.()}>
          <Upload size={13} aria-hidden /> {t('import.action')}
        </Button>
      )}
      {model.refusedOpen && model.held && (
        <Modal open onClose={() => onDismiss?.()} title={t('import.title')} size="sm" footer={<Button onClick={() => onDismiss?.()}>{t('common.back')}</Button>}>
          <p>{t(model.held)}</p>
        </Modal>
      )}
      {model.sheet && <SheetImportDialog model={model.sheet} actions={actions} inline={model.inline} />}
    </>
  )
}
