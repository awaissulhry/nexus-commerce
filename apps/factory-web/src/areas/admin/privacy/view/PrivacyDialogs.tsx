'use client'

import { ExternalLink, FilePlus2, Trash2 } from 'lucide-react'
import { Banner, Field, FileDropzone, KeyValue, Modal, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, Pill, Select, Textarea } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Activity, Notice, NoticeAcks, NoticeKind } from '../api'
import {
  ackWords,
  activityErrors,
  activityPatch,
  draftOf,
  editedLocales,
  KIND_ORDER,
  languageName,
  languagesInOrder,
  missingLanguages,
  newNoticeHeld,
  notYetAcknowledged,
  paperHeld,
  PDF_LANGUAGES,
  publishHeld,
  requiredLanguages,
  type ActivityDraft,
  type ActivityField,
  type NewNoticeDraft,
  type Phrase,
  type PrivacyDialog,
  type PrivacyViewModel,
} from '../model'

export interface DialogActions {
  onCloseDialog?: () => void
  onNewNoticeDraft?: (change: Partial<NewNoticeDraft>) => void
  onCreateNotice?: () => void
  onText?: (locale: string, text: string) => void
  onSaveText?: (locale: string) => void
  onRemoveText?: (locale: string) => void
  onAddLanguage?: (adding: { locale: string; as: 'text' | 'pdf' } | null) => void
  onUploadTextPdf?: (locale: string, file: File) => void
  onPublish?: () => void
  onDeleteDraft?: (confirm: boolean) => void
  onNewVersionFrom?: (kind: NoticeKind) => void
  onOpenFile?: (fileId: string) => void
  onPaper?: (change: Partial<{ workerId: string; locale: string }>) => void
  onRecordPaper?: () => void
  onDpiaScope?: (scope: string) => void
  onCreateDpia?: () => void
  onActivityDraft?: (change: Partial<ActivityDraft>) => void
  onSaveActivity?: () => void
  onConfirmArchive?: () => void
}

/** The one dialog open on the page (each named for what it does; Esc closes, focus returns to the opener). */
export function PrivacyDialogs({ model, actions }: { model: PrivacyViewModel; actions?: DialogActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  if (dialog.kind === 'notice') return <NoticeDialog model={model} dialog={dialog} actions={actions} />
  if (dialog.kind === 'newNotice') return <NewNoticeDialog model={model} dialog={dialog} actions={actions} />
  if (dialog.kind === 'newDpia') return <NewDpiaDialog dialog={dialog} actions={actions} />
  if (dialog.kind === 'activity') return <ActivityDialog model={model} dialog={dialog} actions={actions} />
  return <ArchiveDialog model={model} dialog={dialog} actions={actions} />
}

const STATUS_TONE = { DRAFT: 'info', PUBLISHED: 'success', SUPERSEDED: 'neutral' } as const

function useSay() {
  const t = useT('privacy')
  return (phrase: Phrase | null | undefined) => (phrase ? t(phrase.key, phrase.params) : null)
}

// ---- one notice version ------------------------------------------------------------------------------------------------------

type NoticeDialogState = Extract<PrivacyDialog, { kind: 'notice' }>

function NoticeDialog({ model, dialog, actions }: { model: PrivacyViewModel; dialog: NoticeDialogState; actions?: DialogActions }) {
  const t = useT('privacy')
  const admin = useT('admin')
  const say = useSay()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const notice = dialog.notice.value
  const close = () => actions?.onCloseDialog?.()

  if (!notice) {
    return (
      <Modal open onClose={close} title={t('pv.notice.title')} size="lg">
        {dialog.notice.problem ? <Banner tone="danger" title={t(dialog.notice.problem)} /> : <p className="fw-pv-muted" role="status">{admin('list.loading')}</p>}
      </Modal>
    )
  }

  const draft = notice.status === 'DRAFT'
  const editable = draft && model.can.manage
  const edited = editedLocales(notice, dialog.texts)
  const held = publishHeld(notice, model.can, edited.length > 0)
  const missing = missingLanguages(notice)
  const locales = languagesInOrder(notice.languages)
  // A draft shows the languages it needs (Italian; English too for the worker notice) and any typed in, beside its own.
  const shown = editable ? languagesInOrder([...locales, ...requiredLanguages(notice.kind), ...Object.keys(dialog.texts)].map((code) => ({ locale: code }))) : locales
  const otherDraft = model.notices.value ? draftOf(model.notices.value, notice.kind) : null
  const canNewVersion = model.can.manage && !draft && !otherDraft
  const footer = (
    <>
      {editable && (
        <Button variant="danger-outline" onClick={() => actions?.onDeleteDraft?.(false)} disabled={dialog.busy}>
          <Trash2 size={14} aria-hidden /> {t('pv.notice.deleteDraft')}
        </Button>
      )}
      {canNewVersion && (
        <Button onClick={() => actions?.onNewVersionFrom?.(notice.kind)} disabled={dialog.busy}>
          <FilePlus2 size={14} aria-hidden /> {t('pv.notice.newVersion')}
        </Button>
      )}
      <span className="grow" />
      <Button onClick={close}>{admin('common.close')}</Button>
      {draft && model.can.manage && (
        <Button variant="primary" onClick={actions?.onPublish} heldReason={held ? say(held) : null} disabled={dialog.busy}>
          {t('pv.notice.publish', { label: notice.label })}
        </Button>
      )}
    </>
  )

  return (
    <Modal
      open
      onClose={close}
      size="detail"
      title={t('pv.notice.titleOf', { kind: t(`pv.kind.${notice.kind}.name`), label: notice.label })}
      subtitle={
        <span className="fw-pv-inline">
          <Pill tone={STATUS_TONE[notice.status]}>{t(`pv.status.${notice.status}`)}</Pill>
          <span>{notice.publishedAt ? t('pv.notice.publishedOn', { date: formatDateTime(notice.publishedAt, place) }) : t('pv.notice.notPublished')}</span>
          {notice.supersededAt && <span>{t('pv.notice.replacedOn', { date: formatDate(notice.supersededAt, place) })}</span>}
        </span>
      }
      footer={footer}
    >
      <div className="fw-pv-dialog">
        <Banner tone="warning" title={t('pv.sample.dialogTitle')}>
          {t(draft ? 'pv.sample.dialogBody' : 'pv.sample.dialogBodyPublished')}
        </Banner>
        {dialog.done && <Banner tone="success" title={say(dialog.done)} />}
        {dialog.problem && <Banner tone="danger" title={say(dialog.problem)} />}
        {dialog.confirmDelete && (
          <Banner
            tone="danger"
            title={t('pv.notice.deleteConfirm', { label: notice.label })}
            action={
              <span className="fw-pv-inline">
                <Button size="sm" onClick={() => actions?.onDeleteDraft?.(false)}>
                  {admin('common.cancel')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => actions?.onDeleteDraft?.(true)} disabled={dialog.busy}>
                  {t('pv.notice.deleteNow')}
                </Button>
              </span>
            }
          />
        )}
        <p className="fw-pv-muted">{t(`pv.kind.${notice.kind}.means`)}</p>
        {draft && missing.length > 0 && <Banner tone="info" title={t('pv.notice.missing', { languages: missing.map(languageName).join(', ') })} />}

        <div className="fw-pv-texts">
          {shown.map((code) => {
            const language = notice.languages.find((entry) => entry.locale === code) ?? null
            const typed = dialog.texts[code] ?? language?.body ?? ''
            return (
              <section key={code} className="fw-pv-text" lang={code} aria-label={languageName(code)}>
                <header className="fw-pv-text-head">
                  <h3 className="fw-pv-h3">
                    {languageName(code)} <span className="fw-pv-sub">{code.toUpperCase()}</span>
                  </h3>
                  <span className="fw-pv-inline">
                    {language?.fileId && model.can.files && (
                      <Button size="sm" variant="quiet" onClick={() => actions?.onOpenFile?.(language.fileId!)}>
                        <ExternalLink size={13} aria-hidden /> {t('pv.notice.openPdf')}
                      </Button>
                    )}
                    {language && !language.hasText && <Pill tone="neutral">{t('pv.notice.pdfOnly')}</Pill>}
                  </span>
                </header>
                {editable && (language === null || language.hasText || (dialog.texts[code] ?? '') !== '') ? (
                  <>
                    <Textarea
                      aria-label={t('pv.notice.textOf', { language: languageName(code) })}
                      className="fw-pv-textarea"
                      value={typed}
                      onChange={(event) => actions?.onText?.(code, event.target.value)}
                      dir={code === 'ar' || code === 'ur' ? 'rtl' : undefined}
                    />
                    <span className="fw-pv-inline">
                      <Button size="sm" variant="primary" onClick={() => actions?.onSaveText?.(code)} heldReason={edited.includes(code) ? (typed.trim() === '' ? t('pv.held.emptyText') : null) : t('pv.held.nothingTyped')} disabled={dialog.busy}>
                        {t('pv.notice.saveText')}
                      </Button>
                      {language && (
                        <Button size="sm" variant="quiet" onClick={() => actions?.onRemoveText?.(code)} disabled={dialog.busy}>
                          {t('pv.notice.removeLanguage')}
                        </Button>
                      )}
                    </span>
                  </>
                ) : editable && language && !language.hasText ? (
                  <span className="fw-pv-inline">
                    <span className="fw-pv-muted">{t('pv.notice.pdfLanguage')}</span>
                    <Button size="sm" variant="quiet" onClick={() => actions?.onRemoveText?.(code)} disabled={dialog.busy}>
                      {t('pv.notice.removeLanguage')}
                    </Button>
                  </span>
                ) : language?.body ? (
                  <div className="fw-pv-body">{language.body}</div>
                ) : (
                  <p className="fw-pv-muted">{t('pv.notice.pdfLanguage')}</p>
                )}
              </section>
            )
          })}
        </div>

        {editable && <AddLanguage model={model} dialog={dialog} notice={notice} actions={actions} />}
        {!draft && notice.kind !== 'PRIVACY_PUBLIC' && <Acknowledgements model={model} dialog={dialog} notice={notice} acks={dialog.acks.value} actions={actions} />}
        {notice.kind === 'WORKER_FLOOR' && draft && <p className="fw-pv-muted">{t('pv.notice.publishMeans.WORKER_FLOOR')}</p>}
      </div>
    </Modal>
  )
}

function AddLanguage({ model, dialog, notice, actions }: { model: PrivacyViewModel; dialog: NoticeDialogState; notice: Notice; actions?: DialogActions }) {
  const t = useT('privacy')
  const taken = new Set(notice.languages.map((language) => language.locale))
  const choices = PDF_LANGUAGES.filter((code) => !taken.has(code))
  const adding = dialog.adding
  if (choices.length === 0) return null
  return (
    <section className="fw-pv-add" aria-label={t('pv.notice.addLanguage')}>
      <h3 className="fw-pv-h3">{t('pv.notice.addLanguage')}</h3>
      <p className="fw-pv-muted">{t('pv.notice.addLanguageIntro')}</p>
      <div className="fw-pv-inline">
        <Select size="sm" aria-label={t('pv.notice.language')} value={adding?.locale ?? ''} onChange={(event) => actions?.onAddLanguage?.(event.target.value ? { locale: event.target.value, as: adding?.as ?? 'pdf' } : null)}>
          <option value="">{t('pv.notice.pickLanguage')}</option>
          {choices.map((code) => (
            <option key={code} value={code}>
              {languageName(code)}
            </option>
          ))}
        </Select>
        {adding && (
          <Select size="sm" aria-label={t('pv.notice.addAs')} value={adding.as} onChange={(event) => actions?.onAddLanguage?.({ locale: adding.locale, as: event.target.value as 'text' | 'pdf' })}>
            <option value="pdf">{t('pv.notice.asPdf')}</option>
            <option value="text">{t('pv.notice.asText')}</option>
          </Select>
        )}
      </div>
      {adding?.as === 'pdf' &&
        (model.can.upload ? (
          <FileDropzone accept=".pdf" maxBytes={20 * 1024 * 1024} disabled={model.uploading || dialog.busy} hint={t('pv.notice.dropPdf', { language: languageName(adding.locale) })} onFiles={(files) => files[0] && actions?.onUploadTextPdf?.(adding.locale, files[0])} />
        ) : (
          <p className="fw-pv-muted">{t('pv.held.upload')}</p>
        ))}
      {adding?.as === 'text' && <p className="fw-pv-muted">{t('pv.notice.textAdded', { language: languageName(adding.locale) })}</p>}
    </section>
  )
}

function Acknowledgements({ model, dialog, notice, acks, actions }: { model: PrivacyViewModel; dialog: NoticeDialogState; notice: Notice; acks: NoticeAcks | null; actions?: DialogActions }) {
  const t = useT('privacy')
  const say = useSay()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const counts = acks?.counts ?? notice.acknowledgements
  const words = ackWords(counts)
  const waiting = notYetAcknowledged(acks?.people)
  const held = paperHeld(notice, acks, model.can, dialog.paper)
  return (
    <section className="fw-pv-acks" aria-label={t('pv.ack.title')}>
      <h3 className="fw-pv-h3">{t('pv.ack.title')}</h3>
      <p className="fw-pv-ack-line">
        <strong>{t(words.key, words.params)}</strong>
        {counts && counts.notAcknowledged > 0 && <span className="fw-pv-warning"> · {t('pv.ack.notYetN', { count: counts.notAcknowledged })}</span>}
      </p>
      {dialog.acks.problem && <Banner tone="danger" title={t(dialog.acks.problem)} />}
      {acks?.people ? (
        <>
          <p className="fw-pv-muted">{t('pv.ack.namesHere')}</p>
          {acks.people.length > 0 && (
            <SummaryTable
              label={t('pv.ack.title')}
              stackOnPhone
              columns={[t('pv.ack.person'), t('pv.ack.when'), t('pv.ack.how'), t('pv.ack.language')]}
              align={['left', 'left', 'left', 'left']}
              rows={acks.people.map((person) => ({
                id: person.id,
                cells: [
                  person.displayName,
                  person.acknowledgedAt ? formatDateTime(person.acknowledgedAt, place) : <span className="fw-pv-warning">{t('pv.ack.notYetOne')}</span>,
                  person.channel ? t(`pv.ack.channel.${person.channel}`) : '—',
                  person.locale ? languageName(person.locale) : '—',
                ],
              }))}
            />
          )}
          {notice.kind === 'WORKER_FLOOR' && notice.status === 'PUBLISHED' && model.can.manage && (
            <div className="fw-pv-paper">
              <h4 className="fw-pv-h4">{t('pv.paper.title')}</h4>
              <p className="fw-pv-muted">{t('pv.paper.intro')}</p>
              {waiting.length === 0 ? (
                <p className="fw-pv-muted">{t('pv.paper.everyone')}</p>
              ) : (
                <div className="fw-pv-inline">
                  <Select size="sm" aria-label={t('pv.paper.worker')} value={dialog.paper.workerId} onChange={(event) => actions?.onPaper?.({ workerId: event.target.value })}>
                    <option value="">{t('pv.paper.pickWorker')}</option>
                    {waiting.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.displayName}
                      </option>
                    ))}
                  </Select>
                  <Select size="sm" aria-label={t('pv.paper.language')} value={dialog.paper.locale} onChange={(event) => actions?.onPaper?.({ locale: event.target.value })}>
                    {languagesInOrder(notice.languages).map((code) => (
                      <option key={code} value={code}>
                        {languageName(code)}
                      </option>
                    ))}
                  </Select>
                  <Button size="sm" variant="primary" onClick={actions?.onRecordPaper} heldReason={held ? say(held) : null} disabled={dialog.busy}>
                    {t('pv.paper.record')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <p className="fw-pv-muted">{t('pv.ack.countsOnly')}</p>
      )}
    </section>
  )
}

// ---- a new notice version ----------------------------------------------------------------------------------------------------

function NewNoticeDialog({ model, dialog, actions }: { model: PrivacyViewModel; dialog: Extract<PrivacyDialog, { kind: 'newNotice' }>; actions?: DialogActions }) {
  const t = useT('privacy')
  const admin = useT('admin')
  const say = useSay()
  const held = newNoticeHeld(dialog.draft, model.notices.value ?? [], model.can)
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      size="md"
      title={t('pv.newNotice.title')}
      footer={
        <>
          <Button onClick={() => actions?.onCloseDialog?.()}>{admin('common.cancel')}</Button>
          <Button variant="primary" onClick={actions?.onCreateNotice} heldReason={held ? say(held) : null} disabled={dialog.busy}>
            {t('pv.newNotice.create')}
          </Button>
        </>
      }
    >
      <div className="fw-pv-dialog">
        {dialog.problem && <Banner tone="danger" title={say(dialog.problem)} />}
        <Field label={t('pv.newNotice.kind')} hint={t(`pv.kind.${dialog.draft.kind}.means`)}>
          <Select value={dialog.draft.kind} onChange={(event) => actions?.onNewNoticeDraft?.({ kind: event.target.value as NoticeKind })}>
            {KIND_ORDER.map((kind) => (
              <option key={kind} value={kind}>
                {t(`pv.kind.${kind}.name`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('pv.newNotice.label')} hint={t('pv.newNotice.labelHint')} required>
          <Input value={dialog.draft.label} maxLength={40} onChange={(event) => actions?.onNewNoticeDraft?.({ label: event.target.value })} />
        </Field>
        <Checkbox checked={dialog.draft.copyTexts} onChange={(event) => actions?.onNewNoticeDraft?.({ copyTexts: event.target.checked })} label={t('pv.newNotice.copy')} />
        <p className="fw-pv-muted">{t('pv.newNotice.after')}</p>
      </div>
    </Modal>
  )
}

// ---- a new DPIA draft -------------------------------------------------------------------------------------------------------

function NewDpiaDialog({ dialog, actions }: { dialog: Extract<PrivacyDialog, { kind: 'newDpia' }>; actions?: DialogActions }) {
  const t = useT('privacy')
  const admin = useT('admin')
  const say = useSay()
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      size="md"
      title={t('pv.dpia.newTitle')}
      footer={
        <>
          <Button onClick={() => actions?.onCloseDialog?.()}>{admin('common.cancel')}</Button>
          <Button variant="primary" onClick={actions?.onCreateDpia} disabled={dialog.busy}>
            {t('pv.dpia.create')}
          </Button>
        </>
      }
    >
      <div className="fw-pv-dialog">
        {dialog.problem && <Banner tone="danger" title={say(dialog.problem)} />}
        <Field label={t('pv.dpia.scope')} hint={t('pv.dpia.scopeHint')}>
          <Textarea className="fw-pv-textarea short" value={dialog.scope} maxLength={5000} onChange={(event) => actions?.onDpiaScope?.(event.target.value)} />
        </Field>
        <p className="fw-pv-muted">{t('pv.dpia.after')}</p>
      </div>
    </Modal>
  )
}

// ---- a processing activity -------------------------------------------------------------------------------------------------

const FORM: ReadonlyArray<{ field: ActivityField; long?: boolean; list?: boolean }> = [
  { field: 'name' },
  { field: 'purpose', long: true },
  { field: 'legalBasis', long: true },
  { field: 'dataSubjects', list: true },
  { field: 'dataCategories', list: true },
  { field: 'recipients', list: true },
  { field: 'processors', list: true },
  { field: 'transfers', long: true },
  { field: 'retention', long: true },
  { field: 'security', long: true },
]

function ActivityDialog({ model, dialog, actions }: { model: PrivacyViewModel; dialog: Extract<PrivacyDialog, { kind: 'activity' }>; actions?: DialogActions }) {
  const t = useT('privacy')
  const admin = useT('admin')
  const say = useSay()
  const isNew = dialog.activityId === null
  const activity = dialog.activityId ? (model.register.value ?? []).find((row) => row.id === dialog.activityId) ?? null : null
  const editable = model.can.manage && (isNew || activity?.status === 'ACTIVE')
  const errors = activityErrors(dialog.draft, isNew)
  const unchanged = !isNew && activity ? activityPatch(activity, dialog.draft) === null : false
  const held = !editable ? t('pv.held.manage') : Object.keys(errors).length > 0 ? t('pv.held.form') : unchanged ? t('pv.held.nothingChanged') : null
  const shownError = (field: ActivityField) => (dialog.showErrors && errors[field] ? t(errors[field]!) : undefined)
  const title = isNew ? t('pv.register.newTitle') : t(editable ? 'pv.register.editTitle' : 'pv.register.viewTitle', { name: activity?.name ?? dialog.draft.name })
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      size="xl"
      title={title}
      subtitle={activity ? <Pill tone={activity.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`pv.activityStatus.${activity.status}`)}</Pill> : undefined}
      footer={
        <>
          <Button onClick={() => actions?.onCloseDialog?.()}>{admin(editable ? 'common.cancel' : 'common.close')}</Button>
          {editable && (
            <Button variant="primary" onClick={actions?.onSaveActivity} heldReason={held} disabled={dialog.busy}>
              {t(isNew ? 'pv.register.add' : 'pv.register.save')}
            </Button>
          )}
        </>
      }
    >
      <div className="fw-pv-dialog">
        {dialog.problem && <Banner tone="danger" title={say(dialog.problem)} />}
        {!editable && activity ? (
          <KeyValue
            items={[
              { label: t('pv.form.code'), value: activity.code },
              ...FORM.map(({ field }) => {
                const value = activity[field as keyof Activity]
                return { label: t(`pv.form.${field}`), value: Array.isArray(value) ? (value.length > 0 ? value.join(' · ') : '—') : String(value || '—') }
              }),
            ]}
          />
        ) : (
          <div className="fw-pv-form-grid">
            {isNew && (
              <Field label={t('pv.form.code')} hint={t('pv.form.codeHint')} error={shownError('code')} required>
                <Input value={dialog.draft.code} maxLength={40} onChange={(event) => actions?.onActivityDraft?.({ code: event.target.value.toUpperCase() })} />
              </Field>
            )}
            {FORM.map(({ field, long, list }) => (
              <Field
                key={field}
                label={t(`pv.form.${field}`)}
                hint={list ? t(field === 'processors' ? 'pv.form.processorsHint' : 'pv.form.listHint') : undefined}
                error={shownError(field)}
                required={field !== 'recipients' && field !== 'processors'}
              >
                {long || list ? (
                  <Textarea className="fw-pv-textarea short" value={dialog.draft[field as keyof ActivityDraft]} onChange={(event) => actions?.onActivityDraft?.({ [field]: event.target.value } as Partial<ActivityDraft>)} />
                ) : (
                  <Input value={dialog.draft[field as keyof ActivityDraft]} onChange={(event) => actions?.onActivityDraft?.({ [field]: event.target.value } as Partial<ActivityDraft>)} />
                )}
              </Field>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

function ArchiveDialog({ model, dialog, actions }: { model: PrivacyViewModel; dialog: Extract<PrivacyDialog, { kind: 'archive' }>; actions?: DialogActions }) {
  const t = useT('privacy')
  const admin = useT('admin')
  const say = useSay()
  const activity = (model.register.value ?? []).find((row) => row.id === dialog.activityId)
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      size="sm"
      title={t('pv.archive.title', { name: activity?.name ?? '' })}
      footer={
        <>
          <Button onClick={() => actions?.onCloseDialog?.()}>{admin('common.cancel')}</Button>
          <Button variant="danger" onClick={actions?.onConfirmArchive} disabled={dialog.busy}>
            {t('pv.archive.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-pv-dialog">
        {dialog.problem && <Banner tone="danger" title={say(dialog.problem)} />}
        <p>{t('pv.archive.body')}</p>
      </div>
    </Modal>
  )
}
