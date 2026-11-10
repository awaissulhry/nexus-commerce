'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { readPack, readParties, readShipments, requestPack, type Pack, type PartyOption, type ShipmentOption } from './api'
import { emptyPack, failed, packBody, packProblems, problemOf, ready, refusalDetail, type PackDraft, type Read, type TechfilesCan } from './model'
import type { PackDialogModel } from './view/PackDialog'

/** The file a pack is built from, as the pop-up names it. */
export interface PackTarget {
  id: string
  number: string
  style: { code: string; name: string }
  /** The newest batch's number: the pop-up's scope starts there when there is one. */
  latestBatch: string | null
}

const POLL_MS = 3000

/**
 * Build evidence pack (pop:tf-pack) for the list and the record alike: the draft, the parties and shipments it may name (each
 * read only with its right), the request (one Idempotency-Key per open pop-up), then the pack followed until it is built — by a
 * read every few seconds and at once on a live `technical_file.pack_changed` (`onLive`). The pop-up may be closed: the build goes
 * on and the Evidence pack tab shows it.
 */
export function usePackDialog({ api, can, language, online, onBuilt }: { api: ApiClient; can: TechfilesCan; language: string; online: boolean; onBuilt?: (pack: Pack) => void }) {
  const [target, setTarget] = useState<PackTarget | null>(null)
  const [draft, setDraft] = useState<PackDraft>(() => emptyPack(language))
  const [parties, setParties] = useState<Read<PartyOption[]> | null>(null)
  const [shipments, setShipments] = useState<Read<ShipmentOption[]> | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<PackDialogModel['problem']>(null)
  const [pack, setPack] = useState<Pack | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const key = useRef<string>(newIdempotencyKey())
  const built = useRef(onBuilt)
  built.current = onBuilt

  const open = useCallback(
    (next: PackTarget) => {
      setTarget(next)
      setDraft(emptyPack(language, next.latestBatch))
      setProblem(null)
      setPack(null)
      setStartedAt(null)
      setBusy(false)
      key.current = newIdempotencyKey()
    },
    [language],
  )
  const close = useCallback(() => setTarget(null), [])

  const findParties = useCallback(
    (q: string) => {
      if (!can.parties) return setParties(null)
      setParties((current) => (current?.status === 'ready' ? current : { status: 'loading' }))
      readParties(api, q).then(
        (value) => setParties(ready(value)),
        (error) => setParties(failed(problemOf(error))),
      )
    },
    [api, can.parties],
  )
  const findShipments = useCallback(
    (q: string) => {
      if (!can.shipping) return setShipments(null)
      setShipments((current) => (current?.status === 'ready' ? current : { status: 'loading' }))
      readShipments(api, q).then(
        (value) => setShipments(ready(value)),
        (error) => setShipments(failed(problemOf(error))),
      )
    },
    [api, can.shipping],
  )

  // The recipients and shipments are read once the pop-up opens (each with its own right).
  useEffect(() => {
    if (!target) return
    findParties('')
    findShipments('')
  }, [target, findParties, findShipments])

  const refresh = useCallback(
    (packId: string) =>
      readPack(api, packId).then(
        (value) => {
          setPack(value)
          if (value.status !== 'BUILDING') built.current?.(value)
        },
        () => undefined,
      ),
    [api],
  )

  // A building pack is read again every few seconds until the worker built it or gave up.
  useEffect(() => {
    if (!pack || pack.status !== 'BUILDING') return
    const timer = window.setInterval(() => void refresh(pack.id), POLL_MS)
    return () => window.clearInterval(timer)
  }, [pack, refresh])

  const build = useCallback(() => {
    if (!target || busy || packProblems(draft).length > 0) return
    setBusy(true)
    setProblem(null)
    requestPack(api, target.id, packBody(draft), key.current).then(
      (value) => {
        setBusy(false)
        setPack(value)
        setStartedAt(Date.now())
      },
      (error) => {
        setBusy(false)
        setProblem({ tone: 'danger', key: error && problemOf(error) === 'problem.invalid' ? 'pack.refused' : problemOf(error), detail: refusalDetail(error) })
      },
    )
  }, [api, busy, draft, target])

  const model: PackDialogModel | null = target
    ? {
        file: { id: target.id, number: target.number, style: target.style },
        draft,
        parties,
        shipments,
        busy,
        problem,
        pack,
        startedAt,
        online,
        held: can.manage ? null : 'held.manage',
      }
    : null

  return {
    model,
    open,
    close,
    /** A live `technical_file.pack_changed`: the pack in the pop-up is read at once. */
    onLive: (packId: string) => {
      if (pack && pack.id === packId) void refresh(packId)
    },
    actions: {
      onDraft: setDraft,
      onPartyQuery: findParties,
      onShipmentQuery: findShipments,
      onBuild: build,
      onClose: close,
    },
  }
}
