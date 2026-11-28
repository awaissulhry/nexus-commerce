'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { useLocale } from '../../../../../lib/i18n/provider'
import { orderPicturePath, orderPictureSaver, pictureReader } from '../../../../../lib/record-picture/api'
import { pictureKindOf, type PictureChoice } from '../../../../../lib/record-picture/order-picture'
import { orderFilesOf, type OrderFilesRead } from '../../../../../lib/record-thread/files-view/model'
import { basketsOf, departmentTilesOf, readOrderBaskets } from '../../../../../lib/production/baskets-board'
import { orderLogPath, orderLogReader } from '../../../../../lib/change-log/api'
import { askApproval, readRecordRequests } from '../../../../../record-panels/approvals/api' // owb-of7: the design's approval
import type { Locale } from '../../../../../lib/i18n/locales'
import { flowWordsFor } from '../flow-words'
import { romeToday } from '../../model'
import { officeDraftPort } from '../../draft/api'
import type { Order } from '../../api'
import { answerPaymentNotice, downloadOrderZip, readPaymentNotices, readWarehouseLegs, restrictOrder, type PaymentNotice } from './api'
import { designDueOf, designStateOf, maySendDesign, mayRestrict, textCardOf, type DesignState, type LegFacts, type OrderFlowActions, type OrderFlowModel } from './model'

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
  const [baskets, setBaskets] = useState<OrderFlowModel['baskets']>(null) // owb-of6
  const [notices, setNotices] = useState<PaymentNotice[] | null>(null) // owb-of6
  const [noticeAct, setNoticeAct] = useState<{ busy: string | null; problem: string | null }>({ busy: null, problem: null })
  const [zip, setZip] = useState<OrderFlowModel['zip']>({ busy: false, leftOut: null, problem: null })
  const [restrict, setRestrict] = useState<{ busy: boolean; problem: string | null }>({ busy: false, problem: null })
  const [design, setDesign] = useState<{ state: DesignState | null; busy: boolean; problem: string | null }>({ state: null, busy: false, problem: null }) // owb-of7

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
      .then((board) => {
        setDepartments(departmentTilesOf(board, locale))
        setBaskets(basketsOf(board, locale)) // owb-of6 (L8): the Baskets rows switch to S5's read once it answers
      })
      .catch(() => {
        setDepartments(null)
        setBaskets(null)
      })
    return () => abort.abort()
  }, [api, orderId, status, locale])

  // ---- owb-of6 step 3: the customer's "I paid" notices (of1; before it lands the read fails and nothing is shown) ----
  const readNotices = useCallback(
    (id: string, signal?: AbortSignal) =>
      readPaymentNotices(api, id, signal)
        .then(setNotices)
        .catch(() => setNotices(null)),
    [api],
  )
  useEffect(() => {
    if (!orderId) return setNotices(null)
    const abort = new AbortController()
    void readNotices(orderId, abort.signal)
    return () => abort.abort()
  }, [orderId, readNotices])
  const onNotice = useCallback(
    (noticeId: string, state: 'RECORDED' | 'DISMISSED') => {
      const notice = notices?.find((row) => row.id === noticeId)
      if (!orderId || !notice || noticeAct.busy) return
      setNoticeAct({ busy: noticeId, problem: null })
      answerPaymentNotice(api, orderId, noticeId, { version: notice.version, state })
        .then(() => {
          setNoticeAct({ busy: null, problem: null })
          void readNotices(orderId)
        })
        .catch((error: unknown) => setNoticeAct({ busy: null, problem: isApiError(error) && error.message ? error.message : 'notices.failed' }))
    },
    [api, orderId, notices, noticeAct.busy, readNotices],
  )

  // ---- owb-of6 step 4: Download all — ONE zip (of1 step 5), saved as "<number> files.zip"; the left-out count said under it ----
  const number = order?.number ?? null
  const onZip = useCallback(() => {
    if (!orderId || zip.busy) return
    setZip({ busy: true, leftOut: null, problem: null })
    downloadOrderZip(api, orderId)
      .then(({ bytes, leftOut }) => {
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }))
        const link = document.createElement('a')
        link.href = url
        link.download = `${number ?? 'order'} files.zip`
        document.body.appendChild(link)
        link.click()
        link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
        setZip({ busy: false, leftOut, problem: null })
      })
      .catch((error: unknown) => setZip({ busy: false, leftOut: null, problem: isApiError(error) && error.message ? error.message : 'zip.failed' }))
  }, [api, orderId, number, zip.busy])
  const log = useMemo(() => (orderId ? orderLogReader(api, orderLogPath('office', 'order', orderId)) : null), [api, orderId])
  // ---- end owb-of6

  // ---- owb-of7 step 2: the design's approval — its state (the order's ARTWORK / PROOF requests, partners.approvals.view) and the send ----
  const seesApprovals = permissions.includes('partners.approvals.view')
  const readDesign = useCallback(
    (id: string, signal?: AbortSignal) =>
      readRecordRequests(api, { type: 'SalesOrder', id }, signal)
        .then((answer) => setDesign((now) => ({ ...now, state: designStateOf(answer.requests) })))
        .catch(() => undefined),
    [api],
  )
  useEffect(() => {
    if (!orderId || !seesApprovals) return
    const abort = new AbortController()
    void readDesign(orderId, abort.signal)
    return () => abort.abort()
  }, [orderId, seesApprovals, readDesign])
  const mayDesign = maySendDesign(permissions)
  const pictureFileId = order?.pictureFileId ?? null
  const language = order?.language === 'en' ? 'en' : 'it'
  const onSendDesign = useCallback(() => {
    if (!orderId || !pictureFileId || design.busy || !mayDesign) return
    setDesign((now) => ({ ...now, busy: true, problem: null }))
    const say = flowWordsFor(language as Locale, 'outside')
    askApproval(api, { kind: 'ARTWORK', recordType: 'SalesOrder', recordId: orderId, question: say('design.question', { number: number ?? '' }), dueAt: designDueOf(romeToday()), fileIds: [pictureFileId], send: true, language })
      .then(() => {
        setDesign((now) => ({ ...now, busy: false, state: 'WAITS' }))
        void readDesign(orderId)
      })
      .catch((error: unknown) => setDesign((now) => ({ ...now, busy: false, problem: isApiError(error) && error.message ? error.message : 'design.failed' })))
  }, [api, orderId, pictureFileId, design.busy, mayDesign, language, number, readDesign])
  // ---- end owb-of7

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
      baskets,
      log,
      notices: { rows: notices, busy: noticeAct.busy, problem: noticeAct.problem, may: permissions.includes('payments.record') },
      zip,
      design: { state: design.state, may: mayDesign, held: !pictureFileId ? 'design.noPicture' : design.state === 'WAITS' ? 'design.waits' : null, busy: design.busy, problem: design.problem },
    },
    actions: { onPictureSaved: onReload, onRestrict, onNotice, onZip, onSendDesign },
  }
}
