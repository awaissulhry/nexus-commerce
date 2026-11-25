'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { useLocale, useT } from '../../../lib/i18n/provider'
// pt-w2 W2.3 (lane pt-, S5): the jump both doors run — pages of 200 over the SAME portal page read, at most 1,000, the row lit.
import { JUMP_LIMIT, JUMP_PAGE, jumpRefusal, lightRow, pageBackOrNow } from '../../../lib/record-thread/jump'
import type { PortalThreadMessage } from '../../../lib/record-thread/partner/model'
import { fetchThread, postMessage, type PartnerMessageRead, type PartnerRecord, type PartnerThreadRead } from '../api'
// B-TH-229: reading marks the conversation read for this portal person.
import { markThreadRead } from '../api'
// B-TH-286: the pins of messages shared with this customer (never an office note's, never who pinned).
import { fetchPins, type PartnerPinRead } from '../api'
import { usePortalFrame, usePortalLive, usePortalUnsaved } from '../frame'
// ---- B-TH-273: docked in the portal record frame — the person's own new count goes to its "Messages (2 new)" button, and the
// conversation is marked read only while it is on screen (never behind the narrow page's button).
import { usePortalRecordFrame } from '../record/PortalRecordFrame'
// ---- end B-TH-273
import { frameNewCount, jumpWordsKey, portalMessageOf, replyRefusalKey, THREAD_BODY_LIMIT, threadHeldKey } from '../thread-model'
import { ThreadView } from '../view/ThreadView'
// ---- F-CP-156 (customer page plan C7, D12; B-CP-078, B-CP-079): "Ask <name>, factory designer" — the one name, the chip, the "@".
import { issuePath } from '../../../lib/api/errors'
import { fetchFactoryDesigner } from '../api'
import { designerAskedOf, designerBoxShows, designerChipShows, designerRefusalKey, withDesignerMention } from '../thread-model'
// ---- end F-CP-156
import './thread.css'

/**
 * The conversation about one record (or the account, `Party`) as the partner sees it: GET /portal/threads/:type/:id, a post
 * = POST …/messages under one key per draft (a retry after a lost answer posts once). Typed text is guarded: leaving asks
 * first (Leave without sending?). New messages arrive by the live channel's hints; the box keeps the focus after Send.
 * pt-w2 W2.3 (lane pt-; ONE SHARED THREAD): drawn by the ONE partner face (the office's row, list, composer row, pinned bar) through
 * ThreadView: Reply answers a message (`replyToMessageId`; refused: the words say why, nothing written, the text and the bar stay); a
 * quote or a pin goes to its message (older pages of 200 read if it must, at most 1,000; the row lit); older pages on scroll; the list
 * opens at the person's first new message; a live hint or a Send MERGES the newest page into what is loaded (A7). Off a record frame
 * (a project, a request, a record page) the column is bounded: its list scrolls itself (A6).
 */
export interface PortalThreadProps {
  type: string
  id: string
  /** The box takes the focus once read ("Ask a question"). */
  focus?: boolean
  title?: string
  /** The record as the partner knows it, once read (a record page fills its band with it). */
  onRecord?: (record: PartnerRecord) => void
  /** The record is not one of theirs, or no longer exists (404). */
  onMissing?: () => void
  // B-TH-222: the messages as read, oldest first (the request page quotes our question of a request that waits for the customer).
  onMessages?: (messages: readonly PortalThreadMessage[]) => void
  /** pt-w2 (A19): more sentences for the ⓘ, the page's own (the supplier order's price talk). */
  help?: readonly string[]
  /** pt-w2 (A11): the frame's widths and the current one, and its chooser (a width, 'hide', 'reset'); absent: no ⋮. */
  width?: { readonly widths: readonly string[]; readonly current: string | null } | null
  choose?: ((width: string) => void) | null
}

export function PortalThread({ type, id, focus = false, title, onRecord, onMissing, onMessages, help, width, choose }: PortalThreadProps) {
  const frame = usePortalFrame()
  const t = useT('portal')
  const locale = useLocale()
  const [read, setRead] = useState<PartnerThreadRead | null>(null)
  const [older, setOlder] = useState<PartnerMessageRead[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading')
  const [olderState, setOlderState] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  // pt-w2 W2.3: the message the box answers, what the last post said, the row a jump lights, the person's reading on arrival.
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ id: string; seq: number } | null>(null)
  const [arrival, setArrival] = useState<{ firstNewId: string | null; newCount: number } | null>(null)
  const key = useRef<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  // A7: older pages were read (a scroll up, a jump): a re-read of the newest page keeps them and their cursor.
  const olderRead = useRef(false)
  // ---- B-TH-286: the pins, read with the conversation (a failed read shows none: they are a pointer, never the only copy).
  const [pins, setPins] = useState<PartnerPinRead[]>([])
  // ---- F-CP-156: the one factory designer the customer may ask (null: none named, or not a customer's portal) and the ask.
  const [designerName, setDesignerName] = useState<string | null>(null)
  const [askDesigner, setAskDesigner] = useState(false)
  const customer = frame.kinds.includes('CUSTOMER')
  useEffect(() => {
    if (!customer) return
    const abort = new AbortController()
    fetchFactoryDesigner(frame.api, abort.signal)
      .then(setDesignerName)
      .catch(() => setDesignerName(null))
    return () => abort.abort()
  }, [customer, frame.api])
  // ---- end F-CP-156
  const told = useRef({ onRecord, onMissing, onMessages })
  told.current = { onRecord, onMissing, onMessages }
  // ---- B-TH-273
  const dockFrame = usePortalRecordFrame()
  const onScreen = dockFrame ? dockFrame.onScreen : true
  const reportNew = dockFrame?.reportNew
  // pt-fx2 (W-01b): the button says the face's own count — the band's and the down button's (the reader's own messages never new).
  const loadedRef = useRef<PartnerMessageRead[]>([])
  loadedRef.current = [...(read?.messages ?? []), ...older]
  useEffect(() => {
    if (state === 'ready') reportNew?.(frameNewCount([...(read?.messages ?? []), ...older], read?.reading))
  }, [state, read, older, reportNew])
  // ---- end B-TH-273

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const answer = await fetchThread(frame.api, type, id, null, signal)
        setRead(answer)
        told.current.onRecord?.(answer.record)
        // A7: the newest page MERGES into what is loaded — the older pages read stay (minus what the newest page holds now).
        const newest = new Set(answer.messages.map((message) => message.id))
        setOlder((now) => now.filter((message) => !newest.has(message.id)))
        if (!olderRead.current) setCursor(answer.nextCursor)
        setArrival((now) => now ?? (answer.reading ? { firstNewId: answer.reading.firstNewMessageId, newCount: answer.reading.newCount } : null))
        setState('ready')
        // B-TH-286: the pins of this conversation, as this customer may see them.
        void fetchPins(frame.api, type, id, signal)
          .then(setPins)
          .catch(() => undefined)
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
    setOlder([])
    olderRead.current = false
    setArrival(null)
    setReplyTo(null)
    void load(abort.signal)
    return () => abort.abort()
  }, [load])

  // A new message on this record (ours by mail or in the app, a colleague's in the portal): read the newest page again.
  usePortalLive({ onChange: (change) => (change.type.startsWith('thread.') || change.type === 'partner_notification.created' ? void load() : undefined), onReconnect: () => void load() })

  // B-TH-229 (B-TH-027, T1-F04, PL3-F08): reading marks the conversation read for this person — after the messages were on screen a
  // second while the page is in view, up to the newest one read; once per read (a re-read after it has nothing new). Only the
  // person's own mark: the face reports nothing it saw (A14), and nobody sees who read what.
  useEffect(() => {
    const newest = read?.messages[0]?.id
    // B-TH-273: only while the conversation is on screen (docked, or the narrow page's full-width view open).
    if (state !== 'ready' || !newest || (read?.reading?.newCount ?? 0) <= 0 || !onScreen) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        // B-TH-273: the frame's button follows the count the API answers after the mark — by the face's rule (pt-fx2: the
        // server's count holds the reader's own messages).
        if (document.visibilityState === 'visible')
          void markThreadRead(frame.api, type, id, newest)
            .then((answer) => reportNew?.(frameNewCount(loadedRef.current, answer.reading, newest)))
            .catch(() => undefined)
      }, 1_000)
    }
    if (document.visibilityState === 'visible') later()
    const onVisible = () => document.visibilityState === 'visible' && later()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [state, read, frame.api, type, id, onScreen, reportNew])

  // "Ask a question" opens the box with the focus in it.
  useEffect(() => {
    if (!focus || state !== 'ready') return
    box.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  }, [focus, state])

  // F-CP-156: the box shows for a name to ask, on a record the customer may ask on, while it may write here.
  const boxShows = designerBoxShows({ name: designerName, type, canPost: read?.composer.canPost ?? false })
  const send = useCallback(async (): Promise<boolean> => {
    const body = draft.trim()
    if (!body || sending) return false
    key.current ??= newIdempotencyKey()
    setSending(true)
    setFailed(null)
    const asking = boxShows && askDesigner // F-CP-156
    try {
      const answer = await postMessage(frame.api, type, id, body, key.current, { askFactoryDesigner: asking, replyToMessageId: replyTo })
      key.current = null
      setDraft('')
      setReplyTo(null)
      // ---- F-CP-156: "We asked Giulia Verdi." (or: the day's asks are used up, the message reached the team) in the box's ONE bar.
      setAskDesigner(false)
      const asked = asking ? designerAskedOf(answer.designerAsk) : null
      setSaid(asked ? t(asked.key, asked.name ? { name: asked.name } : undefined) : null)
      // ---- end F-CP-156
      await load()
      return true
    } catch (error) {
      const kind = isApiError(error) ? error.kind : 'internal'
      const paths = isApiError(error) ? error.issues.map(issuePath) : []
      // ---- pt-w2 W2.3 (S.6): a reply the server refused wrote nothing — the text and the reply bar stay, the words say why.
      const refused = replyTo && kind === 'conflict' ? replyRefusalKey(paths) : null
      if (refused) {
        key.current = null
        setFailed(t(refused))
        return false
      }
      // ---- F-CP-156: the ask refused before the post (nothing posted): the text stays, with its words; no name now → no chip.
      const refusal = asking && kind === 'conflict' ? designerRefusalKey(paths) : null
      if (refusal) {
        key.current = null
        setAskDesigner(false)
        if (refusal === 'thread.designer.noDesigner') setDesignerName(null)
        setFailed(t(refusal))
        return false
      }
      // ---- end F-CP-156
      setFailed(t(`thread.failed.${kind === 'conflict' || kind === 'forbidden' || kind === 'invalid' || kind === 'unavailable' ? kind : 'other'}`))
      return false
    } finally {
      setSending(false)
    }
  }, [draft, sending, frame.api, type, id, load, t, boxShows, askDesigner, replyTo])

  usePortalUnsaved(`thread:${type}:${id}`, { dirty: draft.trim() !== '', what: t('unsaved.message'), save: send })

  const messages = useMemo<PortalThreadMessage[]>(() => {
    const all = [...(read?.messages ?? []), ...older]
    // The API pages newest first; a conversation reads down, oldest first.
    return all
      .slice()
      .reverse()
      .map((message) => portalMessageOf(message, locale))
  }, [read, older, locale])

  // B-TH-222
  useEffect(() => {
    if (state === 'ready') told.current.onMessages?.(messages)
  }, [messages, state])

  // Older pages as the person scrolls up (the list's top sentinel asks once per page; a failed page offers Retry).
  const more = async () => {
    if (!cursor || olderState === 'loading') return
    setOlderState('loading')
    try {
      const page = await fetchThread(frame.api, type, id, cursor)
      olderRead.current = true
      setOlder((now) => [...now, ...page.messages.filter((message) => !now.some((one) => one.id === message.id))])
      setCursor(page.nextCursor)
      setOlderState('idle')
    } catch {
      setOlderState('failed')
    }
  }

  // ---- pt-w2 W2.3 (S5): to a message a quote or a pin names — the SAME page read in pages of 200 until it is there (at most 1,000
  // older messages), ONE update for them all, then the row centred in its list, focused and lit. Not reached: the words say why.
  const latest = useRef({ read, older, cursor })
  latest.current = { read, older, cursor }
  const jumpTo = useCallback(
    async (messageId: string) => {
      const now = latest.current
      const loaded = new Set([...(now.read?.messages ?? []), ...now.older].map((message) => message.id))
      // pt-fx1 R-1: a loaded message is reached in this same turn (no await), the same timing in both doors.
      const back = pageBackOrNow({
        id: messageId,
        has: (one) => loaded.has(one),
        cursor: now.cursor,
        readPage: (from: string, size: number) => fetchThread(frame.api, type, id, from, undefined, size),
        page: JUMP_PAGE,
        limit: JUMP_LIMIT,
      })
      const { read: pages, cursor: after, found, failed: broke, pages: count } = back instanceof Promise ? await back : back
      if (count > 0) {
        olderRead.current = true
        setOlder((list) => [...list, ...pages.filter((message) => !list.some((one) => one.id === message.id))])
        setCursor(after)
      }
      const refusal = jumpRefusal({ found, failed: broke, cursor: after })
      if (refusal) {
        setFailed(t(jumpWordsKey(refusal)))
        return
      }
      setFlash((was) => ({ id: messageId, seq: (was?.seq ?? 0) + 1 }))
      requestAnimationFrame(() => lightRow(messageId))
    },
    [frame.api, type, id, t],
  )
  // ---- end pt-w2 W2.3

  const composer = read?.composer ?? null
  const heldKey = composer && !composer.canPost ? threadHeldKey(composer.reason) : null
  const admins = frame.access?.admins.map((admin) => admin.displayName) ?? []
  const accessLine = composer?.reason === 'NO_COMMENT' ? (admins.length > 0 ? t('thread.whoCan', { names: admins.join(', ') }) : t('thread.whoCanNoAdmin')) : null
  const isAccount = type === 'Party'

  return (
    <div ref={box} className={dockFrame ? 'fw-pthr' : 'fw-pthr is-bounded'}>
      <ThreadView
        model={{
          kind: isAccount ? 'account' : 'record',
          state,
          title: title ?? (isAccount ? t('thread.accountTitle') : t('thread.title')),
          record: read ? { theirs: read.record.theirRef ?? (isAccount ? frame.me.party.name : null), ours: read.record.ourRef } : null,
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
          loadMore: cursor ? { busy: olderState === 'loading' } : null,
          older: olderState,
          reading: arrival,
          flash,
          replyTo,
          said,
          accessLine,
          failed,
          // B-TH-286: one line per pin — who wrote it, one line of its words (or why not); never who pinned.
          pins: pins.map((pin) => ({ id: pin.messageId, author: pin.message.removed ? null : pin.message.authorName, words: pin.message.excerpt, date: pin.pinnedAt, pinnedAt: pin.pinnedAt, files: pin.message.attachmentCount, removed: pin.message.removed })),
          // F-CP-156: "Ask <name>, factory designer" in the box's chips row; an "@" being typed: the chip completes it.
          designer: boxShows && designerName ? { name: designerName, ask: askDesigner, chip: designerChipShows(draft, designerName), held: null } : null,
          ...(help && help.length > 0 ? { help } : {}),
          width: width && choose ? { ...width, choose } : null,
        }}
        onChange={(value) => {
          setDraft(value)
          if (failed) setFailed(null)
          if (said) setSaid(null)
          // F-CP-156: the "@" shortcut — the name typed whole ("@Giulia Verdi") ticks the ask; a new ask is a new post (its own key).
          if (boxShows && designerName && !askDesigner && value.includes(`@${designerName}`)) {
            key.current = null
            setAskDesigner(true)
          }
        }}
        onSend={() => void send()}
        // ---- F-CP-156: a change of the ask is a new post (its own key); the chip, while an "@" is typed, puts "@<name> " in the text and ticks.
        onAskDesigner={(ask) => {
          key.current = null
          setAskDesigner(ask)
        }}
        onDesignerChip={() => {
          if (!designerName) return
          key.current = null
          setDraft((now) => withDesignerMention(now, designerName))
          setAskDesigner(true)
          if (failed) setFailed(null)
        }}
        // ---- end F-CP-156
        // ---- pt-w2 W2.3 (S.6): Reply answers a message (its own key); × lets it go. Never a correction from the portal.
        onReply={(messageId) => {
          key.current = null
          setReplyTo(messageId)
          setFailed(null)
        }}
        onDropReply={() => {
          key.current = null
          setReplyTo(null)
        }}
        onJump={(messageId) => void jumpTo(messageId)}
        onDismissNotice={() => setFailed(null)}
        onMore={() => void more()}
        onRetry={() => {
          setState('loading')
          void load()
        }}
      />
    </div>
  )
}
