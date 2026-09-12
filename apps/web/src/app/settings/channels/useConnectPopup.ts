'use client'
import { WORKSPACES_ENABLED, browserWorkspaceId } from '@/lib/workspaces/paths'

/**
 * CX.2 — the ONE popup bridge for every channel connect / reconnect.
 *
 * The flow: open a popup SYNCHRONOUSLY inside the click (a `window.open` after
 * an await has lost its user gesture and is blocked), ask the API to start the
 * OAuth session (`POST /api/cx/connect/:channel/start` — state, PKCE, intent and
 * the double-submit cookie all live server-side), point the popup at the
 * channel's own sign-in, and listen for the API-host callback page to report
 * back. That page `postMessage`s `nexus:channel-connected` to the opener AND
 * broadcasts it on `nexus-oauth` (for the case where `window.opener` was
 * severed), then waits for our `nexus:ack` before closing itself.
 *
 * `start(key, { url })` is the escape hatch for a flow that is not on the
 * shared service yet (Amazon Ads' LWA route until CX.3): the popup is pointed
 * straight at that URL and we resolve when it closes.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { matchesConnectionAttempt, type ConnectionAttempt } from './connection-attempt'

export interface ConnectedMessage {
  type: 'nexus:channel-connected'
  workspaceId?: string
  state?: string
  channel: string
  channelKey?: string
  connectionId?: string
  sellerName?: string
  placement?: 'new' | 'reconsent' | 'adopt' | string
  scopeDrift?: string[]
}

export type ConnectIntent = 'connect' | 'reconnect' | 'adopt'

export interface StartOptions {
  /** Chosen before sign-in. Server membership and permissions remain authoritative. */
  workspaceId?: string
  intent?: ConnectIntent
  targetConnectionId?: string
  region?: string | null
  /** Point the popup at this URL instead of the shared start route. */
  url?: string
}

function isConnected(data: unknown): data is ConnectedMessage {
  return !!data && typeof data === 'object' && (data as { type?: string }).type === 'nexus:channel-connected'
}

export function useConnectPopup(onConnected: (m: ConnectedMessage) => void, onClosedWithoutMessage?: (attempt: ConnectionAttempt) => void) {
  const [connecting, setConnecting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef({ onConnected, onClosedWithoutMessage })
  latest.current = { onConnected, onClosedWithoutMessage }
  const popupRef = useRef<Window | null>(null)
  const heardRef = useRef(false)
  const attemptRef = useRef<ConnectionAttempt | null>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    const apiOrigin = (() => {
      try {
        return new URL(getBackendUrl(), window.location.href).origin
      } catch {
        return null
      }
    })()
    const handle = (data: unknown): boolean => {
      if (heardRef.current || !matchesConnectionAttempt(data, attemptRef.current, WORKSPACES_ENABLED)) return false
      heardRef.current = true
      attemptRef.current = null
      if (timerRef.current !== null) window.clearInterval(timerRef.current)
      timerRef.current = null
      setConnecting(null)
      latest.current.onConnected(data as ConnectedMessage)
      return true
    }
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin && e.origin !== apiOrigin) return
      if (handle(e.data)) {
        try {
          ;(e.source as Window | null)?.postMessage({ type: 'nexus:ack', state: (e.data as ConnectedMessage).state }, e.origin)
        } catch {
          /* popup already gone */
        }
      }
    }
    window.addEventListener('message', onMessage)
    let bc: BroadcastChannel | null = null
    try {
      bc = new BroadcastChannel('nexus-oauth')
      bc.onmessage = (e) => {
        if (handle(e.data)) bc?.postMessage({ type: 'nexus:ack', state: (e.data as ConnectedMessage).state })
      }
    } catch {
      /* no BroadcastChannel — the postMessage path above still works */
    }
    return () => {
      window.removeEventListener('message', onMessage)
      bc?.close()
      if (timerRef.current !== null) window.clearInterval(timerRef.current)
      attemptRef.current = null
    }
  }, [])

  const start = useCallback(async (channelKey: string, opts: StartOptions = {}) => {
    if (attemptRef.current) { popupRef.current?.focus(); return false }
    const workspaceId = opts.workspaceId ?? browserWorkspaceId()
    if (WORKSPACES_ENABLED && !workspaceId) { setError('Choose a business profile before connecting this account.'); return false }
    const attempt: ConnectionAttempt = { channelKey, workspaceId, state: null, ...(!WORKSPACES_ENABLED && opts.url ? { legacy: true } : {}) }
    attemptRef.current = attempt
    const popup = window.open('', '_blank')
    popupRef.current = popup
    heardRef.current = false
    setError(null)
    setConnecting(channelKey)
    try {
      // Business mode always uses the shared flow that records the chosen profile.
      let authUrl = WORKSPACES_ENABLED ? undefined : opts.url
      if (!authUrl) {
        const res = await fetch(`${getBackendUrl()}/api/cx/connect/${channelKey.toLowerCase()}/start`, {
          method: 'POST',
          credentials: 'include',
          signal: AbortSignal.timeout(30_000),
          headers: { 'Content-Type': 'application/json', ...(WORKSPACES_ENABLED && workspaceId ? { 'x-nexus-workspace-id': workspaceId } : {}) },
          body: JSON.stringify({
            intent: opts.intent ?? (opts.targetConnectionId ? 'reconnect' : 'connect'),
            targetConnectionId: opts.targetConnectionId,
            region: opts.region ?? undefined,
          }),
        })
        const data = (await res.json().catch(() => ({}))) as { success?: boolean; authUrl?: string; state?: string; completed?: ConnectedMessage; error?: string }
        if (!res.ok) throw new Error(data.error || `Could not start the ${channelKey} sign-in (HTTP ${res.status})`)
        if (attemptRef.current !== attempt) { popup?.close(); return false }
        if (isConnected(data.completed)) {
          if (data.completed.channelKey !== channelKey || (WORKSPACES_ENABLED && data.completed.workspaceId !== workspaceId)) throw new Error('The connection completed for a different account context. Refresh Channels to review it.')
          popup?.close()
          heardRef.current = true
          attemptRef.current = null
          setConnecting(null)
          latest.current.onConnected(data.completed)
          return true
        }
        if (!data.authUrl) throw new Error(data.error || `Could not start the ${channelKey} sign-in (HTTP ${res.status})`)
        if (!data.state) throw new Error('The sign-in request could not be verified. Please try again.')
        attempt.state = data.state
        authUrl = data.authUrl
      }
      if (popup?.closed) throw new Error('The sign-in window was closed. Select Connect to try again.')
      if (popup && !popup.closed) {
        popup.location.href = authUrl
        // A legacy flow (no callback page of ours) ends when the operator closes
        // the popup; a shared-service flow ends with the message above.
        if (timerRef.current !== null) window.clearInterval(timerRef.current)
        timerRef.current = window.setInterval(() => {
          if (!popup.closed) return
          if (timerRef.current !== null) window.clearInterval(timerRef.current)
          timerRef.current = null
          const attempt = attemptRef.current
          attemptRef.current = null
          if (!heardRef.current && attempt) {
            setConnecting(null)
            latest.current.onClosedWithoutMessage?.(attempt)
          }
        }, 500)
      } else {
        // Popup blocked: the callback returns this tab to the selected profile.
        window.location.href = authUrl
      }
      return true
    } catch (err) {
      popup?.close()
      attemptRef.current = null
      setConnecting(null)
      setError(err instanceof Error ? err.message : 'Connection failed')
      return false
    }
  }, [])

  return { start, connecting, error, clearError: () => setError(null) }
}
