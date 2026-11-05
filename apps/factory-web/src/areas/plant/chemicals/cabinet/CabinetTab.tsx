'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { readCabinet } from '../api'
import { chemicalsCan, readProblemOf } from '../model'
import { CabinetTabView, type CabinetTabModel } from './view/CabinetTabView'

/**
 * `/w/<company>/plant/chemicals/cabinet?site=<id>&code=<cabinet>` (SCR-213-cabinet, design plant.chemicals/tab:cabinet
 * "Cabinet sheet (print)": products in that cabinet with pictograms, for the wall; the Print of pop:qr opens it): GET
 * /safety/chemicals/cabinets/:siteId/:code once (safety.view); the QR holds this web's floor address of the cabinet.
 */
export function CabinetTab() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const can = useMemo(() => chemicalsCan(session.permissions), [session.permissions])
  const siteId = params.get('site') ?? ''
  const code = params.get('code') ?? ''
  const [at] = useState(() => new Date().toISOString())
  const [origin, setOrigin] = useState('')
  const [cabinet, setCabinet] = useState<CabinetTabModel['cabinet']>({ value: null, problem: null })
  useEffect(() => setOrigin(window.location.origin), [])

  useEffect(() => {
    if (!can.view) return
    let live = true
    setCabinet({ value: null, problem: null })
    readCabinet(api, siteId, code).then(
      (value) => live && setCabinet({ value, problem: null }),
      (error: unknown) => live && setCabinet({ value: null, problem: readProblemOf(error) }),
    )
    return () => {
      live = false
    }
  }, [api, can.view, siteId, code])

  return <CabinetTabView model={{ canView: can.view, person: session.user.displayName, at, origin, cabinet }} />
}
