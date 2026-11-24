'use client'

import { useState } from 'react'
import { Lock, Pin } from 'lucide-react'
import { useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { barState, barWords, type BarPin } from '../pins-bar'
import '../head.css'

/** The bar's catalogues: the head's (its name) and the card's (who and what, as a quote says them). */
const PINBAR_NS = ['record-thread-head', 'record-thread-card']

/**
 * tw- W2.1 (W-080 / W-081; Z14): the pinned bar under the head — in RecordThread itself, so every host has it (the Incoming pane with no
 * head too): marks · pin · "Sender: text" one line (a lock on an office note); a click goes to the message (`onJump`, the host's one
 * door) and the bar shows the next older pin. Drawn only with a pin. Draws its model only.
 */
export function PinnedBar({ pins, onJump }: { pins: readonly BarPin[]; onJump?: ((messageId: string) => void) | undefined }) {
  if (pins.length === 0) return null
  return (
    <WithMessages namespaces={PINBAR_NS}>
      <Bar pins={pins} onJump={onJump} />
    </WithMessages>
  )
}

function Bar({ pins, onJump }: { pins: readonly BarPin[]; onJump?: ((messageId: string) => void) | undefined }) {
  const t = useT('record-thread-head')
  const card = useT('record-thread-card')
  const [index, setIndex] = useState(0)
  const state = barState(pins, index)
  if (!state) return null
  const words = barWords(state.pin)
  const who = words.who === null ? null : 'text' in words.who ? words.who.text : card(words.who.key)
  const what = 'text' in words.what ? words.what.text : card(words.what.key, words.what.count === undefined ? undefined : { count: words.what.count })
  return (
    <button
      type="button"
      className="fw-rt-pinbar"
      aria-label={t('pinbar.label', { n: state.index + 1, count: state.count })}
      onClick={() => {
        onJump?.(state.pin.messageId)
        setIndex(state.next)
      }}
    >
      {state.marks.length > 1 && (
        <span className="fw-rt-pinmarks" aria-hidden="true">
          {state.marks.map((on, mark) => (
            <i key={mark} className={on ? 'is-on' : undefined} />
          ))}
        </span>
      )}
      <Pin size={15} className="fw-rt-pinicon" aria-hidden />
      <span className="fw-rt-pintext">
        {who !== null && <b>{who}: </b>}
        {what}
      </span>
      {state.pin.office && <Lock size={12} className="fw-rt-pinlock" aria-hidden />}
    </button>
  )
}
