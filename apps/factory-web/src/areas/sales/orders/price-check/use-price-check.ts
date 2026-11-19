'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLocale } from '../../../../lib/i18n/provider'
import type { Locale } from '../../../../lib/i18n/locales'
import { readProblem, type Phrase } from '../model'
import { readOrderFiles, readPriceCheck, saveBrandPrices, type OfficeSource, type PriceCheck } from './api'
import { draftOf, pricePlanOf, saveRefusalOf, type LineDraft, type PriceDraft } from './model'

/**
 * F-CP-114 (customer page plan C2d, C3; review A3; lead pick "one editor, two doors") — the container of the ONE customer's-price
 * editor: `open(order)` reads the order's price check once (the command-door pattern: the window draws what that read says) and its
 * files for "PO file"; Save sends the changed rows at the versions read (one Idempotency-Key per body); a 409 reads the check again
 * and says "Someone changed these prices meanwhile. Here they are now."; a save closes the window and hands the check to the door
 * (`onSaved`: the sheet's row takes the new figures in place). The Work tab's sheet mounts it now; the order page's Money tab mounts
 * the SAME hook and dialog later (F-CP-142). Only a price holder gets a door (the API answers 403 to anyone else anyway).
 */

export type PriceRead = { readonly status: 'reading' } | { readonly status: 'ready'; readonly check: PriceCheck } | { readonly status: 'failed'; readonly problem: string }
export type FilesRead = { readonly status: 'reading' } | { readonly status: 'ready'; readonly files: readonly { readonly id: string; readonly name: string }[] } | { readonly status: 'failed' }

export interface PriceCheckDialogModel {
  readonly orderId: string
  /** The order's number from the door (the window's title before the read). */
  readonly number: string
  readonly read: PriceRead
  readonly files: FilesRead
  /** What is typed (null until the check is read). */
  readonly draft: PriceDraft | null
  readonly busy: boolean
  /** ONE banner: "Here they are now" after a 409, or a refused save in words. */
  readonly notice: { readonly tone: 'warning' | 'danger'; readonly words: Phrase } | null
  /** A refusal at its field (a line's id, `total`, `file`). */
  readonly fields: Readonly<Record<string, Phrase>>
}

export interface PriceCheckDialogActions {
  onLine?: (lineId: string, patch: Partial<LineDraft>) => void
  onTotal?: (text: string) => void
  onSource?: (source: OfficeSource) => void
  onFile?: (fileId: string) => void
  onNote?: (text: string) => void
  onSave?: () => void
  onRetry?: () => void
  onRetryFiles?: () => void
  onClose?: () => void
}

interface Opened {
  readonly orderId: string
  readonly number: string
}

export function usePriceCheck(api: ApiClient, options: { readonly onSaved?: (check: PriceCheck) => void } = {}): { model: PriceCheckDialogModel | null; actions: PriceCheckDialogActions; open: (order: Opened) => void } {
  const locale = useLocale()
  const [opened, setOpened] = useState<Opened | null>(null)
  const [read, setRead] = useState<PriceRead>({ status: 'reading' })
  const [files, setFiles] = useState<FilesRead>({ status: 'reading' })
  const [draft, setDraft] = useState<PriceDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<PriceCheckDialogModel['notice']>(null)
  const [fields, setFields] = useState<Readonly<Record<string, Phrase>>>({})
  const readId = useRef(0)
  const sent = useRef<{ readonly body: string; readonly key: string } | null>(null)
  const onSaved = useRef(options.onSaved)
  onSaved.current = options.onSaved

  const readCheck = useCallback(
    (orderId: string, at: Locale, after?: PriceCheckDialogModel['notice']) => {
      const id = ++readId.current
      setRead({ status: 'reading' })
      readPriceCheck(api, orderId).then(
        (check) => {
          if (id !== readId.current) return
          setRead({ status: 'ready', check })
          setDraft(draftOf(check, at))
          setFields({})
          setNotice(after ?? null)
        },
        (error: unknown) => id === readId.current && setRead({ status: 'failed', problem: readProblem(error) }),
      )
    },
    [api],
  )
  const readFiles = useCallback(
    (orderId: string) => {
      const id = readId.current
      setFiles({ status: 'reading' })
      readOrderFiles(api, orderId).then(
        (list) => id === readId.current && setFiles({ status: 'ready', files: list }),
        () => id === readId.current && setFiles({ status: 'failed' }),
      )
    },
    [api],
  )

  const open = useCallback(
    (order: Opened) => {
      setOpened(order)
      setDraft(null)
      setBusy(false)
      setNotice(null)
      setFields({})
      sent.current = null
      readCheck(order.orderId, locale)
      readFiles(order.orderId)
    },
    [readCheck, readFiles, locale],
  )

  const close = useCallback(() => {
    readId.current++
    setOpened(null)
  }, [])

  const edit = (patch: (current: PriceDraft) => PriceDraft) => setDraft((current) => (current ? patch(current) : current))
  const check = read.status === 'ready' ? read.check : null

  const save = async () => {
    if (!opened || !check || !draft || busy) return
    const plan = pricePlanOf(check, draft)
    if (plan.kind === 'problems') return setFields(plan.problems)
    if (plan.kind === 'nothing') return
    const body = JSON.stringify(plan.body)
    if (sent.current?.body !== body) sent.current = { body, key: newIdempotencyKey() }
    setBusy(true)
    setNotice(null)
    setFields({})
    try {
      const after = await saveBrandPrices(api, opened.orderId, plan.body, sent.current.key)
      setBusy(false)
      onSaved.current?.(after)
      close()
    } catch (error) {
      setBusy(false)
      const refusal = saveRefusalOf(error, plan.keys, check.currency)
      sent.current = null
      if (refusal.reread) return readCheck(opened.orderId, locale, { tone: refusal.words.key === 'priceCheck.stale' ? 'warning' : 'danger', words: refusal.words })
      setFields(refusal.fields)
      setNotice({ tone: 'danger', words: refusal.words })
    }
  }

  const actions: PriceCheckDialogActions = {
    onLine: (lineId, patch) => edit((current) => ({ ...current, lines: { ...current.lines, [lineId]: { ...(current.lines[lineId] ?? { as: 'unit', value: '' }), ...patch } } })),
    onTotal: (text) => edit((current) => ({ ...current, total: text })),
    onSource: (source) => edit((current) => ({ ...current, source })),
    onFile: (fileId) => edit((current) => ({ ...current, fileId })),
    onNote: (text) => edit((current) => ({ ...current, note: text })),
    onSave: () => void save(),
    onRetry: () => opened && readCheck(opened.orderId, locale),
    onRetryFiles: () => opened && readFiles(opened.orderId),
    onClose: () => !busy && close(),
  }

  const model = useMemo<PriceCheckDialogModel | null>(() => (opened ? { orderId: opened.orderId, number: opened.number, read, files, draft, busy, notice, fields } : null), [opened, read, files, draft, busy, notice, fields])
  return { model, actions, open }
}
