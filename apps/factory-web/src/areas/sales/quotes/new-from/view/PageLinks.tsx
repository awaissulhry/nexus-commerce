'use client'

import { useMemo } from 'react'
import { CalendarCheck, FileStack, MoreHorizontal } from 'lucide-react'
import { Menu } from '@nexus/ui/components'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { useLocale } from '../../../../../lib/i18n/provider'
import { DEPTH_NS } from '../../record/lines-depth/model'

export interface QuotesPageLinksModel {
  /** `/w/<company>` */
  prefix: string
  /** The person opens Planning › Promise dates (planning.promise.view). */
  promiseDates: boolean
}

/**
 * The Quotes page's ⋯ (design sales.quotes page.h "Quote templates (W2b, opens Sales settings)" and page.conn "Planning ›
 * Promise dates (W2b)"): two real links, beside New quote.
 */
export function QuotesPageLinks({ model }: { model: QuotesPageLinksModel }) {
  const locale = useLocale()
  const t = useMemo(() => createTranslator(locale, messagesFor(locale, [DEPTH_NS])[DEPTH_NS] ?? {}), [locale])
  return (
    <Menu
      align="right"
      label={<MoreHorizontal size={16} aria-hidden />}
      triggerProps={{ 'aria-label': t('page.more') }}
      items={[
        { id: 'templates', label: t('page.templates'), description: t('page.templatesHint'), icon: <FileStack size={14} aria-hidden />, href: `${model.prefix}/sales/settings#quote-templates` },
        { id: 'promise', label: t('page.promise'), description: model.promiseDates ? t('page.promiseHint') : t('page.promiseHeld'), icon: <CalendarCheck size={14} aria-hidden />, disabled: !model.promiseDates, href: model.promiseDates ? `${model.prefix}/planning/promise` : undefined },
      ]}
    />
  )
}
