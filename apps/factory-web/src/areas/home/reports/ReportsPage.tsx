'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { getLibrary, type Library } from './api'
import { libraryAddressOf, libraryHref, readLastOpened, readProblem, reportHref, reportsCanOf, type LibraryAddress } from './model'
import { LibraryView } from './view/LibraryView'

/**
 * `/w/<company>/home/reports?q=&area=&outside=1` (SCR-104, the library): reads the pack once (GET /reports: every report
 * with what the person may do with it) and keeps the search and the chips in the address. Without home.reports.view the
 * page says so and asks the API nothing.
 */
export function ReportsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/home\/reports\/?$/, '')
  const can = useMemo(() => reportsCanOf(session.permissions), [session.permissions])
  // The search and the chips answer at once (state here) and are kept in the address; an address that changes from
  // outside (back, a link) is taken over, never one this page just wrote (its replace may land after the next keystroke).
  const [address, setAddress] = useState<LibraryAddress>(() => libraryAddressOf(params))
  const written = useRef<Set<string>>(new Set())
  useEffect(() => {
    const fromUrl = libraryAddressOf(params)
    const href = libraryHref('', fromUrl)
    if (written.current.has(href)) {
      written.current.delete(href)
      return
    }
    setAddress(fromUrl)
  }, [params])
  const [library, setLibrary] = useState<{ value: Library | null; problem: string | null }>({ value: null, problem: null })
  const [lastOpened, setLastOpened] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    if (!can.view) return
    try {
      setLibrary({ value: await getLibrary(api), problem: null })
    } catch (error) {
      setLibrary((current) => ({ value: current.value, problem: readProblem(error) }))
    }
  }, [api, can.view])

  useEffect(() => {
    void load()
    setLastOpened(readLastOpened(typeof window === 'undefined' ? null : safeStorage()))
  }, [load])

  return (
    <LibraryView
      model={{ can, prefix, address, library, lastOpened }}
      actions={{
        onAddress: (next: LibraryAddress) => {
          setAddress(next)
          written.current.add(libraryHref('', next))
          router.replace(libraryHref(prefix, next), { scroll: false })
        },
        onRetry: () => void load(),
        onOpen: (key) => router.push(reportHref(prefix, key)),
      }}
    />
  )
}

/** localStorage, or null where the browser refuses it (a private window). */
export function safeStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
