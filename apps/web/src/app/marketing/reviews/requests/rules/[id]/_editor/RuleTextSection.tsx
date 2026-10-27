'use client'

/**
 * Reviews › Requests › the rule editor — the Message section of a Shopify rule (N3, 2026-10-27): the review e-mail's
 * subject and text per language, the standard text or this rule's own, checked while it is typed by the same check the
 * API refuses a save with (@nexus/shared/review-request-text). "Preview email" shows the text as a buyer gets it.
 *
 *   per language   Standard text (read only, today's words) ⇄ This rule's own text (Subject, Text, the check)
 *   the parts      {first_name} {product} {aspects} — and the two that must stay: {review_button} {unsubscribe_link}
 *
 * Amazon and eBay rules never get here: the editor says in words that Amazon sends its own e-mail and eBay none.
 */
import { CheckCircle2, Mail } from 'lucide-react'
import { Field } from '@/design-system/components'
import { Button, Input, Pill, SegmentedControl, Textarea } from '@/design-system/primitives'
import {
  BODY_MAX,
  REQUEST_TEXT_LANGUAGES,
  REQUEST_TEXT_LANGUAGE_NAMES,
  REQUEST_TEXT_LANGUAGE_WHO,
  REQUEST_TEXT_PARTS,
  SUBJECT_MAX,
  STANDARD_REQUEST_TEXT,
  isStandardRequestText,
  type RequestTextLanguage,
} from '@nexus/shared/review-request-text'
import { languageIssues, withStandardWords, withText, withTextMode, type RuleForm } from './ruleForm'
import s from './editor.module.css'

const MODE_OPTIONS = [
  { value: 'standard', label: 'Standard text' },
  { value: 'own', label: 'This rule’s own text' },
]

export interface RuleTextSectionProps {
  form: RuleForm
  update: (patch: (f: RuleForm) => RuleForm) => void
  /** "Shopify" — whose buyers get this e-mail. */
  channel: string
  onPreview: () => void
}

export function RuleTextSection({ form, update, channel, onPreview }: RuleTextSectionProps) {
  return (
    <div className={s.fields}>
      <p className={s.hint}>
        {channel} buyers get our review e-mail: Italian for buyers in Italy, English for every other market. Each language
        sends the standard text until you give this rule its own and save — until then no buyer’s e-mail changes.
      </p>
      {REQUEST_TEXT_LANGUAGES.map((lang) => <LanguageBlock key={lang} lang={lang} form={form} update={update} />)}
      <div className={s.row}>
        <Button size="sm" onClick={onPreview}><Mail size={13} aria-hidden /> Preview email</Button>
        <span className={s.hint}>Shows each language as a buyer gets it, with your changes. Nothing is sent.</span>
      </div>
      <div className={s.parts}>
        <p className={s.hint}>Parts Nexus fills in for each buyer:</p>
        <ul className={s.partList}>
          {REQUEST_TEXT_PARTS.map((p) => (
            <li key={p.key}>
              <code className={s.token}>{p.token}</code> {p.words}{p.required ? ' — must stay in the text' : ''}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function LanguageBlock({ lang, form, update }: { lang: RequestTextLanguage; form: RuleForm; update: RuleTextSectionProps['update'] }) {
  const text = form.emailText[lang]
  const name = REQUEST_TEXT_LANGUAGE_NAMES[lang]
  const own = text.mode === 'own'
  const issues = languageIssues(text)
  const subjectIssue = issues.find((i) => i.where === 'subject')
  const bodyIssue = issues.find((i) => i.where === 'body')
  const same = own && isStandardRequestText(lang, text)
  const titleId = `rule-text-${lang}`
  return (
    <section className={s.language} aria-labelledby={titleId}>
      <div className={s.languageHead}>
        <h3 id={titleId} className={s.languageTitle}>
          {name} <span className={s.hint}>— {REQUEST_TEXT_LANGUAGE_WHO[lang]}</span>
        </h3>
        <SegmentedControl
          size="sm"
          ariaLabel={`${name} text`}
          options={MODE_OPTIONS}
          value={text.mode}
          onChange={(v) => update((f) => withTextMode(f, lang, v as 'standard' | 'own'))}
        />
      </div>
      {!own ? (
        <div className={s.standardText} aria-label={`The standard ${name} text`}>
          <p className={s.textLine}><strong>Subject</strong> {STANDARD_REQUEST_TEXT[lang].subject}</p>
          <p className={s.textBody}>{STANDARD_REQUEST_TEXT[lang].body}</p>
        </div>
      ) : (
        <>
          <Field label="Subject" error={subjectIssue?.words}>
            <Input value={text.subject} onChange={(e) => update((f) => withText(f, lang, { subject: e.target.value }))} maxLength={SUBJECT_MAX} />
          </Field>
          <Field label="Text" hint="A blank line starts a new paragraph." error={bodyIssue?.words}>
            <Textarea value={text.body} onChange={(e) => update((f) => withText(f, lang, { body: e.target.value }))} rows={11} limit={BODY_MAX} />
          </Field>
          {issues.length > 0 ? (
            <ul className={s.lint} aria-label={`Problems in the ${name} text`}>
              {issues.map((issue, i) => (
                <li key={`${issue.code}-${issue.where}-${i}`} className={s.lintError}>
                  Not allowed in the {issue.where === 'subject' ? 'subject' : 'text'}: {issue.words}{issue.match && !issue.words.includes(issue.match) ? ` (“${issue.match}”)` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.okText}>
              <CheckCircle2 size={14} aria-hidden />
              {same
                ? 'Same words as the standard text: nothing of this rule’s own is saved.'
                : 'The words pass the check: nothing offered for a review, every buyer asked the same way, an honest review only, the review button and the unsubscribe link kept.'}
            </p>
          )}
          <div className={s.row}>
            {same ? <Pill tone="neutral">Standard words</Pill> : <Pill tone="info">This rule’s own words</Pill>}
            <Button size="sm" variant="ghost" onClick={() => update((f) => withStandardWords(f, lang))} heldReason={same ? 'It already has the standard words.' : null}>
              Start again from the standard text
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
