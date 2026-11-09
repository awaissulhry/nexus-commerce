'use client'

import { useEffect, useState } from 'react'
import { usePortalLive } from '../../shell/frame'

/**
 * The containers' small browser helpers (B-W2b-197): whether the page is offline (the browser says so, or the tab's one
 * live channel lost its stream: design offline "No connection — showing what was loaded at 10:42"), a file saved from the
 * page (the CSV of the selected cases, built in the browser; nothing is sent anywhere) and a tab opened before an answer
 * (so no pop-up blocker stops a PDF that comes later).
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

/** Opens an address in a new tab from an answer that comes later (the tab is opened first). */
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
