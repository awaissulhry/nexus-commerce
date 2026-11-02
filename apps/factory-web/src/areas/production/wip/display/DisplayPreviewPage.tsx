'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi } from '../../../../lib/session/context'
import { useBoardRotation, useLineBoard } from '../../../../lib/line-board/use-line-board'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { getLines } from '../../reports/api'
import { getTvBoard } from '../api'
import { boardTouched } from '../model'
import { DisplayPreviewView, type PreviewLine } from './view/DisplayPreviewView'

/**
 * `/w/<company>/production/floor/display?line=<id>` (SCR-173 display.preview, design floor.display): the same line board in
 * a new tab, to check it or show it on a meeting-room screen. It reads GET /production/boards/tv every 10 seconds and at
 * once on a floor change; ← and → change the view, Space pauses the rotation.
 */
export function DisplayPreviewPage() {
  const api = useOfficeApi()
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const [lines, setLines] = useState<readonly PreviewLine[] | null>(null)
  const asked = params.get('line')

  useEffect(() => {
    getLines(api)
      .then((answer) => setLines(answer.lines.map((line) => ({ id: line.id, code: line.code, name: line.name }))))
      .catch(() => setLines([]))
  }, [api])

  const lineId = asked ?? lines?.[0]?.id ?? null
  const onLine = useCallback((id: string) => router.replace(`${pathname}?line=${encodeURIComponent(id)}`, { scroll: false }), [pathname, router])
  return <Preview key={lineId ?? 'none'} lineId={lineId} lines={lines} onLine={onLine} api={api} />
}

function Preview({ lineId, lines, onLine, api }: { lineId: string | null; lines: readonly PreviewLine[] | null; onLine: (id: string) => void; api: ReturnType<typeof useOfficeApi> }) {
  const read = useCallback(() => (lineId ? getTvBoard(api, lineId) : Promise.reject(new Error('no line'))), [api, lineId])
  const { board, problem, staleSince, refresh } = useLineBoard(read)
  const { view, paused, step, togglePause } = useBoardRotation()
  const reread = useCoalesced(refresh, 1500)
  useLive(
    (change) => {
      if (boardTouched(change)) reread()
    },
    refresh,
    lineId !== null,
  )

  // Design floor.display: ← and → change the view; Space pauses the rotation (not inside the line picker).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && ['SELECT', 'INPUT', 'TEXTAREA', 'BUTTON'].includes(target.tagName)) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        step(event.key === 'ArrowRight' ? 1 : -1)
      } else if (event.key === ' ') {
        event.preventDefault()
        togglePause()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [step, togglePause])

  const model = useMemo(() => ({ board: { board, problem: lineId ? problem : null, view, staleSince, preview: true }, lines, lineId, paused }), [board, problem, view, staleSince, lines, lineId, paused])
  return <DisplayPreviewView model={model} actions={{ onLine, onStep: step, onPause: togglePause }} />
}
