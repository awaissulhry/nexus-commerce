/**
 * DS floor kit — confirm feedback (gap G8, MES-108): every floor action answers with colour, vibration and sound
 * together, so a gloved operator in a loud, bright hall notices it without reading.
 *
 *   confirmFeedback('success', { target: rowElement, muted })
 *
 *   success  green flash, one short buzz, a rising two-note chirp      ("done")
 *   warning  amber flash, two short buzzes, two even notes             ("check")
 *   error    red flash, two long buzzes, one low buzz tone             ("refused" — the screen says why in words)
 *
 * - Colour: `data-nds-feedback="<kind>"` on the target for `FEEDBACK_FLASH_MS`; `floor.css` draws it. With
 *   `prefers-reduced-motion` the colour holds still instead of flashing (the colour is information; the motion is not).
 * - Vibration: `navigator.vibrate`, where the device has it (Android Chrome; never iOS).
 * - Sound: WebAudio oscillators, no audio files. One AudioContext for the page, made on the first sound (a browser only
 *   lets it play after a touch, which a floor action is). `muted` silences it; vibration and colour stay.
 *
 * Never throws: a missing API, a blocked AudioContext or a server render just skips that channel, and the result says
 * which channels ran. Labels and icons stay the screen's job — this helper adds no text.
 */

// The flash's colours (`[data-nds-feedback]`) live with the rest of the floor kit.
import './floor.css'

export type FeedbackKind = 'success' | 'warning' | 'error'

export interface FeedbackTone {
  /** Start, ms after the first tone. */
  at: number
  ms: number
  hz: number
  wave: 'sine' | 'triangle' | 'square'
}

/** How long the colour stays on the target, ms. */
export const FEEDBACK_FLASH_MS = 700

export const FEEDBACK_VIBRATION: { readonly [K in FeedbackKind]: readonly number[] } = {
  success: [40],
  warning: [70, 70, 70],
  error: [200, 90, 200],
}

export const FEEDBACK_TONES: { readonly [K in FeedbackKind]: readonly FeedbackTone[] } = {
  success: [
    { at: 0, ms: 90, hz: 880, wave: 'sine' },
    { at: 100, ms: 150, hz: 1320, wave: 'sine' },
  ],
  warning: [
    { at: 0, ms: 150, hz: 660, wave: 'triangle' },
    { at: 220, ms: 150, hz: 660, wave: 'triangle' },
  ],
  error: [{ at: 0, ms: 380, hz: 196, wave: 'square' }],
}

/** Peak loudness, 0–1. A square wave sounds louder than a sine at the same gain, so the error tone is quieter. */
const PEAK: { readonly [W in FeedbackTone['wave']]: number } = { sine: 0.32, triangle: 0.3, square: 0.12 }

export interface ConfirmFeedbackOptions {
  /** The element that flashes: the row, tile, field or button the action was about. None: no flash. */
  target?: Element | null
  /** No sound (the device's mute setting). Vibration and colour stay. */
  muted?: boolean
  /** Vibrate. Default true. */
  haptics?: boolean
}

export interface ConfirmFeedbackResult {
  flashed: boolean
  vibrated: boolean
  sounded: boolean
  /** The flash held still instead of moving (`prefers-reduced-motion`). */
  reducedMotion: boolean
}

/* ── the browser's channels, each guarded ──────────────────────────────────────────────────────────────────────────── */

type AudioCtor = new () => AudioContext

interface FeedbackGlobals {
  navigator?: { vibrate?: (pattern: number | number[]) => boolean }
  matchMedia?: (query: string) => { matches: boolean }
  AudioContext?: AudioCtor
  webkitAudioContext?: AudioCtor
}

const globals = () => globalThis as unknown as FeedbackGlobals

function reducedMotion(): boolean {
  try {
    return globals().matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  } catch {
    return false
  }
}

function vibrate(pattern: readonly number[]): boolean {
  try {
    const nav = globals().navigator
    return typeof nav?.vibrate === 'function' ? nav.vibrate([...pattern]) === true : false
  } catch {
    return false
  }
}

let audio: { ctor: AudioCtor; ctx: AudioContext } | null = null

/** The page's one AudioContext; a new one only if the constructor changed (a test swapped it). */
function audioContext(): AudioContext | null {
  const g = globals()
  const ctor = g.AudioContext ?? g.webkitAudioContext
  if (typeof ctor !== 'function') return null
  if (audio?.ctor !== ctor) audio = { ctor, ctx: new ctor() }
  const ctx = audio.ctx
  if (ctx.state === 'suspended') void ctx.resume?.().catch(() => undefined)
  return ctx
}

function play(tones: readonly FeedbackTone[]): boolean {
  try {
    const ctx = audioContext()
    if (!ctx) return false
    const t0 = ctx.currentTime + 0.01
    for (const tone of tones) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const start = t0 + tone.at / 1000
      const end = start + tone.ms / 1000
      osc.type = tone.wave
      osc.frequency.setValueAtTime(tone.hz, start)
      // A short ramp in and out: a tone that starts or stops at full level clicks.
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(PEAK[tone.wave], start + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, end)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(start)
      osc.stop(end + 0.02)
    }
    return true
  } catch {
    return false
  }
}

const flashTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>()

function flash(target: Element, kind: FeedbackKind): boolean {
  try {
    const running = flashTimers.get(target)
    if (running !== undefined) clearTimeout(running)
    // Restart the animation when the same element answers twice in a row: drop the attribute, read layout, set it again.
    target.removeAttribute('data-nds-feedback')
    void (target as HTMLElement).offsetWidth
    target.setAttribute('data-nds-feedback', kind)
    flashTimers.set(
      target,
      setTimeout(() => {
        if (target.getAttribute('data-nds-feedback') === kind) target.removeAttribute('data-nds-feedback')
        flashTimers.delete(target)
      }, FEEDBACK_FLASH_MS),
    )
    return true
  } catch {
    return false
  }
}

/** Colour, vibration and sound for one floor action. */
export function confirmFeedback(kind: FeedbackKind, { target = null, muted = false, haptics = true }: ConfirmFeedbackOptions = {}): ConfirmFeedbackResult {
  const still = reducedMotion()
  return {
    flashed: target ? flash(target, kind) : false,
    vibrated: haptics ? vibrate(FEEDBACK_VIBRATION[kind]) : false,
    sounded: muted ? false : play(FEEDBACK_TONES[kind]),
    reducedMotion: still,
  }
}
