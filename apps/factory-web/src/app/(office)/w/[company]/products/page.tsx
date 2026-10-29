import { openOfficeEntry } from '../../../../../shell/office/office-entry'

/** `/w/<company>/products` — Products' own address (the rail): its first page this person may open, else the office's. */
export default function ProductsEntryPage({ params }: { params: Promise<{ company: string }> }) {
  return openOfficeEntry(params, 'products')
}
