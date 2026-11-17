'use client'

import { useParams, useSearchParams } from 'next/navigation'
import { RecordPanels } from './RecordPanels'
// ---- B-TH-249: a project has one address, its own page (Products › Development › Projects › <id>) ----
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useOfficeSession } from '../lib/session/context'
import { companyPrefix } from '../lib/session/session'
// ---- end B-TH-249

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
  // ---- B-TH-249: `/records/Project/<id>` goes to the project's own page (one address per project; its thread is the page there).
  if (type === 'Project') return <ToProjectPage id={id} />
  // ---- end B-TH-249
  return (
    <RecordPanels
      key={`${type}:${id}`}
      record={{ type, id, companyId: search.get('company'), siteId: search.get('site') }}
      title={search.get('label') ?? `${type} ${id.slice(0, 8)}`}
    />
  )
}

// ---- B-TH-249 ----
/** Replaces the address with the project's page, keeping the thread's own terms (`?message=`, `?thread=`) and the anchor. */
function ToProjectPage({ id }: { id: string }) {
  const router = useRouter()
  const session = useOfficeSession()
  const search = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  useEffect(() => {
    const kept = new URLSearchParams()
    for (const name of ['message', 'thread']) {
      const value = search.get(name)
      if (value) kept.set(name, value)
    }
    const terms = kept.toString()
    router.replace(`${prefix}/products/projects/${encodeURIComponent(id)}${terms ? `?${terms}` : ''}${window.location.hash}`)
  }, [router, prefix, id, search])
  return null
}
// ---- end B-TH-249
