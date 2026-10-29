import { openOfficeEntry } from '../../../../../shell/office/office-entry'

/** `/w/<company>/sales` — Sales' own address (the rail): its first page this person may open, else the office's. */
export default function SalesEntryPage({ params }: { params: Promise<{ company: string }> }) {
  return openOfficeEntry(params, 'sales')
}
