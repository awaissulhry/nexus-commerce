'use client'

import { useMemo } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { CATALOGUE, createTranslator } from '../../../../lib/i18n/messages'
import { useLocale } from '../../../../lib/i18n/provider'
import { languageHeld, type SendLanguageCode, type SendLanguageModel } from '../language/model'
import { useSendLanguage } from '../language/use-send-language'
import { LanguagePick } from '../language/view/LanguagePick'
import type { SendParts } from '../view/DocumentSendView'
import type { ReplyRecordType } from './api'
import { useMessageTemplates } from './use-message-templates'
import { MessageTemplatePick } from './view/MessageTemplatePick'

/**
 * The send panel's W2b parts for a host, in one call (B-W2b-432; PLT-131): the language (the contact's preselected, while
 * the dialog is open and the person may read parties) and the message templates of that language (email.send), as the
 * DocumentSendView's `parts`, with why Send waits; `language` is the one on screen, for the host's preview.
 */
export function useSendParts(
  api: ApiClient,
  input: {
    recordType: ReplyRecordType
    recordId: string
    partyId: string
    contactId: string | null
    companyId: string | null
    documentLanguage: SendLanguageCode
    message: string
    permissions: readonly string[]
    fix?: SendLanguageModel['fix']
  } | null,
  onFill: (body: string) => void,
): { parts: SendParts | undefined; language: SendLanguageCode | null } {
  const locale = useLocale()
  const mayRead = !!input && input.permissions.includes('parties.view')
  const mayUse = !!input && input.permissions.includes('email.send')
  const language = useSendLanguage(api, input ? { partyId: input.partyId, contactId: input.contactId, documentLanguage: input.documentLanguage, mayRead, fix: input.fix ?? null } : null)
  const picked = language.model?.picked ?? input?.documentLanguage ?? 'it'
  const templates = useMessageTemplates(api, input ? { recordType: input.recordType, recordId: input.recordId, contactId: input.contactId, language: picked, companyId: input.companyId, mayUse, message: input.message } : null, onFill, locale)
  const words = useMemo(() => createTranslator(locale, CATALOGUE[locale]['admin-templates'] ?? {}), [locale])
  const heldKey = languageHeld(language.model)
  const parts: SendParts | undefined = input
    ? {
        language: language.model ? <LanguagePick model={language.model} onPick={language.pick} recordType={input.recordType} /> : undefined,
        messageTemplate: templates.model ? <MessageTemplatePick model={templates.model} language={picked} onPick={templates.pick} onPutBack={templates.putBack} /> : undefined,
        held: heldKey ? words(heldKey, { language: words(`tpl.language.${input.documentLanguage}`) }) : null,
      }
    : undefined
  return { parts, language: input ? picked : null }
}
