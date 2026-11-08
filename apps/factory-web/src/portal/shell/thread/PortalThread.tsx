'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PartnerMessage } from '@nexus/ui/patterns/PartnerThread/index'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { formatDateTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { fetchThread, postMessage, type PartnerMessageRead, type PartnerRecord, type PartnerThreadRead } from '../api'
import { usePortalFrame, usePortalLive, usePortalUnsaved } from '../frame'
import { THREAD_BODY_LIMIT, threadHeldKey } from '../thread-model'
import { ThreadView } from '../view/ThreadView'

/**
 * The conversation about one record (or the account, `Party`) as the partner sees it: GET /portal/threads/:type/:id, a post
 * = POST …/messages under one key per draft (a retry after a lost answer posts once). Typed text is guarded: leaving asks
 * first (Leave without sending?). New messages arrive by the live channel's hints; the box keeps the focus after Send.
 */
export interface PortalThreadProps {
  type: string
  id: string
  /** The box takes the focus once read ("Ask a question"). */
  focus?: boolean
  headingLevel?: 2 | 3
  title?: string
  /** The record as the partner knows it, once read (a record page fills its band with it). */
  onRecord?: (record: PartnerRecord) => void
  /** The record is not one of theirs, or no longer exists (404). */
  onMissing?: () => void
  /** Draw the record's references above the conversation (default true; a record page has them in its band). */
  showRecord?: boolean
}

export function PortalThread({ type, id, focus = false, headingLevel = 2, title, onRecord, onMissing, showRecord = true }: PortalThreadProps) {
  const frame = usePortalFrame()
  const t = useT('portal')
  const locale = useLocale()
  const [read, setRead] = useState<PartnerThreadRead | null>(null)
  const [older, setOlder] = useState<PartnerMessageRead[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading')
  const [moreBusy, setMoreBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const key = useRef<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const told = useRef({ onRecord, onMissing })
  told.current = { onRecord, onMissing }

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const answer = await fetchThread(frame.api, type, id, null, signal)
        setRead(answer)
        told.current.onRecord?.(answer.record)
        setOlder([])
        setCursor(answer.nextCursor)
        setState('ready')
      } catch (error) {
        if ((error as { name?: string } | null)?.name === 'AbortError') return
        if (isApiError(error) && error.kind === 'not_found') told.current.onMissing?.()
        setState('error')
      }
    },
    [frame.api, type, id],
  )

  useEffect(() => {
    const abort = new AbortController()
    setState('loading')
    void load(abort.signal)
    return () => abort.abort()
  }, [load])

  // A new message on this record (ours by mail or in the app, a colleague's in the portal): read the newest page again.
  usePortalLive({ onChange: (change) => (change.type.startsWith('thread.') || change.type === 'partner_notification.created' ? void load() : undefined), onReconnect: () => void load() })

  // "Ask a question" opens the box with the focus in it.
  useEffect(() => {
    if (!focus || state !== 'ready') return
    box.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  }, [focus, state])

  const send = useCallback(async (): Promise<boolean> => {
    const body = draft.trim()
    if (!body || sending) return false
    key.current ??= newIdempotencyKey()
    setSending(true)
    setFailed(null)
    try {
      await postMessage(frame.api, type, id, body, key.current)
      key.current = null
      setDraft('')
      await load()
      return true
    } catch (error) {
      const kind = isApiError(error) ? error.kind : 'internal'
      setFailed(t(`thread.failed.${kind === 'conflict' || kind === 'forbidden' || kind === 'invalid' || kind === 'unavailable' ? kind : 'other'}`))
      return false
    } finally {
      setSending(false)
    }
  }, [draft, sending, frame.api, type, id, load, t])

  usePortalUnsaved(`thread:${type}:${id}`, { dirty: draft.trim() !== '', what: t('unsaved.message'), save: send })

  const messages = useMemo<PartnerMessage[]>(() => {
    const all = [...(read?.messages ?? []), ...older]
    // The API pages newest first; a conversation reads down, oldest first.
    return all
      .slice()
      .reverse()
      .map((message) => ({
        id: message.id,
        side: message.side === 'COMPANY' ? 'company' : 'partner',
        channel: message.channel === 'EMAIL' ? 'email' : message.channel === 'PORTAL' ? 'portal' : 'app',
        author: message.author,
        body: message.body,
        attachments: message.attachments.map((file) => ({ id: file.id, name: file.originalName, size: sizeText(file.sizeBytes, locale), href: `/api/files/${encodeURIComponent(file.id)}/download` })),
        at: message.at,
        atText: formatDateTime(message.at, { locale }),
      }))
  }, [read, older, locale])

  const more = async () => {
    if (!cursor) return
    setMoreBusy(true)
    try {
      const page = await fetchThread(frame.api, type, id, cursor)
      setOlder((current) => [...current, ...page.messages])
      setCursor(page.nextCursor)
    } catch {
      setFailed(t('thread.failed.more'))
    } finally {
      setMoreBusy(false)
    }
  }

  const composer = read?.composer ?? null
  const heldKey = composer && !composer.canPost ? threadHeldKey(composer.reason) : null
  const admins = frame.access?.admins.map((admin) => admin.displayName) ?? []
  const accessLine = composer?.reason === 'NO_COMMENT' ? (admins.length > 0 ? t('thread.whoCan', { names: admins.join(', ') }) : t('thread.whoCanNoAdmin')) : null
  const isAccount = type === 'Party'

  return (
    <div ref={box}>
      <ThreadView
        model={{
          state,
          title: title ?? (isAccount ? t('thread.accountTitle') : t('thread.title')),
          record: read && !isAccount && showRecord ? { theirs: read.record.theirRef, ours: read.record.ourRef } : null,
          companyName: frame.me.company.name,
          messages,
          composer: composer
            ? {
                value: draft,
                busy: sending,
                heldReason: heldKey ? t(heldKey) : null,
                hint: composer.replyByEmail ? t('thread.hint') : null,
                limit: THREAD_BODY_LIMIT,
              }
            : null,
          loadMore: cursor ? { busy: moreBusy } : null,
          accessLine,
          failed,
        }}
        headingLevel={headingLevel}
        onChange={(value) => {
          setDraft(value)
          if (failed) setFailed(null)
        }}
        onSend={() => void send()}
        onMore={() => void more()}
        onRetry={() => {
          setState('loading')
          void load()
        }}
      />
    </div>
  )
}

/** A file's size in the page's language ("673 KB"). */
function sizeText(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'it-IT', { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`
}
