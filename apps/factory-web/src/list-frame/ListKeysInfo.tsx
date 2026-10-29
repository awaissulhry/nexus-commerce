'use client'

import { Fragment, useSyncExternalStore } from 'react'
import { Info } from 'lucide-react'
import { DetailPopover } from '@nexus/ui/components'
import { Button, Kbd } from '@nexus/ui/primitives'
import { useT } from '../lib/i18n/provider'
import type { ListKey } from './model'

const subscribeNever = () => () => undefined

/**
 * The keys of a list, in ONE information icon in the table's footer (Owner rule 2026-10-29: no key hints above a table
 * or beside its count). Hover, focus or tap shows them with their words (DS DetailPopover, a non-modal dialog); "?" on
 * the list still opens the full shortcut list (`onHelp`). A key's words are a `lists` message key, or the list's own.
 */
export function ListKeysInfo({ keys, onHelp, open, onOpenChange }: { keys: readonly ListKey[]; onHelp?: () => void; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const t = useT('lists')
  // A panel asked open from the start (a design case) opens once the page has hydrated: the server draws it closed.
  const hydrated = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  )
  const words = (does: string) => {
    const text = t(does)
    return text === does ? does : text
  }
  return (
    <DetailPopover
      trigger={<Info size={15} aria-hidden />}
      triggerLabel={t('keys.trigger')}
      triggerClassName="fw-list-keys-trigger"
      label={t('keys.title')}
      hoverDelay={150}
      {...(open !== undefined ? { open: hydrated && open, onOpenChange } : {})}
    >
      {({ close }) => (
        <div className="fw-list-keys">
          <p className="fw-list-keys-title">{t('keys.title')}</p>
          <dl className="fw-list-keymap">
            {keys.map((entry) => (
              <Fragment key={`${entry.keys.join('+')}-${entry.does}`}>
                <dt>
                  {entry.keys.map((key) => (
                    <Kbd key={key}>{key === 'click' ? t('keys.click') : key}</Kbd>
                  ))}
                </dt>
                <dd>{words(entry.does)}</dd>
              </Fragment>
            ))}
          </dl>
          {onHelp && (
            <Button
              size="sm"
              variant="link"
              onClick={() => {
                close({ returnFocus: false })
                onHelp()
              }}
            >
              {t('keys.all')}
            </Button>
          )}
        </div>
      )}
    </DetailPopover>
  )
}
