'use client'

import { SegmentedControl, Spinner } from '@nexus/ui/primitives'
import { useLocale } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { SEND_TEMPLATE_NAMESPACES, useSendWords } from '../../template/view/words'
import { recipientDiffers, type SendLanguageCode, type SendLanguageModel } from '../model'

/**
 * The send panel's Language (B-W2b-432; design shell.preview sec:language-version, SegmentedControl): Italiano · English with
 * the contact's language preselected and why it is theirs (their own, their organisation's, the company's; one we do not
 * write is said with the language they read). A language other than the document's re-renders the preview, and says that
 * the document goes out in its own language until the record's language is changed (the host's Fix link).
 */
export function LanguagePick(props: { model: SendLanguageModel; onPick?: (language: SendLanguageCode) => void; recordType: string }) {
  return (
    <WithMessages namespaces={SEND_TEMPLATE_NAMESPACES}>
      <Pick {...props} />
    </WithMessages>
  )
}

function Pick({ model, onPick, recordType }: { model: SendLanguageModel; onPick?: (language: SendLanguageCode) => void; recordType: string }) {
  const t = useSendWords()
  const documentNoun = t(`tpl.send.noun.${recordType}`)
  const locale = useLocale()
  const name = (code: string) => (code === 'it' || code === 'en' ? t(`tpl.language.${code}`) : languageWords(code, locale))
  const why =
    model.status === 'loading' ? (
      <span className="fw-send-hint" role="status">
        <Spinner size={12} /> {t('tpl.send.language.reading')}
      </span>
    ) : model.status === 'ready' && model.recipient ? (
      <span className="fw-send-hint">{model.recipient.notOffered ? t('tpl.send.language.notOffered', { language: name(model.recipient.notOffered) }) : t(`tpl.send.source.${model.recipient.source}`)}</span>
    ) : (
      <span className="fw-send-hint">{t(model.status === 'failed' ? 'tpl.send.language.failed' : 'tpl.send.language.document')}</span>
    )
  return (
    <span className="fw-send-language">
      <SegmentedControl
        ariaLabel={t('tpl.send.language.label')}
        size="sm"
        value={model.picked}
        onChange={(value) => onPick?.(value as SendLanguageCode)}
        options={[
          { value: 'it', label: t('tpl.language.it') },
          { value: 'en', label: t('tpl.language.en') },
        ]}
      />
      {why}
      {model.picked !== model.documentLanguage ? (
        <span className="fw-send-hint is-warning">
          {t('tpl.send.language.differs', { document: documentNoun, language: name(model.documentLanguage) })}{' '}
          {model.fix && (
            <a className="fw-send-fix" href={model.fix.href}>
              {model.fix.label}
            </a>
          )}
        </span>
      ) : recipientDiffers(model) && model.recipient ? (
        <span className="fw-send-hint is-warning">{t('tpl.send.language.reads', { language: name(model.recipient.language), document: documentNoun })}</span>
      ) : null}
    </span>
  )
}

/** "German" / "tedesco" (Intl), else the code itself. */
function languageWords(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}
