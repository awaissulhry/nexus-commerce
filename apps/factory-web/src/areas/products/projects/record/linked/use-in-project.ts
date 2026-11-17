'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { useLiveChanges } from '../../../../../record-panels/live'
import { projectsOfRecord } from '../../api'
import { inProjectChangeFor, inProjectOf, takesProjects } from './model'

/** One project a record is in, as the thread head's chip shows it. */
export interface InProject {
  readonly id: string
  readonly number: string
  readonly label: string
  readonly href: string
}

/**
 * B-TH-251 (PROJ.linked-F05) — "In project …" of a record, for its thread head: read once (GET /projects/of/:type/:id) for a record a
 * project may link and a reader with threads.read, and again when THIS record is linked or unlinked (live `project.linked` /
 * `project.unlinked`). Only the projects the reader may open (the API leaves the others out); none, another kind of record, no right
 * or a failed read: nothing (a detail of the head, never an error on the record).
 */
export function useInProject(api: ApiClient, record: { readonly type: string; readonly id: string }, canRead: boolean, prefix: string): readonly InProject[] {
  const wanted = canRead && takesProjects(record.type)
  const [projects, setProjects] = useState<readonly InProject[]>([])
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!wanted) {
        setProjects([])
        return
      }
      try {
        const answer = await projectsOfRecord(api, { type: record.type, id: record.id }, signal)
        setProjects(inProjectOf(answer.projects, prefix))
      } catch {
        // A detail of the head: without it the thread works as before.
      }
    },
    [api, record.type, record.id, wanted, prefix],
  )
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])
  useLiveChanges(
    {
      onChange: (change) => {
        if (inProjectChangeFor(change, record)) void load()
      },
      onReconnect: () => void load(),
    },
    wanted,
  )
  return projects
}
