'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLiveBus } from '../../../shell/live/use-live'
import type { LiveChange } from '../../../record-panels/model'
import type { LiveState, RecordTab } from './model'

/** The tab a record page shows (`?tab=`), one of its tabs, else the first. */
export function useRecordTab(tabs: readonly RecordTab[]): RecordTab {
  const params = useSearchParams()
  const asked = params?.get('tab')
  return (tabs as readonly string[]).includes(asked ?? '') ? (asked as RecordTab) : tabs[0]!
}

const WIDE = '(min-width: 1280px)'

/**
 * Owner O1: the record's thread beside any tab on a wide screen, remembered per record side on this device (a
 * per-viewer convenience: localStorage, read and written with try/catch); narrower, the same button opens Activity.
 */
export function useThreadDock(key: string, activityTab = 'activity') {
  const router = useRouter()
  const pathname = usePathname()
  const storageKey = `fw.parties.dock.${key}`
  const [open, setOpen] = useState(false)
  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem(storageKey) === '1' && window.matchMedia(WIDE).matches)
    } catch {
      setOpen(false)
    }
  }, [storageKey])
  const toggle = useCallback(() => {
    let wide = false
    try {
      wide = window.matchMedia(WIDE).matches
    } catch {
      wide = false
    }
    if (!wide) {
      router.push(`${pathname}?tab=${activityTab}`)
      return
    }
    setOpen((current) => {
      const next = !current
      try {
        window.localStorage.setItem(storageKey, next ? '1' : '0')
      } catch {
        // Not kept on this device; the dock still toggles.
      }
      return next
    })
  }, [activityTab, storageKey, pathname, router])
  return { dockOpen: open, toggleDock: toggle }
}

/**
 * The live stream (`GET /live` through this app's `/api`, the parties' events: party.created, party.updated,
 * party.status_changed, party.addresses_changed, party.contacts_changed, party.tax_identity_changed, party.vies_checked)
 * with its state in words: connecting, live, offline (the browser's EventSource reconnects by itself; after a break the
 * screen reads everything again). A message is a hint: the screen reads the part again.
 */
export function useLive(onChange: (change: LiveChange) => void, onReconnect: () => void): LiveState {
  // B-W2b-05: the tab's ONE live connection (shell/live/bus.ts), shared with the bell and every other screen.
  return useLiveBus({ onChange, onReconnect })
}

/** A parties' event (`party.*`), and the party it is about. */
export function partyEvent(change: LiveChange): { partyId: string | null } | null {
  if (!change.type.startsWith('party.')) return null
  const id = change.fields.partyId
  return { partyId: typeof id === 'string' ? id : null }
}

/** The byte-order mark spreadsheet programs need to read a UTF-8 CSV as UTF-8. */
const BOM = String.fromCharCode(0xfeff)

/** Downloads text as a file (Export ▾ "This view (CSV)"): a Blob link, clicked once. */
export function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([`${BOM}${text}`], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
