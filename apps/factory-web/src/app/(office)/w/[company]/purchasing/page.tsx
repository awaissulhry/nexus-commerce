import { openOfficeEntry } from '../../../../../shell/office/office-entry'

/** `/w/<company>/purchasing` — Purchasing's own address (the rail): its first page this person may open, else the office's. */
export default function PurchasingEntryPage({ params }: { params: Promise<{ company: string }> }) {
  return openOfficeEntry(params, 'purchasing')
}
