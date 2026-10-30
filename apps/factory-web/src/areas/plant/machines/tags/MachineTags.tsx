'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { getMachine, listMachines, type Machine } from '../../_shared/api'
import { readProblem } from '../../_shared/model'
import { TagsView } from './view/TagsView'

/** The most tags one sheet reads (a page of the register). */
const MAX = 200

/**
 * `/w/<company>/plant/machines/tags?ids=` (SCR-150 tab:tags-pdf): the named machines (else every machine in use, up to
 * 200), read once, drawn as tags for paper.
 */
export function MachineTags() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const ids = useMemo(() => (params?.get('ids') ?? '').split(',').map((id) => id.trim()).filter(Boolean).slice(0, MAX), [params])
  const [at] = useState(() => new Date().toISOString())
  const [machines, setMachines] = useState<{ value: Machine[] | null; problem: string | null }>({ value: null, problem: null })
  useEffect(() => {
    let live = true
    const read = async (): Promise<Machine[]> => {
      if (ids.length === 0) return (await listMachines(api, { limit: MAX })).machines
      const found: Machine[] = []
      for (const id of ids) found.push((await getMachine(api, id)).card.machine)
      return found
    }
    read()
      .then((value) => live && setMachines({ value, problem: null }))
      .catch((error: unknown) => live && setMachines({ value: null, problem: readProblem(error) }))
    return () => {
      live = false
    }
  }, [api, ids])
  return <TagsView model={{ person: session.user.displayName, at, machines }} />
}
