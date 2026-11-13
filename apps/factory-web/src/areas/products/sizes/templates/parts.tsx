'use client'

import { useCallback, type ReactNode } from 'react'
import { Banner } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { NS, type Notice, type Phrase } from './model'
import '../../library/library.css'
import './templates.css'

/** The page's catalogues: `products-mtm-templates`, the libraries' `library` (record band, freshness) and the list frame's `lists`. */
export function TemplatesMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={[NS, 'library', 'lists']}>{children}</WithMessages>
}

/** Parameters that are themselves keys of the catalogue (said in words first). */
const KEY_PARAM = /^(type|status|kind|severity)\.[A-Za-z_]+$/

/** `t` for a key, `say` for a phrase (a parameter that is itself a key is said in words first). */
export function useWords() {
  const t = useT(NS)
  const locale = useLocale()
  const say = useCallback(
    (phrase: Phrase | null | undefined): string | null => {
      if (!phrase) return null
      const params: Record<string, string | number> = {}
      for (const [name, value] of Object.entries(phrase.params ?? {})) params[name] = typeof value === 'string' && KEY_PARAM.test(value) ? t(value) : value
      return t(phrase.key, params)
    },
    [t],
  )
  return { t, say, locale }
}

/** Made-to-measure On / Off for a template, with the word (never colour alone): Off = nothing is checked. */
export function OnOffTag({ on }: { on: boolean }) {
  const { t } = useWords()
  return <Tag tone={on ? 'success' : 'neutral'}>{t(on ? 'mtm.on' : 'mtm.off')}</Tag>
}

/** One notice of this catalogue, with Dismiss when offered. */
export function NoticeLine({ notice, onDismiss }: { notice: Notice | null | undefined; onDismiss?: () => void }) {
  const { t, say } = useWords()
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={say(notice)}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {t('common.dismiss')}
          </Button>
        ) : undefined
      }
    />
  )
}
