import { openOfficeEntry } from '../../../../../shell/office/office-entry'

/** `/w/<company>/planning` — Planning's own address (the rail): its first page this person may open, else the office's. */
export default function PlanningEntryPage({ params }: { params: Promise<{ company: string }> }) {
  return openOfficeEntry(params, 'planning')
}
