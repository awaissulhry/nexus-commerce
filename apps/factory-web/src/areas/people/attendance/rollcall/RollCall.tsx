'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { useLiveBus } from '../../../../shell/live/use-live'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { readRollCall, readSight, type RollCall as RollCallAnswer } from '../api'
import { attendanceCan, isGateClosed, readProblem } from '../model'
import { RollCallView, type RollCallModel } from './view/RollCallView'

/** Live answers at most this often: each one is a recorded opening. */
const REFRESH_MS = 30_000

/**
 * `/w/<company>/people/attendance/roll-call` (design tab:rollcall, D.Lgs. 81/2008 art. 43): who is in now by name, for an
 * evacuation, on a phone or printed at the assembly point. People.attendance.rollcall; every opening is recorded by the API. Live
 * while online (a clock event reads it again, at most every 30 s); offline the last list stays with its time, in this tab's
 * memory only: names are never stored on the device.
 */
export function RollCall() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const can = useMemo(() => attendanceCan(session.permissions), [session.permissions])
  const siteId = scope.siteId
  const [state, setState] = useState<Pick<RollCallModel, 'gate' | 'list' | 'problem' | 'stale' | 'reading'>>({ gate: 'reading', list: null, problem: null, stale: false, reading: true })
  const last = useRef(0)

  const read = useCallback(async () => {
    if (!can.rollCall || !siteId) return
    last.current = Date.now()
    setState((was) => ({ ...was, reading: true }))
    try {
      const list: RollCallAnswer = await readRollCall(api, siteId)
      setState({ gate: 'open', list, problem: null, stale: false, reading: false })
    } catch (error) {
      if (isGateClosed(error)) setState({ gate: 'closed', list: null, problem: null, stale: false, reading: false })
      else setState((was) => (was.list ? { ...was, stale: true, reading: false } : { ...was, gate: 'open', problem: readProblem(error), reading: false }))
    }
  }, [api, can.rollCall, siteId])

  useEffect(() => {
    if (!can.rollCall) return
    if (!siteId) {
      setState({ gate: 'pickSite', list: null, problem: null, stale: false, reading: false })
      return
    }
    let live = true
    readSight(api, siteId)
      .then((sight) => {
        if (!live) return
        if (sight.open) void read()
        else setState({ gate: 'closed', list: null, problem: null, stale: false, reading: false })
      })
      .catch(() => live && setState({ gate: 'failed', list: null, problem: null, stale: false, reading: false }))
    return () => {
      live = false
    }
  }, [api, can.rollCall, siteId, read])

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useLiveBus(
    {
      onChange: (change) => {
        if (change.type !== 'attendance.clock_event' || timer.current) return
        timer.current = setTimeout(() => {
          timer.current = null
          void read()
        }, Math.max(0, REFRESH_MS - (Date.now() - last.current)))
      },
      onReconnect: () => void read(),
    },
    state.gate === 'open',
  )

  return <RollCallView model={{ allowed: can.rollCall, can, prefix: companyPrefix(session.company?.code ?? ''), site: scope.site?.name ?? '', ...state }} onRefresh={() => void read()} />
}
