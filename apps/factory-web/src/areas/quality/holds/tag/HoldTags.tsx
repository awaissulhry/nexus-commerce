'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { failedRead, problemKey, ready, reading, type Read } from '../../_shared/model'
import { getHold, holdReasons, type Hold } from '../api'
import { HoldTagsView } from './view/HoldTagsView'

/** The most tags one sheet reads (the list's most). */
const MAX = 200

/**
 * `/w/<company>/quality/holds/<id>/tag` (SCR-078 tab:qh-tag): the hold (or `?ids=` several, in that order), read once,
 * drawn as tags for paper. Each tag's QR is the hold's address on this office.
 */
export function HoldTags({ holdId }: { holdId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const ids = useMemo(() => {
    const asked = (params?.get('ids') ?? '').split(',').map((id) => id.trim()).filter(Boolean)
    return (asked.length > 0 ? asked : [holdId]).slice(0, MAX)
  }, [params, holdId])
  const [at] = useState(() => new Date().toISOString())
  const [holds, setHolds] = useState<Read<readonly Hold[]>>(reading())
  const [reasons, setReasons] = useState<ReadonlyMap<string, { labelIt: string; labelEn: string }>>(new Map())
  useEffect(() => {
    let live = true
    ;(async () => {
      const found: Hold[] = []
      for (const id of ids) found.push((await getHold(api, id)).hold)
      return found
    })()
      .then((value) => live && setHolds(ready(value)))
      .catch((error: unknown) => live && setHolds(failedRead(problemKey(error))))
    holdReasons(api)
      .then((list) => live && setReasons(new Map(list.map((entry) => [entry.code, { labelIt: entry.labelIt, labelEn: entry.labelEn }]))))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [api, ids])
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const addressOf = Object.fromEntries(ids.map((id) => [id, `${origin}${prefix}/quality/holds?open=${encodeURIComponent(id)}`]))
  return <HoldTagsView model={{ me: session.user.id, person: session.user.displayName, at, addressOf, holds, reasons }} />
}
