'use client'

import { useEffect, useMemo, type FormEvent } from 'react'
import { Download, FileCheck2, FileText, KeyRound, Link2Off, ShieldAlert, X } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Input, Pill, Skeleton, Spinner } from '@nexus/ui/primitives'
import { useDsLabels } from '../../../lib/i18n/ds-labels'
import { FileRow } from '../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime, formatTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import type { Translate } from '../../../lib/i18n/messages'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../lib/pdf/labels'
import { WithMessages } from '../../../record-panels/i18n'
import { useLinkRenew } from '../../../shell/links/renew/context'
import { renewEnd, type LinkRenew } from '../../../shell/links/renew/model'
// B-W2b-F17: the reader's optional note to the sender, with the ask.
import { RenewNote } from '../../../shell/links/renew/RenewNote'
import { LinkFrameView } from '../../../shell/links/view/LinkFrameView'
import {
  allClosesLink,
  availableFiles,
  downloadAllHeld,
  downloadHeld,
  downloadsCount,
  isPicture,
  lastDownload,
  locked,
  monthWords,
  newerOnLink,
  offersDownloadAll,
  receiptHeld,
  receiptOpen,
  shortChecksum,
  sizeText,
  standingHold,
  unlockHeld,
  type FileLinkActions,
  type FileLinkViewModel,
  type FilePage,
  type PageFile,
  type Phrase,
} from '../model'
import '../file-link.css'

export type { FileLinkActions } from '../model'

/** The page's model, plus what a design case gives the frame's "Ask for a new link" (the live page leaves it out). */
export type FileLinkDesignModel = FileLinkViewModel & { renew?: LinkRenew | null }

/**
 * SCR-272 — files by link (design links.file; links.document sec:set, sec:password, sec:newer; links.frame; COL-051,
 * MES-274): the link frame (the sender, the language, whom to ask, the privacy notice) around ONE task — what was sent
 * and until when ("Works until 10 Nov · 5 downloads left"), the password sent apart (5 tries, then held 15 minutes),
 * the files (name, size, the checksum short, Download; Download all says how many downloads it uses and is held when
 * fewer are left), a newer version named with a way to it, a shared PDF or picture read in the page (never a secure
 * file), and "I received these files" with an optional name. Every end is the DS EndState; a dead link offers "Ask for
 * a new link". No money anywhere; the payroll file carries hours only.
 */
export function FileLinkView({ model, actions }: { model: FileLinkDesignModel; actions?: FileLinkActions }) {
  return (
    <WithMessages namespaces={['link-files', 'link-frame', 'ds-words']}>
      <FilePageView model={model} actions={actions} />
    </WithMessages>
  )
}

const say = (t: Translate, held: Phrase | null): string | null => (held ? t(held.key, held.params) : null)

function titleOf(t: Translate, page: FilePage, locale: Locale): string {
  if (page.kind === 'payroll' && page.payroll) return t('title.payroll', { month: monthWords(page.payroll.month, locale) })
  return t(`title.${page.kind}`, { sender: page.sender })
}

function FilePageView({ model, actions }: { model: FileLinkDesignModel; actions?: FileLinkActions }) {
  const t = useT('link-files')
  const locale = useLocale()
  const page = model.page
  const dead = model.link === 'expired' || model.link === 'unavailable' ? model.link : null
  return (
    <LinkFrameView
      model={{
        sender: page ? { name: page.sender } : null,
        title: page ? titleOf(t, page, locale) : null,
        body: dead ? { kind: 'link', state: dead, purpose: null, expiresAt: null, usesLeft: null } : { kind: 'task' },
        timeZone: model.timeZone,
        ...(model.renew !== undefined ? { renew: model.renew } : {}),
      }}
    >
      {dead ? null : model.link === 'loading' || !page ? (
        model.link === 'error' ? <ReadError actions={actions} timeZone={model.timeZone} /> : <Loading slow={model.slow} />
      ) : model.link === 'error' ? (
        <ReadError actions={actions} timeZone={model.timeZone} />
      ) : model.link === 'used' ? (
        <UsedEnd page={page} model={model} />
      ) : (
        <Valid page={page} model={model} actions={actions} />
      )}
    </LinkFrameView>
  )
}

// ---- loading, a failed read ------------------------------------------------------------------------------------------

function Loading({ slow }: { slow: boolean }) {
  const t = useT('link-files')
  return (
    <div className="fw-fl" aria-busy="true">
      <Skeleton width="55%" height={18} />
      <Card padded className="fw-fl-card">
        <Skeleton width="40%" height={22} />
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} height={52} />
        ))}
      </Card>
      <p className="fw-fl-hint fw-fl-live" role="status">
        {slow ? (
          <>
            <Spinner size={14} /> {t('loading.slow')}
          </>
        ) : (
          t('loading.now')
        )}
      </p>
    </div>
  )
}

function ReadError({ actions, timeZone }: { actions?: FileLinkActions; timeZone?: string }) {
  const t = useT('link-files')
  const ds = useDsLabels(timeZone)
  return <EndState tone="danger" icon={<ShieldAlert size={28} aria-hidden />} title={t('error.title')} body={t('error.body')} actions={[{ label: t('retry'), variant: 'primary', onClick: () => actions?.onRetry?.() }]} labels={ds.endState} />
}

// ---- the end after the page's own last download ------------------------------------------------------------------

function UsedEnd({ page, model }: { page: FilePage; model: FileLinkDesignModel }) {
  const t = useT('link-files')
  const f = useT('link-frame')
  const locale = useLocale()
  const ds = useDsLabels(model.timeZone)
  const renew = useLinkRenew(model.renew)
  const end = renew ? renewEnd(renew, (key) => f(key, { time: renew.waitUntil ? formatTime(renew.waitUntil, { locale, timeZone: model.timeZone }) : '', sender: page.sender }), page.sender || null) : null
  const downloaded = page.files.filter((file) => model.downloads[file.id] === 'done').map((file) => file.name)
  return (
    <EndState
      tone="info"
      icon={<Link2Off size={28} aria-hidden />}
      title={t('used.title')}
      body={
        <>
          {t('used.body', { sender: page.sender })}
          <RenewNote renew={renew} />
        </>
      }
      facts={[
        ...(downloaded.length > 0 ? [{ label: t('used.downloaded', { count: downloaded.length }), value: downloaded.join(', ') }] : []),
        ...(page.receipt.at ? [{ label: t('receipt.done.at'), value: formatDateTime(page.receipt.at, { locale, timeZone: model.timeZone }) }] : []),
      ]}
      next={end?.next}
      actions={end ? [end.action] : undefined}
      labels={ds.endState}
    />
  )
}

// ---- the link is open --------------------------------------------------------------------------------------------------

function Valid({ page, model, actions }: { page: FilePage; model: FileLinkDesignModel; actions?: FileLinkActions }) {
  const t = useT('link-files')
  const locale = useLocale()
  const left = page.usesLeft
  const counts = downloadsCount(page)
  return (
    <div className="fw-fl">
      <p className="fw-fl-status">
        <span>{t('status.works', { date: formatDate(page.expiresAt, { locale, timeZone: model.timeZone }) })}</span>
        <Pill tone={left <= (counts ? 1 : 3) ? 'warning' : 'neutral'}>{counts ? t('status.downloadsLeft', { count: left }) : t('status.opensLeft', { count: left })}</Pill>
      </p>
      <p className="fw-fl-lead">
        {page.kind === 'payroll' && page.payroll
          ? t('lead.payroll', { sender: page.sender, month: monthWords(page.payroll.month, locale) })
          : t(`lead.${page.kind}`, { sender: page.sender, count: page.count })}
      </p>
      {page.kind === 'payroll' && page.payroll && (
        <Card padded className="fw-fl-card">
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('payroll.month'), value: monthWords(page.payroll.month, locale) },
              ...(page.payroll.number ? [{ label: t('payroll.number'), value: page.payroll.number }] : []),
              { label: t('payroll.revision'), value: page.payroll.revision <= 1 ? t('payroll.first') : t('payroll.corrected', { revision: page.payroll.revision }) },
              { label: t('payroll.what'), value: t('payroll.hoursOnly') },
            ]}
          />
        </Card>
      )}
      {locked(page) ? (
        <PasswordCard page={page} model={model} actions={actions} />
      ) : (
        <>
          <FilesCard page={page} model={model} actions={actions} />
          {page.kind === 'shared' && model.preview && <PreviewCard page={page} model={model} actions={actions} />}
          {page.receipt.asked && <ReceiptCard page={page} model={model} actions={actions} />}
        </>
      )}
      <p className="fw-fl-hint">{t(`logged.${page.kind}`, { sender: page.sender })}</p>
    </div>
  )
}

// ---- sec:password ----------------------------------------------------------------------------------------------------

function PasswordCard({ page, model, actions }: { page: FilePage; model: FileLinkDesignModel; actions?: FileLinkActions }) {
  const t = useT('link-files')
  const locale = useLocale()
  const now = model.now ? new Date(model.now) : new Date()
  const hold = standingHold(model, page, now)
  const held = unlockHeld(model, page, now)
  const problem = model.password.problem
  const error =
    problem?.kind === 'wrong'
      ? problem.triesLeft === null
        ? t('password.wrongPlain')
        : t('password.wrong', { count: problem.triesLeft })
      : problem?.kind === 'empty'
        ? t('password.empty')
        : null
  const time = hold ? formatTime(hold, { locale, timeZone: model.timeZone }) : ''
  const submit = (event: FormEvent) => {
    event.preventDefault()
    actions?.onUnlock?.()
  }
  return (
    <Card padded className="fw-fl-card">
      <h2 className="fw-fl-h2">
        <KeyRound size={18} aria-hidden /> {t('password.title')}
      </h2>
      <p className="fw-fl-hint">{t('password.lead', { sender: page.sender, count: page.count })}</p>
      {problem?.kind === 'relock' && <Banner tone="info" title={t('password.relock')} />}
      {hold && (
        <Banner tone="warning" title={t('password.heldTitle')}>
          {t('password.heldBody', { time, sender: page.sender })}
        </Banner>
      )}
      {problem?.kind === 'failed' && <Banner tone="danger" title={t('password.failed')} />}
      <form className="fw-fl-password" onSubmit={submit} noValidate>
        <Field label={t('password.label')} hint={problem?.kind === 'wrong' && problem.triesLeft === 1 ? t('password.lastTry') : t('password.hint')} error={error}>
          <Input
            type={model.password.shown ? 'text' : 'password'}
            value={model.password.value}
            onChange={(event) => actions?.onPassword?.(event.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            readOnly={!!hold}
          />
        </Field>
        <div className="fw-fl-actions">
          <Button type="submit" variant="primary" heldReason={held ? t(held.key, { ...held.params, time }) : null}>
            {model.password.busy && <Spinner size={14} />} {t('password.open')}
          </Button>
          <Button type="button" variant="quiet" aria-pressed={model.password.shown} onClick={() => actions?.onShowPassword?.()}>
            {model.password.shown ? t('password.hide') : t('password.show')}
          </Button>
        </div>
      </form>
    </Card>
  )
}

// ---- sec:files / sec:set ---------------------------------------------------------------------------------------------

function FilesCard({ page, model, actions }: { page: FilePage; model: FileLinkDesignModel; actions?: FileLinkActions }) {
  const t = useT('link-files')
  const n = availableFiles(page).length
  const allHeld = downloadAllHeld(page, model)
  const counts = downloadsCount(page)

  // "Go to version 4": the row of the newer version takes the focus.
  useEffect(() => {
    if (!model.focus) return
    const row = document.getElementById(`fw-fl-file-${model.focus}`)
    row?.focus()
    row?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }, [model.focus])

  return (
    <Card padded className="fw-fl-card">
      <div className="fw-fl-head">
        <h2 className="fw-fl-h2">{t(`files.title.${page.kind}`, { count: page.files.length })}</h2>
        {offersDownloadAll(page) && (
          <Button variant="primary" heldReason={say(t, allHeld)} onClick={() => actions?.onDownloadAll?.()}>
            {model.all?.busy ? <Spinner size={14} /> : <Download size={16} aria-hidden />} {t('all.label', { count: n })}
          </Button>
        )}
      </div>
      {counts && offersDownloadAll(page) && <p className="fw-fl-hint">{t('all.uses', { count: n, left: page.usesLeft })}</p>}
      {allClosesLink(page) && (
        <Banner tone="warning" title={t('all.closesTitle', { count: page.usesLeft })}>
          {receiptOpen(page) ? t('last.bodyReceipt', { sender: page.sender }) : t('all.closesBody')}
        </Banner>
      )}
      {lastDownload(page) && (
        <Banner tone="warning" title={t('last.title')}>
          {receiptOpen(page) ? t('last.bodyReceipt', { sender: page.sender }) : t('last.body')}
        </Banner>
      )}
      <p className="fw-fl-hint fw-fl-live" role="status">
        {model.all?.busy ? t('all.busy', { done: model.all.done, of: model.all.of }) : model.all && model.all.done < model.all.of ? t('all.partial', { done: model.all.done, of: model.all.of }) : model.all ? t('all.done', { count: model.all.done }) : ''}
      </p>
      {page.files.length === 0 ? (
        <EmptyState icon={<FileText size={28} aria-hidden />} title={t('files.none.title')} description={t('files.none.body', { sender: page.sender })} />
      ) : (
        <ul className="fw-fl-files" aria-label={t(`files.title.${page.kind}`, { count: page.files.length })}>
          {page.files.map((file) => (
            <li key={file.id} id={`fw-fl-file-${file.id}`} tabIndex={-1} className={model.focus === file.id ? 'fw-fl-file is-focus' : 'fw-fl-file'}>
              {file.newer && <NewerBanner page={page} file={file} model={model} actions={actions} />}
              <FileLine page={page} file={file} model={model} actions={actions} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function FileLine({ page, file, model, actions }: { page: FilePage; file: PageFile; model: FileLinkDesignModel; actions?: FileLinkActions }) {
  const t = useT('link-files')
  const locale = useLocale()
  const state = model.downloads[file.id] ?? null
  const gone = !file.available || state === 'gone'
  const held = say(t, downloadHeld(page, model, file.id))
  const label = file.payrollKind ? t(`payroll.kind.${file.payrollKind}`) : null
  const facts = [label, sizeText(file.sizeBytes, locale), t('file.checksum', { sum: shortChecksum(file.sha256) })].filter(Boolean).join(' · ')
  const said = gone ? t('file.gone', { sender: page.sender }) : state === 'busy' ? t('file.busy') : state === 'done' ? t('file.done') : state === 'failed' ? t('file.failed') : null
  return (
    <FileRow
      name={file.name}
      tone={gone || state === 'failed' ? 'danger' : 'neutral'}
      status={
        <span className="fw-fl-file-status" title={t('file.checksumFull', { sum: file.sha256 })}>
          {/* A replaced version says so in its own row too: on a phone the names are cut short. */}
          {file.newer && <Pill tone="warning">{file.newer.versionNo === null ? t('file.replaced') : t('file.replacedBy', { version: file.newer.versionNo })}</Pill>}
          <span>{facts}</span>
          {said && (state === 'done' ? <Pill tone="success">{said}</Pill> : <span className="fw-fl-file-said">{said}</span>)}
        </span>
      }
      actions={
        gone ? null : (
          <>
            {page.kind === 'shared' && file.preview && (
              <Button size="sm" aria-label={t('file.readOf', { name: file.name })} onClick={() => actions?.onPreview?.(file.id)} heldReason={model.preview?.fileId === file.id && model.preview.state === 'loading' ? t('preview.loading') : null}>
                <FileCheck2 size={14} aria-hidden /> {t('file.read')}
              </Button>
            )}
            <Button size="sm" variant={offersDownloadAll(page) ? 'secondary' : 'primary'} aria-label={t('file.downloadOf', { name: file.name })} heldReason={held} onClick={() => actions?.onDownload?.(file.id)}>
              {state === 'busy' ? <Spinner size={14} /> : <Download size={14} aria-hidden />} {state === 'failed' ? t('file.again') : t('file.download')}
            </Button>
          </>
        )
      }
    />
  )
}

// ---- sec:newer -------------------------------------------------------------------------------------------------------

function NewerBanner({ page, file, model, actions }: { page: FilePage; file: PageFile; model: FileLinkDesignModel; actions?: FileLinkActions }) {
  const t = useT('link-files')
  const locale = useLocale()
  const newer = file.newer!
  const date = formatDate(newer.replacedAt, { locale, timeZone: model.timeZone })
  const shared = newerOnLink(page, file)
  return (
    <Banner
      tone="warning"
      title={newer.versionNo === null ? t('newer.titleNoNumber', { date }) : t('newer.title', { version: newer.versionNo, date })}
      action={
        shared ? (
          <Button size="sm" onClick={() => actions?.onGoTo?.(shared.id)}>
            {newer.versionNo === null ? t('newer.goNoNumber') : t('newer.go', { version: newer.versionNo })}
          </Button>
        ) : undefined
      }
    >
      {shared ? t('newer.onLink', { name: shared.name }) : t('newer.ask', { sender: page.sender })}
    </Banner>
  )
}

// ---- a shared file read in the page ----------------------------------------------------------------------------------

function PreviewCard({ page, model, actions }: { page: FilePage; model: FileLinkDesignModel; actions?: FileLinkActions }) {
  const t = useT('link-files')
  const shell = useT('shell')
  const preview = model.preview!
  const file = page.files.find((entry) => entry.id === preview.fileId)
  const picture = isPicture(preview.contentType)
  // A picture's bytes as an address for <img> (this visit only; let go when it changes).
  const address = useMemo(() => (picture && preview.data ? URL.createObjectURL(new Blob([preview.data.slice()], { type: preview.contentType })) : null), [picture, preview.data, preview.contentType])
  useEffect(() => () => (address ? URL.revokeObjectURL(address) : undefined), [address])
  if (!file) return null
  return (
    <Card padded className="fw-fl-card" aria-label={t('preview.of', { name: file.name })}>
      <div className="fw-fl-head">
        <h2 className="fw-fl-h2">{file.name}</h2>
        <Button size="sm" variant="quiet" onClick={() => actions?.onClosePreview?.()}>
          <X size={14} aria-hidden /> {t('preview.close')}
        </Button>
      </div>
      {preview.state === 'loading' ? (
        <div aria-busy="true">
          <p className="fw-fl-hint fw-fl-live" role="status">
            <Spinner size={14} /> {t('preview.loading')}
          </p>
          <Skeleton height={280} />
        </div>
      ) : preview.state === 'failed' || !preview.data ? (
        <EmptyState
          icon={<FileText size={28} aria-hidden />}
          title={t('preview.failed.title')}
          description={t('preview.failed.body')}
          action={
            <Button variant="secondary" onClick={() => actions?.onPreview?.(file.id)}>
              {t('retry')}
            </Button>
          }
        />
      ) : picture ? (
        address && <img className="fw-fl-picture" src={address} alt={file.name} />
      ) : (
        <PdfViewer src={preview.data} title={file.name} fileName={file.name} labels={pdfViewerLabels(shell)} height="min(70vh, 720px)" />
      )}
    </Card>
  )
}

// ---- sec:ack ---------------------------------------------------------------------------------------------------------

function ReceiptCard({ page, model, actions }: { page: FilePage; model: FileLinkDesignModel; actions?: FileLinkActions }) {
  const t = useT('link-files')
  const locale = useLocale()
  const ds = useDsLabels(model.timeZone)
  if (page.receipt.at) {
    return (
      <EndState
        tone="success"
        title={t('receipt.done.title')}
        body={t('receipt.done.body', { sender: page.sender })}
        facts={[
          { label: t('receipt.done.at'), value: formatDateTime(page.receipt.at, { locale, timeZone: model.timeZone }) },
          ...(page.receipt.name ? [{ label: t('receipt.done.name'), value: page.receipt.name }] : []),
        ]}
        focusOnMount={!!model.receipt.confirmedHere}
        labels={ds.endState}
      />
    )
  }
  const held = say(t, receiptHeld(model, page))
  return (
    <Card padded className="fw-fl-card">
      <h2 className="fw-fl-h2">{t('receipt.title')}</h2>
      <p className="fw-fl-hint">{t('receipt.lead', { sender: page.sender })}</p>
      {model.receipt.failed && <Banner tone="danger" title={t('receipt.failed')} />}
      <form
        className="fw-fl-receipt"
        onSubmit={(event) => {
          event.preventDefault()
          actions?.onReceipt?.()
        }}
        noValidate
      >
        <Field label={t('receipt.name')} hint={t('receipt.nameHint', { sender: page.sender })}>
          <Input value={model.receipt.name} onChange={(event) => actions?.onReceiptName?.(event.target.value)} autoComplete="name" />
        </Field>
        <div className="fw-fl-actions">
          <Button type="submit" variant="secondary" heldReason={held}>
            {model.receipt.busy ? <Spinner size={14} /> : <FileCheck2 size={16} aria-hidden />} {t('receipt.send')}
          </Button>
        </div>
      </form>
    </Card>
  )
}
