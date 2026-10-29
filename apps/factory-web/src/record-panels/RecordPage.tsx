'use client'

import { useParams, useSearchParams } from 'next/navigation'
import { RecordPanels } from './RecordPanels'

/**
 * The record panel route, `/w/<company>/records/<type>/<id>` (SCR-006): any record's thread, files and history, for a
 * record whose own page is not built yet (lib/records/record-links.ts sends its openers here). The opener passes what
 * the panels show and file under: `?label=` (the record's number), `company=` and `site=` (its company and site ids).
 * The API checks the record itself on every call (a record the person may not see answers 404 in each panel).
 */
export function RecordPage() {
  const params = useParams<{ type: string; id: string }>()
  const search = useSearchParams()
  const type = decodeURIComponent(params.type ?? '')
  const id = decodeURIComponent(params.id ?? '')
  return (
    <RecordPanels
      key={`${type}:${id}`}
      record={{ type, id, companyId: search.get('company'), siteId: search.get('site') }}
      title={search.get('label') ?? `${type} ${id.slice(0, 8)}`}
    />
  )
}
