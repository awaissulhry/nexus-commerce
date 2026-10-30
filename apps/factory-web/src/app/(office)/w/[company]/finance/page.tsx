import { openOfficeEntry } from '../../../../../shell/office/office-entry'

/** `/w/<company>/finance` — Finance's own address (the rail): its first page this person may open, else the office's. */
export default function FinanceEntryPage({ params }: { params: Promise<{ company: string }> }) {
  return openOfficeEntry(params, 'finance')
}
