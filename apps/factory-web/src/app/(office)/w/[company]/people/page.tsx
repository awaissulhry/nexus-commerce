import { openOfficeEntry } from '../../../../../shell/office/office-entry'

/** `/w/<company>/people` — People's own address (the rail): its first page this person may open, else the office's. */
export default function PeopleEntryPage({ params }: { params: Promise<{ company: string }> }) {
  return openOfficeEntry(params, 'people')
}
