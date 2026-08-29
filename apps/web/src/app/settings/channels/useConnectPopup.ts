'use client'

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

export interface ConnectedMessage {
  type: 'nexus:channel-connected'
  channel: string
  channelKey?: string
  connectionId?: string
  sellerName?: string
  placement?: 'new' | 'reconsent' | 'adopt' | string
  scopeDrift?: string[]
}

export type ConnectIntent = 'connect' | 'reconnect' | 'adopt'

export interface StartOptions {
  intent?: ConnectIntent
  targetConnectionId?: string
  region?: string | null
  /** Point the popup at this URL instead of the shared start route. */
  url?: string
}

function isConnected(data: unknown): data is ConnectedMessage {
  return !!data && typeof data === 'object' && (data as { type?: string }).type === 'nexus:channel-connected'
}

export function useConnectPopup(onConnected: (m: ConnectedMessage) => void, onClosedWithoutMessage?: () => void) {
  const [connecting, setConnecting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef({ onConnected, onClosedWithoutMessage })
  latest.current = { onConnected, onClosedWithoutMessage }
  const popupRef = useRef<Window | null>(null)
  const heardRef = useRef(false)

  useEffect(() => {
    const apiOrigin = (() => {
      try {
        return new URL(getBackendUrl(), window.location.href).origin
      } catch {
        return null
      }
    })()
    const handle = (data: unknown): boolean => {
      if (!isConnected(data)) return false
      heardRef.current = true
      setConnecting(null)
      latest.current.onConnected(data)
      return true
    }
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin && e.origin !== apiOrigin) return
      if (handle(e.data)) {
        try {
          ;(e.source as Window | null)?.postMessage({ type: 'nexus:ack' }, e.origin)
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
        if (handle(e.data)) bc?.postMessage({ type: 'nexus:ack' })
      }
    } catch {
      /* no BroadcastChannel — the postMessage path above still works */
    }
    return () => {
      window.removeEventListener('message', onMessage)
      bc?.close()
    }
  }, [])

  const start = useCallback(async (channelKey: string, opts: StartOptions = {}) => {
    const popup = window.open('', '_blank', 'width=1000,height=800')
    popupRef.current = popup
    heardRef.current = false
    setError(null)
    setConnecting(channelKey)
    try {
      let authUrl = opts.url
      if (!authUrl) {
        const res = await fetch(`${getBackendUrl()}/api/cx/connect/${channelKey.toLowerCase()}/start`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            intent: opts.intent ?? (opts.targetConnectionId ? 'reconnect' : 'connect'),
            targetConnectionId: opts.targetConnectionId,
            region: opts.region ?? undefined,
          }),
        })
        const data = (await res.json().catch(() => ({}))) as { success?: boolean; authUrl?: string; error?: string }
        if (!res.ok || !data.authUrl) throw new Error(data.error || `Could not start the ${channelKey} sign-in (HTTP ${res.status})`)
        authUrl = data.authUrl
      }
      if (popup && !popup.closed) {
        popup.location.href = authUrl
        // A legacy flow (no callback page of ours) ends when the operator closes
        // the popup; a shared-service flow ends with the message above.
        const timer = window.setInterval(() => {
          if (!popup.closed) return
          window.clearInterval(timer)
          if (!heardRef.current) {
            setConnecting(null)
            latest.current.onClosedWithoutMessage?.()
          }
        }, 500)
      } else {
        // Blocked or already closed — fall back to this tab rather than doing nothing.
        window.location.href = authUrl
      }
    } catch (err) {
      popup?.close()
      setConnecting(null)
      setError(err instanceof Error ? err.message : 'Connection failed')
    }
  }, [])

  return { start, connecting, error, clearError: () => setError(null) }
}
