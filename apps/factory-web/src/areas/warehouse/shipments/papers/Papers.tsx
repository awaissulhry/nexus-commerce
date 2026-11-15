'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatPublicDocCode, publicDocCodeOf, publicDocPath } from '@nexus/factory-domain/compliance/public-doc/code'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { openPresigned } from '../files'
import { useLive } from '../hooks'
import { failed, LOADING, readWords, ready, touchesShipment, words, writeWords, type DepthAbilities, type Read } from '../queue/shared/depth'
import { fileDownload, makePack, makeProforma, packPdf, readPack, readProformas, readPublicDoc, type Pack, type Proformas } from './api'
import type { PapersActions, PapersModel, PublicDoc } from './model'
import { PapersView } from './view/PapersView'

/**
 * Documents in depth (SCR-596): the pack (`GET|POST …/pack`, `GET …/pack/pdf`; shipping.pack), the proforma (`GET|POST
 * /shipping/proformas`; shipping.proforma.issue + money.price) and each style's public DoC page (its code is pure; whether
 * it shows a declaration today from `GET /compliance/public-doc/address` for a reader with compliance.certificates.view).
 * Read again when the record's version moves, on this shipment's pack / proforma / label events and on reconnect.
 */
export function Papers({ shipment, version, styles, can }: { shipment: { id: string; number: string; status: string }; version: number; styles: readonly { id: string; code: string; name: string }[]; can: DepthAbilities }) {
  const api = useOfficeApi()
  const shipmentId = shipment.id
  const [pack, setPack] = useState<Read<Pack> | null>(can.pack ? LOADING : null)
  const [proformas, setProformas] = useState<Read<Proformas> | null>(can.proforma && can.price ? LOADING : null)
  const [docs, setDocs] = useState<Read<readonly PublicDoc[]>>(LOADING)
  const [rest, setRest] = useState<Pick<PapersModel, 'pdf' | 'dialog' | 'busy' | 'problem' | 'done'>>({ pdf: null, dialog: null, busy: false, problem: null, done: null })
  const latest = useRef(rest)
  latest.current = rest
  const keys = useRef<Record<string, string>>({})
  const styleKey = styles.map((style) => style.id).join(',')

  const loadDocs = useCallback(async () => {
    const origin = typeof window === 'undefined' ? '' : window.location.origin
    const list = styles.map((style): PublicDoc => {
      const code = publicDocCodeOf(style.id)
      return { styleId: style.id, styleCode: style.code, styleName: style.name, code: formatPublicDocCode(code), address: `${origin}${publicDocPath(code)}`, live: null }
    })
    if (!can.certificatesView) return setDocs(ready(list))
    const answers = await Promise.allSettled(list.map((doc) => readPublicDoc(api, doc.styleId)))
    setDocs(ready(list.map((doc, index) => {
      const answer = answers[index]
      return answer?.status === 'fulfilled' ? { ...doc, address: answer.value.address, live: answer.value.live } : doc
    })))
    // `styles` is named by its ids (styleKey).
  }, [api, styleKey, can.certificatesView])

  const load = useCallback(
    async (quiet = false) => {
      if (can.pack) {
        if (!quiet) setPack(LOADING)
        readPack(api, shipmentId)
          .then((value) => setPack(ready(value)))
          .catch((error: unknown) => setPack((state) => (quiet && state?.state === 'ready' ? state : failed(error))))
      }
      if (can.proforma && can.price) {
        if (!quiet) setProformas(LOADING)
        readProformas(api, shipmentId)
          .then((value) => setProformas(ready(value)))
          .catch((error: unknown) => setProformas((state) => (quiet && state?.state === 'ready' ? state : failed(error))))
      }
      void loadDocs()
    },
    [api, shipmentId, can.pack, can.proforma, can.price, loadDocs],
  )

  useEffect(() => {
    void load(true)
  }, [load, version])

  useLive(
    (change) => {
      if ((change.type === 'shipping.pack_made' || change.type === 'shipping.proforma_made' || change.type.startsWith('shipment.label') || change.type.startsWith('ddt.')) && touchesShipment(change, shipmentId)) void load(true)
    },
    () => void load(true),
  )

  const fail = useCallback(
    (error: unknown) => {
      const problem = writeWords(error, 'papers.refusal', [])
      setRest((state) => ({ ...state, busy: false, problem: { key: problem.key, params: problem.params } }))
      if (problem.reload) void load(true)
    },
    [load],
  )

  const openPdf = useCallback(
    (at: number | null) => {
      setRest((state) => ({ ...state, pdf: { version: at, data: null, problem: null } }))
      packPdf(api, shipmentId, at)
        .then((data) => setRest((state) => (state.pdf ? { ...state, pdf: { version: at, data, problem: null } } : state)))
        .catch((error: unknown) => setRest((state) => (state.pdf ? { ...state, pdf: { version: at, data: null, problem: readWords(error) } } : state)))
    },
    [api, shipmentId],
  )

  const actions = useMemo<PapersActions>(
    () => ({
      onRetry: () => void load(),
      onMakePack: (print) => {
        if (latest.current.busy) return
        const name = print ? 'pack:print' : 'pack'
        const key = (keys.current[name] ??= newIdempotencyKey())
        setRest((state) => ({ ...state, busy: true, problem: null, done: null }))
        makePack(api, shipmentId, print, key)
          .then((made) => {
            delete keys.current[name]
            const done = !made.pack.made
              ? words('pack.done.same', { version: made.pack.version })
              : made.job
                ? words('pack.done.printed', { version: made.pack.version, pages: made.pack.pages ?? '—' })
                : made.problem
                  ? words(`pack.done.notPrinted.${made.problem.code}`, { version: made.pack.version })
                  : words('pack.done.made', { version: made.pack.version, pages: made.pack.pages ?? '—' })
            setRest((state) => ({ ...state, busy: false, done }))
            void load(true)
            if (!print) openPdf(made.pack.version)
          })
          .catch(fail)
      },
      onOpenPdf: openPdf,
      onClosePdf: () => setRest((state) => ({ ...state, pdf: null })),
      onDialog: (dialog) => {
        if (dialog) keys.current.proforma = newIdempotencyKey()
        setRest((state) => ({ ...state, dialog, problem: null, done: null }))
      },
      onMakeProforma: () => {
        const state = latest.current
        if (!state.dialog || state.busy) return
        const body = { ...(state.dialog.language ? { language: state.dialog.language } : {}), ...(state.dialog.notes.trim() ? { notes: state.dialog.notes.trim() } : {}) }
        setRest((current) => ({ ...current, busy: true, problem: null }))
        makeProforma(api, shipmentId, body, keys.current.proforma ?? newIdempotencyKey())
          .then((made) => {
            setRest((current) => ({ ...current, busy: false, dialog: null, done: words(made.made ? 'proforma.done.made' : 'proforma.done.same', { number: made.number, version: made.version }) }))
            void load(true)
          })
          .catch(fail)
      },
      onOpenProforma: (fileId) => {
        fileDownload(api, fileId)
          .then(openPresigned)
          .catch(fail)
      },
      onCopy: (address) => {
        void navigator.clipboard
          ?.writeText(address)
          .then(() => setRest((state) => ({ ...state, done: words('publicDoc.copied') })))
          .catch(() => setRest((state) => ({ ...state, problem: words('publicDoc.copyFailed', { address }) })))
      },
    }),
    [api, shipmentId, load, fail, openPdf],
  )

  return <PapersView model={{ number: shipment.number, status: shipment.status, pack, proformas, docs, can: { pack: can.pack, printDocuments: can.printDocuments, readFiles: can.readFiles, proforma: can.proforma, price: can.price }, ...rest }} actions={actions} />
}
