import { openOfficeEntry } from '../../../../../shell/office/office-entry'

/** `/w/<company>/compliance` — Compliance's own address (the rail): its first page this person may open, else the office's. */
export default function ComplianceEntryPage({ params }: { params: Promise<{ company: string }> }) {
  return openOfficeEntry(params, 'compliance')
}
