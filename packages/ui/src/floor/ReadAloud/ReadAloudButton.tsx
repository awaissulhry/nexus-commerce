'use client'

/**
 * ReadAloudButton — reads a screen's short text in the person's language (B-W2b-28, D27 / A2 G21): the worker notice,
 * the reason grid's words, work instructions. For low literacy (MES-188), next to icon-first screens.
 *
 *   <ReadAloudButton text={pageText} lang="it-IT" labels={ds.readAloud} />
 *
 * - The browser's own speech (Web Speech) on the device; nothing leaves the tablet through this part.
 * - The voice is named under the button ("Voice: Alice"). **No voice for the language → no button**: a page in Urdu on
 *   a tablet without an Urdu voice shows nothing rather than a voice reading it wrong (`readAloudModel.ts`). Until the
 *   device lists its voices (asynchronous in Chrome) nothing is drawn either, and nothing on the server.
 * - Press: reads, sentence by sentence; the button becomes "Stop reading" (`aria-pressed`). Press again, leave the
 *   screen or start another read-aloud: it stops. One voice at a time on the page.
 * - Sized by the density (a FloorButton).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Square, Volume2 } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { FloorButton, type FloorButtonSize } from '../FloorButton'
import { READ_ALOUD_LABELS, type ReadAloudLabels } from './ReadAloudLabels'
import { pickVoice, speechChunks } from './readAloudModel'
import '../floor.css'
import './readAloud.css'

export interface ReadAloudButtonProps {
  /** The words to read — or a function read at the press (the page's text as it is then). */
  text: string | (() => string)
  /** The person's language, BCP 47 ("it-IT", "ro", "ur"). */
  lang: string
  /** Default `md`. */
  size?: FloorButtonSize
  /** Name the voice under the button. Default true. */
  showVoice?: boolean
  labels?: Partial<ReadAloudLabels>
  id?: string
}

type Synth = Pick<SpeechSynthesis, 'getVoices' | 'speak' | 'cancel' | 'addEventListener' | 'removeEventListener'>

function synth(): Synth | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function') return null
  return window.speechSynthesis
}

/** The device's voice for `lang`: undefined while the voices are not listed yet, null when it has none. */
export function useSpeechVoice(lang: string): SpeechSynthesisVoice | null | undefined {
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null | undefined>(undefined)
  useEffect(() => {
    const s = synth()
    if (!s) {
      setVoice(null)
      return
    }
    const read = () => {
      const voices = s.getVoices()
      if (voices.length) setVoice(pickVoice(voices, lang))
    }
    read()
    s.addEventListener('voiceschanged', read)
    // A browser that never lists voices has none: give up after a moment.
    const giveUp = setTimeout(() => setVoice((v) => (v === undefined ? null : v)), 3000)
    return () => {
      s.removeEventListener('voiceschanged', read)
      clearTimeout(giveUp)
    }
  }, [lang])
  return voice
}

/** The read-aloud that is speaking on this page: starting another stops it. */
let speaking: { stop: () => void } | null = null

export function ReadAloudButton({ text, lang, size = 'md', showVoice = true, labels, id }: ReadAloudButtonProps) {
  const lw = mergeLabels(READ_ALOUD_LABELS, labels)
  const voice = useSpeechVoice(lang)
  const [on, setOn] = useState(false)
  const me = useRef<{ stop: () => void } | null>(null)

  const stop = useCallback(() => {
    if (speaking === me.current) {
      synth()?.cancel()
      speaking = null
    }
    setOn(false)
  }, [])

  // Leaving the screen stops the voice.
  useEffect(() => () => stop(), [stop])

  if (!voice) return null

  const read = () => {
    const s = synth()
    if (!s) return
    if (on) {
      stop()
      return
    }
    speaking?.stop()
    s.cancel()
    const pieces = speechChunks(typeof text === 'function' ? text() : text)
    if (!pieces.length) return
    const handle = { stop: () => setOn(false) }
    me.current = handle
    speaking = handle
    pieces.forEach((piece, i) => {
      const u = new window.SpeechSynthesisUtterance(piece)
      u.voice = voice
      u.lang = voice.lang
      if (i === pieces.length - 1) u.onend = () => (speaking === handle ? stop() : undefined)
      u.onerror = () => (speaking === handle ? stop() : undefined)
      s.speak(u)
    })
    setOn(true)
  }

  return (
    <span id={id} className="nds-floor-readaloud">
      <FloorButton size={size} variant="secondary" icon={on ? <Square /> : <Volume2 />} aria-pressed={on} onClick={read}>
        {on ? lw.stop : lw.read}
      </FloorButton>
      {showVoice ? <span className="nds-floor-readaloud-voice">{lw.voice(voice.name)}</span> : null}
    </span>
  )
}
