import { openOfficeEntry } from '../../../../../shell/office/office-entry'

/** `/w/<company>/quality` — Quality's own address (the rail): its first page this person may open, else the office's. */
export default function QualityEntryPage({ params }: { params: Promise<{ company: string }> }) {
  return openOfficeEntry(params, 'quality')
}
