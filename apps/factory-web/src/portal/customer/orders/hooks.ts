'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePortalLive } from '../../shell/frame'
// F-SA-238: the order's shared files (Documents).
import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { portalFilesRead, type OrderFilesModel } from '../../../lib/record-thread/files-view/model'
import { fetchOrderFiles } from './api'
// F-SA-246: a design change's files from the device (the order's conversation's upload route), the shared files model of New order.
import { newIdempotencyKey } from '../../../lib/api/client'
import { holdFiles, stateAfterUpload, type HeldFile } from '../../../lib/request-compose/files'
import { putToStore, sha256Hex } from '../../../record-panels/store'
import { heldList } from '../requests/use-request-files'
import { announceOrderFile, completeOrderFile } from './api'
import { cleanedUploads, uploadFailureOf } from './ask-model'

/**
 * The containers' small browser helpers (B-W2b-191): whether the page is offline (the browser says so, or the tab's one live
 * channel lost its stream: design offline "No connection — showing what was loaded at 10:42"), and a file saved from the
 * page (the CSV of a view, built in the browser; nothing is sent anywhere).
 */
export function useOffline(): boolean {
  const live = usePortalLive({})
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return !online || live === 'offline'
}

export function saveText(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob(['﻿', text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Saves bytes the page read (a document from the store) under their name. */
export function saveBytes(name: string, bytes: Uint8Array, type = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Opens an address in a new tab from an answer that came later (the tab is opened first, so no blocker stops it). */
export function openLater(): { go: (url: string) => void; fail: () => void } {
  const tab = typeof window !== 'undefined' ? window.open('about:blank', '_blank') : null
  return {
    go: (url) => {
      if (tab && !tab.closed) tab.location.href = url
      else window.open(url, '_blank', 'noopener')
    },
    fail: () => tab?.close(),
  }
}

// ---- F-SA-238 (sales page plan N9, P14, R6): the order's shared files on Documents, grouped like the office's Files tab ----

/**
 * The customer's face of the order's files (B-SA-037's read through the content wall): read while Documents shows and again on the
 * live channel's news (the page calls `reload`); another customer's order is "not found" (the portal's neutral frame). The body is
 * the office Files tab's, drawn with its customer face (no audience, no "also on", nothing counted, no sharing).
 */
export function usePortalOrderFiles(api: ApiClient, orderId: string, enabled: boolean, ownNumber: string): { readonly model: OrderFilesModel & { readonly notFound: boolean }; readonly reload: () => void } {
  const [state, setState] = useState<{ read: OrderFilesModel['read']; problem: string | null; notFound: boolean }>({ read: null, problem: null, notFound: false })
  const turn = useRef(0)
  const number = useRef(ownNumber)
  number.current = ownNumber
  const reload = useCallback(() => {
    const mine = ++turn.current
    fetchOrderFiles(api, orderId)
      .then((read) => mine === turn.current && setState({ read: portalFilesRead(read, number.current), problem: null, notFound: false }))
      .catch((error: unknown) => mine === turn.current && setState((known) => ({ read: known.read, problem: isApiError(error) && error.kind === 'not_found' ? null : 'read', notFound: isApiError(error) && error.kind === 'not_found' })))
  }, [api, orderId])
  useEffect(() => {
    if (enabled) reload()
  }, [enabled, reload])
  return { model: { read: state.read, problem: state.problem, selected: [], canShare: false, face: 'customer', notFound: state.notFound }, reload }
}
// ---- end F-SA-238

// ---- F-SA-246 (sales page plan R6; 14-change-flow §2.4): a design change's files from the device ----

/**
 * The files a design change sends from the device, each through the order's conversation's own upload route (the portal composer's,
 * `/portal/threads/SalesOrder/:orderId/files`): announced, its bytes PUT to the store, completed — sent (clean), held for the virus
 * scan (it is on the order and goes with the ask once the order's list holds it: `cleaned`), or failed with the API's own words
 * (uploads from outside closed until the scanner runs, too many files on the order) and Retry. Each file goes up at once when added;
 * nothing names a party or a company (the session's).
 */
export interface DesignUploads {
  readonly held: readonly HeldFile[]
  readonly leftOut: number
  /** The list as last changed, at once (Send reads it right after `cleaned`). */
  readonly current: () => readonly HeldFile[]
  add: (files: File[]) => void
  remove: (key: string) => void
  retry: () => void
  clear: () => void
  /** Our uploads held for the scan that the order's shared list now holds are clean: they go with the ask. */
  cleaned: (available: ReadonlySet<string>) => void
}

export function useDesignUploads(api: ApiClient, orderId: string, words: { network: string; store: string; refused: string }): DesignUploads {
  const [held, setHeld] = useState<HeldFile[]>([])
  const [leftOut, setLeftOut] = useState(0)
  const files = useRef(new Map<string, File>())
  const list = useRef<ReturnType<typeof heldList> | null>(null)
  if (list.current === null) list.current = heldList(setHeld)
  const latest = list.current
  const busy = useRef(false)
  const wording = useRef(words)
  wording.current = words
  const patch = useCallback((key: string, change: Partial<HeldFile>) => latest.update((current) => current.map((file) => (file.key === key ? { ...file, ...change } : file))), [latest])

  const upload = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    try {
      // Each waiting file in turn (one added meanwhile is taken too); a failed one waits for Retry.
      for (let row = waitingOf(latest.current); row; row = waitingOf(latest.current)) {
        const file = files.current.get(row.key)
        if (!file) {
          patch(row.key, { state: 'failed', failure: wording.current.store })
          continue
        }
        patch(row.key, { state: 'uploading', failure: undefined })
        try {
          const bytes = await file.arrayBuffer()
          const { file: announced, upload: target } = await announceOrderFile(api, orderId, { originalName: row.name, contentType: row.contentType, sizeBytes: row.sizeBytes, sha256: await sha256Hex(bytes) })
          await putToStore(target, new Blob([bytes], { type: row.contentType }))
          const done = await completeOrderFile(api, orderId, announced.id)
          patch(row.key, { state: stateAfterUpload(done.status), fileId: done.id, uploaded: true })
        } catch (error) {
          patch(row.key, { state: 'failed', failure: uploadFailureOf(error, wording.current) })
        }
      }
    } finally {
      busy.current = false
    }
  }, [api, orderId, latest, patch])

  const add = useCallback(
    (dropped: File[]) => {
      const keys = dropped.map(() => `df-${newIdempotencyKey()}`)
      const result = holdFiles(latest.current, dropped.map((file) => ({ name: file.name || 'Pasted image.png', type: file.type, size: file.size })), (index) => keys[index]!)
      for (const file of result.held) {
        const index = keys.indexOf(file.key)
        if (index >= 0) files.current.set(file.key, dropped[index]!)
      }
      setLeftOut(result.leftOut)
      latest.update(() => result.held)
      void upload()
    },
    [latest, upload],
  )

  return {
    held,
    leftOut,
    current: () => latest.current,
    add,
    remove: (key) => {
      files.current.delete(key)
      latest.update((current) => current.filter((file) => file.key !== key))
    },
    retry: () => {
      latest.update((current) => current.map((file) => (file.state === 'failed' && !file.uploaded ? { ...file, state: 'held' as const, failure: undefined } : file)))
      void upload()
    },
    clear: () => {
      files.current.clear()
      setLeftOut(0)
      latest.update(() => [])
    },
    cleaned: (available) => latest.update((current) => cleanedUploads(current, available)),
  }
}

/** The next file that waits to go up: taken (no problem), not uploaded, not under way, not failed. */
const waitingOf = (held: readonly HeldFile[]): HeldFile | undefined => held.find((file) => file.problem === null && !file.uploaded && file.state === 'held')
// ---- end F-SA-246
