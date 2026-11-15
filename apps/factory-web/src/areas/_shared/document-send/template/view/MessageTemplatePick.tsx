'use client'

import { Field } from '@nexus/ui/components'
import { Button, Select, Spinner, Tag } from '@nexus/ui/primitives'
import type { MessageTemplateModel } from '../model'
import { WithMessages } from '../../../../../record-panels/i18n'
import { SEND_TEMPLATE_NAMESPACES, useSendWords } from './words'

/**
 * The send panel's "Message from a template" (B-W2b-432; design shell.preview sec:send-panel, "Message (template per
 * language)"): the templates of the language on screen (the office's shared ones, then the person's own); one picked puts
 * its words, filled with the record's values, in the message box below — still the person's to change — and names what the
 * record had no value for; "Put back what I wrote" undoes the pick.
 */
export function MessageTemplatePick(props: MessageTemplatePickProps) {
  return (
    <WithMessages namespaces={SEND_TEMPLATE_NAMESPACES}>
      <TemplatePick {...props} />
    </WithMessages>
  )
}

export interface MessageTemplatePickProps {
  model: MessageTemplateModel
  language: 'it' | 'en'
  onPick?: (replyId: string | null) => void
  onPutBack?: () => void
  readOnly?: boolean
}

function TemplatePick({ model, language, onPick, onPutBack, readOnly }: MessageTemplatePickProps) {
  const t = useSendWords()
  const languageName = t(`tpl.language.${language}`)
  const shared = model.replies.filter((reply) => reply.shared)
  const own = model.replies.filter((reply) => !reply.shared)
  const hint =
    model.status === 'loading'
      ? t('tpl.send.template.loading')
      : model.status === 'failed'
        ? t('tpl.send.template.listFailed')
        : model.replies.length === 0
          ? t('tpl.send.template.none', { language: languageName })
          : t('tpl.send.template.hint', { language: languageName })
  return (
    <div className="fw-send-template">
      <Field label={t('tpl.send.template.label')} hint={hint} error={model.problem ? t(model.problem) : undefined}>
        <Select size="sm" value={model.pickedId ?? ''} disabled={readOnly || model.status !== 'ready' || model.replies.length === 0 || model.filling} onChange={(event) => onPick?.(event.target.value || null)}>
          <option value="">{t('tpl.send.template.pick')}</option>
          {shared.length > 0 && (
            <optgroup label={t('tpl.send.template.shared')}>
              {shared.map((reply) => (
                <option key={reply.id} value={reply.id}>
                  {reply.name}
                </option>
              ))}
            </optgroup>
          )}
          {own.length > 0 && (
            <optgroup label={t('tpl.send.template.own')}>
              {own.map((reply) => (
                <option key={reply.id} value={reply.id}>
                  {reply.name}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </Field>
      {model.filling && (
        <span className="fw-send-hint" role="status">
          <Spinner size={12} /> {t('tpl.send.template.filling')}
        </span>
      )}
      {model.missing.length > 0 && (
        <span className="fw-send-hint is-warning">
          {t('tpl.send.template.missing', { count: model.missing.length })}{' '}
          {model.missing.map((name) => (
            <Tag key={name} tone="warning">{`{{${name}}}`}</Tag>
          ))}
        </span>
      )}
      {model.previous !== null && !readOnly && (
        <span>
          <Button size="sm" variant="quiet" onClick={() => onPutBack?.()}>
            {t('tpl.send.template.putBack')}
          </Button>
        </span>
      )}
    </div>
  )
}
