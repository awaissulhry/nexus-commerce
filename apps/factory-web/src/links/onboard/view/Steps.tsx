'use client'

import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, FileText, Plus, Trash2 } from 'lucide-react'
import { COUNTRY_CODES } from '@nexus/factory-domain/parties/geo'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { SignBlock } from '@nexus/ui/components/SignBlock/index'
import { Button, Checkbox, Input, Pill, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, FileDropzone, Textarea } from '../../../lib/i18n/ds-parts'
import { formatDate } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { STEPS_OF_SITES, type OnboardPage, type QuestionView, type SiteBody, type SiteStep } from '../api'
import {
  answerSummary,
  DOCUMENT_ACCEPT,
  DOCUMENT_MAX_BYTES,
  fieldId,
  fileOfAnswer,
  problemAt,
  problemsOf,
  questionsIn,
  STEPS,
  vatWords,
  type OnboardActions,
  type OnboardViewModel,
  type Problem,
  type Step,
} from '../model'

interface StepProps {
  page: OnboardPage
  model: OnboardViewModel
  actions?: OnboardActions
}

type T = (key: string, params?: Record<string, string | number>) => string

/** The problems of the whole form (the domain's checks), computed once per draw. */
function useProblems(page: OnboardPage, model: OnboardViewModel): readonly Problem[] {
  return useMemo(() => problemsOf(model.form, page, model.today), [model.form, page, model.today])
}

/** The words of a problem at a field, or undefined (our catalogue's, by the check's code). */
function errorAt(t: T, model: OnboardViewModel, problems: readonly Problem[], path: string): string | undefined {
  const problem = problemAt(model, problems, path)
  return problem ? t(`check.${problem.code}`) : undefined
}

/** A problem under a group of choices (a fieldset): said, and read with the group. */
function GroupError({ id, text }: { id: string; text: string | undefined }) {
  if (!text) return null
  return (
    <p id={`${id}-error`} className="fw-ob-error" role="alert">
      {text}
    </p>
  )
}

/** Design sec:intro — Why we ask: due diligence explained, how long, saved with us, who reads it. */
export function Intro({ page }: { page: OnboardPage }) {
  const t = useT('link-onboard')
  const locale = useLocale()
  return (
    <Card padded className="fw-ob-card fw-ob-intro">
      <h2 className="fw-ob-h3">{t('intro.title')}</h2>
      <p className="fw-ob-text">{t('intro.why', { company: page.sender.companyName })}</p>
      <ul className="fw-ob-points">
        <li>{t('intro.time')}</li>
        <li>{t('intro.later', { day: formatDate(page.link.expiresAt, { locale }) })}</li>
        <li>{page.reviewer ? t('intro.readerNamed', { name: page.reviewer.name, company: page.sender.companyName }) : t('intro.reader', { company: page.sender.companyName })}</li>
      </ul>
      {page.note && (
        <Banner tone="info" title={t('intro.note', { company: page.sender.companyName })}>
          <span className="fw-ob-pre">{page.note}</span>
        </Banner>
      )}
    </Card>
  )
}

function Questions({ page, model, actions, step }: StepProps & { step: Step }) {
  const t = useT('link-onboard')
  const problems = useProblems(page, model)
  const questions = questionsIn(page, step)
  if (questions.length === 0) return <p className="fw-ob-hint">{t('step.empty')}</p>
  return (
    <div className="fw-ob-fields">
      {questions.map((question) => (
        <QuestionField key={question.key} question={question} page={page} model={model} actions={actions} problems={problems} t={t} />
      ))}
    </div>
  )
}

export const CompanyStep = (props: StepProps) => <Questions {...props} step="company" />
export const ContactsStep = (props: StepProps) => <Questions {...props} step="contacts" />
export const SitesStep = (props: StepProps) => <Questions {...props} step="sites" />
export const CertificationsStep = (props: StepProps) => <Questions {...props} step="certifications" />
export const LabourStep = (props: StepProps) => <Questions {...props} step="labour" />

interface FieldProps extends StepProps {
  question: QuestionView
  problems: readonly Problem[]
  t: T
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

function QuestionField(props: FieldProps) {
  const { question, model, actions, problems, t } = props
  const locale = useLocale()
  const label = question.text[locale]
  const hint = question.help?.[locale]
  const entry = model.form.answers[question.key]
  const path = `answers/${question.key}/value`
  const id = fieldId(path)
  switch (question.kind) {
    case 'TEXT':
    case 'URL':
      return (
        <Field label={label} required={question.required} hint={hint} error={errorAt(t, model, problems, path)} htmlFor={id}>
          <Input id={id} value={textOf(entry?.value)} type={question.kind === 'URL' ? 'url' : 'text'} inputMode={question.kind === 'URL' ? 'url' : undefined} autoComplete={question.kind === 'URL' ? 'url' : 'organization'} onChange={(event) => actions?.onAnswer?.(question.key, { value: event.target.value })} />
        </Field>
      )
    case 'LONG_TEXT':
    case 'ADDRESS':
      return (
        <Field label={label} required={question.required} hint={hint} error={errorAt(t, model, problems, path)} htmlFor={id}>
          <Textarea id={id} rows={question.kind === 'ADDRESS' ? 3 : 4} value={textOf(entry?.value)} onChange={(event) => actions?.onAnswer?.(question.key, { value: event.target.value })} />
        </Field>
      )
    case 'VAT':
      return <VatField {...props} />
    case 'CONTACT':
      return <ContactField {...props} />
    case 'FILE':
      return <DocumentField {...props} />
    case 'YES_NO':
      return <YesNoField {...props} />
    case 'CHOICE':
      return <ChoiceField {...props} />
    case 'SIGN':
      return <SignField {...props} />
    case 'SITES':
    case 'SUB_TIER_SITES':
      return <SitesField {...props} />
  }
}

/** Design sec:company — the VAT number, checked live in VIES ("Valid — name matches"). */
function VatField({ question, page, model, actions, problems, t }: FieldProps) {
  const locale = useLocale()
  const path = `answers/${question.key}/value`
  const id = fieldId(path)
  const value = textOf(model.form.answers[question.key]?.value)
  const said = vatWords(model, value)
  const tone = said === 'vat.validName' || said === 'vat.valid' || said === 'vat.NOT_CHECKED' ? 'success' : said === 'vat.validOtherName' || said === 'vat.ERROR' || said === 'vat.failed' ? 'warning' : said === 'vat.INVALID' || said === 'vat.FORMAT' ? 'danger' : 'neutral'
  return (
    <Field label={question.text[locale]} required={question.required} hint={question.help?.[locale]} error={errorAt(t, model, problems, path)} htmlFor={id}>
      <div className="fw-ob-inline">
        <Input id={id} value={value} autoComplete="off" spellCheck={false} onChange={(event) => actions?.onAnswer?.(question.key, { value: event.target.value })} onBlur={() => value.trim() && actions?.onVat?.()} />
        <Button size="sm" onClick={() => actions?.onVat?.()} heldReason={value.trim() === '' ? t('vat.held') : model.vat.status === 'checking' ? t('vat.checking') : null}>
          {t('vat.check')}
        </Button>
      </div>
      {said && (
        <p className="fw-ob-status" role="status">
          {model.vat.status === 'checking' ? <Spinner size={14} /> : <Pill tone={tone}>{t(said)}</Pill>}
          {said === 'vat.validOtherName' && <span className="fw-ob-hint">{t('vat.otherNameHint')}</span>}
        </p>
      )}
      {page.supplier.vatNumber && value.replace(/\s+/g, '').toUpperCase() !== page.supplier.vatNumber.toUpperCase() && <p className="fw-ob-hint">{t('vat.onFile', { vat: page.supplier.vatNumber })}</p>}
    </Field>
  )
}

/** Design sec:contacts — name, e-mail and phone of the person for orders, invoices, quality. */
function ContactField({ question, model, actions, problems, t }: FieldProps) {
  const locale = useLocale()
  const value = (model.form.answers[question.key]?.value ?? {}) as Record<string, unknown>
  const base = `answers/${question.key}/value`
  const set = (field: 'name' | 'email' | 'phone', text: string) => actions?.onAnswer?.(question.key, { value: { name: textOf(value.name), email: textOf(value.email), phone: textOf(value.phone), [field]: text } })
  return (
    <fieldset className="fw-ob-group">
      <legend className="fw-ob-legend">
        {question.text[locale]}
        {question.required && <span className="fw-ob-required" aria-hidden> *</span>}
      </legend>
      <div className="fw-ob-grid">
        <Field label={t('contact.name')} required={question.required} error={errorAt(t, model, problems, `${base}/name`)} htmlFor={fieldId(`${base}/name`)}>
          <Input id={fieldId(`${base}/name`)} value={textOf(value.name)} autoComplete="name" onChange={(event) => set('name', event.target.value)} />
        </Field>
        <Field label={t('contact.email')} required={question.required} error={errorAt(t, model, problems, `${base}/email`)} htmlFor={fieldId(`${base}/email`)}>
          <Input id={fieldId(`${base}/email`)} type="email" inputMode="email" autoComplete="email" value={textOf(value.email)} onChange={(event) => set('email', event.target.value)} />
        </Field>
        <Field label={t('contact.phone')} error={errorAt(t, model, problems, `${base}/phone`)} htmlFor={fieldId(`${base}/phone`)}>
          <Input id={fieldId(`${base}/phone`)} type="tel" inputMode="tel" autoComplete="tel" value={textOf(value.phone)} onChange={(event) => set('phone', event.target.value)} />
        </Field>
      </div>
    </fieldset>
  )
}

/** Design sec:certs — a document with its issue and expiry day, captured once (uploaded as soon as it is chosen). */
function DocumentField({ question, model, actions, problems, t }: FieldProps) {
  const locale = useLocale()
  const base = `answers/${question.key}/value`
  const id = fieldId(base)
  const file = fileOfAnswer(model.form, question.key)
  const uploaded = file ? model.files.find((entry) => entry.id === file.fileId) : undefined
  const upload = model.uploads[question.key]
  const set = (field: 'issuer' | 'number' | 'issuedOn' | 'expiresOn', text: string) => {
    if (!file) return
    actions?.onAnswer?.(question.key, { value: { ...file, [field]: text === '' ? null : text } })
  }
  return (
    <fieldset className="fw-ob-group" id={id} aria-describedby={errorAt(t, model, problems, base) ? `${id}-error` : undefined}>
      <legend className="fw-ob-legend">
        {question.text[locale]}
        {question.required ? <span className="fw-ob-required" aria-hidden> *</span> : <span className="fw-ob-optional"> {t('field.optional')}</span>}
      </legend>
      {question.help?.[locale] && <p className="fw-ob-hint">{question.help[locale]}</p>}
      {file ? (
        <div className="fw-ob-file">
          <FileText size={18} aria-hidden />
          <span className="fw-ob-file-name">{uploaded?.name ?? t('upload.done')}</span>
          {uploaded && uploaded.status !== 'AVAILABLE' && <Pill tone="warning">{t('upload.checking')}</Pill>}
          <Button size="sm" variant="quiet" onClick={() => actions?.onRemoveFile?.(question.key)}>
            <Trash2 size={14} aria-hidden /> {t('upload.remove')}
          </Button>
        </div>
      ) : upload?.kind === 'uploading' ? (
        <p className="fw-ob-status" role="status">
          <Spinner size={14} /> {t('upload.busy', { name: upload.name })}
        </p>
      ) : (
        <FileDropzone accept={DOCUMENT_ACCEPT} maxBytes={DOCUMENT_MAX_BYTES} hint={t('upload.hint')} onFiles={(files) => files[0] && actions?.onUpload?.(question.key, files[0])} />
      )}
      {upload?.kind === 'failed' && (
        <p className="fw-ob-error" role="alert">
          {t(upload.key, { name: upload.name })}
        </p>
      )}
      <GroupError id={id} text={errorAt(t, model, problems, base)} />
      {file && (
        <div className="fw-ob-grid">
          <Field label={t('document.issuer')} htmlFor={fieldId(`${base}/issuer`)} error={errorAt(t, model, problems, `${base}/issuer`)}>
            <Input id={fieldId(`${base}/issuer`)} value={file.issuer} onChange={(event) => set('issuer', event.target.value)} />
          </Field>
          <Field label={t('document.number')} htmlFor={fieldId(`${base}/number`)} error={errorAt(t, model, problems, `${base}/number`)}>
            <Input id={fieldId(`${base}/number`)} value={file.number} onChange={(event) => set('number', event.target.value)} />
          </Field>
          <Field label={t('document.issuedOn')} htmlFor={fieldId(`${base}/issuedOn`)} error={errorAt(t, model, problems, `${base}/issuedOn`)}>
            <DateField id={fieldId(`${base}/issuedOn`)} value={file.issuedOn} max={model.today} clearable onChange={(value) => set('issuedOn', value)} />
          </Field>
          <Field label={t('document.expiresOn')} hint={t('document.expiresHint')} htmlFor={fieldId(`${base}/expiresOn`)} error={errorAt(t, model, problems, `${base}/expiresOn`)}>
            <DateField id={fieldId(`${base}/expiresOn`)} value={file.expiresOn} min={model.today} clearable onChange={(value) => set('expiresOn', value)} />
          </Field>
        </div>
      )}
    </fieldset>
  )
}

/** Design sec:labour — Yes / No, and words when the answer needs them. */
function YesNoField({ question, model, actions, problems, t }: FieldProps) {
  const locale = useLocale()
  const entry = model.form.answers[question.key]
  const base = `answers/${question.key}`
  const id = fieldId(`${base}/value`)
  const error = errorAt(t, model, problems, `${base}/value`)
  const value = entry?.value
  const needsWords = question.explain !== null && question.explain !== undefined && value === question.explain
  return (
    <fieldset className="fw-ob-group" id={id} aria-describedby={error ? `${id}-error` : undefined}>
      <legend className="fw-ob-legend">
        {question.text[locale]}
        {question.required && <span className="fw-ob-required" aria-hidden> *</span>}
      </legend>
      {question.help?.[locale] && <p className="fw-ob-hint">{question.help[locale]}</p>}
      <div className="fw-ob-yesno" role="radiogroup" aria-label={question.text[locale]}>
        {(['YES', 'NO'] as const).map((answer) => (
          <RadioCard key={answer} name={id} value={answer} checked={value === answer} selected={value === answer} onChange={() => actions?.onAnswer?.(question.key, { value: answer, explain: entry?.explain ?? null })} title={t(answer === 'YES' ? 'answer.yes' : 'answer.no')} />
        ))}
      </div>
      <GroupError id={id} text={error} />
      {(needsWords || (value !== undefined && textOf(entry?.explain) !== '')) && (
        <Field label={needsWords ? t('answer.explainNeeded') : t('answer.explain')} required={needsWords} error={errorAt(t, model, problems, `${base}/explain`)} htmlFor={fieldId(`${base}/explain`)}>
          <Textarea id={fieldId(`${base}/explain`)} rows={3} value={textOf(entry?.explain)} onChange={(event) => actions?.onAnswer?.(question.key, { value, explain: event.target.value })} />
        </Field>
      )}
      {!needsWords && value !== undefined && textOf(entry?.explain) === '' && (
        <Button size="sm" variant="link" onClick={() => actions?.onAnswer?.(question.key, { value, explain: ' ' })}>
          {t('answer.addWords')}
        </Button>
      )}
    </fieldset>
  )
}

/** A choice among the question's options (the LWG rating …). */
function ChoiceField({ question, model, actions, problems, t }: FieldProps) {
  const locale = useLocale()
  const base = `answers/${question.key}/value`
  const id = fieldId(base)
  const error = errorAt(t, model, problems, base)
  const value = model.form.answers[question.key]?.value
  return (
    <fieldset className="fw-ob-group" id={id} aria-describedby={error ? `${id}-error` : undefined}>
      <legend className="fw-ob-legend">
        {question.text[locale]}
        {question.required && <span className="fw-ob-required" aria-hidden> *</span>}
      </legend>
      <div className="fw-ob-choices" role="radiogroup" aria-label={question.text[locale]}>
        {(question.options ?? []).map((option) => (
          <RadioCard key={option.code} variant="row" name={id} value={option.code} checked={value === option.code} selected={value === option.code} onChange={() => actions?.onAnswer?.(question.key, { value: option.code })} title={option.text[locale]} />
        ))}
      </div>
      <GroupError id={id} text={error} />
    </fieldset>
  )
}

/** The code of conduct: read in a new tab (design tab:code-of-conduct), then signed with a tick. */
function SignField({ question, page, model, actions, problems, t }: FieldProps) {
  const locale = useLocale()
  const base = `answers/${question.key}/value`
  const id = fieldId(base)
  const error = errorAt(t, model, problems, base)
  const signed = model.form.answers[question.key]?.value === 'SIGNED'
  return (
    <fieldset className="fw-ob-group fw-ob-sign" id={id} aria-describedby={error ? `${id}-error` : undefined}>
      <legend className="fw-ob-legend">
        {question.text[locale]}
        {question.required && <span className="fw-ob-required" aria-hidden> *</span>}
      </legend>
      {page.questionnaire.hasCode && (
        <div className="fw-ob-inline">
          <Button size="sm" onClick={() => actions?.onCode?.()} heldReason={model.code === 'opening' ? t('code.opening') : null}>
            <ExternalLink size={14} aria-hidden /> {t('code.open')}
          </Button>
          {model.code === 'failed' && (
            <span className="fw-ob-error" role="alert">
              {t('code.failed')}
            </span>
          )}
        </div>
      )}
      <Checkbox checked={signed} onChange={(event) => actions?.onAnswer?.(question.key, { value: event.target.checked ? 'SIGNED' : null })} label={t('code.sign', { company: page.sender.companyName })} />
      <GroupError id={id} text={error} />
    </fieldset>
  )
}

/** Design sec:sites — your sites, and for leather who does each step where (country); Add a site. */
function SitesField({ question, model, actions, problems, t }: FieldProps) {
  const locale = useLocale()
  const field = question.kind === 'SITES' ? 'sites' : 'subTierSites'
  const rows = model.form[field]
  const id = fieldId(field)
  const error = errorAt(t, model, problems, field)
  // The countries' names in the reader's language come from the browser (a server may name them otherwise): drawn as codes
  // until the page is in the browser, so the first paint is the same on both sides.
  const [named, setNamed] = useState(false)
  useEffect(() => setNamed(true), [])
  const countries = useMemo(() => {
    const names = named && typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames([locale], { type: 'region' }) : null
    const rows = COUNTRY_CODES.map((code) => ({ code, name: names?.of(code) ?? code }))
    return names ? rows.sort((a, b) => a.name.localeCompare(b.name, locale)) : rows
  }, [locale, named])
  const change = (index: number, edit: Partial<SiteBody>) => actions?.onSites?.(field, rows.map((row, at) => (at === index ? { ...row, ...edit } : row)))
  const toggle = (index: number, step: SiteStep) => {
    const steps = rows[index]!.steps
    change(index, { steps: steps.includes(step) ? steps.filter((entry) => entry !== step) : STEPS_OF_SITES.filter((entry) => entry === step || steps.includes(entry)) })
  }
  return (
    <fieldset className="fw-ob-group" id={id} aria-describedby={error ? `${id}-error` : undefined}>
      <legend className="fw-ob-legend">
        {question.text[locale]}
        {question.required ? <span className="fw-ob-required" aria-hidden> *</span> : <span className="fw-ob-optional"> {t('field.optional')}</span>}
      </legend>
      {question.help?.[locale] && <p className="fw-ob-hint">{question.help[locale]}</p>}
      {rows.length === 0 && <p className="fw-ob-hint">{t(field === 'sites' ? 'sites.none' : 'sites.noneSub')}</p>}
      <ul className="fw-ob-sites">
        {rows.map((row, index) => {
          const at = `${field}/${index}`
          return (
            <li key={index} className="fw-ob-site">
              <div className="fw-ob-site-head">
                <span className="fw-ob-h3">{t(field === 'sites' ? 'sites.site' : 'sites.sub', { n: index + 1 })}</span>
                <Button size="sm" variant="quiet" onClick={() => actions?.onSites?.(field, rows.filter((_, other) => other !== index))}>
                  <Trash2 size={14} aria-hidden /> {t('sites.remove')}
                </Button>
              </div>
              <div className="fw-ob-grid">
                <Field label={t('sites.name')} required error={errorAt(t, model, problems, `${at}/name`)} htmlFor={fieldId(`${at}/name`)}>
                  <Input id={fieldId(`${at}/name`)} value={row.name} onChange={(event) => change(index, { name: event.target.value })} />
                </Field>
                <Field label={t('sites.country')} required error={errorAt(t, model, problems, `${at}/country`)} htmlFor={fieldId(`${at}/country`)}>
                  <Select id={fieldId(`${at}/country`)} value={row.country} onChange={(event) => change(index, { country: event.target.value })}>
                    <option value="">{t('sites.chooseCountry')}</option>
                    {countries.map((country) => (
                      <option key={country.code} value={country.code}>
                        {country.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('sites.town')} htmlFor={fieldId(`${at}/town`)} error={errorAt(t, model, problems, `${at}/town`)}>
                  <Input id={fieldId(`${at}/town`)} value={row.town ?? ''} onChange={(event) => change(index, { town: event.target.value })} />
                </Field>
              </div>
              <fieldset className="fw-ob-steps">
                <legend className="fw-ob-sub">{t('sites.steps')}</legend>
                {STEPS_OF_SITES.map((step) => (
                  <Checkbox key={step} checked={row.steps.includes(step)} onChange={() => toggle(index, step)} label={t(`siteStep.${step}`)} />
                ))}
              </fieldset>
            </li>
          )
        })}
      </ul>
      <GroupError id={id} text={error} />
      <div>
        <Button size="sm" onClick={() => actions?.onSites?.(field, [...rows, { name: '', country: '', town: null, steps: [] }])} heldReason={rows.length >= 20 ? t('sites.full') : null}>
          <Plus size={14} aria-hidden /> {t(field === 'sites' ? 'sites.add' : 'sites.addSub')}
        </Button>
      </div>
    </fieldset>
  )
}

/** Design sec:sign — every answer with Change, the signer's role, the SignBlock: name, "true to the best of my knowledge". */
export function SignStep({ page, model, actions }: StepProps) {
  const t = useT('link-onboard')
  const locale = useLocale()
  const problems = useProblems(page, model)
  const busy = model.send === 'busy'
  const sections = STEPS.filter((step) => step !== 'sign')
  const roleError = errorAt(t, model, problems, 'signedRole')
  const elsewhere = problems.filter((problem) => problem.step !== 'sign')
  const held = page.link.usesLeft < 1 ? t('send.used') : null
  return (
    <div className="fw-ob-fields">
      {sections.map((step) => {
        const questions = questionsIn(page, step)
        if (questions.length === 0) return null
        const open = problems.some((problem) => problem.step === step)
        return (
          <section key={step} className="fw-ob-review" aria-labelledby={`fw-ob-review-${step}`}>
            <div className="fw-ob-site-head">
              <h3 id={`fw-ob-review-${step}`} className="fw-ob-h3">
                {t(`step.${step}.title`)} {open && <Pill tone="warning">{t('review.toFix')}</Pill>}
              </h3>
              <Button size="sm" variant="quiet" onClick={() => actions?.onStep?.(step)}>
                {t('review.change')}
              </Button>
            </div>
            <KeyValue
              labelCase="sentence"
              items={questions.flatMap((question) => {
                if (question.kind === 'SITES' || question.kind === 'SUB_TIER_SITES') {
                  const rows = question.kind === 'SITES' ? model.form.sites : model.form.subTierSites
                  return [{ label: question.text[locale], value: rows.length === 0 ? t('review.none') : rows.map((row) => [row.name, row.country, row.steps.map((entry) => t(`siteStep.${entry}`)).join(', ')].filter(Boolean).join(' · ')).join(' | ') }]
                }
                const entry = model.form.answers[question.key]
                const words = textOf(entry?.explain).trim()
                return [{ label: question.text[locale], value: words ? `${answerSummary(question, entry, model.files, locale, t)} — ${words}` : answerSummary(question, entry, model.files, locale, t) }]
              })}
            />
          </section>
        )
      })}
      {elsewhere.length > 0 && (
        <Banner tone="warning" title={t('review.fixFirst', { count: elsewhere.length })}>
          {t('review.fixFirstBody')}
        </Banner>
      )}
      <Field label={t('sign.role')} required hint={t('sign.roleHint')} error={roleError} htmlFor={fieldId('signedRole')}>
        <Input id={fieldId('signedRole')} value={model.form.signedRole} autoComplete="organization-title" onChange={(event) => actions?.onSigner?.('signedRole', event.target.value)} />
      </Field>
      <SignBlock
        id={fieldId('signedName')}
        title={<span className="fw-ob-h3">{t('sign.title')}</span>}
        legal={<p className="fw-ob-hint">{t('sign.legal', { company: page.sender.companyName })}</p>}
        acknowledgements={[{ id: 'truthful', label: t('sign.truthful') }]}
        acknowledgementMissingLabel={t('sign.tickMissing')}
        nameLabel={t('sign.name')}
        nameHint={t('sign.nameHint')}
        nameEmptyLabel={t('sign.nameEmpty')}
        acceptLabel={t('sign.send')}
        onAccept={(signed) => actions?.onSign?.(signed.name, signed.acknowledged.includes('truthful'))}
        state={busy ? 'busy' : 'idle'}
        busyLabel={t('send.busy')}
        heldReason={held}
        message={model.problem ? t(model.problem) : undefined}
        messageTone="danger"
      />
    </div>
  )
}
