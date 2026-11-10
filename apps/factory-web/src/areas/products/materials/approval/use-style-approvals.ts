'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { readProblem } from '../../library/model'
import { readStyleApprovals, type MaterialApprovalsView } from './api'
import type { PartRead } from './depth-model'

/**
 * B-W2b-238: the approvals of the materials of the style's revision in view, for its Compliance tab (Material checks ›
 * Blocked or unapproved materials), read while that tab shows and again when the revision or a material's approval moves
 * (`reload`, from the record's live changes).
 */
export function useStyleApprovals({ api, styleId, revisionId, enabled }: { api: ApiClient; styleId: string; revisionId: string | null; enabled: boolean }): { read: PartRead<MaterialApprovalsView>; reload: () => void } {
  const [read, setRead] = useState<PartRead<MaterialApprovalsView>>({ status: 'idle' })
  const load = useCallback(() => {
    if (!enabled || revisionId === null) return
    setRead((current) => (current.status === 'ready' && current.value.revision.id === revisionId ? current : { status: 'loading' }))
    readStyleApprovals(api, styleId, revisionId)
      .then((value) => setRead({ status: 'ready', value }))
      .catch((error: unknown) => setRead({ status: 'error', problem: readProblem(error) }))
  }, [api, styleId, revisionId, enabled])
  useEffect(() => load(), [load])
  return { read, reload: load }
}
