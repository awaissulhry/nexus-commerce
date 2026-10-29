import { openOfficeEntry } from '../../../../../shell/office/office-entry'

/** `/w/<company>/admin` — Admin's own address (the rail): its first page this person may open, else the office's. */
export default function AdminEntryPage({ params }: { params: Promise<{ company: string }> }) {
  return openOfficeEntry(params, 'admin')
}
