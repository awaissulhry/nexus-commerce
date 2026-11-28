'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { isApiError } from '../../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { WithMessages } from '../../../../../record-panels/i18n'
import { readProblem, writeProblem } from '../../../../warehouse/shipments/model'
import { fileBytes, listPlacements, printStartPreview, savePlacement, type Placement, type PrintPreview } from './api'
import { mayPrintOf, PRINT_NS } from './model'
import { imageDrawn, pdfPageDrawn, type DrawnPage } from './page-image'
import { isPdfBytes, placeBodyOf, saveHeldOf, savedOf, startPlaceOf, withSaved, type Place, type Said } from './place/model'
import { PlaceScanCodeView, type PlaceScanCodeViewModel } from './place/view/PlaceScanCodeView'
import { PrintAgainWindow } from './PrintAgainWindow'

/**
 * SLOT — owner: S3 (owb-ss4); filled by ss4 step 4.4 (the window "Place the scan code": the page, the code dragged and sized, ≥ 20 mm).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Where: Production › What we
 * make it to and the Design desk open it (S2 of6, of7 mount it); not mounted by the base. Office only: the customer never reaches it.
 *
 * owb-ss4b (design plan § 5f; settle L8; server owb-ss2b): reads the order's design pages (the preview, `GET …/print-start`) and its saved
 * places (`GET …/placements`), draws one page of one piece at a time with its own size in mm (`page-image.ts`, the SAME rule as the print
 * sheet), and saves the place ONE time per press (`PUT …/placements/:salesOrderLineId` with the page's sides and the version of a saved
 * place). "Print this page again…" opens Print again with only that page ticked. Mounted only while open.
 */
export interface PlaceScanCodeWindowProps {
  readonly open: boolean
  readonly onClose: () => void
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The order (SalesOrder id). */
  readonly orderId: string
}

export function PlaceScanCodeWindow(props: PlaceScanCodeWindowProps): ReactElement | null {
  if (!props.open) return null
  return (
    <WithMessages namespaces={PRINT_NS}>
      <Container {...props} />
    </WithMessages>
  )
}

function Container({ open, onClose, companyId, orderId }: PlaceScanCodeWindowProps): ReactElement {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const mayPrint = useMemo(() => mayPrintOf(session.permissions), [session.permissions])
  const [preview, setPreview] = useState<PrintPreview | null>(null)
  const [placements, setPlacements] = useState<Placement[] | null>(null)
  const [readFailed, setReadFailed] = useState<string | null>(null)
  const [pieceIndex, setPieceIndex] = useState(0)
  const [page, setPage] = useState(1)
  const [drawn, setDrawn] = useState<DrawnPage | null>(null)
  const [drawFailed, setDrawFailed] = useState(false)
  const [place, setPlace] = useState<Place | null>(null)
  const [why, setWhy] = useState<Said | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<PlaceScanCodeViewModel['writeProblem']>(null)
  const [savedNow, setSavedNow] = useState(false)
  const [again, setAgain] = useState(false)
  const bytes = useRef(new Map<string, Promise<Uint8Array>>())

  const load = useCallback(() => {
    Promise.all([printStartPreview(api, orderId), listPlacements(api, orderId)])
      .then(([value, rows]) => {
        setPreview(value)
        setPlacements(rows)
      })
      // The pages read is production.print.start's: another reader (a designer on the order) is told so in words.
      .catch((error: unknown) => setReadFailed(isApiError(error) && (error.kind === 'forbidden' || error.kind === 'not_found') ? 'place.notForYou' : readProblem(error)))
  }, [api, orderId])
  useEffect(() => load(), [load])

  const pieces = useMemo(() => (preview?.pages ?? []).flatMap((entry) => (entry.fileId ? [{ salesOrderLineId: entry.salesOrderLineId, label: entry.label, fileId: entry.fileId }] : [])), [preview])
  const piece = pieces[pieceIndex] ?? null
  const saved = piece && placements ? savedOf(placements, piece.salesOrderLineId, piece.fileId, page) : null

  // One page of one piece, drawn with its own size in mm; the square starts at its saved place, else at the usual place.
  const savedRef = useRef(saved)
  savedRef.current = saved
  useEffect(() => {
    if (!piece) return
    let live = true
    setDrawn(null)
    setDrawFailed(false)
    setWhy(null)
    setSavedNow(false)
    const known = bytes.current.get(piece.fileId) ?? fileBytes(api, piece.fileId)
    bytes.current.set(piece.fileId, known)
    known
      .then((data) => {
        if (isPdfBytes(data)) return pdfPageDrawn(data, page, 1400)
        const copy = new Uint8Array(data.byteLength)
        copy.set(data)
        return imageDrawn(URL.createObjectURL(new Blob([copy])))
      })
      .then((value) => {
        if (!live) return
        setDrawn(value)
        setPlace(startPlaceOf(savedRef.current, value))
      })
      .catch(() => {
        if (live) setDrawFailed(true)
      })
    return () => {
      live = false
    }
    // A new piece or page draws again; the saved place is read through its ref (a save does not redraw the page).
  }, [api, piece?.fileId, piece?.salesOrderLineId, page])

  const held = saveHeldOf({ may: true, drawn: drawn !== null, place, saved, busy })

  const save = async () => {
    if (!piece || !drawn || !place || held) return
    setBusy(true)
    setProblem(null)
    try {
      const row = await savePlacement(api, orderId, piece.salesOrderLineId, placeBodyOf({ fileId: piece.fileId, page, place, pageMm: drawn, saved }))
      setPlacements((current) => withSaved(current ?? [], row))
      setSavedNow(true)
      setWhy(null)
    } catch (error) {
      const said = writeProblem(error)
      setProblem({ key: said.key, detail: said.detail ?? null })
      // A place someone moved meanwhile: read the places again (the version moved).
      if (said.reload) listPlacements(api, orderId).then(setPlacements).catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  const model: PlaceScanCodeViewModel = {
    open,
    state: readFailed ? 'failed' : preview === null || placements === null ? 'reading' : pieces.length === 0 ? 'none' : 'ready',
    readProblem: readFailed,
    pieces,
    pieceIndex,
    page,
    pageCount: drawn?.pages ?? 1,
    drawn,
    drawFailed,
    place,
    saved,
    why,
    held,
    busy,
    savedNow,
    writeProblem: problem,
    mayPrintAgain: mayPrint && preview?.state === 'PRINTED',
  }
  return (
    <>
      <PlaceScanCodeView
        model={model}
        actions={{
          onClose: () => {
            if (!busy) onClose()
          },
          onPiece: (index) => {
            setPieceIndex(index)
            setPage(1)
            setProblem(null)
          },
          onPage: (next) => {
            setPage(next)
            setProblem(null)
          },
          onPlace: (next, stopped) => {
            setPlace(next)
            setWhy(stopped)
            setSavedNow(false)
            setProblem(null)
          },
          onSave: () => void save(),
          onPrintAgain: () => setAgain(true),
        }}
      />
      {again && piece ? <PrintAgainWindow open onClose={() => setAgain(false)} companyId={companyId} orderId={orderId} pageOnly={{ salesOrderLineId: piece.salesOrderLineId, page }} /> : null}
    </>
  )
}
