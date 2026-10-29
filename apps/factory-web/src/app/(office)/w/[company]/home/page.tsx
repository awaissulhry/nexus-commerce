import { openOfficeEntry } from '../../../../../shell/office/office-entry'

/** `/w/<company>/home` — Home's own address (the rail, the brand link): its first page this person may open, else the office's. */
export default function HomeEntryPage({ params }: { params: Promise<{ company: string }> }) {
  return openOfficeEntry(params, 'home')
}
