import { openOfficeEntry } from '../../../../../shell/office/office-entry'

/** `/w/<company>/production` — Production's own address (the rail): its first page this person may open, else the office's. */
export default function ProductionEntryPage({ params }: { params: Promise<{ company: string }> }) {
  return openOfficeEntry(params, 'production')
}
