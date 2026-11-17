'use client'

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { findStyles, getParty, getStyle } from '../../quotes/api'
import { createManualOrder, nextOrderNumber, previewManualOrder } from '../api'
import { namesOf, newKey, withCells, type DraftLine } from '../daily-model'
// B-W2b-374: a typed line's options.
import { NewLineOptions } from '../../_shared/options-entry/NewLineOptions'
import { abilitiesOf, readProblem, romeToday, writeProblem } from '../model'
import { COMPOSER_EMPTY } from '../record/record-model'
import { draftKey, EMPTY_DRAFT, headerFromAddress, manualBody, parseDraft, sentLines, type NewOrderDraft, type NewOrderModel } from './new-model'
import { NewOrderView } from './view/NewOrderView'
// B-TH-231: the customer's files, held in the page and attached to the new order right after Confirm.
import { completeUpload, requestUpload } from '../../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../../record-panels/store'
import { holdFiles, toAttach, type HeldFile } from './new-files'

/**
 * `/w/<company>/sales/orders/new?company=&party=&contact=&ref=` (B-W2a-50; the New order dialog opens it): reads the
 * customer and the number the order will get, holds the typed lines (this tab's session storage keeps them over a
 * reload), asks the API's price preview a moment after each change (nothing written), and on "Confirm order" makes the
 * order in one command (POST /sales/orders/manual, one Idempotency-Key per confirm) and opens it.
 */
export function NewOrderPage() {
  return (
    <WithMessages namespaces={['orders', 'sales', 'lists']}>
      <NewOrderContainer />
    </WithMessages>
  )
}

const store = {
  read(key: string): string | null {
    try {
      return window.sessionStorage.getItem(key)
    } catch {
      return null
    }
  },
  write(key: string, value: string | null) {
    try {
      if (value === null) window.sessionStorage.removeItem(key)
      else window.sessionStorage.setItem(key, value)
    } catch {
      // A private window or blocked storage: the draft lives on the page only.
    }
  },
}

function NewOrderContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/sales\/orders\/new\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const header = useMemo(() => headerFromAddress(params), [params])
  const [party, setParty] = useState<NewOrderModel['party']>(header ? { status: 'loading' } : { status: 'missing' })
  const [number, setNumber] = useState<string | null | undefined>(undefined)
  const [draft, setDraft] = useState<NewOrderDraft>(EMPTY_DRAFT)
  const [styles, setStyles] = useState<NewOrderModel['styles']>({})
  const [composer, setComposer] = useState(COMPOSER_EMPTY)
  const [preview, setPreview] = useState<NewOrderModel['preview']>({ phase: 'idle', value: null, problem: null })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<NewOrderModel['problem']>(null)
  const restored = useRef(false)
  const searchSeq = useRef(0)
  const previewSeq = useRef(0)
  const confirmKey = useRef<string | null>(null)
  // ---- B-TH-231: the customer's files (the File objects stay here; the page draws the held list)
  const canUpload = session.permissions.includes('files.upload')
  const [held, setHeld] = useState<HeldFile[]>([])
  const heldRef = useRef<HeldFile[]>([])
  heldRef.current = held
  const fileBodies = useRef(new Map<string, File>())
  const [leftOut, setLeftOut] = useState(0)
  const [made, setMade] = useState<{ id: string; number: string; href: string } | null>(null)
  const [attachingNow, setAttachingNow] = useState(false)
  const mark = (key: string, state: HeldFile['state']) => setHeld((now) => now.map((file) => (file.key === key ? { ...file, state } : file)))
  /** Each held file to the made order (office only; a ticked sheet as MEASUREMENTS); true when every one went. */
  const attachTo = async (order: { id: string }, companyId: string): Promise<boolean> => {
    setAttachingNow(true)
    let failed = 0
    for (const file of toAttach(heldRef.current)) {
      const body = fileBodies.current.get(file.key)
      mark(file.key, 'attaching')
      try {
        if (!body) throw new Error('The file is no longer in this page.')
        const bytes = await body.arrayBuffer()
        const announced = await requestUpload(api, {
          companyId,
          record: { type: 'SalesOrder', id: order.id },
          kind: file.kind,
          name: file.name,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
          sha256: await sha256Hex(bytes),
          visibility: ['OFFICE'],
          floorSiteId: null,
          partyId: null,
          ...(file.sheet ? { measurementSheet: true } : {}),
        })
        await putToStore(announced.upload, new Blob([bytes], { type: file.contentType }))
        await completeUpload(api, announced.file.id)
        mark(file.key, 'attached')
      } catch {
        failed += 1
        mark(file.key, 'failed')
      }
    }
    setAttachingNow(false)
    return failed === 0
  }
  // ---- end B-TH-231

  const readStyle = useCallback(
    (styleId: string) =>
      getStyle(api, styleId)
        .then((style) => setStyles((known) => ({ ...known, [styleId]: style })))
        .catch(() => setStyles((known) => ({ ...known, [styleId]: null }))),
    [api],
  )

  const loadHeader = useCallback(() => {
    if (!header) return
    setParty({ status: 'loading' })
    getParty(api, header.partyId)
      .then((value) => setParty({ status: 'ready', value }))
      .catch((error: unknown) => setParty({ status: 'error', problem: readProblem(error) }))
    nextOrderNumber(api, header.companyId)
      .then(setNumber)
      .catch(() => setNumber(null))
  }, [api, header])

  useEffect(() => {
    loadHeader()
  }, [loadHeader])

  // The draft of this company and customer, kept in this tab over a reload.
  useEffect(() => {
    if (!header || restored.current) return
    restored.current = true
    const kept = parseDraft(store.read(draftKey(header)))
    if (!kept) return
    setDraft(kept)
    for (const styleId of new Set(kept.lines.map((line) => line.styleId))) {
      setStyles((known) => ({ ...known, [styleId]: undefined }))
      void readStyle(styleId)
    }
  }, [header, readStyle])
  useEffect(() => {
    if (!header || !restored.current) return
    store.write(draftKey(header), draft.lines.length > 0 || draft.requestedDate || draft.promiseDate || draft.internalNote ? JSON.stringify(draft) : null)
  }, [header, draft])

  // The price preview, a moment after each change (the newest answer wins).
  const runPreview = useCallback(() => {
    if (!header) return
    const mine = ++previewSeq.current
    if (sentLines(draft).length === 0) {
      setPreview({ phase: 'idle', value: null, problem: null })
      return
    }
    setPreview((current) => ({ ...current, phase: 'reading', problem: null }))
    previewManualOrder(api, manualBody(header, draft))
      .then((value) => mine === previewSeq.current && setPreview({ phase: 'ready', value, problem: null }))
      .catch((error: unknown) => mine === previewSeq.current && setPreview({ phase: 'failed', value: null, problem: writeProblem(error).key }))
  }, [api, header, draft])
  useEffect(() => {
    const timer = setTimeout(runPreview, 400)
    return () => clearTimeout(timer)
  }, [runPreview])

  const confirm = async () => {
    if (!header || busy) return
    setBusy(true)
    setProblem(null)
    // One key per confirm attempt of this draft: a repeat after a lost answer is answered from the receipt.
    confirmKey.current ??= newIdempotencyKey()
    try {
      const order = await createManualOrder(api, manualBody(header, draft), confirmKey.current)
      store.write(draftKey(header), null)
      const href = `${prefix}/sales/orders/${order.id}`
      // B-TH-231: the held files go now; when some do not, the order stays made and the page says so (Retry, Open the order).
      if (toAttach(heldRef.current).length > 0) {
        setMade({ id: order.id, number: order.number, href })
        setBusy(false)
        if (!(await attachTo(order, header.companyId))) return
      }
      router.push(href)
    } catch (error) {
      confirmKey.current = null
      setProblem(writeProblem(error))
      setBusy(false)
      runPreview()
    }
  }

  // B-W2b-374 (XF3:02): a typed line takes its options when the order is made (the preview prices them).
  const newLineOptions = (line: DraftLine) =>
    createElement(NewLineOptions, {
      key: line.key,
      api,
      styleId: line.styleId,
      colourwayId: line.colourwayId,
      line: (({ style, colour }) => ({ style, colour }))(namesOf(line, null, styles[line.styleId])),
      picks: line.options ?? [],
      onChange: (picks) => {
        confirmKey.current = null
        setDraft((current) => ({ ...current, lines: current.lines.map((entry) => (entry.key === line.key ? { ...entry, options: picks } : entry)) }))
      },
    })
  // B-TH-231: the fold "Customer files".
  const files: NewOrderModel['files'] = { held, canUpload, leftOut, made: made ? { number: made.number, href: made.href } : null, busy: attachingNow }
  const model: NewOrderModel = { prefix, can, today: romeToday(), header, party, number, draft, styles, composer, preview, busy, problem, newLineOptions, files }

  return (
    <NewOrderView
      model={model}
      actions={{
        onCells: (styleId, next) => {
          confirmKey.current = null
          setDraft((current) => ({ ...current, lines: withCells(current.lines, Object.fromEntries(Object.entries(next).filter(([key]) => current.lines.some((line) => line.key === key && line.styleId === styleId)))) }))
        },
        onPrice: (key, text) => {
          confirmKey.current = null
          setDraft((current) => ({ ...current, lines: current.lines.map((line) => (line.key === key ? { ...line, price: text } : line)) }))
        },
        onField: (field, value) => {
          confirmKey.current = null
          setDraft((current) => ({ ...current, [field]: value }))
        },
        onComposerQuery: (query) => {
          const mine = ++searchSeq.current
          if (query.trim() === '') {
            setComposer((current) => ({ ...current, query: '', results: null, searching: false, problem: null }))
            return
          }
          setComposer((current) => ({ ...current, query, searching: true, problem: null }))
          findStyles(api, query, header?.companyId ?? null)
            .then((results) => mine === searchSeq.current && setComposer((current) => ({ ...current, results, searching: false })))
            .catch((error: unknown) => mine === searchSeq.current && setComposer((current) => ({ ...current, searching: false, problem: readProblem(error) })))
        },
        onComposerPick: (styleId) => {
          if (!styleId) {
            setComposer((current) => ({ ...current, chosen: null, picked: [] }))
            return
          }
          getStyle(api, styleId)
            .then((style) => {
              setStyles((known) => ({ ...known, [styleId]: style }))
              setComposer((current) => ({ ...current, chosen: style, picked: [] }))
            })
            .catch((error: unknown) => setComposer((current) => ({ ...current, problem: readProblem(error) })))
        },
        onComposerToggle: (colourwayId) => setComposer((current) => ({ ...current, picked: current.picked.includes(colourwayId) ? current.picked.filter((id) => id !== colourwayId) : [...current.picked, colourwayId] })),
        onComposerAdd: () => {
          const chosen = composer.chosen
          if (!chosen) return
          setDraft((current) => {
            const have = new Set(current.lines.filter((line) => line.styleId === chosen.id).map((line) => line.colourwayId))
            const added = composer.picked.filter((colourwayId) => !have.has(colourwayId)).map((colourwayId) => ({ key: newKey(chosen.id, colourwayId), lineId: null, styleId: chosen.id, colourwayId, sizes: {}, price: '', locked: false }))
            return { ...current, lines: [...current.lines, ...added] }
          })
          setComposer(COMPOSER_EMPTY)
        },
        onConfirm: () => void confirm(),
        onDiscard: () => {
          if (header) store.write(draftKey(header), null)
          router.push(`${prefix}/sales/orders`)
        },
        onRetry: () => {
          if (party.status !== 'ready') loadHeader()
          else runPreview()
        },
        // ---- B-TH-231: the fold's held files; after Confirm, Retry sends only the ones that did not attach.
        files: {
          onDrop: (dropped) => {
            const base = Date.now()
            const next = holdFiles(heldRef.current, dropped, (index) => `held-${base}-${index}-${dropped[index]!.name}`)
            for (const file of next.held) {
              const body = dropped.find((one, index) => `held-${base}-${index}-${one.name}` === file.key)
              if (body) fileBodies.current.set(file.key, body)
            }
            setHeld(next.held)
            setLeftOut(next.leftOut)
          },
          onSheet: (key, sheet) => setHeld((now) => now.map((file) => (file.key === key ? { ...file, sheet } : file))),
          onRemove: (key) => {
            fileBodies.current.delete(key)
            setHeld((now) => now.filter((file) => file.key !== key))
          },
          onRetry: () => {
            if (!made || !header) return
            void attachTo({ id: made.id }, header.companyId).then((all) => all && router.push(made.href))
          },
          onOpenOrder: () => made && router.push(made.href),
        },
        // ---- end B-TH-231
      }}
    />
  )
}
