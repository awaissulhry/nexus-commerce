'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePortalLive } from '../../shell/frame'
// F-SA-238: the order's shared files (Documents).
import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { portalFilesRead, type OrderFilesModel } from '../../../lib/record-thread/files-view/model'
import { fetchOrderFiles } from './api'

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
