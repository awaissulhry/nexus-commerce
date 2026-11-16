'use client'

import Link from 'next/link'
import { Download, ExternalLink, FileArchive, ShieldCheck, UserX } from 'lucide-react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { Button, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { DetailModal, JobProgress, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { DataRequest, RequestActionName } from '../api'
import { actionHeld, formHeld, sizeWords, STATUS_PILL, type RequestForm, type RequestsViewModel } from '../model'
import { Clock } from './Clock'

export interface RequestDialogActions {
  onCloseRequest?: () => void
  onRetryRequest?: () => void
  onForm?: (form: RequestForm | null) => void
  onSubmitForm?: () => void
  onCollect?: () => void
  onDownload?: () => void
  onFinish?: () => void
  onErase?: () => void
}

/**
 * One data request (SCR-660 `request`, the list's DetailModal `?request=<id>`): the clock (received, due in force, the first due
 * day once extended and why), the identity check (GDPR art. 12(6): the work starts with it), then per kind — an access request's
 * package (Collect = the worker's background job with its JobProgress; Download = a 60-second link the read log records), an
 * erasure's Anonymise… with what it did, a correction made in the person's own record — and Mark done, Extend, Refuse,
 * Withdrawn. Every held step says why in the page's words (from the API's codes).
 */
export function RequestDialog({ model, actions }: { model: RequestsViewModel; actions?: RequestDialogActions }) {
  const t = useT('admin-privacy-depth')
  const dialog = model.dialog
  if (!dialog) return null
  const request = dialog.read.value
  const title = request ? t('dp.record.title', { kind: t(`dp.kind.${request.kind}`), person: request.person.erased ? t('dp.req.erasedPerson') : request.person.name }) : t('dp.record.loading')
  const held = (action: RequestActionName) => (request ? actionHeld(request, action, model.can) : 'dp.record.loading')
  const footer = request ? (
    <div className="fw-dprq-footer">
      <Button size="sm" onClick={() => actions?.onForm?.({ name: 'extend', months: 1, reason: '' })} heldReason={heldWords(held('extend'), t)} disabled={dialog.busy}>
        {t('dp.action.extend')}
      </Button>
      <Button size="sm" onClick={() => actions?.onForm?.({ name: 'withdraw', reason: '' })} heldReason={heldWords(held('withdraw'), t)} disabled={dialog.busy}>
        {t('dp.action.withdraw')}
      </Button>
      <Button size="sm" variant="danger-outline" onClick={() => actions?.onForm?.({ name: 'refuse', reason: '' })} heldReason={heldWords(held('refuse'), t)} disabled={dialog.busy}>
        {t('dp.action.refuse')}
      </Button>
      <Button size="sm" variant="primary" onClick={() => actions?.onFinish?.()} heldReason={dialog.busy ? t('dp.common.working') : heldWords(held('close'), t)}>
        {t('dp.action.close')}
      </Button>
    </div>
  ) : undefined

  return (
    <DetailModal
      open
      onClose={() => actions?.onCloseRequest?.()}
      title={title}
      subtitle={request ? t('dp.record.subtitle', { company: request.company.name, kind: t(`dp.personKind.${request.person.kind}`) }) : undefined}
      meta={request ? <Pill tone={STATUS_PILL[request.status]}>{t(`dp.status.${request.status}`)}</Pill> : undefined}
      loading={!request && !dialog.read.problem}
      error={dialog.read.problem ? t(dialog.read.problem) : undefined}
      onRetry={actions?.onRetryRequest}
      footer={footer}
    >
      {request && <RequestBody request={request} model={model} actions={actions} />}
    </DetailModal>
  )
}

const heldWords = (key: string | null, t: ReturnType<typeof useT>) => (key ? t(key) : null)

function RequestBody({ request, model, actions }: { request: DataRequest; model: RequestsViewModel; actions?: RequestDialogActions }) {
  const t = useT('admin-privacy-depth')
  const locale = useLocale()
  const dialog = model.dialog!
  const place = { locale, timeZone: model.timeZone }
  const when = (value: string | null) => (value ? formatDateTime(value, place) : '—')
  const held = (action: RequestActionName) => actionHeld(request, action, model.can)
  const personHref = `${model.prefix}${recordAddress({ type: request.person.recordType, id: request.person.recordId, companyId: request.company.id }, OFFICE_PAGES)}`

  return (
    <div className="fw-dprq-body">
      {dialog.done && <Banner tone="success" title={t(dialog.done)} />}
      {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
      {dialog.form && <FormCard form={dialog.form} busy={dialog.busy} actions={actions} />}

      <Card header={t('dp.record.clock')} headingLevel={3} className="fw-dprq-card">
        <KeyValue
          labelCase="sentence"
          items={[
            { label: t('dp.record.due'), value: <Clock request={request} now={model.now} timeZone={model.timeZone} /> },
            { label: t('dp.record.dueAt'), value: when(request.dueAt) },
            { label: t('dp.record.received'), value: when(request.receivedAt) },
            ...(request.extended ? [{ label: t('dp.record.firstDue'), value: when(request.originalDueAt) }, { label: t('dp.record.extendedWhy'), value: request.extensionReason ?? '—' }] : []),
          ]}
        />
        <p className="fw-dprq-muted">{t('dp.record.clockLaw')}</p>
      </Card>

      <Card header={t('dp.record.identity')} headingLevel={3} className="fw-dprq-card">
        {request.identityCheckedAt ? (
          <p className="fw-dprq-line">
            <ShieldCheck size={16} aria-hidden /> {t('dp.record.identityChecked', { date: when(request.identityCheckedAt), name: request.identityCheckedBy?.name || t('dp.common.someone') })}
          </p>
        ) : (
          <div className="fw-dprq-stack">
            <p className="fw-dprq-muted">{t('dp.record.identityNot')}</p>
            <div>
              <Button size="sm" variant="primary" onClick={() => actions?.onForm?.({ name: 'identity', how: '' })} heldReason={heldWords(held('checkIdentity'), t)} disabled={dialog.busy}>
                {t('dp.action.checkIdentity')}
              </Button>
            </div>
          </div>
        )}
      </Card>

      {request.kind === 'ACCESS' && <PackageCard request={request} model={model} actions={actions} />}

      {request.kind === 'ERASURE' && (
        <Card header={t('dp.record.erasure')} headingLevel={3} className="fw-dprq-card">
          {request.erasure && request.erasure.records > 0 ? (
            <p className="fw-dprq-line">{t('dp.record.erased', { anonymised: request.erasure.anonymised, deleted: request.erasure.deleted, kept: request.erasure.kept })}</p>
          ) : (
            <div className="fw-dprq-stack">
              <p className="fw-dprq-muted">{t('dp.record.eraseIntro')}</p>
              <div>
                <Button size="sm" variant="danger" onClick={() => actions?.onErase?.()} heldReason={heldWords(held('erase'), t)} disabled={dialog.busy}>
                  <UserX size={14} aria-hidden /> {t('dp.action.erase')}
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {request.kind === 'CORRECTION' && (
        <Card header={t('dp.record.correction')} headingLevel={3} className="fw-dprq-card">
          <div className="fw-dprq-stack">
            <p className="fw-dprq-muted">{t('dp.record.correctionIntro')}</p>
            {!request.person.erased && (
              <Link className="fw-dprq-link" href={personHref}>
                <ExternalLink size={13} aria-hidden /> {t('dp.record.openPerson')}
              </Link>
            )}
          </div>
        </Card>
      )}

      {(request.note || request.decidedAt) && (
        <Card header={t('dp.record.notes')} headingLevel={3} className="fw-dprq-card">
          <KeyValue
            labelCase="sentence"
            items={[
              ...(request.note ? [{ label: t('dp.record.note'), value: request.note }] : []),
              ...(request.decidedAt ? [{ label: t(`dp.record.decided.${request.status}`), value: t('dp.record.decidedBy', { date: when(request.decidedAt), name: request.decidedBy?.name || t('dp.common.someone') }) }] : []),
              ...(request.refusalReason ? [{ label: t('dp.record.refusal'), value: request.refusalReason }] : []),
            ]}
          />
        </Card>
      )}
    </div>
  )
}

function PackageCard({ request, model, actions }: { request: DataRequest; model: RequestsViewModel; actions?: RequestDialogActions }) {
  const t = useT('admin-privacy-depth')
  const locale = useLocale()
  const dialog = model.dialog!
  const place = { locale, timeZone: model.timeZone }
  const state = request.collect?.state ?? 'NONE'
  const collectHeld = actionHeld(request, 'collect', model.can)
  return (
    <Card header={t('dp.pkg.title')} headingLevel={3} className="fw-dprq-card">
      <div className="fw-dprq-stack">
        <p className="fw-dprq-muted">{t('dp.pkg.intro')}</p>
        {state === 'RUNNING' ? (
          <JobProgress label={t('dp.pkg.collecting')} startedAt={request.collect?.at ? Date.parse(request.collect.at) : undefined} note={t('dp.pkg.collectingNote')} />
        ) : state === 'FAILED' ? (
          <Banner tone="danger" title={t('dp.pkg.failed')} />
        ) : null}
        {request.package ? (
          <KeyValue
            labelCase="sentence"
            items={[
              { label: t('dp.pkg.file'), value: <span className="fw-dprq-line"><FileArchive size={14} aria-hidden /> {request.package.name}</span> },
              { label: t('dp.pkg.size'), value: sizeWords(request.package.sizeBytes, locale) },
              { label: t('dp.pkg.made'), value: request.package.madeAt ? formatDateTime(request.package.madeAt, place) : '—' },
              // B-W2b-GF1 (G274): the package goes on its date.
              ...(request.package.deleteAfter ? [{ label: t('dp.pkg.deleteAfter'), value: formatDateTime(request.package.deleteAfter, place) }] : []),
              { label: t('dp.pkg.sha'), value: <code className="fw-dprq-code">{request.package.sha256.slice(0, 16)}…</code> },
            ]}
          />
        ) : state !== 'RUNNING' ? (
          <p className="fw-dprq-muted">{t('dp.pkg.none')}</p>
        ) : null}
        <div className="fw-dprq-actions">
          <Button size="sm" variant={request.package ? 'secondary' : 'primary'} onClick={() => actions?.onCollect?.()} heldReason={state === 'RUNNING' ? t('dp.pkg.running') : heldWords(collectHeld, t)} disabled={dialog.busy}>
            {t(request.package || state === 'FAILED' ? 'dp.action.collectAgain' : 'dp.action.collect')}
          </Button>
          <Button size="sm" variant={request.package ? 'primary' : 'secondary'} onClick={() => actions?.onDownload?.()} heldReason={heldWords(actionHeld(request, 'openPackage', model.can), t)}>
            <Download size={14} aria-hidden /> {t('dp.action.openPackage')}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function FormCard({ form, busy, actions }: { form: RequestForm; busy: boolean; actions?: RequestDialogActions }) {
  const t = useT('admin-privacy-depth')
  const held = formHeld(form)
  const text = form.name === 'identity' ? form.how : form.reason
  const set = (value: string) => actions?.onForm?.(form.name === 'identity' ? { ...form, how: value } : { ...form, reason: value })
  return (
    <Card header={t(`dp.form.${form.name}.title`)} headingLevel={3} className="fw-dprq-card fw-dprq-form">
      <div className="fw-dprq-stack">
        <p className="fw-dprq-muted">{t(`dp.form.${form.name}.intro`)}</p>
        {form.name === 'extend' && (
          <Field label={t('dp.form.extend.months')}>
            <Select size="sm" value={String(form.months)} onChange={(event) => actions?.onForm?.({ ...form, months: event.target.value === '2' ? 2 : 1 })}>
              <option value="1">{t('dp.form.extend.one')}</option>
              <option value="2">{t('dp.form.extend.two')}</option>
            </Select>
          </Field>
        )}
        <Field label={t(`dp.form.${form.name}.label`)} hint={t(`dp.form.${form.name}.hint`)} required={form.name !== 'withdraw'}>
          <Textarea rows={3} value={text} maxLength={2000} disabled={busy} onChange={(event) => set(event.target.value)} />
        </Field>
        <div className="fw-dprq-actions">
          <Button size="sm" variant={form.name === 'refuse' ? 'danger' : 'primary'} onClick={() => actions?.onSubmitForm?.()} heldReason={busy ? t('dp.common.working') : held ? t(held) : null}>
            {busy && <Spinner size={14} />}
            {t(`dp.form.${form.name}.save`)}
          </Button>
          <Button size="sm" onClick={() => actions?.onForm?.(null)} disabled={busy}>
            {t('dp.common.cancel')}
          </Button>
        </div>
      </div>
    </Card>
  )
}
