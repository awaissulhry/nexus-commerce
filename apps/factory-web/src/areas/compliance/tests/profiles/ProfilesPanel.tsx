'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { csvLine, downloadText, liveMatches, useLive } from '../../../quality/_shared/hooks'
import { failedRead, problemKey, ready, reading, type Notice, type Read } from '../../../quality/_shared/model'
import { writeProblemKey } from '../declarations/model'
import { DEPTH_NAMESPACE } from '../substances/frame/parts'
import type { PageFrame } from '../substances/frame/views'
import { evaluateMaterials, listProfiles, type ProfileList, type ProfileRow } from './api'
import { materialHref, profilesAddressOf, profilesAddressText, profilesCan, profilesCsv, toAsk, type ProfilesAddress } from './model'
import { ProfilesView } from './view/ProfilesView'

const EVENTS = ['compliance_substances.profile_evaluated', 'compliance_material_tests.', 'compliance_substances.rule_changed']

/**
 * `?view=profiles` of Compliance › Tests & substances (B-W2b-267 on B-W2b-256's and B-W2b-250's API): GET
 * /compliance/material-profiles with the address's filters; a row opens the material's Compliance tab (where the profile's
 * evidence, the confirmations and the rule verdicts are); Request declarations opens the Supplier declarations view's dialog
 * with the materials and the kinds they miss; Evaluate again is the evaluator over the chosen materials in ONE command (the
 * screens never set a state). Live: profile evaluations and declaration changes count as "N updates · Show".
 */
export function ProfilesPanel({ frame }: { frame: PageFrame }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const t = useT(DEPTH_NAMESPACE)
  const can = useMemo(() => profilesCan(session.permissions), [session.permissions])
  const address = useMemo(() => profilesAddressOf(params), [params])
  const prefix = pathname.replace(/\/compliance\/tests\/?$/, '')

  const [list, setList] = useState<Read<ProfileList>>(reading())
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const [online, setOnline] = useState(true)
  const turn = useRef(0)

  useEffect(() => {
    const update = () => setOnline(typeof navigator === 'undefined' || navigator.onLine !== false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const go = useCallback((change: Partial<ProfilesAddress>) => router.replace(`${pathname}${profilesAddressText({ ...address, ...change })}`, { scroll: false }), [router, pathname, address])
  const { state, kind, q } = address
  const read = useCallback(async () => {
    if (!can.view) return
    const mine = ++turn.current
    try {
      const value = await listProfiles(api, { state, kind, q })
      if (mine !== turn.current) return
      setList(ready(value))
      setAsOf(value.asOf)
      setUpdates(0)
      setSelected((current) => current.filter((id) => value.profiles.some((row) => row.material.id === id)))
    } catch (error) {
      if (mine === turn.current) setList(failedRead(problemKey(error)))
    }
  }, [api, can.view, state, kind, q])
  useEffect(() => {
    const timer = setTimeout(() => void read(), q ? 250 : 0)
    return () => clearTimeout(timer)
  }, [read, q])
  const readRef = useRef(read)
  readRef.current = read
  const live = useLive(
    (change) => {
      if (can.view && liveMatches(change, EVENTS)) setUpdates((count) => count + 1)
    },
    () => void readRef.current(),
  )

  const evaluate = async (rows: readonly ProfileRow[]) => {
    if (rows.length === 0 || busy) return
    setBusy(true)
    try {
      const answer = await evaluateMaterials(api, rows.map((row) => row.material.id), newIdempotencyKey())
      const changed = answer.profiles.filter((profile) => profile.changed).length
      setNotice({ key: 'done.evaluated', params: { count: answer.profiles.length, changed }, tone: 'success' })
      setSelected([])
      void read()
    } catch (error) {
      setNotice({ key: writeProblemKey('evaluate', error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }
  const askFor = (rows: readonly ProfileRow[]) => {
    const items = rows.map((row) => row.material.id).slice(0, 100)
    const kinds = [...new Set(rows.flatMap(toAsk))]
    const search = new URLSearchParams({ view: 'declarations', ask: '1' })
    if (items.length > 0) search.set('items', items.join(','))
    if (kinds.length > 0) search.set('kinds', kinds.join(','))
    router.push(`${pathname}?${search.toString()}`, { scroll: false })
  }
  const exportRows = (rows: readonly ProfileRow[]) => {
    downloadText(`material-profiles-${new Date().toISOString().slice(0, 10)}.csv`, profilesCsv(rows, t).map(csvLine).join('\r\n'))
    setNotice({ key: 'done.exported', params: { count: rows.length }, tone: 'success' })
  }

  return (
    <ProfilesView
      model={{ prefix, can, online, frame, address, list, asOf, live, updates, selected, notice, busy, keysOpen }}
      actions={{
        onAddress: go,
        onRetry: () => void read(),
        onShowUpdates: () => void read(),
        onSelect: (ids) => setSelected([...ids]),
        onOpen: (row) => router.push(materialHref(prefix, row.material.id)),
        onAsk: askFor,
        onEvaluate: (rows) => void evaluate(rows),
        onExport: exportRows,
        onKeys: setKeysOpen,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
