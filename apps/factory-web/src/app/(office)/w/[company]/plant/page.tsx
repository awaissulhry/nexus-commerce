import { openOfficeEntry } from '../../../../../shell/office/office-entry'

/** `/w/<company>/plant` — Plant's own address (the rail): its first page this person may open, else the office's. */
export default function PlantEntryPage({ params }: { params: Promise<{ company: string }> }) {
  return openOfficeEntry(params, 'plant')
}
