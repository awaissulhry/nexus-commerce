/**
 * DS floor kit — telling a hardware scanner from a person at the keyboard (gap G3).
 *
 * A USB or Bluetooth barcode scanner is a "keyboard wedge": it types the code as keystrokes, 5–30 ms apart, and ends it
 * with Enter (or Tab). A person types 80 ms or more apart. So a scan is a BURST: on average the characters arrive within
 * `maxKeyGapMs`, and no single pause is longer than three times that (a scanner's USB polling can stall once).
 *
 * Two readers use these rules:
 *   - inside the scan field (`ScanInput`), the field keeps the text and records when each character arrived; the
 *     terminator asks `classifyBurst` whether it was a scanner or a person;
 *   - outside any text field (focus on a tile, a button or nothing), `createWedgeReader` listens to the document so a
 *     scan is never lost: a burst is swallowed and handed to the scan field, while a person's single key presses pass
 *     through untouched (Enter on a focused tile still presses it).
 *
 * Pure: no DOM, no timers. Times are milliseconds from any monotonic clock.
 */

export interface WedgeOptions {
  /** The longest AVERAGE pause between two characters of one scan, ms. */
  maxKeyGapMs: number
  /** The shortest code accepted as a scan. */
  minLength: number
  /** Keys that end a scan (`KeyboardEvent.key`). */
  terminators: readonly string[]
}

/** Scanners type 5–30 ms apart; 50 ms leaves room for a slow Bluetooth link and stays well under a person's 80 ms. */
export const WEDGE_DEFAULTS: WedgeOptions = { maxKeyGapMs: 50, minLength: 3, terminators: ['Enter', 'Tab'] }

/** One pause may be this many times `maxKeyGapMs` before the burst counts as broken. */
export const WEDGE_PAUSE_FACTOR = 3

export type ScanSource = 'wedge' | 'typed' | 'camera'

/**
 * `wedge` when the characters arrived as a scanner types them, `typed` when a person did. `stamps` are the arrival times
 * of the characters, oldest first. One character (or a paste, all at one moment) counts as a wedge.
 */
export function classifyBurst(stamps: readonly number[], maxKeyGapMs: number): 'wedge' | 'typed' {
  if (stamps.length < 2) return 'wedge'
  let longest = 0
  for (let i = 1; i < stamps.length; i++) longest = Math.max(longest, stamps[i] - stamps[i - 1])
  const mean = (stamps[stamps.length - 1] - stamps[0]) / (stamps.length - 1)
  return mean <= maxKeyGapMs && longest <= maxKeyGapMs * WEDGE_PAUSE_FACTOR ? 'wedge' : 'typed'
}

/**
 * The arrival times of a field's characters after an edit. A field reports its whole value on every change; this keeps
 * one time per character: new characters at the end get `at`, a shorter value drops times from the end, and a value that
 * changed in the middle (a person editing) restarts with every character at `at` — which the terminator then judges by
 * the characters that follow.
 */
export function nextStamps(stamps: readonly number[], before: string, after: string, at: number): number[] {
  if (after.length === 0) return []
  if (after.startsWith(before)) return [...stamps.slice(0, before.length), ...Array<number>(after.length - before.length).fill(at)]
  if (before.startsWith(after)) return stamps.slice(0, after.length)
  return Array<number>(after.length).fill(at)
}

/** Keys a scanner sends around a character (Shift for a capital) that must neither count nor break a burst. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock'])

export type WedgeStep =
  /** Not part of a scan: let the key do what it normally does. */
  | { kind: 'ignore' }
  /** Buffered. `burst`: the buffer so far is scanner-fast, so the key belongs to a scan and should be swallowed. */
  | { kind: 'char'; burst: boolean }
  /** The terminator after a burst of at least `minLength` characters: a scan. Swallow the terminator. */
  | { kind: 'scan'; code: string }

export interface WedgeReader {
  /** A key arrived (`KeyboardEvent.key`) at `at` ms. */
  key(key: string, at: number): WedgeStep
  /** Forget the buffer (focus moved into a text field, the reader was paused). */
  reset(): void
}

/** A document-level reader for scans that arrive while no text field has focus. */
export function createWedgeReader(options: Partial<WedgeOptions> = {}): WedgeReader {
  const o: WedgeOptions = { ...WEDGE_DEFAULTS, ...options }
  let chars: string[] = []
  let stamps: number[] = []
  const reset = () => {
    chars = []
    stamps = []
  }
  const broken = (at: number) => stamps.length > 0 && at - stamps[stamps.length - 1] > o.maxKeyGapMs * WEDGE_PAUSE_FACTOR

  return {
    key(key, at) {
      if (MODIFIERS.has(key)) return { kind: 'ignore' }
      if (o.terminators.includes(key)) {
        const scan = chars.length >= o.minLength && !broken(at) && classifyBurst(stamps, o.maxKeyGapMs) === 'wedge'
        const code = chars.join('').trim()
        reset()
        return scan && code.length >= o.minLength ? { kind: 'scan', code } : { kind: 'ignore' }
      }
      if (key.length !== 1) {
        // Arrows, Escape, Backspace…: a person at the keyboard. Nothing buffered survives it.
        reset()
        return { kind: 'ignore' }
      }
      if (broken(at)) reset()
      chars.push(key)
      stamps.push(at)
      return { kind: 'char', burst: chars.length >= 2 && classifyBurst(stamps, o.maxKeyGapMs) === 'wedge' }
    },
    reset,
  }
}

/** Repeat reads of one code by a camera (it decodes several times a second) inside this window count once. */
export const CAMERA_REPEAT_MS = 1500

/** True when a camera read is the same code as the last one, inside the repeat window. */
export function isCameraRepeat(last: { code: string; at: number } | null, code: string, at: number, windowMs = CAMERA_REPEAT_MS): boolean {
  return last !== null && last.code === code && at - last.at < windowMs
}
