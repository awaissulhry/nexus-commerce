'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { useLocale } from '../../../../../lib/i18n/provider'
import { orderPicturePath, orderPictureSaver, pictureReader } from '../../../../../lib/record-picture/api'
import { pictureKindOf, type PictureChoice } from '../../../../../lib/record-picture/order-picture'
import { orderFilesOf, type OrderFilesRead } from '../../../../../lib/record-thread/files-view/model'
import { departmentTilesOf, readOrderBaskets } from '../../../../../lib/production/baskets-board'
import { officeDraftPort } from '../../draft/api'
import type { Order } from '../../api'
import { readWarehouseLegs, restrictOrder } from './api'
import { mayRestrict, textCardOf, type LegFacts, type OrderFlowActions, type OrderFlowModel } from './model'

/** The statuses whose orders may have a leg at our warehouse (S3's warehouse way): the legs are read only then. */
const LEG_STATUSES = new Set<string>(['SHIPPED', 'PARTLY_SHIPPED', 'CLOSED'])
/** The statuses whose orders have baskets on the floor (S5's board). */
const FLOOR_STATUSES = new Set<string>(['IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'])

/** The files of the order that may be its picture: an image or a PDF everybody on the order may see (never body data). */
export function pictureChoicesOf(read: OrderFilesRead | null | undefined): PictureChoice[] {
  if (!read) return []
  return orderFilesOf(read)
    .filter((file) => !file.bodyData && (file.contentType.startsWith('image/') || file.contentType === 'application/pdf'))
    .map((file) => ({ fileId: file.id, name: file.name, kind: pictureKindOf({ type: file.contentType, name: file.name }), small: null }))
}

/**
 * owb-of5 — what the order band and the Overview read beside the order (the container's; the view draws OrderFlowModel only):
 * S3's warehouse legs (It arrived / Send on), the picture's ports (orders.manage changes it: sales and the owner, never the designer),
 * the request the order came from (its subject; "The order as it was written"), S5's baskets per department (the strip), and
 * Restrict on the floor (of1 step 4; the order is read again after it).
 */
export function useOrderFlow(input: { api: ApiClient; order: Order | null; permissions: readonly string[]; files: OrderFilesRead | null | undefined; onReload: () => void }): { model: OrderFlowModel | null; actions: OrderFlowActions } {
  const { api, order, permissions, files, onReload } = input
  const locale = useLocale()
  const orderId = order?.id ?? null
  const status = order?.status ?? null
  const requestId = order?.chain.portalOrder?.id ?? null
  const [legs, setLegs] = useState<LegFacts[] | null>(null)
  const [request, setRequest] = useState<{ subject: string | null; text: OrderFlowModel['text'] } | null>(null)
  const [departments, setDepartments] = useState<OrderFlowModel['departments']>(null)
  const [restrict, setRestrict] = useState<{ busy: boolean; problem: string | null }>({ busy: false, problem: null })

  // S3's legs: only for a reader with shipping.view and an order that left (never asked for a draft or one in production).
  const seesShipping = permissions.includes('shipping.view')
  useEffect(() => {
    if (!orderId || !status || !seesShipping || !LEG_STATUSES.has(status)) return setLegs(null)
    const abort = new AbortController()
    readWarehouseLegs(api, orderId, abort.signal)
      .then(setLegs)
      .catch(() => setLegs(null))
    return () => abort.abort()
  }, [api, orderId, status, seesShipping])

  // The request the order came from: its subject and, for an order that came as text, the words it was written with.
  useEffect(() => {
    if (!requestId) return setRequest(null)
    const abort = new AbortController()
    officeDraftPort(api)
      .read(requestId, abort.signal)
      .then((record) => setRequest({ subject: record.request.subject?.trim() || null, text: textCardOf(record.request) }))
      .catch(() => setRequest(null))
    return () => abort.abort()
  }, [api, requestId])

  // S5's baskets per department (the strip): only while the order is on the floor.
  useEffect(() => {
    if (!orderId || !status || !FLOOR_STATUSES.has(status)) return setDepartments(null)
    const abort = new AbortController()
    readOrderBaskets(api, orderId, abort.signal)
      .then((board) => setDepartments(departmentTilesOf(board, locale)))
      .catch(() => setDepartments(null))
    return () => abort.abort()
  }, [api, orderId, status, locale])

  const manages = permissions.includes('orders.manage')
  const read = useMemo(() => pictureReader(api), [api])
  const save = useMemo(() => (orderId && manages ? orderPictureSaver(api, orderPicturePath('office', 'order', orderId)) : null), [api, orderId, manages])
  const choices = useMemo(() => pictureChoicesOf(files), [files])

  const onRestrict = useCallback(
    (restricted: boolean) => {
      if (!order || restrict.busy) return
      setRestrict({ busy: true, problem: null })
      restrictOrder(api, order.id, { version: order.version, restricted })
        .then(() => {
          setRestrict({ busy: false, problem: null })
          onReload()
        })
        .catch((error: unknown) => setRestrict({ busy: false, problem: isApiError(error) && error.message ? error.message : 'restrict.failed' }))
    },
    [api, order, restrict.busy, onReload],
  )

  if (!order) return { model: null, actions: {} }
  return {
    model: {
      legs,
      picture: { read, save, fileId: order.pictureFileId ?? null, choices },
      restrict: { may: mayRestrict(permissions), now: order.restricted ?? null, busy: restrict.busy, problem: restrict.problem },
      subject: request?.subject ?? null,
      text: request?.text ?? null,
      departments,
    },
    actions: { onPictureSaved: onReload, onRestrict },
  }
}
