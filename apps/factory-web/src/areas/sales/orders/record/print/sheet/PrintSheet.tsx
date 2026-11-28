'use client'

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { ApiClient } from '../../../../../../lib/api/client'
import { readProblem } from '../../../../../warehouse/shipments/model'
import { fileAddress, fileBytes, printSheet, type PrintSheetAnswer } from '../api'
import { imageDrawn, pdfPageDrawn } from '../page-image' // owb-ss4b: the page's own mm size, as Place the scan code reads it
import { cardSheetsOf, qrTextsOf, sheetPagesOf, sheetTitleOf } from './model'
import { PrintSheetView, type PrintSheetViewModel } from './view/PrintSheetView'

/** A picture as it is drawn: its address (a design page: and its size in mm), or failed. */
type Drawn = { readonly src: string; readonly widthMm?: number; readonly heightMm?: number } | { readonly failed: true }

/**
 * owb-ss4 step 4.2 — the print sheet's container: reads `GET /production/orders/:orderId/print-sheet?printId=`, draws each design page
 * (a PDF page with pdf.js, an image file as it is), each QR (`qrcode`, the work order number or the BN code) and each card's picture,
 * puts the sheet full screen over the page (a portal on <body>), and calls `window.print()` once when everything is drawn (Print prints
 * again). Escape or Close leaves it. Never a customer name, never a price: the answer carries neither.
 */
export function PrintSheet({ api, orderId, printId, onClose }: { api: ApiClient; orderId: string; printId: string; onClose: () => void }): ReactElement | null {
  const [answer, setAnswer] = useState<PrintSheetAnswer | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [pictures, setPictures] = useState<ReadonlyMap<string, Drawn>>(new Map())
  const [codes, setCodes] = useState<ReadonlyMap<string, string>>(new Map())
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const printed = useRef(false)

  // The portal's root on <body> (the print rules hide every other child of <body>).
  useEffect(() => {
    const element = document.createElement('div')
    element.className = 'fw-psheet-root'
    document.body.append(element)
    setRoot(element)
    return () => element.remove()
  }, [])

  useEffect(() => {
    let live = true
    printSheet(api, orderId, printId)
      .then((value) => live && setAnswer(value))
      .catch((error: unknown) => live && setProblem(readProblem(error)))
    return () => {
      live = false
    }
  }, [api, orderId, printId])

  // The QR codes, once each (dynamic: the qrcode library only loads with a print).
  useEffect(() => {
    if (!answer) return
    let live = true
    void import('qrcode').then(async ({ toDataURL }) => {
      const pairs = await Promise.all(qrTextsOf(answer).map(async (text): Promise<[string, string] | null> => toDataURL(text, { margin: 0, width: 512, errorCorrectionLevel: 'M' }).then((url): [string, string] => [text, url]).catch(() => null)))
      if (live) setCodes(new Map(pairs.filter((pair): pair is [string, string] => pair !== null)))
    })
    return () => {
      live = false
    }
  }, [answer])

  // The pictures: each design page (a PDF page drawn by pdf.js, an image as it is) and each card's picture.
  const pages = useMemo(() => (answer ? sheetPagesOf(answer) : []), [answer])
  const cardSheets = useMemo(() => (answer ? cardSheetsOf(answer) : []), [answer])
  useEffect(() => {
    if (!answer) return
    let live = true
    const put = (key: string, drawn: Drawn) => live && setPictures((current) => new Map(current).set(key, drawn))
    const bytes = new Map<string, Promise<Uint8Array>>()
    const bytesOf = (fileId: string) => {
      if (!bytes.has(fileId)) bytes.set(fileId, fileBytes(api, fileId))
      return bytes.get(fileId)!
    }
    for (const page of pages) {
      const draw = page.pdf ? bytesOf(page.fileId).then((data) => pdfPageDrawn(data, page.page, 1600)) : fileAddress(api, page.fileId).then((src) => imageDrawn(src))
      draw.then((drawn) => put(page.key, { src: drawn.src, widthMm: drawn.widthMm, heightMm: drawn.heightMm })).catch(() => put(page.key, { failed: true }))
    }
    const pictureIds = [...new Set(cardSheets.flat().flatMap((card) => (card.pictureFileId ? [card.pictureFileId] : [])))]
    for (const fileId of pictureIds) fileAddress(api, fileId).then((src) => put(`picture:${fileId}`, { src })).catch(() => put(`picture:${fileId}`, { failed: true }))
    return () => {
      live = false
    }
  }, [api, answer, pages, cardSheets])

  const pictureIds = [...new Set(cardSheets.flat().flatMap((card) => (card.pictureFileId ? [card.pictureFileId] : [])))]
  const drawing = answer !== null && (pages.some((page) => !pictures.has(page.key)) || pictureIds.some((id) => !pictures.has(`picture:${id}`)) || qrTextsOf(answer).some((text) => !codes.has(text)))

  // Once everything is drawn, the browser's print opens by itself (once); Print opens it again.
  useEffect(() => {
    if (!answer || drawing || printed.current) return
    printed.current = true
    const timer = window.setTimeout(() => window.print(), 300)
    return () => window.clearTimeout(timer)
  }, [answer, drawing])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const srcOf = (key: string): string | null => {
    const drawn = pictures.get(key)
    return drawn && 'src' in drawn ? drawn.src : null
  }
  const pageMmOf = (key: string): { widthMm: number; heightMm: number } | null => {
    const drawn = pictures.get(key)
    return drawn && 'src' in drawn && drawn.widthMm && drawn.heightMm ? { widthMm: drawn.widthMm, heightMm: drawn.heightMm } : null
  }
  const model: PrintSheetViewModel = {
    state: problem ? 'failed' : answer ? 'ready' : 'reading',
    problem,
    title: answer ? sheetTitleOf(answer) : null,
    pages: pages.map((page) => ({ ...page, src: srcOf(page.key), pageMm: pageMmOf(page.key), failed: (pictures.get(page.key) ?? null) !== null && !srcOf(page.key), qrSrc: codes.get(page.qr) ?? null })),
    cardSheets: cardSheets.map((sheet) => sheet.map((card) => ({ ...card, pictureSrc: card.pictureFileId ? srcOf(`picture:${card.pictureFileId}`) : null, qrSrc: codes.get(card.code) ?? null }))),
    drawing,
  }
  if (!root) return null
  return createPortal(<PrintSheetView model={model} actions={{ onPrint: () => window.print(), onClose }} />, root)
}
