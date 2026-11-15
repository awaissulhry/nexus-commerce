'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useCoalesced, useLive } from '../hooks'
import { failed, LOADING, ready, words, writeWords, type Words } from '../queue/shared/depth'
import { dispatchAbilitiesOf } from '../pickup/dispatch'
import { confirmExit, listBrokers, makeCommercialInvoice, makePostalForm, nameInvoice, openDeclaration, packLink, packPdf, readExport, readPack, recordMrn, removeDeclaration, uploadExitProof } from './api'
import { BROKER_PACK_REFUSALS, CUSTOMS_REFUSALS, dialogProblem, type ExportDialog, type ExportPapersModel } from './model'
import { ExportPapersView } from './view/ExportPapersView'

const REFUSALS = [...CUSTOMS_REFUSALS, ...BROKER_PACK_REFUSALS, 'CUSTOMS']

/**
 * The Export tab's papers of one shipment (SCR-653; B-W2b-412 on B-W2b-409): reads `GET …/export` (again on customs.* events
 * of the shipment and after each write), and makes each write ONE call with its own Idempotency-Key — the commercial invoice,
 * a CN 22 / CN 23, the declaration (with the company's brokers read when the person may list parties), its MRN, its invoice,
 * the proof of exit (the file uploaded on the declaration first), the removal; the broker's pack (`…/pack`, the merged PDF, a
 * link). A refusal is said in words from its code.
 */
export function ExportPapers({ shipmentId, companyId, prefix }: { shipmentId: string; companyId: string; prefix: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => dispatchAbilitiesOf(session.permissions), [session.permissions])
  const [model, setModel] = useState<ExportPapersModel>({ read: LOADING, can, dialog: null, busy: false, problem: null, done: null, brokers: null, pack: null, packPdf: null, passOn: null, prefix })
  const latest = useRef(model)
  latest.current = model
  const key = useRef<string | null>(null)
  const keyOf = () => (key.current ??= newIdempotencyKey())

  const load = useCallback(
    async (quiet: boolean) => {
      if (!shipmentId) return
      if (!quiet) setModel((state) => ({ ...state, read: state.read.state === 'ready' ? state.read : LOADING }))
      try {
        const value = await readExport(api, shipmentId)
        setModel((state) => ({ ...state, read: ready(value) }))
      } catch (error) {
        setModel((state) => (quiet && state.read.state === 'ready' ? state : { ...state, read: failed(error) }))
      }
    },
    [api, shipmentId],
  )
  useEffect(() => {
    void load(false)
  }, [load])

  const loadPack = useCallback(
    async (origin: readonly string[]) => {
      setModel((state) => ({ ...state, pack: state.pack?.state === 'ready' ? state.pack : LOADING }))
      try {
        const value = await readPack(api, shipmentId, origin)
        setModel((state) => ({ ...state, pack: ready(value) }))
      } catch (error) {
        setModel((state) => ({ ...state, pack: failed(error) }))
      }
    },
    [api, shipmentId],
  )

  const reread = useCoalesced(() => void load(true), 900)
  useLive(
    (change) => {
      if (change.type.startsWith('customs.') && Object.values(change.fields).includes(shipmentId)) reread()
    },
    () => reread(),
  )

  const fail = (error: unknown) => {
    const problem = writeWords(error, 'export.refusal', REFUSALS)
    setModel((state) => ({ ...state, busy: false, problem: { key: problem.key, params: problem.params } }))
    if (problem.reload) void load(true)
  }
  const succeed = (done: Words, keepDialog = false) => {
    key.current = null
    setModel((state) => ({ ...state, busy: false, problem: null, done, dialog: keepDialog ? state.dialog : null }))
    void load(true)
  }

  const go = async () => {
    const state = latest.current
    const dialog = state.dialog
    if (!dialog || state.busy || state.read.state !== 'ready') return
    const read = state.read.value
    if (dialogProblem(dialog, read)) return
    const declaration = read.declaration
    setModel({ ...state, busy: true, problem: null })
    try {
      switch (dialog.kind) {
        case 'invoice': {
          const document = await makeCommercialInvoice(api, shipmentId, { ...(dialog.language ? { language: dialog.language } : {}), reason: dialog.reason, ...(dialog.reason === 'OTHER' ? { reasonText: dialog.reasonText.trim() } : {}), ...(dialog.notes.trim() ? { notes: dialog.notes.trim() } : {}) }, keyOf())
          return succeed(words(document.made ? 'export.done.invoice' : 'export.done.invoiceSame', { version: document.version }))
        }
        case 'postal': {
          const document = await makePostalForm(api, shipmentId, { form: dialog.form, ...(dialog.language ? { language: dialog.language } : {}), reason: dialog.reason, ...(dialog.reason === 'OTHER' ? { reasonText: dialog.reasonText.trim() } : {}), ...(dialog.comments.trim() ? { comments: dialog.comments.trim() } : {}) }, keyOf())
          return succeed(words(document.made ? 'export.done.postal' : 'export.done.postalSame', { form: document.kind === 'CN22' ? 'CN 22' : 'CN 23', version: document.version }))
        }
        case 'declaration':
          await openDeclaration(api, shipmentId, { brokerPartyId: dialog.brokerPartyId || null, alertAfterDays: dialog.alertAfterDays }, keyOf())
          return succeed(words(dialog.brokerPartyId ? 'export.done.openedBroker' : 'export.done.openedCarrier'))
        case 'mrn':
          if (!declaration) return
          await recordMrn(api, shipmentId, { mrn: dialog.mrn.trim().toUpperCase(), version: declaration.version }, keyOf())
          return succeed(words('export.done.mrn'))
        case 'nameInvoice':
          if (!declaration) return
          await nameInvoice(api, shipmentId, { invoiceId: dialog.invoiceId, version: declaration.version }, keyOf())
          return succeed(words('export.done.invoiceNamed'))
        case 'exit': {
          if (!declaration || !dialog.file) return
          const fileId = await uploadExitProof(api, { id: declaration.id, companyId }, dialog.file)
          await confirmExit(api, shipmentId, { exitConfirmedAt: new Date(dialog.at).toISOString(), fileId, version: declaration.version }, keyOf())
          return succeed(words('export.done.exit'))
        }
        case 'remove': {
          if (!declaration) return
          const removed = await removeDeclaration(api, shipmentId, { version: declaration.version, reason: dialog.reason.trim() }, keyOf())
          return succeed(words('export.done.removed', { count: removed.linksRevoked }))
        }
        case 'pack':
          return
      }
    } catch (error) {
      fail(error)
    }
  }

  return (
    <ExportPapersView
      model={model}
      actions={{
        onRetry: () => {
          const state = latest.current
          if (state.dialog?.kind === 'pack') void loadPack(state.dialog.origin)
          else void load(false)
        },
        onDismiss: () => setModel((state) => ({ ...state, done: null })),
        onDialog: (dialog: ExportDialog) => {
          const state = latest.current
          if (state.busy) return
          key.current = null
          setModel({ ...state, dialog, problem: null, ...(dialog ? {} : { pack: null, packPdf: null, passOn: null }) })
          if (dialog?.kind === 'declaration' && can.viewParties && !state.brokers) {
            setModel((current) => ({ ...current, brokers: LOADING }))
            listBrokers(api, companyId).then(
              (value) => setModel((current) => ({ ...current, brokers: ready(value) })),
              (error: unknown) => setModel((current) => ({ ...current, brokers: failed(error) })),
            )
          }
          if (dialog?.kind === 'pack') {
            const before = state.dialog?.kind === 'pack' ? state.dialog.origin.join(',') : null
            if (before !== dialog.origin.join(',')) void loadPack(dialog.origin)
          }
        },
        onGo: () => void go(),
        onPackPdf: (open) => {
          const state = latest.current
          if (!open) return setModel({ ...state, packPdf: null })
          const origin = state.dialog?.kind === 'pack' ? state.dialog.origin : []
          setModel({ ...state, packPdf: LOADING })
          packPdf(api, shipmentId, origin).then(
            (bytes) => setModel((current) => ({ ...current, packPdf: current.packPdf ? ready(bytes) : null })),
            (error: unknown) => setModel((current) => ({ ...current, packPdf: current.packPdf ? failed(error) : null })),
          )
        },
        onPackLink: (send) => {
          const state = latest.current
          if (state.busy || state.dialog?.kind !== 'pack') return
          setModel({ ...state, busy: true, problem: null, passOn: null })
          packLink(api, shipmentId, { originFileIds: [...state.dialog.origin], send }, keyOf())
            .then((answer) => {
              key.current = null
              setModel((current) => ({ ...current, busy: false, passOn: answer.url, done: words(send ? 'export.done.packSent' : 'export.done.packLink'), dialog: send ? null : current.dialog }))
              void load(true)
            })
            .catch(fail)
        },
      }}
    />
  )
}
