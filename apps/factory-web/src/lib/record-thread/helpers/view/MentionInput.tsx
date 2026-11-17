'use client'

import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type ForwardedRef, type KeyboardEvent, type TextareaHTMLAttributes } from 'react'
import { AlertTriangle, AtSign, EyeOff } from 'lucide-react'
import { Button, Tag } from '@nexus/ui/primitives'
import { Textarea } from '../../../i18n/ds-parts'
import { useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { completeMention, mentionAt, mentionCandidates, mentionsIn, mentionSuggestions, mentionWarnings, type MentionPerson } from '../model'
import '../helpers.css'

export const HELPERS_NS = 'record-thread-helpers'

export interface MentionInputProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'role'> {
  value: string
  onChange: (text: string) => void
  /** Who a note may mention (GET /threads/<type>/<id>/people, through `withMentionTags`). */
  people: readonly MentionPerson[]
  /** Mentions belong to office notes: in a reply to the customer the box offers none. */
  mode: 'note' | 'reply'
  /** The box's name for screen readers ("Office note"). */
  label: string
  /** The DS counter's limit (factory-domain MAX_BODY_LENGTH). */
  limit?: number
  /** The DS Textarea sizes from `rows` (no 168 px floor): the composer at rest is two rows. */
  honourRows?: boolean
}

/** What the composer may ask of the box: the "@" button starts a mention at the caret. */
export interface MentionInputHandle {
  focus: () => void
  startMention: () => void
}

/**
 * MentionInput (B-TH-208, T8-F01; picture 6 drawn to the approved pictures' look): the composer's text box with @
 * suggestions as you type in an office note — ↑ / ↓ pick, Enter or Tab inserts, Esc closes — office people who may read
 * the record only, tagged people first with their tag beside the name; a person who cannot read the record is shown with
 * that warning and cannot be picked, and a typed @Name nobody of them carries is said under the box. Never a checkbox list,
 * never @everyone, at most 20 mentions. A DS Textarea (the counter's words in the page's language) as an ARIA combobox.
 */
export const MentionInput = forwardRef<MentionInputHandle, MentionInputProps>(function MentionInput(props, ref) {
  return (
    <WithMessages namespaces={[HELPERS_NS]}>
      <Box {...props} handle={ref} />
    </WithMessages>
  )
})

function Box({ value, onChange, people, mode, label, limit, handle, onKeyDown, ...rest }: MentionInputProps & { handle: ForwardedRef<MentionInputHandle> }) {
  const t = useT(HELPERS_NS)
  const listId = useId()
  const warnId = useId()
  const box = useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState(value.length)
  const [active, setActive] = useState(0)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const pendingCaret = useRef<number | null>(null)

  const candidates = useMemo(() => mentionCandidates(people), [people])
  const chosen = useMemo(() => mentionsIn(value, candidates), [value, candidates])
  const at = mode === 'note' ? mentionAt(value, caret) : null
  const suggestions = at && dismissedAt !== at.start ? mentionSuggestions(at.query, candidates, chosen) : []
  const open = suggestions.length > 0
  const current = open ? Math.min(active, suggestions.length - 1) : -1
  const warnings = mode === 'note' ? mentionWarnings(value, candidates) : []

  useEffect(() => setActive(0), [at?.query])
  useEffect(() => {
    if (pendingCaret.current === null || !box.current) return
    box.current.setSelectionRange(pendingCaret.current, pendingCaret.current)
    setCaret(pendingCaret.current)
    pendingCaret.current = null
  }, [value])

  const insert = (person: MentionPerson) => {
    if (person.canRead === false) return
    const next = completeMention(value, caret, person)
    pendingCaret.current = next.caret
    onChange(next.text)
    box.current?.focus()
  }

  useImperativeHandle(handle, () => ({
    focus: () => box.current?.focus(),
    startMention: () => {
      const element = box.current
      const at = element ? element.selectionStart ?? value.length : value.length
      const before = value.slice(0, at)
      const glue = before === '' || /\s$/.test(before) ? '' : ' '
      pendingCaret.current = at + glue.length + 1
      setDismissedAt(null)
      onChange(`${before}${glue}@${value.slice(at)}`)
      element?.focus()
    },
  }))

  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length)
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        const person = suggestions[current]
        if (person && person.canRead !== false) {
          event.preventDefault()
          insert(person)
          return
        }
      }
      if (event.key === 'Escape' && at) {
        // Closes the suggestions only: the dock or window around stays open.
        event.preventDefault()
        event.stopPropagation()
        setDismissedAt(at.start)
        return
      }
    }
    onKeyDown?.(event)
  }

  return (
    <div className="fw-rtm">
      <Textarea
        {...rest}
        ref={box}
        value={value}
        {...(limit ? { limit } : {})}
        aria-label={label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && current >= 0 ? `${listId}-${current}` : undefined}
        aria-describedby={warnings.length > 0 ? warnId : undefined}
        onChange={(event) => {
          onChange(event.target.value)
          setCaret(event.target.selectionStart ?? event.target.value.length)
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? value.length)}
        onKeyDown={keys}
      />
      {open && (
        <ul id={listId} className="fw-rtm-list" role="listbox" aria-label={t('mention.list')}>
          {suggestions.map((person, index) => (
            <li
              key={person.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === current}
              aria-disabled={person.canRead === false || undefined}
              className={`fw-rtm-option${index === current ? ' is-active' : ''}${person.canRead === false ? ' is-held' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insert(person)}
            >
              <span className="fw-rtm-avatar" aria-hidden>
                {initials(person.name)}
              </span>
              <span className="fw-rtm-name">{person.name}</span>
              {person.tag && <Tag tone="info">{person.tag}</Tag>}
              {person.canRead === false && (
                <span className="fw-rtm-warn">
                  <EyeOff size={12} aria-hidden /> {t('mention.cannotReadShort')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul id={warnId} className="fw-rtm-warnings" role="status">
          {warnings.map((warning) => (
            <li key={`${warning.key}:${String(warning.params.name ?? '')}`}>
              <AlertTriangle size={12} aria-hidden /> {t(warning.key, warning.params)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The person's initials as the thread's avatar draws them (Avatar comes with TH-1b's parts/; drawn here meanwhile). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toLocaleUpperCase()
}

/** The composer's "@" button: starts a mention at the caret (office notes only). */
export function MentionButton({ onClick, held = null }: { onClick: () => void; held?: string | null }) {
  return (
    <WithMessages namespaces={[HELPERS_NS]}>
      <MentionTrigger onClick={onClick} held={held} />
    </WithMessages>
  )
}

function MentionTrigger({ onClick, held }: { onClick: () => void; held: string | null }) {
  const t = useT(HELPERS_NS)
  return (
    <Button size="sm" className="icon" aria-label={t('mention.button')} heldReason={held} onClick={onClick}>
      <AtSign size={16} aria-hidden />
    </Button>
  )
}
