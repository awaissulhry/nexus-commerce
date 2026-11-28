'use client'

import { useEffect, useMemo, useState } from 'react'
import { useOfficeApi } from '../../../../../../lib/session/context'
import { OrderPictureWindow } from '../../../../../../lib/record-picture/OrderPictureWindow'
import { isPictureFile, pictureKindOf, type PictureChoice } from '../../../../../../lib/record-picture/order-picture'
import { orderPicturePath, orderPictureSaver } from '../../../../../../lib/record-picture/api'
import type { SheetPictures } from '../../../../../../lib/orders-sheet/pictures'
import { readOrderFiles } from '../../../../../_shared/record-thread/api'
import { officeDraftPort } from '../../../draft/api'
import type { SheetRowRead } from '../api'

/** The files that may be an order's picture: an image or a PDF the customer can open (never office only, never a size sheet). */
export function pictureChoicesOf(files: ReadonlyArray<{ readonly id: string; readonly name: string; readonly contentType: string; readonly audience?: string; readonly locked?: boolean; readonly sheet?: boolean }>): PictureChoice[] {
  return files
    .filter((file) => file.audience !== 'OFFICE_ONLY' && !file.locked && !file.sheet && isPictureFile({ type: file.contentType, name: file.name }))
    .map((file) => ({ fileId: file.id, name: file.name, kind: pictureKindOf({ type: file.contentType, name: file.name }), small: null }))
}

/**
 * owb-of3 step 1 (design § 5zj A) — the picture of a row is the door to the base's ONE window "The picture of the order": a draft and a
 * sent order alike (the request's picture), a confirmed one (the order's). The choices are the order's walled files: an order's
 * Files read (customer-visible images and PDFs), a draft's logos and references (never its measurement sheets). Save is the office
 * door (`orders.manage`); the sheet stays where it is and reads again.
 */
export function SheetPictureWindow({ row, pictures, onClose, onDone }: { row: SheetRowRead; pictures: SheetPictures; onClose: () => void; onDone: (words: string | null) => void }) {
  const api = useOfficeApi()
  const [choices, setChoices] = useState<readonly PictureChoice[]>([])

  useEffect(() => {
    const control = new AbortController()
    const read =
      row.kind === 'ORDER'
        ? readOrderFiles(api, row.id, control.signal).then((answer) => pictureChoicesOf(answer.groups.flatMap((group) => group.files.map((file) => ({ id: file.id, name: file.name, contentType: file.contentType, audience: file.audience })))))
        : officeDraftPort(api)
            .read(row.id, control.signal)
            .then((record) => {
              const files = record.request.files
              const named = [...(files?.logos ?? []), ...(files?.references ?? [])]
              return pictureChoicesOf(named.map((file) => ({ id: file.id, name: file.originalName ?? file.id, contentType: file.contentType, locked: file.locked ?? false })))
            })
    read.then((found) => !control.signal.aborted && setChoices(found)).catch(() => undefined)
    return () => control.abort()
  }, [api, row.id, row.kind])

  const save = useMemo(() => orderPictureSaver(api, orderPicturePath('office', row.kind === 'ORDER' ? 'order' : 'request', row.id)), [api, row.kind, row.id])

  return (
    <OrderPictureWindow
      open
      onClose={onClose}
      number={row.number ?? row.subject ?? ''}
      subject={row.subject}
      record={{ source: pictures.sourceOf({ kind: row.kind }), recordId: row.id, read: pictures.read }}
      now={{ fileId: row.picture?.fileId ?? null, version: row.version }}
      choices={choices}
      save={save}
      onSaved={() => onDone(null)}
    />
  )
}
