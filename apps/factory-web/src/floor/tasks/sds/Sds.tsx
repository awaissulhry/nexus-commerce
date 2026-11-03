'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import type { SdsPack } from './api'
import { tabletKeeper } from './keep'
import { cabinetCodeFrom } from './view/SdsView'
import { refreshKept } from './refresh'
import { warmPdfReader } from './warm-pdf'
import { SdsView, type SdsModel, type SdsOpenSheet } from './view/SdsView'

/**
 * The live cabinet reader (`/floor/sds?cabinet=<code>`; SCR-213-floor; B-W2b-143; design plant.chemicals "SDS at the cabinet by
 * QR, readable offline on floor devices"): it shows the cabinet from what the tablet keeps at once (refresh.ts, keep.ts), then,
 * online, brings the kept pack and PDFs up to date and shows them again. A sheet opens full screen from its kept bytes, so it
 * reads without network; a sheet the tablet does not hold yet says so. Nothing here is written to the API.
 */
export function FloorSds() {
  const store = useFloor()
  const router = useFloorRouter()
  const params = useSearchParams()
  const { frame, onFrame } = store.frame('tile.sds', { showHome: true })
  const { api, me, online, sessionEnded } = store
  // The cabinet a scan handed over (Scan anything, Home: `openWith`), else the address's (a camera opening the QR's address).
  const [cabinet, setCabinet] = useState<string | null>(() => cabinetCodeFrom(params.get('cabinet')))
  const taken = useRef(false)
  useEffect(() => {
    if (taken.current) return
    taken.current = true
    const code = store.takeScan()
    if (code) setCabinet(cabinetCodeFrom(code))
  }, [store])
  const [pack, setPack] = useState<SdsPack | null>(null)
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set())
  const [state, setState] = useState<SdsModel['state']>('reading')
  const [open, setOpen] = useState<SdsOpenSheet | null>(null)
  const siteId = me?.site.id ?? null

  const showKept = useCallback(async () => {
    if (!siteId) return null
    const keeper = tabletKeeper()
    const [stored, files] = await Promise.all([keeper.pack(siteId), keeper.files()])
    setPack(stored)
    setKept(new Set(files.keys()))
    return stored
  }, [siteId])

  useEffect(() => {
    if (!siteId) return
    let live = true
    void (async () => {
      const stored = await showKept().catch(() => null)
      if (!live) return
      if (!online) return setState(stored ? 'offline' : 'nothingKept')
      void warmPdfReader()
      setState(stored ? 'refreshing' : 'reading')
      try {
        const result = await refreshKept(api, tabletKeeper(), {
          onPack: (fresh) => {
            if (!live) return
            setPack(fresh)
            setState('refreshing')
          },
          onFile: (fileId) => live && setKept((current) => new Set([...current, fileId])),
        })
        if (!live) return
        await showKept()
        setState(result.missing > 0 ? 'partial' : 'fresh')
      } catch (error) {
        if (!live) return
        if (isApiError(error) && error.kind === 'signed_out') return void sessionEnded()
        setState(stored ? 'offline' : 'nothingKept')
      }
    })()
    return () => {
      live = false
    }
  }, [siteId, online, api, showKept, sessionEnded])

  const openSheet = async (sheetId: string, fileId: string, title: string) => {
    setOpen({ sheetId, title, bytes: null, problem: false })
    const file = await tabletKeeper()
      .file(fileId)
      .catch(() => null)
    setOpen(file ? { sheetId, title, bytes: file.bytes, problem: false } : { sheetId, title, bytes: null, problem: true })
  }

  useFloorKeys({ escape: open ? () => setOpen(null) : () => router.push('/floor') })

  if (!me) return null
  return (
    <SdsView
      model={{ frame, cabinet, pack, kept, state, open, readerLanguage: me.worker.locale }}
      onFrame={onFrame}
      onAction={(action) => {
        if (action.type === 'open') return void openSheet(action.sheetId, action.fileId, action.title)
        if (action.type === 'close') return setOpen(null)
        if (action.type === 'cabinet') return setCabinet(action.code)
        if (action.type === 'home') return router.push('/floor')
      }}
    />
  )
}
