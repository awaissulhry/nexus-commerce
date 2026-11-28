'use client'

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { WithMessages } from '../../../../../record-panels/i18n'
import { readProblem, writeProblem } from '../../../../warehouse/shipments/model'
import { printAgain, printSheet, printStartPreview, type SheetCard } from './api'
import { againBodyOf, againCardsOf, againFormOf, againHeldOf, againPagesOf, mayPrintOf, PRINT_NS, toggledIn, type AgainForm, type AgainPage } from './model'
import { PrintSheet } from './sheet/PrintSheet'
import { PrintAgainView, type PrintAgainViewModel } from './view/PrintAgainView'

/**
 * SLOT — owner: S3 (owb-ss4); filled by ss4 step 4.3 (the window "Print again": the same codes, ticked pages and cards, a reason).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Where: Production › Baskets
 * and Place the scan code open it (S2 of6 mounts it); not mounted by the base. Office only: the customer never reaches it.
 *
 * owb-ss4 (settle L7; server Shape owb-ss2): reads the order's pages (the preview, `GET …/print-start`) and its basket cards (the print
 * sheet of its first print, `GET …/print-sheet` — see the notes: the Shape names a printId only), ticks every page and every card (a
 * shipped basket's card is not offered), then ONE `POST /production/orders/:orderId/prints` (its own Idempotency-Key per choice) and opens
 * the print sheet of that print over the page. Nothing starts; the codes stay the same. Right: production.print.start.
 */
export interface PrintAgainWindowProps {
  readonly open: boolean
  readonly onClose: () => void
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The order (SalesOrder id). */
  readonly orderId: string
}

/**
 * owb-ss4 (S5 ask via the S3 lead): the window is built — S5's Baskets board reads this through a namespace import and shows "Print its
 * card and pages again…" only when it is true.
 */
export const PRINT_AGAIN_READY = true

export function PrintAgainWindow(props: PrintAgainWindowProps): ReactElement | null {
  if (!props.open) return null
  return (
    <WithMessages namespaces={PRINT_NS}>
      <Container {...props} />
    </WithMessages>
  )
}

const EMPTY: AgainForm = Object.freeze({ pages: new Set<string>(), cards: new Set<string>(), reason: null, note: '' })

function Container({ open, onClose, orderId }: PrintAgainWindowProps): ReactElement {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const may = useMemo(() => mayPrintOf(session.permissions), [session.permissions])
  const [pages, setPages] = useState<AgainPage[] | null>(null)
  const [cards, setCards] = useState<SheetCard[] | null>(null)
  const [cardsMissing, setCardsMissing] = useState(false)
  const [readFailed, setReadFailed] = useState<string | null>(null)
  const [form, setForm] = useState<AgainForm>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<PrintAgainViewModel['writeProblem']>(null)
  const [printId, setPrintId] = useState<string | null>(null)
  const key = useRef<{ body: string; key: string } | null>(null)

  useEffect(() => {
    let live = true
    printStartPreview(api, orderId)
      .then((preview) => live && setPages(againPagesOf(preview.pages)))
      .catch((error: unknown) => live && setReadFailed(readProblem(error)))
    // The cards: the first print's sheet; a failed read leaves the pages (they still print) and says the cards are not known.
    printSheet(api, orderId, null)
      .then((sheet) => live && setCards(againCardsOf(sheet.cards)))
      .catch(() => {
        if (!live) return
        setCards([])
        setCardsMissing(true)
      })
    return () => {
      live = false
    }
  }, [api, orderId])

  // From the order: every page and every card offered is ticked, once both are read.
  const ticked = useRef(false)
  useEffect(() => {
    if (ticked.current || pages === null || cards === null) return
    ticked.current = true
    setForm(againFormOf(pages, cards))
  }, [pages, cards])

  const held = againHeldOf({ may, form, busy })

  const print = async () => {
    if (held || !pages || !cards) return
    const body = againBodyOf(form, pages, cards)
    if (!body) return
    const text = JSON.stringify(body)
    if (key.current?.body !== text) key.current = { body: text, key: newIdempotencyKey() }
    setBusy(true)
    setProblem(null)
    try {
      const answer = await printAgain(api, orderId, body, key.current.key)
      setPrintId(answer.printId)
    } catch (error) {
      const said = writeProblem(error)
      setProblem({ key: said.key, detail: said.detail ?? null })
    } finally {
      setBusy(false)
    }
  }

  // Printed: the sheet of that print over the page; closing it closes the window.
  if (printId) return <PrintSheet api={api} orderId={orderId} printId={printId} onClose={onClose} />

  const model: PrintAgainViewModel = {
    open,
    state: readFailed ? 'failed' : pages === null || cards === null ? 'reading' : 'ready',
    readProblem: readFailed,
    pages: pages ?? [],
    cards: cards ?? [],
    cardsMissing,
    form,
    held,
    busy,
    writeProblem: problem,
  }
  return (
    <PrintAgainView
      model={model}
      actions={{
        onClose: () => {
          if (!busy) onClose()
        },
        onForm: (next) => {
          setForm(next)
          setProblem(null)
        },
        onTickPage: (pageKey) => setForm((current) => ({ ...current, pages: toggledIn(current.pages, pageKey) })),
        onTickCard: (bundleId) => setForm((current) => ({ ...current, cards: toggledIn(current.cards, bundleId) })),
        onAllCards: (all) => setForm((current) => ({ ...current, cards: new Set(all ? (cards ?? []).map((card) => card.bundleId) : []) })),
        onPrint: () => void print(),
      }}
    />
  )
}
