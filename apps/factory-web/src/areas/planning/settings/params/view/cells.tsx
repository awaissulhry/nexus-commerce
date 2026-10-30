'use client'

import { useCallback } from 'react'
import { Banner, Modal } from '@nexus/ui/components'
import { CellSaveMark } from '@nexus/ui/grid'
import { Button, Kbd } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import type { Mark, Notice, Words } from '../model'

/** Words of this page: a `pp.` key of `planning-params`, a `ps.` key of `planning-settings`; a value that is a key is said too. */
export function useSay(): (words: Words | null | undefined) => string {
  const tp = useT('planning-params')
  const ts = useT('planning-settings')
  return useCallback(
    (words: Words | null | undefined) => {
      if (!words) return ''
      const tr = (key: string, params?: Readonly<Record<string, string | number>>) => (key.startsWith('ps.') || key.startsWith('cal.') ? ts(key, params) : tp(key, params))
      const params = Object.fromEntries(
        Object.entries(words.params ?? {}).map(([name, value]) => [name, typeof value === 'string' && /^p[ps]\./.test(value) ? value.split('|').map((key) => tr(key)).join(', ') : value]),
      )
      return tr(words.key, params)
    },
    [tp, ts],
  )
}

/** A cell's save mark: saving / unknown (the DS mark), refused ("!" with its reason); nothing once saved. */
export function SaveMark({ mark }: { mark: Mark | undefined }) {
  const say = useSay()
  if (!mark || mark.state === 'saved') return null
  if (mark.state === 'refused') {
    const reason = say(mark.problem)
    return (
      <span className="fw-pp-refused" role="img" aria-label={reason} title={reason}>
        !
      </span>
    )
  }
  return <CellSaveMark state={mark.state} />
}

/** A cell takes Enter for itself (opening its dialog); printable keys never start an edit (the list's keys). */
export const cellKeys = (onEnter?: () => void) => (params: { event: KeyboardEvent; editing: boolean }) => {
  const event = params.event
  if (params.editing || event.metaKey || event.ctrlKey || event.altKey) return false
  if (event.key === 'Enter' && onEnter) {
    if (event.type === 'keydown') onEnter()
    return true
  }
  return false
}

/** The page's notice (a save, a bulk result with each refused row named). */
export function NoticeBanner({ notice, onDismiss }: { notice: Notice | null | undefined; onDismiss?: () => void }) {
  const say = useSay()
  if (!notice) return null
  return (
    <Banner tone={notice.tone} title={say(notice.words)} onDismiss={onDismiss}>
      {notice.refused && notice.refused.length > 0 ? (
        <ul className="fw-pp-refusals">
          {notice.refused.map((entry) => (
            <li key={entry.name}>
              <b>{entry.name}</b> — {say(entry.words)}
            </li>
          ))}
        </ul>
      ) : null}
    </Banner>
  )
}

/** "Changed by someone else · Reload": our unsaved form edits are kept until Reload. */
export function ElsewhereBanner({ onReload }: { onReload?: () => void }) {
  const t = useT('planning-params')
  return (
    <Banner
      tone="info"
      title={t('pp.elsewhere.title')}
      action={
        <Button size="sm" onClick={() => onReload?.()}>
          {t('pp.elsewhere.reload')}
        </Button>
      }
    >
      {t('pp.elsewhere.body')}
    </Banner>
  )
}

/** The full list of a list's keys (`?` and the footer icon's "All shortcuts"). */
export function KeysDialog({ keys, selection, onClose }: { keys: readonly ListKey[]; selection: boolean; onClose: () => void }) {
  const t = useT('planning-params')
  const tl = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('pp.keys.title')} size="sm">
      <dl className="fw-pp-keys">
        {listKeys(keys, selection).map((entry) => (
          <div key={entry.keys.join('+')}>
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key === 'click' ? tl('keys.click') : key}</Kbd>
              ))}
            </dt>
            <dd>{entry.does.startsWith('keys.') ? tl(entry.does) : entry.does}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
