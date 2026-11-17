'use client'

import { useEffect, useId, useMemo, useState } from 'react'
import { Download, ExternalLink, Files as FilesIcon, Info, Paperclip, Users } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue } from '@nexus/ui/components'
import { PartnerThread, type PartnerMessage } from '@nexus/ui/patterns/PartnerThread/index'
import { Button, Skeleton, Spinner, Toggle } from '@nexus/ui/primitives'
import { FileDropzone, FileRow, Modal, useDsWords } from '../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { LinkFrameView } from '../../../shell/links/view/LinkFrameView'
import type { SharePage } from '../api'
import { acceptOf, BODY_LIMIT, daysLeft, fieldValueOf, heldKey, LINK_NS, mayKeys, shownFields, sizeText, threadOldestFirst, type InviteActions, type InviteViewModel, type Words } from '../model'
// B-TH-274: the files strip of the thread (the old Shared files card merged in).
import { filesStrip } from '../model'
import '../invite.css'

export type { InviteViewModel, InviteActions } from '../model'

/**
 * SCR-270 — Join a record (design links.invite; 00 §2.9 one-off link page; COL-061, COL-062): the link frame (the sender,
 * the language, whom to ask, the privacy notice) around the ONE record a partner was invited to.
 * B-TH-274 (threads plan TH-6, PL7; L-INVITE.side, L-INVITE.thread): the five stacked cards became two columns. The record's shared
 * thread is the MAIN column (~2/3): its files strip on top (every file shared with the person, by name, Open in a new tab; "All
 * files" opens the Files view — the old Shared files card merged in, files in one place), the conversation (PartnerThread, the
 * partner version: two sides, never an office note; ⌘Enter posts, the shared files ticked go with it; held with the reason when the
 * invitation does not allow writing) and, under it, Add files when the invitation allows it (the link's own upload, as before). From
 * 1280 px the SIDE column (~1/3, sticky) holds Why you are here (who invited you to what, what you can do, until when), The record
 * (only the fields shared with partners: never a price, a cost or an office person) and E-mail me (their own switch, on by default).
 * Narrower, the thread is the whole page and the side column waits behind "i" (a sheet). No rail, no menu: a link page's only way
 * out is Contact. Loading = skeleton + "Still loading…" after about a second; a failed read = our words + Try again; a revoked or
 * ended invitation = the frame's dead link (whom to ask; a new invitation is the office's).
 */
export function InviteView({ model, actions }: { model: InviteViewModel; actions?: InviteActions }) {
  return (
    <WithMessages namespaces={[LINK_NS]}>
      <Invite model={model} actions={actions} />
    </WithMessages>
  )
}

function useSay() {
  const t = useT(LINK_NS)
  const say = (words: Words | null) => (words ? t(words.key, words.params) : null)
  return { t, say }
}

function Invite({ model, actions }: { model: InviteViewModel; actions?: InviteActions }) {
  const { t } = useSay()
  const page = model.page
  const valid = model.link === 'valid'
  const title = page ? t('title', { type: t(`type.${page.record.type}`), reference: page.record.reference }) : null
  return (
    <LinkFrameView
      model={{
        sender: page ? { name: page.from.companyName } : null,
        title,
        body: valid ? { kind: 'task' } : { kind: 'link', state: model.link, purpose: 'RECORD_INVITE', expiresAt: null, usesLeft: null },
        timeZone: model.timeZone,
      }}
    >
      {valid && (page ? <Body page={page} model={model} actions={actions} /> : model.problem ? <ReadProblem model={model} actions={actions} /> : <Loading />)}
    </LinkFrameView>
  )
}

/** Skeleton cards in the shape of the page; after about a second, "Still loading…". */
function Loading() {
  const { t } = useSay()
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="fw-inv-page" aria-busy="true">
      <div className="fw-inv-main">
        <Skeleton width="60%" height={28} />
        <Card padded className="fw-inv-card">
          <Skeleton width="40%" height={20} />
          <Skeleton width="100%" height={220} />
        </Card>
        <p className="fw-inv-muted" role="status">
          {slow ? t('loading.slow') : t('loading.now')}
        </p>
      </div>
      <div className="fw-inv-side">
        {[96, 72, 48].map((height, index) => (
          <Card padded className="fw-inv-card" key={index}>
            <Skeleton width="40%" height={20} />
            <Skeleton width="100%" height={height} />
          </Card>
        ))}
      </div>
    </div>
  )
}

/** A failed read is never drawn as an empty record: the problem in our words and Try again. */
function ReadProblem({ model, actions }: { model: InviteViewModel; actions?: InviteActions }) {
  const { t } = useSay()
  return (
    <Banner
      tone="danger"
      title={t(model.problem ?? 'problem.read')}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('retry')}
        </Button>
      }
    >
      {t('problem.readBody')}
    </Banner>
  )
}

// ---- B-TH-274 (PL7-F01): the thread as the main column; the side column beside it from 1280 px, behind "i" narrower ----------
function Body({ page, model, actions }: { page: SharePage; model: InviteViewModel; actions?: InviteActions }) {
  const { t } = useSay()
  return (
    <div className="fw-inv-page">
      <div className="fw-inv-main">
        {/* Narrower than 1280 px: the side column waits behind "i" (CSS shows this row only there). */}
        <div className="fw-inv-bar">
          <Button size="sm" variant="secondary" aria-haspopup="dialog" onClick={() => actions?.onSheet?.('side')}>
            <Info size={14} aria-hidden /> {t('side.open')}
          </Button>
        </div>
        <FilesStrip page={page} model={model} actions={actions} />
        <Messages page={page} model={model} actions={actions} />
        <Upload page={page} model={model} actions={actions} />
      </div>
      <aside className="fw-inv-side" aria-label={t('side.title')}>
        <Side page={page} model={model} actions={actions} />
      </aside>
      {model.sheet === 'side' && (
        <Modal open sheet size="md" title={t('side.title')} onClose={() => actions?.onSheet?.(null)}>
          <div className="fw-inv-sheet">
            <Side page={page} model={model} actions={actions} />
          </div>
        </Modal>
      )}
      {model.sheet === 'files' && (
        <Modal open sheet size="lg" title={t('files.viewTitle')} onClose={() => actions?.onSheet?.(null)}>
          <FilesView page={page} model={model} actions={actions} />
        </Modal>
      )}
    </div>
  )
}

/** The side column: why you are here, the record, E-mail me (the same parts in the "i" sheet on a narrow screen). */
function Side({ page, model, actions }: { page: SharePage; model: InviteViewModel; actions?: InviteActions }) {
  return (
    <div className="fw-inv-stack">
      <Why page={page} model={model} />
      <Summary page={page} model={model} />
      <Notify page={page} model={model} actions={actions} />
    </div>
  )
}
// ---- end B-TH-274

/** sec:why — who invited you to what; what you can do (COL-062) and until when. */
function Why({ page, model }: { page: SharePage; model: InviteViewModel }) {
  const { t } = useSay()
  const locale = useLocale()
  const record = t('recordName', { type: t(`type.${page.record.type}`), reference: page.record.reference })
  const days = daysLeft(page.share.expiresAt, model.now)
  return (
    <Card padded className="fw-inv-card">
      <h2 className="fw-inv-h2">{t('why.title')}</h2>
      <Banner tone="info" icon={<Users size={16} aria-hidden />} title={page.share.invitedBy ? t('why.by', { name: page.share.invitedBy, company: page.from.companyName, record }) : t('why.byCompany', { company: page.from.companyName, record })} />
      <KeyValue
        labelCase="sentence"
        items={[
          { label: t('why.may'), value: mayKeys(page.share.permissions).map((key) => t(key)).join(' · ') },
          { label: t('why.until'), value: `${formatDate(page.share.expiresAt, { locale, timeZone: model.timeZone })} · ${days === 0 ? t('why.lastDay') : t('why.daysLeft', { count: days })}` },
          { label: t('why.invitedOn'), value: formatDate(page.share.invitedAt, { locale, timeZone: model.timeZone }) },
          { label: t('why.only'), value: t('why.onlyBody') },
        ]}
      />
    </Card>
  )
}

/** sec:summary — only the fields the record type shares with partners (no money on this section). */
function Summary({ page, model }: { page: SharePage; model: InviteViewModel }) {
  const { t, say } = useSay()
  const locale = useLocale()
  const fields = shownFields(page.record.fields)
  return (
    <Card padded className="fw-inv-card">
      <h2 className="fw-inv-h2">{t('summary.title')}</h2>
      {fields.length === 0 ? (
        <p className="fw-inv-muted">{t('summary.empty')}</p>
      ) : (
        <KeyValue
          labelCase="sentence"
          items={fields.map((field) => {
            const value = fieldValueOf(field)
            const text =
              value.kind === 'words'
                ? say(value.words)
                : value.kind === 'day'
                  ? formatDate(`${value.iso.slice(0, 10)}T12:00:00Z`, { locale, timeZone: 'UTC' })
                  : value.kind === 'instant'
                    ? formatDateTime(value.iso, { locale, timeZone: model.timeZone })
                    : value.kind === 'text'
                      ? value.text
                      : '—'
            return { label: t(`field.${field.key}`), value: text }
          })}
        />
      )}
    </Card>
  )
}

// ---- B-TH-274 (PL7-F01 "one place for files"; L-INVITE.thread): the old Shared files card merged into the thread's files strip and
// its Files view; Add files sits under the conversation (the link's own upload, as before: B-TH-305's upload slot in the box waits).

/** One shared file: Open (a new tab), held while another file opens. */
function OpenFile({ file, model, actions, quiet = false }: { file: SharePage['files'][number]; model: InviteViewModel; actions?: InviteActions; quiet?: boolean }) {
  const { t } = useSay()
  return (
    <Button size="sm" variant={quiet ? 'quiet' : 'secondary'} heldReason={model.opening && model.opening !== file.id ? t('files.held.opening') : null} aria-label={t('files.openNamed', { name: file.originalName })} onClick={() => actions?.onOpenFile?.(file.id)}>
      {model.opening === file.id ? <Spinner size={14} /> : quiet ? <Paperclip size={14} aria-hidden /> : <ExternalLink size={14} aria-hidden />} {quiet ? file.originalName : t('files.open')}
    </Button>
  )
}

/** The thread's files strip: the newest files by name (each opens in a new tab), "All files (N)" for the Files view. */
function FilesStrip({ page, model, actions }: { page: SharePage; model: InviteViewModel; actions?: InviteActions }) {
  const { t, say } = useSay()
  const strip = filesStrip(page.files)
  return (
    <section className="fw-inv-strip" aria-label={t('files.title')}>
      <span className="fw-inv-strip-title">
        <FilesIcon size={14} aria-hidden /> {t('files.title')}
      </span>
      {strip.all.length === 0 ? (
        <span className="fw-inv-muted">{t('files.empty')}</span>
      ) : (
        <>
          <ul className="fw-inv-strip-files">
            {strip.shown.map((file) => (
              <li key={file.id}>
                <OpenFile file={file} model={model} actions={actions} quiet />
              </li>
            ))}
          </ul>
          <Button size="sm" variant="quiet" aria-haspopup="dialog" onClick={() => actions?.onSheet?.('files')}>
            {strip.more > 0 ? t('files.allMore', { count: strip.all.length, more: strip.more }) : t('files.all', { count: strip.all.length })}
          </Button>
        </>
      )}
      {model.fileProblem && model.sheet !== 'files' && <Banner tone="danger" title={say(model.fileProblem)} action={<Button size="sm" variant="quiet" onClick={() => actions?.onDismiss?.('file')}>{t('dismiss')}</Button>} />}
    </section>
  )
}

/** The Files view: every file shared with the person on this record, newest first, each with Open. */
function FilesView({ page, model, actions }: { page: SharePage; model: InviteViewModel; actions?: InviteActions }) {
  const { t, say } = useSay()
  const locale = useLocale()
  const ds = useDsWords()
  const { all } = filesStrip(page.files)
  return (
    <div className="fw-inv-stack">
      {model.fileProblem && <Banner tone="danger" title={say(model.fileProblem)} action={<Button size="sm" variant="quiet" onClick={() => actions?.onDismiss?.('file')}>{t('dismiss')}</Button>} />}
      {all.length === 0 ? (
        <EmptyState icon={<Download size={20} aria-hidden />} title={t('files.empty')} description={t('files.emptyBody')} />
      ) : (
        <ul className="fw-inv-files" aria-label={t('files.viewTitle')}>
          {all.map((file) => (
            <li key={file.id}>
              <FileRow
                name={file.originalName}
                size={file.sizeBytes}
                status={file.mine ? t('files.yours', { at: formatDate(file.at, { locale, timeZone: model.timeZone }) }) : formatDate(file.at, { locale, timeZone: model.timeZone })}
                labels={ds.fileRow}
                actions={<OpenFile file={file} model={model} actions={actions} />}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Add files under the conversation when the invitation allows it (the link's own upload); else why not, in words. */
function Upload({ page, model, actions }: { page: SharePage; model: InviteViewModel; actions?: InviteActions }) {
  const { t, say } = useSay()
  const ds = useDsWords()
  const held = heldKey(page.upload.held)
  if (!page.upload.canUpload) return held ? <p className="fw-inv-muted">{t(held)}</p> : null
  return (
    <Card padded className="fw-inv-card">
      <section className="fw-inv-upload" aria-label={t('files.upload')}>
      <h3 className="fw-inv-h3">{t('files.upload')}</h3>
      <FileDropzone
        multiple
        accept={acceptOf(page.upload.contentTypes)}
        maxBytes={page.upload.maxBytes}
        disabled={model.upload.busy}
        labels={ds.fileDropzone}
        hint={t('files.uploadHint', { mb: Math.round(page.upload.maxBytes / 1_048_576) })}
        onFiles={(files) => actions?.onFiles?.(files)}
      />
      {model.upload.busy && (
        <p className="fw-inv-muted" role="status">
          <Spinner size={14} /> {t('files.uploading', { name: model.upload.name ?? '' })}
        </p>
      )}
      {model.upload.problem && <Banner tone="danger" title={say(model.upload.problem)} action={<Button size="sm" variant="quiet" onClick={() => actions?.onDismiss?.('upload')}>{t('dismiss')}</Button>} />}
      {model.upload.done && <Banner tone="success" title={say(model.upload.done)} action={<Button size="sm" variant="quiet" onClick={() => actions?.onDismiss?.('upload')}>{t('dismiss')}</Button>} />}
      </section>
    </Card>
  )
}
// ---- end B-TH-274

/** sec:thread — the record's shared thread (messages and files; e-mail replies land here); post with ⌘Enter. */
function Messages({ page, model, actions }: { page: SharePage; model: InviteViewModel; actions?: InviteActions }) {
  const { t, say } = useSay()
  const locale = useLocale()
  const ds = useDsWords()
  const messages = useMemo<PartnerMessage[]>(
    () =>
      threadOldestFirst(page.thread.messages, model.older).map((message) => ({
        id: message.id,
        side: message.side === 'COMPANY' ? 'company' : 'partner',
        channel: message.channel === 'EMAIL' ? 'email' : message.channel === 'PORTAL' ? 'portal' : 'app',
        author: message.author,
        body: message.body,
        attachments: message.attachments.map((file) => ({ id: file.id, name: file.originalName, size: sizeText(file.sizeBytes, locale) })),
        at: message.at,
        atText: formatDateTime(message.at, { locale, timeZone: model.timeZone }),
      })),
    [page.thread.messages, model.older, locale, model.timeZone],
  )
  const held = heldKey(page.thread.held)
  // PartnerThread draws its own frame: no card around it.
  return (
    <div className="fw-inv-thread">
      {model.postProblem && <Banner tone="danger" title={say(model.postProblem)} action={<Button size="sm" variant="quiet" onClick={() => actions?.onDismiss?.('post')}>{t('dismiss')}</Button>} />}
      <PartnerThread
        title={t('thread.title')}
        headingLevel={2}
        companyName={page.from.companyName}
        messages={messages}
        empty={t('thread.empty')}
        labels={ds.partnerThread}
        textareaLabels={ds.textarea}
        loadMore={model.cursor ? { onClick: () => actions?.onMore?.(), busy: model.moreBusy } : null}
        composer={{
          value: model.draft,
          onChange: (value) => actions?.onDraft?.(value),
          onSend: () => actions?.onPost?.(),
          busy: model.posting,
          heldReason: held ? t(held) : null,
          hint: page.thread.replyByEmail ? t('thread.replyByEmail') : null,
          limit: BODY_LIMIT,
          // "Post, attach": the record's files shared with the person may go with the message.
          files: page.files.map((file) => ({ id: file.id, name: file.originalName })),
          attached: model.attached,
          onAttach: (ids) => actions?.onAttach?.(ids),
        }}
      />
    </div>
  )
}

/** sec:notify — new messages by e-mail (a switch, on until the person turns it off). */
function Notify({ page, model, actions }: { page: SharePage; model: InviteViewModel; actions?: InviteActions }) {
  const { t, say } = useSay()
  // B-TH-274: drawn in the side column and again in the "i" sheet: each copy its own ids.
  const id = `fw-inv-notify-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
  return (
    <Card padded className="fw-inv-card">
      <h2 className="fw-inv-h2">{t('notify.title')}</h2>
      <div className="fw-inv-toggle">
        <Toggle id={id} checked={page.share.notifyByEmail} disabled={model.notifyBusy} aria-describedby={`${id}-hint`} aria-label={t('notify.label')} onChange={(next) => actions?.onNotify?.(next)} />
        <label htmlFor={id} className="fw-inv-toggle-label">
          {page.share.notifyByEmail ? t('notify.on') : t('notify.off')}
        </label>
        {model.notifyBusy && <Spinner size={14} />}
      </div>
      <p id={`${id}-hint`} className="fw-inv-muted">
        {t('notify.hint')}
      </p>
      {model.notifyProblem && <Banner tone="danger" title={say(model.notifyProblem)} action={<Button size="sm" variant="quiet" onClick={() => actions?.onDismiss?.('notify')}>{t('dismiss')}</Button>} />}
    </Card>
  )
}
