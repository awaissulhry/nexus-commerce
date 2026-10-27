'use client'

/**
 * Reviews › Inbox — the review pop-up (build spec §3.2 "Pop-up", the Inbox-detail board): a centred DS `DetailModal`
 * (1160 px; a full-screen sheet on a phone) over the Inbox. ▲ / ▼ and K / J walk the rows on screen, counted in the whole
 * filtered list ("53 of 56" on page 2), held at either end with the reason; Esc closes it and the focus goes back to the
 * row.
 *
 * Header: the product, who · where · what · when, the stars, the mood, "Return open"; Status and Owner save at once
 * (`PATCH /api/reviews/:id/triage`). Tabs: Review · Order · Buyer · History. The Review tab: what the buyer wrote and its
 * English, the buyer's photos (PR G: eBay's photos open the DS `Lightbox`; channels whose photos Nexus does not read yet
 * keep the labelled sample), eBay's AI topics and the revision state, product / order / return / listing links, the
 * mood and themes (AI-set, editable: `PATCH /api/reviews/:id/sentiment`), the reply (DS `ReplyComposer` with the
 * channel's rules), and beside it the team's triage (tags, a note saved 800 ms after typing) and what happened.
 *
 * No optimistic changes: every save is the call, then `emitInvalidation` (the Inbox and any other tab read again), then
 * this review is read again, then a toast in the server's words. Without "Manage reviews" every change is held and says
 * so. A sent reply sets Responded on the server; nothing here sets it by hand.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, ExternalLink, Languages } from 'lucide-react'
import {
  AsOf, Banner, Card, Disclosure, Field, KeyValue, Listbox, StarRating, Thumbnail, Timeline, useToast, type KeyValueItem,
} from '@/design-system/components'
import { DetailModal, Lightbox, ReplyComposer, type ReplyAction } from '@/design-system/patterns'
import { Button, Pill, SegmentedControl, Spinner, Tag, TagInput, Textarea, TokenChip } from '@/design-system/primitives'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { reviewsGet, reviewsSend } from '../_lib/reviewsFetch'
import { MOOD_WORD, STATUS_WORD, themeWord } from '../_lib/reviewWords'
import { useReplyTemplates } from '../settings/_settings/useReplyTemplates'
import { studioHref } from '../insights/products/productModalModel'
import { ownerChoices } from './inboxBulk'
import {
  MANAGE_MOOD, MANAGE_TRIAGE, MOOD_OPTIONS, MOOD_TONE, STATUS_OPTIONS, buyerFacts, composerView, dateWords, detailSubtitle, detailTabs,
  detailTitle, draftResponseId, historySteps, initialReplyText, lightboxHead, nextHeld, nextId, orderFacts, photosView, recentSteps,
  removalView, replyDoneWords, replyTargetWords, returnOpen, returnWords, revisionLine, sameThemeLink, textView, themeChoices, topicChips,
  type DetailTab, type InboxDetail,
} from './reviewDetailModel'
import s from './inbox.module.css'

export interface ReviewDetailModalProps {
  reviewId: string
  /** The ids of the rows on screen, in their order. */
  ids: readonly string[]
  /** Where those rows sit in the whole filtered list (`navPlace`): the counter says "53 of 56", not "3 of 50". */
  place?: { offset: number; total: number | null }
  onGo: (id: string) => void
  onClose: () => void
  canManage: boolean
  /** Everyone who owns a review now (the Inbox's facets), for the Owner list. */
  owners: readonly string[]
  /** The signed-in person's name, offered first in the Owner list. */
  me: string | null
}

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: string } | { kind: 'error'; words: string }

const NOTE_SAVE_MS = 800

export function ReviewDetailModal({ reviewId, ids, place, onGo, onClose, canManage, owners, me }: ReviewDetailModalProps) {
  const { toast } = useToast()
  const [detail, setDetail] = useState<InboxDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<DetailTab>('review')
  /** PR G — the photo open in the Lightbox (index), or null. */
  const [photo, setPhoto] = useState<number | null>(null)
  const abort = useRef<AbortController | null>(null)

  // ── Read the review ──
  const load = useCallback(async (id: string, quiet = false) => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    if (!quiet) setLoading(true)
    try {
      const res = await reviewsGet<InboxDetail>(`/reviews/inbox/${encodeURIComponent(id)}`, undefined, { signal: controller.signal })
      if (controller.signal.aborted) return
      setDetail(res.data)
      setError(res.data ? null : res.error)
    } catch {
      return // aborted: a newer read is on its way
    } finally {
      if (abort.current === controller) setLoading(false)
    }
  }, [])

  // Another review: start on its Review tab, with its own reply text and note.
  const [reply, setReply] = useState('')
  const [english, setEnglish] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [noteState, setNoteState] = useState<SaveState>({ kind: 'idle' })
  const shownId = useRef<string | null>(null)
  useEffect(() => {
    setTab('review')
    setPhoto(null)
    setDetail(null)
    void load(reviewId)
    return () => abort.current?.abort()
  }, [reviewId, load])
  useEffect(() => {
    if (!detail || shownId.current === detail.review.id) return
    shownId.current = detail.review.id
    setReply(initialReplyText(detail))
    setEnglish(null)
    setNote(detail.review.note ?? '')
    setNoteState({ kind: 'idle' })
  }, [detail])

  const reread = useCallback(() => void load(reviewId, true), [load, reviewId])

  // The saved replies from Reviews › Settings, for this review's channel and language (the reply box's Templates menu).
  const replyTemplates = useReplyTemplates(detail?.review.channel ?? null, detail?.language ?? null, detail?.review.market ?? null)
  const pickTemplate = useCallback((id: string) => {
    const body = replyTemplates.pick(id)
    if (body != null) setReply(body)
  }, [replyTemplates])

  // ── Writes: the call → tell every page → read again → a toast ──
  const triage = useCallback(async (patch: Record<string, unknown>, done: string | null) => {
    const res = await reviewsSend<unknown>('PATCH', `/reviews/${encodeURIComponent(reviewId)}/triage`, patch)
    if (res.error) {
      toast(res.error, 'danger')
      return false
    }
    emitInvalidation({ type: 'review.updated', id: reviewId })
    reread()
    if (done) toast(done, 'success')
    return true
  }, [reviewId, reread, toast])

  const setStatus = useCallback((status: string) => {
    void triage({ status }, `Status: ${STATUS_WORD[status] ?? status}.`)
  }, [triage])
  const setOwner = useCallback((owner: string) => {
    void triage({ assignee: owner || null }, owner ? `Assigned to ${owner}.` : 'Nobody owns this review now.')
  }, [triage])
  const setTags = useCallback((tags: string[]) => {
    void triage({ tags }, null)
  }, [triage])

  // The note saves itself 800 ms after the last keystroke.
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveNote = useCallback(async (text: string) => {
    setNoteState({ kind: 'saving' })
    const res = await reviewsSend<unknown>('PATCH', `/reviews/${encodeURIComponent(reviewId)}/triage`, { note: text.trim() ? text : null })
    if (res.error) {
      setNoteState({ kind: 'error', words: res.error })
      return
    }
    setNoteState({ kind: 'saved', at: new Date().toISOString() })
    emitInvalidation({ type: 'review.updated', id: reviewId })
  }, [reviewId])
  const onNote = useCallback((text: string) => {
    setNote(text)
    if (noteTimer.current) clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => void saveNote(text), NOTE_SAVE_MS)
  }, [saveNote])
  useEffect(() => () => { if (noteTimer.current) clearTimeout(noteTimer.current) }, [reviewId])

  const sentiment = useCallback(async (patch: { label?: string; categories?: string[] }) => {
    const res = await reviewsSend<unknown>('PATCH', `/reviews/${encodeURIComponent(reviewId)}/sentiment`, patch)
    if (res.error) {
      toast(res.error, 'danger')
      return
    }
    emitInvalidation({ type: 'review.updated', id: reviewId })
    reread()
    // Audit B14: Themes and Products read the edited mood and themes; the spike check keeps the rates it counted.
    toast('Saved. Themes and Products count your choice from now on; alerts already counted do not change.', 'success')
  }, [reviewId, reread, toast])

  const [translating, setTranslating] = useState(false)
  const [translateError, setTranslateError] = useState<string | null>(null)
  const translate = useCallback(async () => {
    setTranslating(true)
    setTranslateError(null)
    const res = await reviewsSend<{ language: string | null; english: string | null }>('POST', `/reviews/${encodeURIComponent(reviewId)}/translate`)
    setTranslating(false)
    if (res.error) {
      setTranslateError(res.error)
      return
    }
    emitInvalidation({ type: 'review.updated', id: reviewId })
    reread()
  }, [reviewId, reread])

  const [drafting, setDrafting] = useState(false)
  const draft = useCallback(async () => {
    setDrafting(true)
    const res = await reviewsSend<{ response: { body: string }; englishText: string | null }>('POST', `/reviews/${encodeURIComponent(reviewId)}/reply/draft`, {})
    setDrafting(false)
    if (!res.data) {
      toast(res.error ?? 'The draft could not be made.', 'danger')
      return
    }
    setReply(res.data.response.body)
    setEnglish(res.data.englishText)
    emitInvalidation({ type: 'review.updated', id: reviewId })
    reread()
    toast('Draft ready. Nothing was sent: read it, then send it.', 'success')
  }, [reviewId, reread, toast])

  const [sending, setSending] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  useEffect(() => setRefused(null), [reviewId])
  const send = useCallback(async (mode: 'send' | 'mark') => {
    if (!detail) return
    setSending(true)
    setRefused(null)
    const res = await reviewsSend<unknown>(
      'POST',
      `/reviews/${encodeURIComponent(reviewId)}/reply/send`,
      { body: reply, responseId: draftResponseId(detail) ?? undefined },
      { idempotent: true, what: 'reply' },
    )
    setSending(false)
    // Whatever happened, the channel's answer is on the review now (a refusal shows in the box and in History).
    reread()
    if (res.error) {
      setRefused(res.error)
      return
    }
    emitInvalidation({ type: 'review.replied', id: reviewId })
    toast(replyDoneWords(mode, detail.review.channel), 'success')
  }, [detail, reply, reviewId, reread, toast])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(reply)
      toast('Reply copied. Paste it on the channel, then mark it as responded.', 'success')
    } catch {
      toast('The reply could not be copied. Select the text and copy it by hand.', 'danger')
    }
  }, [reply, toast])

  // ── The view ──
  const next = nextId(ids, reviewId)
  const nextHold = nextHeld(ids, reviewId, place)
  const view = detail ? composerView(detail, { canManage }) : null
  const text = detail ? textView(detail) : null
  const photos = detail ? photosView(detail) : null
  const topics = detail ? topicChips(detail) : []
  const revision = detail ? revisionLine(detail) : null
  const removal = detail ? removalView(detail) : null

  const header = detail ? (
    <>
      <StarRating value={detail.review.rating} size="md" />
      {detail.sentiment.label && <Pill tone={MOOD_TONE[detail.sentiment.label] ?? 'neutral'}>{MOOD_WORD[detail.sentiment.label] ?? detail.sentiment.label}</Pill>}
      {returnOpen(detail) && <Pill tone="danger" dot>Return open</Pill>}
      {detail.review.imported && <Pill tone="neutral">Imported</Pill>}
    </>
  ) : null

  const ownerOptions = ownerChoices([...owners, ...(detail?.review.assignee ? [detail.review.assignee] : [])], me)
  const actions = detail ? (
    canManage ? (
      <span className={s.headControls}>
        <Listbox size="sm" ariaLabel="Status" options={STATUS_OPTIONS} value={detail.review.status} onChange={setStatus} width={140} />
        <Listbox size="sm" ariaLabel="Owner" options={ownerOptions} value={detail.review.assignee ?? ''} onChange={setOwner} width={170} searchable />
      </span>
    ) : (
      <span className={s.headControls}>
        <Button size="sm" heldReason={MANAGE_TRIAGE}>Status: {STATUS_WORD[detail.review.status] ?? detail.review.status}</Button>
        <Button size="sm" heldReason={MANAGE_TRIAGE}>Owner: {detail.review.assignee ?? 'Nobody'}</Button>
      </span>
    )
  ) : null

  const footer = (
    <div className={s.detailFoot}>
      <Button size="sm" onClick={() => setStatus('IGNORED')} heldReason={!canManage ? MANAGE_TRIAGE : !detail ? 'The review is still loading.' : detail.review.status === 'IGNORED' ? 'This review is Ignored already.' : null}>
        Ignore
      </Button>
      <span className={s.footHint}>Resolve when nothing more is needed. A reply sets Responded on its own.</span>
      <Button size="sm" onClick={() => setStatus('RESOLVED')} heldReason={!canManage ? MANAGE_TRIAGE : !detail ? 'The review is still loading.' : detail.review.status === 'RESOLVED' ? 'This review is Resolved already.' : null}>
        Resolve
      </Button>
      <Button size="sm" variant="primary" aria-keyshortcuts="J" onClick={() => { if (next) onGo(next) }} heldReason={nextHold}>
        Next review (J)
      </Button>
    </div>
  )

  return (
    <DetailModal
      open
      onClose={onClose}
      title={detail ? detailTitle(detail) : 'Review'}
      subtitle={detail ? detailSubtitle(detail) : undefined}
      meta={header}
      actions={actions}
      tabs={detailTabs(detail)}
      activeTab={tab}
      onTabChange={(id) => setTab(id as DetailTab)}
      tabsLabel="Review sections"
      nav={{ ids, current: reviewId, onGo, noun: 'review', offset: place?.offset, total: place?.total }}
      loading={loading && !detail}
      error={!detail && error ? error : undefined}
      onRetry={() => void load(reviewId)}
      footer={footer}
    >
      {detail && text && view && (
        <>
          {tab === 'review' && (
            <div className={s.detailGrid}>
              <div className={s.detailMain}>
                <Card header={text.heading}>
                  <div className={s.quote} lang={detail.language ?? undefined}>
                    {text.title && <p className={s.quoteTitle}>{text.title}</p>}
                    <p>{text.body}</p>
                  </div>
                  {text.english ? (
                    <div className={s.translation} lang="en">
                      <span className={s.translationLabel}><Languages size={13} aria-hidden /> {text.english.from}</span>
                      <p>{text.english.text}</p>
                    </div>
                  ) : text.canTranslate ? (
                    <div className={s.translateRow}>
                      <Button size="sm" onClick={() => void translate()} heldReason={translating ? 'Translating… this takes a few seconds.' : null}>
                        {translating ? <Spinner size={13} /> : <Languages size={13} aria-hidden />} Translate to English
                      </Button>
                      {translateError && <span className={s.inlineError} role="alert">{translateError}</span>}
                    </div>
                  ) : null}
                </Card>

                {photos?.kind === 'later' ? (
                  // ⛔ KEEP — placeholder (build spec ruling 3): this channel's photos arrive with a later update (review
                  // apps, Etsy). Until then a labelled sample, never hidden. eBay's photos are real since PR G.
                  <Card header="Photos from the buyer" headerAction={<span className={s.pills}><Pill tone="info">Coming later</Pill><Pill tone="neutral">Sample</Pill></span>}>
                    <div className={s.photoStrip} aria-label="Sample photos">
                      {[1, 2, 3].map((n) => <Thumbnail key={n} src={null} alt={`Sample photo ${n}`} />)}
                    </div>
                    <p className={s.hint}>Nexus will show the photos buyers add on eBay and in your review app here. These tiles are a sample.</p>
                  </Card>
                ) : photos ? (
                  <Card header="Photos from the buyer" headerAction={photos.kind === 'photos' ? <Tag tone="neutral">{photos.count}</Tag> : undefined}>
                    {photos.kind === 'photos' ? (
                      <>
                        <div className={s.photoStrip} role="group" aria-label="Photos from the buyer">
                          {photos.items.map((item, i) => (
                            <Thumbnail key={`${i}:${item.url}`} src={item.url} alt={item.alt} photoCount={photos.items.length} hoverPreview={false} title={`Open ${item.alt}`} onClick={() => setPhoto(i)} />
                          ))}
                        </div>
                        <p className={s.hint}>Press a photo to see it large. eBay keeps the photos; Nexus shows them from eBay.</p>
                      </>
                    ) : (
                      <p className={s.hint}>{photos.words}</p>
                    )}
                  </Card>
                ) : null}
                {photos?.kind === 'photos' && photo != null && (
                  <Lightbox
                    open
                    onClose={() => setPhoto(null)}
                    items={photos.items}
                    index={photo}
                    onIndex={setPhoto}
                    meta={lightboxHead(detail).meta}
                    caption={text.body}
                    external={lightboxHead(detail).external ?? undefined}
                  />
                )}

                {(topics.length > 0 || revision || detail.aiTopics) && (
                  <Card header="What eBay says about it">
                    {revision && (
                      <p className={s.revisionLine}>
                        <span className={s.muted}>Revision request</span>
                        <Pill tone={revision.tone}>{revision.words}</Pill>
                        {revision.since && <span className={s.muted}>{revision.since}</span>}
                      </p>
                    )}
                    <div className={s.themeRow} role="group" aria-label="Topics eBay’s AI found">
                      {topics.length === 0
                        ? <span className={s.muted}>{detail.aiTopics ? 'eBay’s AI found no topics in this feedback.' : 'eBay’s AI topics are read for the feedback of the last 30 days.'}</span>
                        : topics.map((t) => (
                            <Tag key={t.key} tone={t.tone} title={t.texts.length ? `The buyer: “${t.texts.join('”, “')}”` : undefined}>{t.label}</Tag>
                          ))}
                    </div>
                    <p className={s.hint}>Topics come from eBay’s AI and cannot be changed here; the themes below are Nexus’s own and can.</p>
                  </Card>
                )}

                <Card header="Product, order and return">
                  <KeyValue items={productItems(detail)} labelCase="sentence" />
                </Card>

                <Card header="Mood and themes">
                  <div className={s.moodRow}>
                    {canManage ? (
                      <SegmentedControl
                        size="sm"
                        ariaLabel="Mood"
                        options={MOOD_OPTIONS}
                        value={detail.sentiment.label ?? ''}
                        onChange={(label) => void sentiment({ label })}
                      />
                    ) : (
                      <Button size="sm" heldReason={MANAGE_MOOD}>Mood: {detail.sentiment.label ? MOOD_WORD[detail.sentiment.label] : 'not read yet'}</Button>
                    )}
                  </div>
                  <div className={s.themeRow} role="group" aria-label="Themes">
                    {detail.sentiment.categories.length === 0 && <span className={s.muted}>No themes yet.</span>}
                    {detail.sentiment.categories.map((theme) => canManage ? (
                      <TokenChip
                        key={theme}
                        onRemove={() => void sentiment({ categories: detail.sentiment.categories.filter((c) => c !== theme) })}
                        removeLabel={`Remove the theme ${themeWord(theme)}`}
                      >
                        {themeWord(theme)}
                      </TokenChip>
                    ) : <Tag key={theme} tone="neutral">{themeWord(theme)}</Tag>)}
                    {canManage && (
                      <Listbox
                        size="sm"
                        ariaLabel="Add a theme"
                        placeholder="Add theme"
                        options={themeChoices(detail.sentiment.categories)}
                        onChange={(theme) => void sentiment({ categories: [...detail.sentiment.categories, theme] })}
                        width={150}
                      />
                    )}
                  </div>
                  <p className={s.hint}>
                    {detail.sentiment.edited
                      ? `Set by a person on ${dateWords(detail.sentiment.editedAt)}. Insights counts this choice.`
                      : 'AI set these from the text. Change them and Themes and Products count your choice from now on (alerts already counted do not change).'}
                  </p>
                </Card>

                {removal && (
                  <Card header="Removal check" headerAction={<Pill tone={removal.tone} dot>{removal.label}</Pill>}>
                    <p className={s.removalWords}>{removal.words}</p>
                    <Disclosure summary="How the removal check decides">
                      <ul className={s.ruleList}>{removal.rules.map((rule) => <li key={rule}>{rule}</li>)}</ul>
                    </Disclosure>
                  </Card>
                )}

                <ReplyComposer
                  title={detail.reply.mode === 'send' ? 'Reply on eBay' : 'Reply'}
                  label={`Reply to ${detail.review.buyer ?? 'the buyer'}`}
                  value={reply}
                  onChange={setReply}
                  limit={view.limit}
                  ruleLine={view.ruleLine}
                  window={view.window}
                  templates={canManage ? replyTemplates.templates : undefined}
                  onTemplate={pickTemplate}
                  draft={{ onDraft: () => void draft(), busy: drafting, heldReason: view.draftHeld, englishLine: english }}
                  primary={{ label: view.primary.label, onClick: () => void send(view.primary.mode), heldReason: view.primary.held, busy: sending }}
                  secondary={secondaryActions(view, reply, () => void copy())}
                  sent={view.sent}
                  refused={refused ?? view.refused}
                />
              </div>

              <aside className={s.detailAside} aria-label="Triage and history">
                <Card header="Triage" headerAction={<NoteState state={noteState} />}>
                  <div className={s.triage}>
                    <Field label="Tags" hint={canManage ? 'Press Enter after each tag.' : MANAGE_TRIAGE}>
                      {canManage ? (
                        <TagInput value={detail.review.tags} onChange={setTags} placeholder="Add a tag" aria-label="Tags" />
                      ) : (
                        <span className={s.themeRow}>{detail.review.tags.length ? detail.review.tags.map((t) => <Tag key={t} tone="neutral">{t}</Tag>) : <span className={s.muted}>No tags</span>}</span>
                      )}
                    </Field>
                    <Field label="Note for the team" hint="Only your team sees this. Never sent to the buyer.">
                      <Textarea value={note} onChange={(e) => onNote(e.target.value)} readOnly={!canManage} rows={4} aria-label="Note for the team" placeholder={canManage ? 'What the team should know' : MANAGE_TRIAGE} />
                    </Field>
                  </div>
                </Card>
                <Card header="What happened" headerAction={<Button size="sm" variant="link" onClick={() => setTab('history')}>All history</Button>}>
                  <Timeline label="What happened to this review" steps={recentSteps(detail)} />
                  <p className={s.hint}>{replyTargetWords(detail, Date.now())}</p>
                </Card>
              </aside>
            </div>
          )}

          {tab === 'order' && (
            detail.order ? (
              <div className={s.tabBody}>
                <KeyValue items={orderFacts(detail).map((f) => ({ label: f.label, value: f.value, hint: f.hint }))} columns={2} labelCase="sentence" />
                <div className={s.linkRow}>
                  <Button asChild size="sm"><Link href={`/orders/${encodeURIComponent(detail.order.id)}`}>Open the order</Link></Button>
                  {detail.return && <Button asChild size="sm"><Link href={returnsHref(detail.order.label)}>Find the return in Returns</Link></Button>}
                </div>
              </div>
            ) : (
              <Banner tone="info" title="No order is linked to this review.">
                {detail.review.imported ? 'Imported reviews carry no order unless the file named one.' : 'The channel did not say which order it belongs to.'}
              </Banner>
            )
          )}

          {tab === 'buyer' && (
            <div className={s.tabBody}>
              <KeyValue items={buyerFacts(detail)} columns={2} labelCase="sentence" />
              {detail.buyerHistory.length > 0 && (
                <Card header="Their other feedback and reviews">
                  <ul className={s.historyList}>
                    {detail.buyerHistory.map((h) => (
                      <li key={h.id}>
                        <StarRating value={h.rating} size="sm" />
                        <span className={s.historyText}>{h.snippet || 'No text'}</span>
                        <span className={s.sub}>{dateWords(h.postedAt)}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              <p className={s.hint}>Nexus shows no e-mail or address here. Write to the buyer from the order, through the channel.</p>
            </div>
          )}

          {tab === 'history' && (
            <div className={s.tabBody}>
              <Timeline label="Everything that happened to this review" steps={historySteps(detail)} />
            </div>
          )}
        </>
      )}
    </DetailModal>
  )
}

/** The Product, order and return card: each fact with its link where Nexus has the page. */
function productItems(d: InboxDetail): KeyValueItem[] {
  const items: KeyValueItem[] = []
  items.push({
    label: 'Product',
    // The product studio, as Insights' product pop-up opens it (audit C12): one target for "the product".
    value: d.product ? <Link href={studioHref(d.product.id)}>{d.product.name}</Link> : 'No product link',
    hint: d.product ? d.product.sku : d.review.imported ? 'The file named no product Nexus knows' : undefined,
  })
  if (d.variant?.words) items.push({ label: 'Size and colour', value: d.variant.words, hint: d.variant.sku })
  items.push({
    label: 'Order',
    value: d.order ? <Link href={`/orders/${encodeURIComponent(d.order.id)}`}>{d.order.label}</Link> : 'No order',
    hint: d.order ? (d.order.deliveredAt ? `delivered ${dateWords(d.order.deliveredAt)}` : 'not delivered yet') : undefined,
  })
  if (d.return) {
    const r = returnWords(d.return)
    items.push({ label: 'Return', value: d.order ? <Link href={returnsHref(d.order.label)}>{r.value}</Link> : r.value, hint: r.hint })
  }
  if (d.listingHref) {
    items.push({
      label: 'Listing',
      value: <Button asChild size="sm" variant="link"><a href={d.listingHref} target="_blank" rel="noopener noreferrer">Open on the channel <ExternalLink size={12} aria-hidden /></a></Button>,
    })
  }
  const same = sameThemeLink(d)
  if (same) items.push({ label: 'Same theme', value: <Link href={same.href}>{same.label}</Link> })
  return items
}

/** The Returns list searched for this order (it finds a return by its order number). */
function returnsHref(orderLabel: string): string {
  return `/fulfillment/returns?q=${encodeURIComponent(orderLabel)}`
}

/** Copy mode: Copy reply, then the channel's own page (Seller Central, Feedback Manager, Etsy, the review app). */
function secondaryActions(view: NonNullable<ReturnType<typeof composerView>>, text: string, onCopy: () => void): ReplyAction[] {
  if (!view.copy || view.sent) return []
  const out: ReplyAction[] = []
  if (text.trim()) out.push({ label: <><Copy size={13} aria-hidden /> Copy reply</>, onClick: onCopy })
  if (view.open) out.push({ label: view.open.label, href: view.open.href, external: true })
  return out
}

function NoteState({ state }: { state: SaveState }) {
  if (state.kind === 'saving') return <span className={s.saveState} role="status"><Spinner size={12} /> Saving…</span>
  if (state.kind === 'saved') return <span className={s.saveState} role="status">Saved <AsOf at={state.at} kind="event" /></span>
  if (state.kind === 'error') return <span className={s.saveError} role="alert">Not saved: {state.words}</span>
  return null
}
