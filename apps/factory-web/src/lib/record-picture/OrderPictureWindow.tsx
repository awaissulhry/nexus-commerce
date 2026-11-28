'use client'

import { useEffect, useRef, useState } from 'react'
import { isApiError } from '../api/errors'
import type { OrderPictureSaved, SaveOrderPicture } from './api'
import { forgetRecord, type ReadPictures } from './cache'
import type { PictureSource } from './model'
import { isPictureFile, openPictureState, orderPictureViewOf, pickPicture, refusedWith, saveRefusalOf, saveStarted, uploadDone, uploadStarted, type OrderPictureState, type PictureChoice } from './order-picture'
import { OrderPictureWindowView } from './view/OrderPictureWindowView'

/** The upload port a host gives the window: its own upload for this order's files; answers the new file as a choice. */
export type UploadPictureFile = (file: File) => Promise<PictureChoice>

export interface OrderPictureWindowProps {
  readonly open: boolean
  readonly onClose: () => void
  /** The order's number in words ("Your order 12", "SO-2026-0142") and its subject: the window's second line. */
  readonly number: string
  readonly subject?: string | null
  /** The record whose picture this is, as its lists draw it (`source` `order` / `portalOrder` / `customerOrder` …, the host's batch read). */
  readonly record: { readonly source: PictureSource; readonly recordId: string; readonly read?: ReadPictures | null }
  /** The saved picture (null: the design of the first line) and the record's version the save sends back. */
  readonly now: { readonly fileId: string | null; readonly version: number }
  /** The order's files that may be its picture: the host's walled read (an image or a PDF the customer can open). */
  readonly choices: readonly PictureChoice[]
  /** Save: the host's door (`orderPictureSaver(api, orderPicturePath(door, record, id))`). */
  readonly save: SaveOrderPicture
  /** Upload: the host's own upload of an order file; absent: the window offers only the order's files and the design. */
  readonly upload?: UploadPictureFile | null
  /** After a save: the answer (the host refreshes its rows; the window has closed). */
  readonly onSaved?: (saved: OrderPictureSaved) => void
}

/**
 * owb-b4 w4.3 — the window "The picture of the order" with its state: it opens on the saved picture, takes a pick, an upload (the
 * host's port) and a Save (the host's port: `orders.picture.set` through its door — S1 wires the portal's, S2 the office's). A refusal
 * is said in words (409: the picture changed meanwhile, close and open again; 404: out of reach; 422: not an allowed file); a save
 * that worked forgets the record's kept picture (the next mount reads the new one), tells the host and closes. Not a view: it holds
 * state and calls the ports; the view (view/OrderPictureWindowView) draws its model only.
 */
export function OrderPictureWindow({ open, onClose, number, subject = null, record, now, choices, save, upload, onSaved }: OrderPictureWindowProps) {
  const [state, setState] = useState<OrderPictureState>(() => openPictureState(now, choices))
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  // Each opening starts from the saved picture and the host's files.
  useEffect(() => {
    if (open) setState(openPictureState(now, choices))
    // `now` and `choices` are read when the window opens, not on every host render.
  }, [open])

  const onPick = (value: string) => setState((current) => pickPicture(current, value))

  const onFiles = (files: File[]) => {
    const file = files[0]
    if (!file || !upload || state.busy !== 'idle') return
    if (!isPictureFile(file)) return setState((current) => refusedWith(current, 'NOT_ALLOWED'))
    setState(uploadStarted)
    upload(file).then(
      (choice) => live.current && setState((current) => uploadDone(current, choice)),
      () => live.current && setState((current) => refusedWith(current, 'UPLOAD_FAILED')),
    )
  }

  const onSave = () => {
    if (orderPictureViewOf(state).saveHeld) return
    const body = { fileId: state.picked, version: state.now.version }
    setState(saveStarted)
    save(body).then(
      (saved) => {
        forgetRecord(record.source, record.recordId)
        if (!live.current) return
        setState((current) => ({ ...current, busy: 'idle', now: { fileId: saved.pictureFileId, version: saved.version } }))
        onSaved?.(saved)
        onClose()
      },
      (error: unknown) => live.current && setState((current) => refusedWith(current, saveRefusalOf(isApiError(error) ? error.kind : null))),
    )
  }

  const close = () => {
    if (state.busy === 'saving') return
    onClose()
  }

  return <OrderPictureWindowView model={{ open, number, subject, record, view: orderPictureViewOf(state), canUpload: !!upload }} actions={{ onClose: close, onPick, onFiles, onSave }} />
}
