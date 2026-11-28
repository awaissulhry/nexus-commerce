'use client'

import { useRef, useState, type ReactNode } from 'react'
import { CircleCheck, FileText, Image as ImageIcon, Info, Paperclip, Send, Trash2 } from 'lucide-react'
import { Banner, Card, Field } from '@nexus/ui/components'
import { Button, Input, Select, Tag } from '@nexus/ui/primitives'
import { DateField, Textarea } from '../../i18n/ds-parts'
import { useHeldModel } from '../../order-lines/redraw'
import { OrderLinesTable, type OrderLinesActions, type OrderLinesModel } from '../../order-lines/view/OrderLinesTable'
import { WindowShell } from '../../window-shell/view/WindowShell'
import { SUBJECT_MAX, type HeaderDraft, type HeaderField, type ShipToOption, type StillOpenEntry } from '../model'
import type { DraftFile, DraftFilePart } from '../schema'
import { DraftDoorProvider, useDraftWords } from '../words'
import { ACCEPT, FilesBox, type FilesBoxModel } from './files'
import { StillOpen } from './StillOpen'
import '../order-draft.css'

/**
 * owb-po3.1 + po3.4 — THE NEW ORDER WINDOW (design § 5zi D; prototype portal.js `composeWin`, `cmpOpenHTML`, `composeSent`): ONE window
 * like a mail, on the base's WindowShell (the foot fixed; a sheet on a phone). Only a subject is needed; free text is a full order. In
 * order: the picture and the Subject (+ Wanted for, Your reference, Deliver to; "For your customer" waits for Your customers: not drawn)
 * · Lines (the ONE table) · Files (A mockup · A size file · Another file, or drop one) · Message to the factory. Beside it "Your order
 * at one look": lines, pieces, the sum (money only) · Still open (a list, never a stop; a row takes you to its field) · What happens
 * next. Head: "Draft saved hh:mm" and "Drafts n" (open one, or delete it with a question). Foot: the bin · Cancel (= save and close:
 * every field saves as you leave it; the shell's word, S2's WindowShell has no "Save and close" yet) · **Send to the factory**. Esc =
 * save and close; ⌘ / Ctrl + Enter sends (a field you are in is left first, so its words go with it). After Send the window stays:
 * "Your order is with the factory" (no number: the request's number is not the order's) + What happens next + **Open the order**.
 * Gone: the "more" button and the number field for pieces. Draws what it is given (the host's container holds the draft).
 */

export type DraftWindowPhase = 'loading' | 'draft' | 'sent' | 'closed' | 'missing' | 'failed'

export interface DraftWindowModel {
  readonly open: boolean
  readonly phase: DraftWindowPhase
  /** The subject, else "New order". */
  readonly title: string
  /** "Draft saved 10:42", "Saved 10:42 by Marta", "Not saved yet". */
  readonly saved: string
  /** "Drafts n": the customer's other drafts (null: none to show). */
  readonly drafts: readonly { readonly id: string; readonly title: string; readonly line: string }[] | null
  /** The picture of the order: chosen (a file) or the design of the first line; null: no draft yet (nothing to choose on). */
  readonly picture: { readonly chosen: boolean; readonly held: string | null } | null
  readonly header: HeaderDraft
  readonly headerErrors: Partial<Record<HeaderField, string>>
  readonly shipTo: readonly ShipToOption[]
  readonly today: string
  readonly lines: OrderLinesModel
  /** The order's files (its own: mockups, size files, other files) and the ones going up. */
  readonly files: FilesBoxModel & { readonly sheets: readonly DraftFile[]; readonly logos: readonly string[] }
  readonly side: { readonly lines: number; readonly pieces: string; readonly sum: string | null; readonly stillOpen: readonly StillOpenEntry[]; readonly openCount: number }
  /** Why Send waits (words), or null. */
  readonly sendHeld: string | null
  readonly busy: boolean
  /** Why the bin waits (words), or null; the question is open. */
  readonly deleteHeld: string | null
  readonly deleteAsk: boolean
  /** Why nothing can be written now (words), or null. */
  readonly writeHeld: string | null
  /** ONE banner, by weight (offline, changed elsewhere, a refusal, a done line). */
  readonly banner: { readonly tone: 'warning' | 'danger' | 'success' | 'info'; readonly title: string; readonly action?: { readonly words: string; readonly run: 'reload' | 'undo' | 'dismiss' } } | null
  /** After Send: what went (its subject, lines, pieces, wanted), and where "Open the order" leads. */
  readonly sent: { readonly subject: string; readonly lines: number; readonly pieces: string; readonly wanted: string | null; readonly openHref: string | null } | null
  /** A draft no longer a draft, or gone: its words and where it leads. */
  readonly end: { readonly title: string; readonly body: string; readonly openHref: string | null } | null
}

export interface DraftWindowActions {
  /** Save and close: Cancel, Esc, the backdrop, the X (every field saves as it is left; nothing is deleted). */
  readonly onClose: () => void
  readonly onSend?: () => void
  readonly onHeader?: (field: HeaderField, value: string) => void
  readonly onHeaderLeave?: (field: HeaderField) => void
  readonly onAddAddress?: () => void
  readonly onPicture?: () => void
  readonly onOpenDraft?: (id: string) => void
  readonly onDeleteDraft?: (id: string) => void
  readonly onAsk?: () => void
  readonly onAskCancel?: () => void
  readonly onDelete?: () => void
  readonly onFiles?: (part: DraftFilePart, files: File[]) => void
  readonly onRemoveFile?: (file: DraftFile) => void
  readonly onLogo?: (file: DraftFile, on: boolean) => void
  readonly lines?: OrderLinesActions
  readonly onStillOpen?: (entry: StillOpenEntry) => void
  readonly onBanner?: (run: 'reload' | 'undo' | 'dismiss') => void
  readonly onOpenOrder?: () => void
  readonly onNewOrder?: () => void
}

export interface DraftWindowSlots {
  /** The host's doors beside "Add a line" (the portal's "Add from: catalogue · a past order · a sheet"). */
  readonly addFrom?: ReactNode
  /** The host's panels under the lines (a past order, a sheet). */
  readonly panels?: ReactNode
}

/** Leave the field you are in first (its words save as you leave it), then run: ⌘ Enter sends what you just typed too. */
const leaveFieldThen = (run: () => void) => () => {
  if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) document.activeElement.blur()
  run()
}

export function DraftWindow({ model, actions, slots }: { model: DraftWindowModel; actions: DraftWindowActions; slots?: DraftWindowSlots }) {
  return (
    <DraftDoorProvider door="portal">
      <DraftWindowFrame model={model} actions={actions} slots={slots} />
    </DraftDoorProvider>
  )
}

function DraftWindowFrame({ model: given, actions, slots }: { model: DraftWindowModel; actions: DraftWindowActions; slots?: DraftWindowSlots }) {
  const { t } = useDraftWords()
  const model = useHeldModel(given, given.open)
  const sent = model.phase === 'sent'
  const editing = model.phase === 'draft'
  const openHref = sent ? model.sent?.openHref : model.end?.openHref
  const act = editing
    ? { words: t('window.send'), onAct: leaveFieldThen(() => actions.onSend?.()), held: model.sendHeld, busy: model.busy }
    : openHref
      ? { words: t('window.openOrder'), onAct: () => actions.onOpenOrder?.() }
      : null
  const more = sent ? (
    <Button size="sm" variant="quiet" onClick={() => actions.onNewOrder?.()}>
      {t('window.another')}
    </Button>
  ) : editing ? (
    <Button size="sm" variant="quiet" aria-label={t('window.delete')} heldReason={model.deleteHeld} onClick={() => actions.onAsk?.()}>
      <Trash2 size={14} aria-hidden />
    </Button>
  ) : null
  return (
    <WindowShell open={model.open} onClose={actions.onClose} title={sent ? t('window.sentTitle') : model.title} subtitle={editing ? model.saved : undefined} act={act} more={more} size="xl" closeHeld={model.busy ? t('window.busy') : null}>
      <DraftWindowBody model={model} actions={actions} slots={slots} />
    </WindowShell>
  )
}

/** The window's body (exported for the tests and the design index: a server render draws no dialog). */
export function DraftWindowBody({ model, actions, slots }: { model: DraftWindowModel; actions: DraftWindowActions; slots?: DraftWindowSlots }) {
  const { t } = useDraftWords()
  if (model.phase === 'loading') return <p className="fw-od-quiet">{t('window.loading')}</p>
  if (model.phase === 'sent' && model.sent) return <SentBody sent={model.sent} />
  if (model.phase !== 'draft') {
    return (
      <div className="fw-odw-end">
        <p className="fw-od-h2">{model.end?.title ?? t('window.failed')}</p>
        {model.end ? <p className="fw-od-quiet">{model.end.body}</p> : null}
      </div>
    )
  }
  const held = model.writeHeld !== null
  const error = (field: HeaderField) => (model.headerErrors[field] ? t(model.headerErrors[field]!) : undefined)
  return (
    <div className="fw-odw">
      {model.deleteAsk ? (
        <Banner
          tone="warning"
          title={t('window.deleteAsk')}
          action={
            <span className="fw-od-buttons">
              <Button size="sm" onClick={() => actions.onAskCancel?.()}>
                {t('dialog.cancel')}
              </Button>
              <Button size="sm" variant="danger" heldReason={model.deleteHeld} onClick={() => actions.onDelete?.()}>
                <Trash2 size={14} aria-hidden /> {t('window.deleteGo')}
              </Button>
            </span>
          }
        />
      ) : model.banner ? (
        <Banner
          tone={model.banner.tone}
          title={model.banner.title}
          action={
            model.banner.action ? (
              <Button size="sm" onClick={() => actions.onBanner?.(model.banner!.action!.run)}>
                {model.banner.action.words}
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {model.drafts && model.drafts.length > 0 ? <DraftsList drafts={model.drafts} actions={actions} held={model.writeHeld} /> : null}
      <div className="fw-odw-main">
        <div className="fw-odw-body">
          <section className="fw-odw-top" aria-label={t('mail.subject')}>
            <Button className="fw-odw-pic" variant="quiet" aria-label={t('window.picture')} heldReason={model.picture ? model.picture.held : t('window.pictureLater')} onClick={() => actions.onPicture?.()}>
              <ImageIcon size={28} aria-hidden />
              <span>{model.picture?.chosen ? t('window.pictureChosen') : t('window.pictureWord')}</span>
            </Button>
            <div className="fw-odw-id">
              <Field label={t('mail.subject')} error={error('subject')}>
                <Input
                  id="od-subject"
                  value={model.header.subject}
                  maxLength={SUBJECT_MAX}
                  disabled={held}
                  placeholder={t('window.subjectPh')}
                  autoComplete="off"
                  onChange={(event) => actions.onHeader?.('subject', event.target.value)}
                  onBlur={() => actions.onHeaderLeave?.('subject')}
                />
              </Field>
              <div className="fw-odw-three" id="od-date" tabIndex={-1}>
                <Field label={t('window.wanted')} error={error('requestedDate')}>
                  <DateField
                    value={model.header.requestedDate}
                    min={model.today}
                    clearable
                    disabled={held}
                    onChange={(value) => {
                      actions.onHeader?.('requestedDate', value)
                      actions.onHeaderLeave?.('requestedDate')
                    }}
                  />
                </Field>
                <Field label={t('window.reference')} error={error('customerRef')}>
                  <Input value={model.header.customerRef} maxLength={100} disabled={held} placeholder={t('window.referencePh')} onChange={(event) => actions.onHeader?.('customerRef', event.target.value)} onBlur={() => actions.onHeaderLeave?.('customerRef')} />
                </Field>
                <Field label={t('row.shipTo')} error={error('shipToAddressId')}>
                  <span className="fw-odw-shipto">
                    <Select
                      value={model.header.shipToAddressId}
                      disabled={held}
                      onChange={(event) => {
                        actions.onHeader?.('shipToAddressId', event.target.value)
                        actions.onHeaderLeave?.('shipToAddressId')
                      }}
                    >
                      <option value="">{t('head.shipToChoose')}</option>
                      {model.shipTo.map((option) => (
                        <option key={option.id} value={option.id}>
                          {[option.name, option.line].filter(Boolean).join(' — ')}
                          {option.isDefault ? ` (${t('head.default')})` : option.state === 'WAITING' ? ` (${t('head.waiting')})` : ''}
                        </option>
                      ))}
                    </Select>
                    {actions.onAddAddress ? (
                      <Button size="sm" variant="quiet" heldReason={model.writeHeld} onClick={() => actions.onAddAddress?.()}>
                        {t('window.newAddress')}
                      </Button>
                    ) : null}
                  </span>
                </Field>
              </div>
            </div>
          </section>
          <section className="fw-odw-sec" id="od-products" tabIndex={-1} aria-labelledby="odw-lines">
            <div className="fw-od-parthead">
              <h3 id="odw-lines" className="fw-od-h2">
                {t('window.lines')}
              </h3>
              {model.side.lines > 0 ? <Tag tone="neutral">{model.side.lines}</Tag> : <span className="fw-od-quiet">{t('window.linesHint')}</span>}
            </div>
            <OrderLinesTable model={model.lines} actions={actions.lines} foot={slots?.addFrom} />
            {slots?.panels}
          </section>
          <FilesSection model={model} actions={actions} />
          <section className="fw-odw-sec" aria-labelledby="odw-message">
            <Field label={t('window.message')} error={error('note')}>
              <Textarea value={model.header.note} rows={5} honourRows maxLength={4000} disabled={held} placeholder={t('window.messagePh')} onChange={(event) => actions.onHeader?.('note', event.target.value)} onBlur={() => actions.onHeaderLeave?.('note')} />
            </Field>
          </section>
        </div>
        <aside className="fw-odw-side" aria-label={t('window.oneLook')}>
          <Card padded>
            <section className="fw-od-section" aria-label={t('window.oneLook')}>
              <h3 className="fw-od-h2">{t('window.oneLook')}</h3>
              <p className="fw-od-quiet">{model.side.lines > 0 ? t('window.summary', { lines: model.side.lines, pieces: model.side.pieces }) : t('window.summaryNone')}</p>
              {model.side.sum ? <p className="fw-od-total">{t('window.sum', { sum: model.side.sum })}</p> : null}
            </section>
          </Card>
          <StillOpen entries={model.side.stillOpen} openCount={model.side.openCount} noProducts={model.side.lines === 0} onGo={actions.onStillOpen} />
          <Card padded>
            <section className="fw-od-section" aria-labelledby="odw-next">
              <h3 id="odw-next" className="fw-od-h2">
                {t('window.nextTitle')}
              </h3>
              <ol className="fw-odw-steps">
                <li>{t('window.next1')}</li>
                <li>{t('window.next2')}</li>
                <li>{t('window.next3')}</li>
              </ol>
            </section>
          </Card>
        </aside>
      </div>
      <p className="fw-od-quiet">
        <Info size={14} aria-hidden /> {t('window.keys')}
      </p>
    </div>
  )
}

/** "Drafts n": open one, or delete it with a question first (it was not sent: the factory never saw it). */
function DraftsList({ drafts, actions, held }: { drafts: NonNullable<DraftWindowModel['drafts']>; actions: DraftWindowActions; held: string | null }) {
  const { t } = useDraftWords()
  const [shown, setShown] = useState(false)
  const [asking, setAsking] = useState<string | null>(null)
  return (
    <div className="fw-odw-drafts">
      <Button size="sm" variant="quiet" aria-expanded={shown} onClick={() => setShown(!shown)}>
        <FileText size={14} aria-hidden /> {t('window.drafts', { n: drafts.length })}
      </Button>
      {shown ? (
        <ul className="fw-odw-draftlist">
          {drafts.map((draft) => (
            <li key={draft.id}>
              {asking === draft.id ? (
                <span className="fw-od-buttons">
                  <span>{t('window.deleteOther', { title: draft.title })}</span>
                  <Button size="sm" onClick={() => setAsking(null)}>
                    {t('dialog.cancel')}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    heldReason={held}
                    onClick={() => {
                      setAsking(null)
                      actions.onDeleteDraft?.(draft.id)
                    }}
                  >
                    {t('window.deleteGo')}
                  </Button>
                </span>
              ) : (
                <>
                  <Button size="sm" variant="quiet" onClick={() => actions.onOpenDraft?.(draft.id)}>
                    <strong>{draft.title}</strong>
                  </Button>
                  <span className="fw-od-quiet">{draft.line}</span>
                  <Button size="sm" variant="quiet" aria-label={t('window.deleteThis', { title: draft.title })} heldReason={held} onClick={() => setAsking(draft.id)}>
                    <Trash2 size={14} aria-hidden />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** Files with their kind: A mockup (filed as a logo / artwork) · A size file (measurements, never a picture) · Another file; or drop one. */
function FilesSection({ model, actions }: { model: DraftWindowModel; actions: DraftWindowActions }) {
  const { t } = useDraftWords()
  const inputs = useRef<Partial<Record<DraftFilePart, HTMLInputElement | null>>>({})
  const kinds: readonly { part: DraftFilePart; key: string; icon: ReactNode }[] = [
    { part: 'LOGO', key: 'window.fileMockup', icon: <ImageIcon size={14} aria-hidden /> },
    { part: 'SHEET', key: 'window.fileSizes', icon: <FileText size={14} aria-hidden /> },
    { part: 'REFERENCE', key: 'window.fileOther', icon: <Paperclip size={14} aria-hidden /> },
  ]
  const count = model.files.files.length + model.files.sheets.length
  return (
    <section className="fw-odw-sec" aria-labelledby="odw-files">
      <div className="fw-od-parthead">
        <h3 id="odw-files" className="fw-od-h2">
          {t('window.files')}
        </h3>
        {count > 0 ? <Tag tone="neutral">{count}</Tag> : null}
        <span className="fw-odw-grow" />
        {model.files.open
          ? kinds.map((kind) => (
              <span key={kind.part}>
                <Button size="sm" variant="quiet" heldReason={model.files.addHeld} onClick={() => inputs.current[kind.part]?.click()}>
                  {kind.icon} {t(kind.key)}
                </Button>
                <input
                  ref={(node) => {
                    inputs.current[kind.part] = node
                  }}
                  type="file"
                  hidden
                  multiple
                  accept={ACCEPT[kind.part]}
                  aria-label={t(kind.key)}
                  onChange={(event) => {
                    const list = Array.from(event.target.files ?? [])
                    event.target.value = ''
                    if (list.length > 0) actions.onFiles?.(kind.part, list)
                  }}
                />
              </span>
            ))
          : null}
      </div>
      {model.files.sheets.length > 0 ? (
        <ul className="fw-od-filelist">
          {model.files.sheets.map((file) => (
            <li key={file.id} className="fw-od-quiet">
              <FileText size={14} aria-hidden /> {file.originalName ?? '—'} · {t('window.kindSizes')}
            </li>
          ))}
        </ul>
      ) : null}
      <FilesBox model={model.files} actions={{ onFiles: (files) => actions.onFiles?.('REFERENCE', files), onRemove: actions.onRemoveFile, onLogo: actions.onLogo }} logo />
    </section>
  )
}

/** After Send: the window stays and says so — what went, what happens next, and Open the order. No number (settle 3). */
function SentBody({ sent }: { sent: NonNullable<DraftWindowModel['sent']> }) {
  const { t } = useDraftWords()
  return (
    <div className="fw-odw-sent" role="status">
      <CircleCheck size={40} aria-hidden className="fw-odw-ok" />
      <h3 className="fw-od-h2">{t('window.sentLine', { subject: sent.subject })}</h3>
      <p className="fw-od-quiet">
        {t('window.summary', { lines: sent.lines, pieces: sent.pieces })}
        {sent.wanted ? ` · ${t('window.sentWanted', { day: sent.wanted })}` : ''}
      </p>
      <ol className="fw-odw-steps">
        <li>
          <Send size={14} aria-hidden /> {t('window.sent1')}
        </li>
        <li>{t('window.sent2')}</li>
        <li>{t('window.sent3')}</li>
      </ol>
    </div>
  )
}
