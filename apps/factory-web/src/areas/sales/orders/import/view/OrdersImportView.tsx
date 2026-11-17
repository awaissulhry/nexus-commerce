'use client'

import { History } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { SheetImport } from '../../../../products/styles/import/sheet-import'
import { SheetImportDialog } from '../../../../products/styles/import/view/SheetImportDialog'
import { NAMESPACE as DEPTH } from '../../depth/model'
import type { ImportMemory } from '../memory'
import type { OrdersImportActions } from '../use-orders-import'

/** SCR-429 — Import orders' view model: the wizard while it is open (null: closed); `inline` for the design cases. */
export interface OrdersImportModel {
  sheet: SheetImport | null
  inline?: boolean
  /** B-TH-293: the customer's remembered columns for this sheet's headers, said in one line; null/absent: nothing remembered. */
  memory?: ImportMemory | null
}

/**
 * Import orders (SCR-429; design sales.orders pop:orders.import, D14 ImportFlow): the one import wizard on the orders importer
 * (`sales.orders`, keyed by the order reference, style, colour and size): upload a sheet, the dry run (what would be made, the
 * refused rows with their reasons, nothing written), Apply (every order or none), the result. Opened from the band's ⋯
 * "Import orders"; it fetches nothing.
 * B-TH-293: on one customer's sheet the check says in one line that the columns were read as in that customer's last sheet, or
 * offers "Use them" (the sheet checked again with those columns).
 */
export function OrdersImportView({ model, actions }: { model: OrdersImportModel; actions?: OrdersImportActions }) {
  if (!model.sheet) return null
  return <SheetImportDialog model={model.sheet} actions={actions} inline={model.inline} memory={model.memory ? <MemoryLine memory={model.memory} onUse={actions?.onUseMemory} /> : undefined} />
}

// ── B-TH-293 ──
function MemoryLine({ memory, onUse }: { memory: ImportMemory; onUse?: () => void }) {
  return (
    <WithMessages namespaces={[DEPTH]}>
      <MemoryWords memory={memory} onUse={onUse} />
    </WithMessages>
  )
}

function MemoryWords({ memory, onUse }: { memory: ImportMemory; onUse?: () => void }) {
  const d = useT(DEPTH)
  const locale = useLocale()
  const params = { customer: memory.customer, file: memory.fileName, day: formatDate(memory.appliedAt, { locale }) }
  return (
    <p className="fw-adm-hint" role="status">
      <History size={13} aria-hidden /> {d(memory.same ? 'import.memory.same' : 'import.memory.offer', params)}{' '}
      {!memory.same && (
        <Button size="sm" onClick={onUse} heldReason={memory.busy ? d('import.memory.busy') : null}>
          {d('import.memory.use')}
        </Button>
      )}
    </p>
  )
}
// ── end B-TH-293 ──
