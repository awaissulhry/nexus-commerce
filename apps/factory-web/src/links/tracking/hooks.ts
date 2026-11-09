'use client'

import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import type { ApiClient } from '../../lib/api/client'
import { newIdempotencyKey } from '../../lib/api/client'
import { askForNewLink, downloadPaper, presignedBytes, readTracking, reportProblem } from './api'
import { claimOfError, keepsPolling, loadOfError, POLL_MS, saveBytes, type TrackingActions, type TrackingViewModel } from './model'

const SLOW_MS = 1_000

/**
 * The tracking part of the page for one link client (a link's own, or the one a search's token made): reads the page,
 * says "Still loading…" after a second, reads again every minute while the goods are packed or on the way (and when the tab
 * comes back), downloads a paper (one Idempotency-Key per paper per visit: reading it again is answered from the receipt),
 * copies a tracking number, opens "Report a problem" (a window opened at the click, filled with the claim link's address
 * when it comes), and asks for a new link once the link died. The token stays in the client's header; nothing is stored.
 */
export function useTracking(api: ApiClient | null, model: TrackingViewModel, setModel: Dispatch<SetStateAction<TrackingViewModel>>): TrackingActions {
  const keys = useRef(new Map<string, string>())
  const claimKey = useRef<string | null>(null)
  const latest = useRef(model)
  latest.current = model
  const client = useRef(api)
  client.current = api

  const load = useCallback(
    async (quiet: boolean) => {
      const reader = client.current
      if (!reader) return
      if (!quiet) setModel((state) => ({ ...state, load: 'loading', slow: false }))
      try {
        const page = await readTracking(reader)
        if (client.current !== reader) return
        setModel((state) => ({ ...state, load: 'ready', page, readAt: new Date().toISOString() }))
      } catch (error) {
        if (client.current !== reader) return
        const failed = loadOfError(error)
        // A quiet read that fails keeps what is shown, unless the link died.
        setModel((state) => (quiet && failed !== 'dead' ? state : { ...state, load: failed, page: failed === 'dead' ? null : state.page }))
      }
    },
    [setModel],
  )

  useEffect(() => {
    keys.current = new Map()
    claimKey.current = null
    if (api) void load(false)
  }, [api, load])

  // "Still loading…" after about a second.
  useEffect(() => {
    if (model.load !== 'loading') return
    const timer = setTimeout(() => setModel((state) => (state.load === 'loading' ? { ...state, slow: true } : state)), SLOW_MS)
    return () => clearTimeout(timer)
  }, [model.load, setModel])

  // Live: read again every minute while the goods move, and when the tab comes back (a link has no live channel).
  const polling = model.load === 'ready' && keepsPolling(model.page)
  useEffect(() => {
    if (!polling) return
    const again = () => {
      if (document.visibilityState === 'visible') void load(true)
    }
    const timer = setInterval(again, POLL_MS)
    document.addEventListener('visibilitychange', again)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', again)
    }
  }, [polling, load])

  return useMemo<TrackingActions>(
    () => ({
      onRetry: () => void load(false),
      onCopy: (trackingNumber) => {
        void navigator.clipboard
          ?.writeText(trackingNumber)
          .then(() => setModel((state) => ({ ...state, copied: trackingNumber })))
          .catch(() => undefined)
      },
      onPaper: (fileId) => {
        const reader = client.current
        const paper = latest.current.page?.papers.files.find((entry) => entry.fileId === fileId)
        if (!reader || !paper || latest.current.papers[fileId] === 'busy') return
        setModel((state) => ({ ...state, papers: { ...state.papers, [fileId]: 'busy' } }))
        const key = keys.current.get(fileId) ?? newIdempotencyKey()
        keys.current.set(fileId, key)
        downloadPaper(reader, fileId, key)
          .then((download) => presignedBytes(download))
          .then((data) => {
            saveBytes(data, paper.originalName, paper.contentType)
            setModel((state) => ({ ...state, papers: { ...state.papers, [fileId]: 'idle' } }))
          })
          .catch((error: unknown) => {
            if (loadOfError(error) === 'dead') setModel((state) => ({ ...state, load: 'dead', page: null }))
            else setModel((state) => ({ ...state, papers: { ...state.papers, [fileId]: 'failed' } }))
          })
      },
      onClaim: () => {
        const reader = client.current
        const page = latest.current.page
        if (!reader || !page || page.claim.held || latest.current.claim === 'busy' || latest.current.claim === 'too-many') return
        // Opened at the click (a window opened after an answer is blocked), filled when the claim link's address comes.
        const opened = window.open('', '_blank')
        if (opened) opened.opener = null
        setModel((state) => ({ ...state, claim: 'busy' }))
        claimKey.current ??= newIdempotencyKey()
        reportProblem(reader, claimKey.current)
          .then((answer) => {
            if (answer.url && opened) opened.location.href = answer.url
            else if (answer.url) window.location.assign(answer.url)
            else opened?.close()
            // Opened: a next press asks for another claim link (the API holds them at three).
            if (answer.url) claimKey.current = null
            setModel((state) => ({ ...state, claim: answer.url ? 'opened' : 'failed' }))
          })
          .catch((error: unknown) => {
            opened?.close()
            const claim = claimOfError(error)
            if (claim === 'dead') setModel((state) => ({ ...state, load: 'dead', page: null, claim: 'idle' }))
            else setModel((state) => ({ ...state, claim }))
          })
      },
      onAskNewLink: () => {
        const reader = client.current
        if (!reader || latest.current.ask === 'busy' || latest.current.ask === 'done') return
        setModel((state) => ({ ...state, ask: 'busy' }))
        askForNewLink(reader)
          .then(() => setModel((state) => ({ ...state, ask: 'done' })))
          .catch(() => setModel((state) => ({ ...state, ask: 'failed' })))
      },
    }),
    [load, setModel],
  )
}
