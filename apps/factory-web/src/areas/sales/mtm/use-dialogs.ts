'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { addUnit, checkMeasures, createQuote, getStyle, listMtmStyles, sendMeasureLink, type ProfileRow, type QuoteRef } from './api'
import { linkDraftFor, linkHeld, linkProblem, quoteHeld, quoteHref, readProblem, writeProblem, type MtmCan } from './model'
import type { LinkDialogActions, LinkDialogModel, QuoteDialogActions, QuoteDialogModel } from './view-model'

export interface LinkTarget {
  readonly profileId: string
  readonly riderName: string
  readonly garmentType: string
  readonly contactId: string | null
  readonly pointCount: number | null
}

/**
 * Send a measurement link, for both containers: from the band (the rider picked among the list's rows) or the record (its rider).
 * ONE call (POST /sales/measure-links) with one Idempotency-Key per dialog; the answer says mailed (FAKE locally) or shows the
 * address once. A refusal in our words (no privacy notice published: GATE-PRIVACY).
 */
export function useLinkDialog({ api, can, companyId, language, offline, pointsOf }: { api: ApiClient; can: MtmCan; companyId: string | null; language: 'it' | 'en'; offline: boolean; pointsOf: (garmentType: string) => number | null }) {
  const [model, setModel] = useState<LinkDialogModel | null>(null)
  const contact = useRef<string | null>(null)
  const key = useRef<string | null>(null)
  const current = useRef<LinkDialogModel | null>(null)
  current.current = model
  const patch = useCallback((next: Partial<LinkDialogModel>) => setModel((now) => (now ? { ...now, ...next } : now)), [])

  const base = (target: LinkTarget | null, choices: readonly ProfileRow[] | null): LinkDialogModel => ({
    choices,
    profileId: target?.profileId ?? '',
    riderName: target?.riderName ?? '',
    garmentType: target?.garmentType ?? '',
    hasContact: !!target?.contactId,
    pointCount: target?.pointCount ?? null,
    draft: linkDraftFor(language),
    busy: false,
    offline,
    notice: null,
    sent: null,
    copied: false,
  })

  const openFor = useCallback(
    (target: LinkTarget) => {
      key.current = null
      contact.current = target.contactId
      setModel(base(target, null))
    },
    // `base` reads only the props below.
    [language, offline],
  )
  const openFromBand = useCallback(
    (rows: readonly ProfileRow[]) => {
      key.current = null
      contact.current = null
      setModel(base(null, rows))
    },
    [language, offline],
  )

  const send = useCallback(async () => {
    const now = current.current
    if (!now || now.busy || !companyId || !now.profileId) return
    if (linkHeld(now.draft, { can, offline, hasContact: now.hasContact })) return
    patch({ busy: true, notice: null })
    key.current ??= newIdempotencyKey()
    try {
      const sent = await sendMeasureLink(
        api,
        { profileId: now.profileId, companyId, ...(contact.current ? { contactId: contact.current } : {}), ...(now.draft.email.trim() ? { email: now.draft.email.trim() } : {}), send: now.draft.send, photos: now.draft.photos, language: now.draft.language, expiresInDays: now.draft.days },
        key.current,
      )
      key.current = null
      patch({ busy: false, sent })
    } catch (error) {
      patch({ busy: false, notice: { ...linkProblem(error), tone: 'danger' } })
    }
  }, [api, can, companyId, offline, patch])

  const actions: LinkDialogActions = {
    onPick: (profileId) => {
      const row = current.current?.choices?.find((entry) => entry.id === profileId)
      contact.current = row?.contactId ?? null
      key.current = null
      patch({ profileId, riderName: row?.riderName ?? '', garmentType: row?.garmentType ?? '', hasContact: !!row?.contactId, pointCount: row ? pointsOf(row.garmentType) : null })
    },
    onDraft: (next) => setModel((now) => (now ? { ...now, draft: { ...now.draft, ...next } } : now)),
    onSend: () => void send(),
    onCopy: () => {
      const url = current.current?.sent?.url
      if (!url) return
      void navigator.clipboard
        ?.writeText(url)
        .then(() => patch({ copied: true }))
        .catch(() => undefined)
    },
    onClose: () => setModel(null),
  }

  return { model: model ? { ...model, offline } : null, actions, openFor, openFromBand }
}

export interface QuoteTarget {
  readonly profileId: string
  readonly riderName: string
  readonly customer: string
  readonly partyId: string
  readonly contactId: string | null
  readonly revision: number
}

/**
 * Use in a new quote, for both containers: the MTM styles, the style picked (its colourways), the style's check against the
 * rider's newest revision (base size suggested, made-to-measure started), then ONE quote (W1's POST /sales/quotes) and ONE unit
 * (POST …/lines/made-to-measure), each with its own Idempotency-Key, and the quote opens. A unit refused after the quote was
 * made says so and links the quote (it stays a draft).
 */
export function useQuoteDialog({ api, can, companyId, prefix, offline, onCreated }: { api: ApiClient; can: MtmCan; companyId: string | null; prefix: string; offline: boolean; onCreated: (quote: QuoteRef) => void }) {
  const [model, setModel] = useState<QuoteDialogModel | null>(null)
  const target = useRef<QuoteTarget | null>(null)
  const made = useRef<QuoteRef | null>(null)
  const keys = useRef<{ quote: string | null; unit: string | null }>({ quote: null, unit: null })
  const current = useRef<QuoteDialogModel | null>(null)
  current.current = model
  const patch = useCallback((next: Partial<QuoteDialogModel>) => setModel((now) => (now ? { ...now, ...next } : now)), [])

  const open = useCallback(
    (to: QuoteTarget) => {
      target.current = to
      made.current = null
      keys.current = { quote: null, unit: null }
      setModel({ riderName: to.riderName, customer: to.customer, revision: to.revision, styles: { items: null, problem: null }, style: null, draft: { styleId: '', colourwayId: '', baseSize: '' }, check: null, checking: false, busy: false, offline, notice: null })
      if (!can.styles) {
        patch({ styles: { items: [], problem: 'held.noStyles' } })
        return
      }
      listMtmStyles(api, companyId)
        .then((items) => patch({ styles: { items, problem: null } }))
        .catch((error: unknown) => patch({ styles: { items: [], problem: readProblem(error) } }))
    },
    [api, can.styles, companyId, offline, patch],
  )

  const styleId = model?.draft.styleId ?? ''
  useEffect(() => {
    if (!styleId) return
    const controller = new AbortController()
    patch({ style: null, check: null })
    getStyle(api, styleId, controller.signal)
      .then((style) => {
        const first = style.colourways.find((colourway) => colourway.status === 'ACTIVE')
        setModel((now) => (now && now.draft.styleId === styleId ? { ...now, style, draft: { ...now.draft, colourwayId: now.draft.colourwayId || first?.id || '' } } : now))
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) patch({ notice: { key: readProblem(error), tone: 'danger' } })
      })
    return () => controller.abort()
  }, [api, styleId, patch])

  const colourwayId = model?.draft.colourwayId ?? ''
  useEffect(() => {
    const profileId = target.current?.profileId
    if (!styleId || !colourwayId || !profileId) return
    const controller = new AbortController()
    patch({ checking: true })
    checkMeasures(api, { styleId, colourwayId, measurementProfileId: profileId }, controller.signal)
      .then((check) => patch({ checking: false, check }))
      .catch(() => {
        if (!controller.signal.aborted) patch({ checking: false, check: null })
      })
    return () => controller.abort()
  }, [api, styleId, colourwayId, patch])

  const create = useCallback(async () => {
    const now = current.current
    const to = target.current
    if (!now || !to || now.busy || !companyId) return
    if (quoteHeld(now.draft, now.check, { can, offline, companyId })) return
    patch({ busy: true, notice: null })
    try {
      keys.current.quote ??= newIdempotencyKey()
      made.current ??= await createQuote(api, { companyId, partyId: to.partyId, contactId: to.contactId }, keys.current.quote)
      keys.current.unit ??= newIdempotencyKey()
      const quote = await addUnit(api, made.current, { styleId: now.draft.styleId, colourwayId: now.draft.colourwayId, measurementProfileId: to.profileId, baseSize: now.draft.baseSize.trim() || now.check?.baseSize.size || null }, keys.current.unit)
      setModel(null)
      onCreated(quote)
    } catch (error) {
      const quote = made.current
      const said = writeProblem(error)
      patch({
        busy: false,
        notice: quote
          ? { key: 'quote.problem.unitRefused', params: { number: quote.number }, tone: 'danger', lines: [isApiError(error) && error.kind === 'conflict' ? { key: 'quote.problem.notStarted' } : said], link: { href: quoteHref(prefix, quote.id), label: { key: 'quote.openQuote', params: { number: quote.number } } } }
          : { ...said, tone: 'danger' },
      })
    }
  }, [api, can, companyId, prefix, offline, onCreated, patch])

  const actions: QuoteDialogActions = {
    onDraft: (next) => setModel((now) => (now ? { ...now, draft: { ...now.draft, ...next } } : now)),
    onCreate: () => void create(),
    onClose: () => setModel(null),
  }

  return { model: model ? { ...model, offline } : null, actions, open }
}
