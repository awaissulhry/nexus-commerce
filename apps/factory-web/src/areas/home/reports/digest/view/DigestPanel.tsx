'use client'

import { Mail, MailCheck, Send, Settings2, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, SegmentedControl, Select, Skeleton, Spinner, Tag, Toggle } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DIGEST_SECTIONS, type Digest, type DigestLocale, type DigestPreview, type DigestSection } from '../api'
import { changesOf, coveredCompanies, daysWords, draftHeld, heldKey, leftOut, NAMESPACE, recipientRows, WEEKDAYS, type DigestDraft, type Loaded } from '../model'
import '../digest.css'

/** The owner digest panel's model (design home.reports `digest`; Today ⋯ "Daily digest by e-mail" opens the same panel). */
export interface DigestPanelModel {
  readonly digest: Loaded<Digest>
  readonly preview: Loaded<DigestPreview>
  readonly previewLocale: DigestLocale
  /** The form while editing (null: reading). */
  readonly draft: DigestDraft | null
  readonly busy: 'save' | 'test' | 'switch' | null
  readonly offline: boolean
  /** A refusal or a done message, as a message key. */
  readonly notice: { readonly key: string; readonly tone: 'success' | 'danger' | 'warning'; readonly params?: Record<string, string | number> } | null
  /** `card`: a section of Home › Reports; `plain`: inside Today's dialog. */
  readonly frame: 'card' | 'plain'
}

export interface DigestPanelActions {
  onPreviewLocale?: (locale: DigestLocale) => void
  onEdit?: () => void
  onDraft?: (change: Partial<DigestDraft>) => void
  onToggleDay?: (day: number) => void
  onToggleSection?: (section: DigestSection) => void
  onDiscard?: () => void
  onSave?: () => void
  onTest?: () => void
  onSwitch?: (companyId: string, on: boolean) => void
  onRetry?: () => void
  onDismiss?: () => void
}

/**
 * SCR-640 — the owner digest (design home.reports `digest`, ANA-032): every morning's e-mail, previewed. Left: how it goes out —
 * on or off, the time on the site's clock and the weekdays, the language, the companies it covers, where it goes, when next — with
 * Edit (a small form under the DS EditModeBar: ⌘S saves) and Send me a test (held with why while no company's morning e-mail is
 * switched on); for the owner each company's switch (OFF by default) and who gets it there. Right: today's digest as it would go
 * out, in Italiano or English (DS SegmentedControl), its subject and lines; the sections the reader's rights leave out are said.
 * Nothing per person: orders, work orders, lines, alerts and approvals only. One view model, nothing fetched.
 */
export function DigestPanel({ model, actions }: { model: DigestPanelModel; actions?: DigestPanelActions }) {
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Panel model={model} actions={actions} />
    </WithMessages>
  )
}

function Panel({ model, actions }: { model: DigestPanelModel; actions?: DigestPanelActions }) {
  const t = useT(NAMESPACE)
  const title = (
    <span className="fw-dig-title">
      <Mail size={16} aria-hidden /> {t('digest.title')}
    </span>
  )
  const body = <Body model={model} actions={actions} />
  if (model.frame === 'plain') return <div className="fw-dig">{body}</div>
  return (
    <section id="digest" className="fw-dig" aria-labelledby="fw-dig-h">
      <div className="fw-dig-head">
        <h2 id="fw-dig-h" className="fw-dig-h">
          {title}
        </h2>
        <p className="fw-dig-muted">{t('digest.intro')}</p>
      </div>
      <Card padded>{body}</Card>
    </section>
  )
}

function Body({ model, actions }: { model: DigestPanelModel; actions?: DigestPanelActions }) {
  const t = useT(NAMESPACE)
  if (model.digest.status === 'loading') {
    return (
      <div className="fw-dig-grid" aria-busy="true">
        <div className="fw-dig-col">
          <Skeleton height={20} />
          <Skeleton height={20} />
          <Skeleton height={20} />
        </div>
        <div className="fw-dig-col">
          <Skeleton height={120} />
        </div>
        <p className="fw-dig-muted" role="status">
          {t('digest.loading')}
        </p>
      </div>
    )
  }
  if (model.digest.status === 'error') {
    return (
      <EmptyState
        icon={<Mail size={22} aria-hidden />}
        title={t('digest.failed')}
        description={t(model.digest.problem)}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {t('digest.retry')}
          </Button>
        }
      />
    )
  }
  const digest = model.digest.data
  return (
    <div className="fw-dig-stack">
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            actions?.onDismiss ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismiss}>
                {t('digest.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      <div className="fw-dig-grid">
        <div className="fw-dig-col">{model.draft ? <EditForm model={model} digest={digest} draft={model.draft} actions={actions} /> : <Settings model={model} digest={digest} actions={actions} />}</div>
        <div className="fw-dig-col">
          <Preview model={model} actions={actions} />
        </div>
      </div>
      <Switches model={model} digest={digest} actions={actions} />
    </div>
  )
}

/** How it goes out now (reading). */
function Settings({ model, digest, actions }: { model: DigestPanelModel; digest: Digest; actions?: DigestPanelActions }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const setting = digest.setting
  const covered = coveredCompanies(digest, setting.companyId)
  const held = heldKey(digest.held)
  const testHeld = model.offline
    ? t('digest.held.offline')
    : model.busy
      ? t('digest.held.busy')
      : covered.every((company) => !company.mailOn)
        ? t('digest.held.testMailOff')
        : null
  return (
    <div className="fw-dig-stack">
      <div className="fw-dig-row">
        <Tag tone={held ? 'neutral' : 'success'}>{held ? t('digest.state.off') : t('digest.state.on')}</Tag>
        {held && <span className="fw-dig-muted">{t(held)}</span>}
      </div>
      <KeyValue
        columns={1}
        labelCase="sentence"
        items={[
          { label: t('digest.field.when'), value: t('digest.when', { time: setting.sendTime, zone: setting.timeZone, days: daysWords(setting.weekdays, t) }) },
          { label: t('digest.field.language'), value: t(`digest.language.${setting.locale}`) },
          { label: t('digest.field.covers'), value: setting.companyId ? (covered[0]?.name ?? '—') : t('digest.covers.all', { count: digest.companies.length }) },
          { label: t('digest.field.sections'), value: setting.sections.map((section) => t(`digest.section.${section}`)).join(', ') },
          { label: t('digest.field.to'), value: digest.email ?? '—' },
          { label: t('digest.field.next'), value: digest.nextAt ? formatDateTime(digest.nextAt, { locale, timeZone: setting.timeZone }) : t('digest.next.none') },
          { label: t('digest.field.last'), value: setting.lastSentAt ? formatDateTime(setting.lastSentAt, { locale, timeZone: setting.timeZone }) : t('digest.last.never') },
        ]}
      />
      <div className="fw-dig-row">
        <Button size="sm" variant="primary" onClick={() => actions?.onEdit?.()} heldReason={model.offline ? t('digest.held.offline') : undefined}>
          <Settings2 size={14} aria-hidden /> {t('digest.edit')}
        </Button>
        <Button size="sm" onClick={() => actions?.onTest?.()} heldReason={testHeld}>
          {model.busy === 'test' ? <Spinner size={12} /> : <Send size={14} aria-hidden />} {t('digest.test')}
        </Button>
      </div>
      <p className="fw-dig-muted">{t('digest.never')}</p>
    </div>
  )
}

/** The small form (design: Edit opens a small form with the EditModeBar). */
function EditForm({ model, digest, draft, actions }: { model: DigestPanelModel; digest: Digest; draft: DigestDraft; actions?: DigestPanelActions }) {
  const t = useT(NAMESPACE)
  const changes = changesOf(draft, digest.setting)
  const heldKeyOf = model.offline ? 'digest.held.offline' : model.busy ? 'digest.held.busy' : draftHeld(draft, changes)
  const zone = draft.companyId ? (digest.companies.find((company) => company.id === draft.companyId)?.timeZone ?? digest.setting.timeZone) : digest.setting.timeZone
  return (
    <form
      className="fw-dig-stack"
      aria-label={t('digest.form.label')}
      onSubmit={(event) => {
        event.preventDefault()
        if (!heldKeyOf) actions?.onSave?.()
      }}
    >
      <div className="fw-dig-row">
        <Toggle checked={draft.enabled} onChange={(next) => actions?.onDraft?.({ enabled: next })} aria-label={t('digest.form.enabled')} />
        <span>{draft.enabled ? t('digest.form.enabledOn') : t('digest.form.enabledOff')}</span>
      </div>
      <div className="fw-dig-form">
        <Field label={t('digest.form.time')} hint={t('digest.form.timeHint', { zone })}>
          <Input type="time" step={900} value={draft.sendTime} onChange={(event) => actions?.onDraft?.({ sendTime: event.target.value })} />
        </Field>
        <Field label={t('digest.form.language')}>
          <Select value={draft.locale} onChange={(event) => actions?.onDraft?.({ locale: event.target.value === 'en' ? 'en' : 'it' })}>
            <option value="it">{t('digest.language.it')}</option>
            <option value="en">{t('digest.language.en')}</option>
          </Select>
        </Field>
        <Field label={t('digest.form.company')} hint={t('digest.form.companyHint')}>
          <Select value={draft.companyId ?? ''} onChange={(event) => actions?.onDraft?.({ companyId: event.target.value === '' ? null : event.target.value })}>
            {digest.companies.length > 1 && <option value="">{t('digest.covers.all', { count: digest.companies.length })}</option>}
            {digest.companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <fieldset className="fw-dig-fieldset">
        <legend className="fw-dig-legend">{t('digest.form.days')}</legend>
        <div className="fw-dig-checks">
          {WEEKDAYS.map((day) => (
            <Checkbox key={day} label={t(`digest.day.${day}`)} checked={draft.weekdays.includes(day)} onChange={() => actions?.onToggleDay?.(day)} />
          ))}
        </div>
      </fieldset>
      <fieldset className="fw-dig-fieldset">
        <legend className="fw-dig-legend">{t('digest.form.sections')}</legend>
        <div className="fw-dig-checks">
          {DIGEST_SECTIONS.map((section) => (
            <Checkbox key={section} label={t(`digest.section.${section}`)} checked={draft.sections.includes(section)} onChange={() => actions?.onToggleSection?.(section)} />
          ))}
        </div>
      </fieldset>
      <EditModeBar
        count={changes}
        message={changes === 0 ? t('digest.form.noChanges') : t('digest.form.changes', { count: changes })}
        onDiscard={() => actions?.onDiscard?.()}
        onApply={() => actions?.onSave?.()}
        applyLabel={model.busy === 'save' ? t('digest.form.saving') : t('digest.form.save')}
        busy={model.busy === 'save'}
        applyHeldReason={heldKeyOf ? t(heldKeyOf) : null}
        saveShortcut
      />
    </form>
  )
}

/** Today's digest as it would go out (design: "Preview of today's digest in Italiano / English"). */
function Preview({ model, actions }: { model: DigestPanelModel; actions?: DigestPanelActions }) {
  const t = useT(NAMESPACE)
  const preview = model.preview
  return (
    <div className="fw-dig-stack">
      <div className="fw-dig-row fw-dig-row--between">
        <h3 className="fw-dig-h3">{t('digest.preview.title')}</h3>
        <SegmentedControl
          ariaLabel={t('digest.preview.language')}
          size="sm"
          value={model.previewLocale}
          onChange={(value) => actions?.onPreviewLocale?.(value === 'en' ? 'en' : 'it')}
          options={[
            { value: 'it', label: t('digest.language.it') },
            { value: 'en', label: t('digest.language.en') },
          ]}
        />
      </div>
      {preview.status === 'loading' ? (
        <div className="fw-dig-mail" aria-busy="true">
          <Skeleton height={18} />
          <Skeleton height={14} />
          <Skeleton height={14} />
          <Skeleton height={14} />
        </div>
      ) : preview.status === 'error' ? (
        <Banner tone="warning" title={t('digest.preview.failed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('digest.retry')}</Button>}>
          {t(preview.problem)}
        </Banner>
      ) : (
        <>
          {!preview.data.wouldSend && <Banner tone="info" title={t('digest.preview.notSent')} />}
          <article className="fw-dig-mail" aria-label={t('digest.preview.mail')} lang={preview.data.locale}>
            <p className="fw-dig-mail-meta">
              <span className="fw-dig-muted">{t('digest.preview.to')}</span> {preview.data.mail.to ?? '—'}
            </p>
            <p className="fw-dig-mail-subject">
              <MailCheck size={14} aria-hidden /> {preview.data.mail.subject}
            </p>
            <div className="fw-dig-mail-body">
              {preview.data.mail.lines.map((line, index) => (line === '' ? <br key={index} /> : <p key={index}>{line}</p>))}
            </div>
          </article>
          {leftOut(preview.data).length > 0 && (
            <p className="fw-dig-muted fw-dig-row">
              <ShieldOff size={14} aria-hidden /> {t('digest.preview.leftOut', { sections: leftOut(preview.data).map((section) => t(`digest.section.${section}`)).join(', ') })}
            </p>
          )}
        </>
      )}
    </div>
  )
}

/** The owner's switches, one per company, and who gets it there (design: "recipients"). */
function Switches({ model, digest, actions }: { model: DigestPanelModel; digest: Digest; actions?: DigestPanelActions }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const mine = digest.companies.filter((company) => company.maySwitch)
  if (mine.length === 0) return null
  const rows = recipientRows(digest)
  const held = model.offline ? t('digest.held.offline') : model.busy ? t('digest.held.busy') : null
  return (
    <div className="fw-dig-stack fw-dig-switches">
      <h3 className="fw-dig-h3">{t('digest.switch.title')}</h3>
      <p className="fw-dig-muted">{t('digest.switch.intro')}</p>
      <ul className="fw-dig-list">
        {mine.map((company) => (
          <li key={company.id} className="fw-dig-row">
            <Toggle checked={company.mailOn} onChange={(next) => (held ? undefined : actions?.onSwitch?.(company.id, next))} aria-label={t('digest.switch.label', { company: company.name })} disabled={held !== null} title={held ?? undefined} />
            <span>{t(company.mailOn ? 'digest.switch.on' : 'digest.switch.off', { company: company.name })}</span>
            {company.mailOn && company.mailOnAt && <span className="fw-dig-muted">{t('digest.switch.since', { at: formatDateTime(company.mailOnAt, { locale }) })}</span>}
          </li>
        ))}
      </ul>
      {held && <p className="fw-dig-muted">{held}</p>}
      <h3 className="fw-dig-h3">{t('digest.recipients.title')}</h3>
      {rows.length === 0 ? (
        <p className="fw-dig-muted">{t('digest.recipients.none')}</p>
      ) : (
        <SummaryTable
          label={t('digest.recipients.title')}
          stackOnPhone
          columns={[t('digest.recipients.col.person'), t('digest.recipients.col.company'), t('digest.recipients.col.time'), t('digest.recipients.col.language')]}
          rows={rows.map((row) => ({
            id: `${row.companyId}:${row.id}`,
            cells: [row.me ? t('digest.recipients.me', { name: row.name }) : row.name, row.group ? t('digest.recipients.group') : row.company, row.sendTime, t(`digest.language.${row.locale}`)],
          }))}
        />
      )}
    </div>
  )
}
