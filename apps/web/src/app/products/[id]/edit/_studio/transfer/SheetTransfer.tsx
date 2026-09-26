'use client'

import { ExportDialog } from './ExportDialog'
import { ImportDialog } from './ImportDialog'
import type { ExportContext } from './exportModel'

/**
 * PSIE — the sheet's Export and Import buttons open these two dialogs; there is no other import or export in the
 * product. Keep this mounted (like the drawer it replaces): a save that is running keeps going after Import closes.
 */
export function SheetTransfer({ open, intent, onClose, onApplied, onReference, visibleFields, ...context }: ExportContext & {
  open: boolean; intent: 'import' | 'export'; onClose(): void; onApplied(): void; visibleFields?: string[]
  /** The table on screen as a CSV, for reading only (it cannot be imported). */
  onReference?(): void
}) {
  return <>
    {intent === 'export' && open && <ExportDialog open onClose={onClose} context={context} visibleFields={visibleFields} onReference={onReference} />}
    <ImportDialog open={open && intent === 'import'} onClose={onClose} productId={context.productId} market={context.market} onApplied={onApplied} />
  </>
}
