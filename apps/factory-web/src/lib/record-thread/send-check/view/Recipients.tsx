'use client'

import { useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Pencil, X } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../i18n/provider'
import { chipWords, cleanAddress, suggestions, type Contact, type Recipient } from '../model'
import '../send-check.css'

export interface RecipientsProps {
  to: readonly Recipient[]
  cc: readonly Recipient[]
  subject: string
  /** The record's customer's contacts (the only suggestions, W21). */
  contacts: readonly Contact[]
  partyName: string
  /** Open the Cc line at once (design cases). */
  ccOpen?: boolean
  onChange: (next: { to: Recipient[]; cc: Recipient[]; subject: string }) => void
}

/**
 * To and Cc on one line each (B-TH-207, T7-F01; picture 5): every person a chip with their organisation — another customer's in
 * red, an unknown address in amber — the record's customer's contacts suggested as you type (arrow keys, Enter; Backspace takes
 * the last chip off), Cc behind its button, the Subject folded (click to change it). Draws its model.
 */
export function Recipients({ to, cc, subject, contacts, partyName, ccOpen = false, onChange }: RecipientsProps) {
  const t = useT('record-thread-send')
  const [showCc, setShowCc] = useState(ccOpen || cc.length > 0)
  const [editSubject, setEditSubject] = useState(false)
  const ccInput = useRef<HTMLInputElement>(null)
  const set = (next: Partial<{ to: Recipient[]; cc: Recipient[]; subject: string }>) => onChange({ to: [...to], cc: [...cc], subject, ...next })
  const taken = [...to, ...cc].map((item) => item.address)

  return (
    <div className="fw-rt-rcpt">
      <Line label={t('to')} list={to} taken={taken} contacts={contacts} partyName={partyName} onList={(list) => set({ to: list })}>
        {!showCc && (
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              setShowCc(true)
              setTimeout(() => ccInput.current?.focus(), 0)
            }}
          >
            {t('cc')}
          </Button>
        )}
      </Line>
      {showCc && <Line label={t('cc')} list={cc} taken={taken} contacts={contacts} partyName={partyName} onList={(list) => set({ cc: list })} inputRef={ccInput} />}
      <div className="fw-rt-rcpt-row is-subject">
        {editSubject ? (
          <input
            className="fw-rt-rcpt-in"
            autoFocus
            aria-label={t('subject')}
            defaultValue={subject}
            onBlur={(event) => {
              set({ subject: event.currentTarget.value.trim() || subject })
              setEditSubject(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === 'Escape') {
                event.preventDefault()
                if (event.key === 'Enter') set({ subject: event.currentTarget.value.trim() || subject })
                setEditSubject(false)
              }
            }}
          />
        ) : (
          <button type="button" className="fw-rt-rcpt-subject" onClick={() => setEditSubject(true)} aria-label={t('subjectChange', { subject })}>
            {t('subjectLabel')} <span>{subject}</span> <Pencil size={12} aria-hidden />
          </button>
        )}
      </div>
    </div>
  )
}

function Line({
  label,
  list,
  taken,
  contacts,
  partyName,
  onList,
  inputRef,
  children,
}: {
  label: string
  list: readonly Recipient[]
  taken: readonly string[]
  contacts: readonly Contact[]
  partyName: string
  onList: (list: Recipient[]) => void
  inputRef?: RefObject<HTMLInputElement | null>
  children?: ReactNode
}) {
  const t = useT('record-thread-send')
  const listId = useId()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const found = suggestions(query, contacts, taken)
  const options = [...found.contacts.map((contact) => ({ kind: 'contact' as const, contact })), ...(found.free ? [{ kind: 'free' as const, address: found.free }] : [])]
  const add = (recipient: Recipient) => {
    onList([...list, recipient])
    setQuery('')
    setActive(0)
  }
  const pick = (index: number) => {
    const option = options[index]
    if (!option) return
    if (option.kind === 'contact') add({ address: option.contact.email.toLowerCase(), name: option.contact.name, kind: 'PARTY', organisation: partyName })
    else add({ address: option.address, name: null, kind: null, organisation: null })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActive((index) => Math.min(options.length - 1, index + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => Math.max(0, index - 1))
    } else if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
      if (open && options.length > 0) {
        event.preventDefault()
        pick(Math.min(active, options.length - 1))
      } else {
        const address = cleanAddress(query)
        if (address) {
          event.preventDefault()
          add({ address, name: null, kind: null, organisation: null })
        }
      }
    } else if (event.key === 'Backspace' && query === '' && list.length > 0) {
      onList(list.slice(0, -1))
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }
  const showList = open && options.length > 0
  return (
    <div className="fw-rt-rcpt-row">
      <span className="fw-rt-rcpt-lab">{label}</span>
      {list.map((recipient) => {
        const words = chipWords(recipient)
        return (
          <span key={recipient.address} className={`fw-rt-chip${recipient.kind === 'OTHER_PARTY' ? ' is-other' : recipient.kind === 'UNKNOWN' ? ' is-unknown' : ''}`} title={recipient.address}>
            {recipient.name ?? recipient.address} <small>{t(words.key, words.params)}</small>
            <button type="button" aria-label={t('remove', { name: recipient.name ?? recipient.address })} onClick={() => onList(list.filter((item) => item.address !== recipient.address))}>
              <X size={11} aria-hidden />
            </button>
          </span>
        )
      })}
      <input
        ref={inputRef}
        className="fw-rt-rcpt-in"
        value={query}
        role="combobox"
        aria-label={t('lineLabel', { line: label })}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList ? `${listId}-${active}` : undefined}
        placeholder={list.length === 0 ? t('placeholder', { party: partyName }) : ''}
        autoComplete="off"
        inputMode="email"
        onChange={(event) => {
          setQuery(event.target.value)
          setOpen(true)
          setActive(0)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {children}
      {showList && (
        <div id={listId} className="fw-rt-sugg" role="listbox" aria-label={t('suggestions', { party: partyName })}>
          {found.contacts.length > 0 && <p className="fw-rt-sugg-grp">{partyName}</p>}
          {options.map((option, index) => (
            <button
              key={option.kind === 'contact' ? option.contact.email : option.address}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={index === active}
              className={index === active ? 'is-active' : ''}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(index)}
            >
              {option.kind === 'contact' ? `${option.contact.name} · ${option.contact.email}` : t('useAddress', { address: option.address })}
              <small>{option.kind === 'contact' ? partyName : t('chip.unknown')}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
