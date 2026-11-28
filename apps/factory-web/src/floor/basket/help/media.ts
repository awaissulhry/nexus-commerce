import { VOICE_SECONDS } from '../../tasks/machine/depth'
import { voiceSeconds } from './model'

/**
 * owb-fl8 — a voice note's length for the server (server B: required for audio, at most 120 s). The browser decodes the note it
 * just recorded (a recorded WebM often says "Infinity" in an <audio> element, the decoded buffer never does); when it cannot, the
 * time the recorder was open stands in. Nothing leaves the phone here.
 */
export async function measureVoice(blob: Blob, openedAt: number, now: number = Date.now()): Promise<number> {
  const fallback = Math.min(VOICE_SECONDS, Math.max(1, (now - openedAt) / 1000))
  try {
    const Context = typeof window === 'undefined' ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
    if (!Context) return voiceSeconds(null, fallback)
    const context = new Context()
    try {
      const buffer = await context.decodeAudioData(await blob.arrayBuffer())
      return voiceSeconds(buffer.duration, fallback)
    } finally {
      void context.close()
    }
  } catch {
    return voiceSeconds(null, fallback)
  }
}
