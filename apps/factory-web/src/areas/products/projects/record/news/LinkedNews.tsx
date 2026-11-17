'use client'

import { useCallback, useRef, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { companyPrefix } from '../../../../../lib/session/session'
import { recordAddress } from '../../../../../lib/records/record-links'
import { useLiveBus } from '../../../../../shell/live/use-live'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { readLinkedNews } from '../../api'
import { readProblem } from '../../model'
import { newsLineOf } from '../model'
import { LinkedNewsCard, type LinkedNewsModel } from './view/LinkedNewsCard'

/**
 * B-TH-249 (PROJ.linked-F08) — the container of "News of linked records": nothing is read until the person asks (the news is asked
 * only, never part of the project's default feed); then GET /threads/Project/<id>/timeline?kinds=linked, page by page, read again
 * when a record is linked or unlinked while it is open. Each line opens its record (its own page, else its panels).
 */
export function LinkedNews({ projectId }: { projectId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const prefix = companyPrefix(session.company?.code ?? '')
  const [model, setModel] = useState<LinkedNewsModel>({ asked: false, status: 'idle', lines: [], more: false, moreBusy: false, problem: null })
  const cursor = useRef<string | null>(null)
  const readId = useRef(0)

  const linesOf = useCallback(
    (entries: Awaited<ReturnType<typeof readLinkedNews>>['entries']) =>
      entries.map((entry) => ({ ...newsLineOf(entry), href: `${prefix}${recordAddress({ type: entry.recordType, id: entry.recordId, label: entry.label }, OFFICE_PAGES)}` })),
    [prefix],
  )

  const load = useCallback(async () => {
    const id = ++readId.current
    setModel((now) => ({ ...now, asked: true, status: 'loading', problem: null }))
    try {
      const answer = await readLinkedNews(api, projectId)
      if (id !== readId.current) return
      cursor.current = answer.nextCursor
      setModel({ asked: true, status: 'ready', lines: linesOf(answer.entries), more: answer.nextCursor !== null, moreBusy: false, problem: null })
    } catch (error) {
      if (id === readId.current) setModel((now) => ({ ...now, status: 'error', problem: readProblem(error) }))
    }
  }, [api, projectId, linesOf])

  const more = useCallback(async () => {
    const from = cursor.current
    if (!from) return
    setModel((now) => ({ ...now, moreBusy: true }))
    try {
      const answer = await readLinkedNews(api, projectId, from)
      cursor.current = answer.nextCursor
      setModel((now) => ({ ...now, lines: [...now.lines, ...linesOf(answer.entries)], more: answer.nextCursor !== null, moreBusy: false }))
    } catch (error) {
      setModel((now) => ({ ...now, moreBusy: false, status: 'error', problem: readProblem(error) }))
    }
  }, [api, projectId, linesOf])

  // A record linked or unlinked while the news is open: read it again (its lines come and go with the link).
  useLiveBus(
    {
      onChange: (change) => {
        if ((change.type === 'project.linked' || change.type === 'project.unlinked') && change.fields.projectId === projectId) void load()
      },
      onReconnect: () => void load(),
    },
    model.asked,
  )

  return (
    <LinkedNewsCard
      model={model}
      actions={{
        onAsk: () => void load(),
        onRetry: () => void load(),
        onMore: () => void more(),
        onHide: () => {
          readId.current += 1
          cursor.current = null
          setModel({ asked: false, status: 'idle', lines: [], more: false, moreBusy: false, problem: null })
        },
      }}
    />
  )
}
