import { openOfficeEntry } from '../../../../shell/office/office-entry'

/** `/w/<company>` — the office's entry: the first page this person may open (shell/office/office-entry.ts). */
export default function OfficeEntryPage({ params }: { params: Promise<{ company: string }> }) {
  return openOfficeEntry(params)
}
