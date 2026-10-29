import { openOfficeEntry } from '../../../../../shell/office/office-entry'

/** `/w/<company>/warehouse` — Warehouse's own address (the rail): its first page this person may open, else the office's. */
export default function WarehouseEntryPage({ params }: { params: Promise<{ company: string }> }) {
  return openOfficeEntry(params, 'warehouse')
}
