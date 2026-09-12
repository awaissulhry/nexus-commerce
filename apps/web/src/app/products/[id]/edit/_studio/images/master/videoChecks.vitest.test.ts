/**
 * PES.7 — the video checks, written fresh with the rules re-derived from the channels' own limits.
 * The point of most of these is the THIRD state: a missing input must not read as a pass.
 */
import { describe, expect, it } from 'vitest'

import { checkVideo, worstState, type VideoCheck } from './videoChecks'

const get = (cs: VideoCheck[], id: VideoCheck['id']) => cs.find((c) => c.id === id)!

const GOOD = { width: 1920, height: 1080, durationSec: 45, mimeType: 'video/mp4', fileSize: 12 * 1048576 }

describe('checkVideo', () => {
  it('passes a compliant video on every check', () => {
    const cs = checkVideo(GOOD)
    expect(cs.map((c) => c.state)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass'])
    expect(worstState(cs)).toBe('pass')
  })

  it('reports a missing input as unknown, never as a pass', () => {
    const cs = checkVideo({})
    expect(cs.every((c) => c.state === 'unknown')).toBe(true)
    expect(worstState(cs)).toBe('unknown')
    // The message says what is absent, not what is wrong.
    expect(get(cs, 'resolution').message).toMatch(/not recorded/i)
  })

  it('treats width without height as unknown for BOTH dimension checks', () => {
    const cs = checkVideo({ width: 1920, height: null })
    expect(get(cs, 'resolution').state).toBe('unknown')
    expect(get(cs, 'aspect').state).toBe('unknown')
  })

  it('treats a zero dimension as unrecorded rather than as a tiny video', () => {
    const cs = checkVideo({ width: 0, height: 0 })
    expect(get(cs, 'resolution').state).toBe('unknown')
  })

  it('fails an unsupported container rather than warning', () => {
    const cs = checkVideo({ ...GOOD, mimeType: 'video/x-msvideo' })
    expect(get(cs, 'container').state).toBe('fail')
    expect(worstState(cs)).toBe('fail')
  })

  it('warns below 1280x720', () => {
    expect(get(checkVideo({ ...GOOD, width: 640, height: 360 }), 'resolution').state).toBe('warn')
  })

  it('accepts 1280x720 exactly — the threshold is inclusive', () => {
    expect(get(checkVideo({ ...GOOD, width: 1280, height: 720 }), 'resolution').state).toBe('pass')
  })

  it('warns on a non-16:9 aspect and passes one inside tolerance', () => {
    expect(get(checkVideo({ ...GOOD, width: 1080, height: 1080 }), 'aspect').state).toBe('warn')
    // 1920x1090 is 1.761 vs 1.778 — an encoder rounding, not a different shape.
    expect(get(checkVideo({ ...GOOD, width: 1920, height: 1090 }), 'aspect').state).toBe('pass')
  })

  it('warns past five minutes but not at exactly five', () => {
    expect(get(checkVideo({ ...GOOD, durationSec: 300 }), 'duration').state).toBe('pass')
    expect(get(checkVideo({ ...GOOD, durationSec: 301 }), 'duration').state).toBe('warn')
  })

  it('warns past eBay 150 MB ceiling and names it', () => {
    const c = get(checkVideo({ ...GOOD, fileSize: 200 * 1048576 }), 'weight')
    expect(c.state).toBe('warn')
    expect(c.message).toMatch(/eBay/)
  })

  it('never prints a small file as "0 MB"', () => {
    // A 71 KB clip fixed to MB read as "0 MB" on screen — an empty file, not a small one.
    expect(get(checkVideo({ ...GOOD, fileSize: 71 * 1024 }), 'weight').message).toBe('71 KB')
    expect(get(checkVideo({ ...GOOD, fileSize: 900 }), 'weight').message).toBe('900 B')
    expect(get(checkVideo({ ...GOOD, fileSize: 5 * 1048576 }), 'weight').message).toBe('5.0 MB')
    expect(get(checkVideo({ ...GOOD, fileSize: 42 * 1048576 }), 'weight').message).toBe('42 MB')
  })

  it('ranks a real problem above an unknown', () => {
    // A video with an unsupported container AND unrecorded dimensions is a FAIL, not an unknown.
    expect(worstState(checkVideo({ mimeType: 'video/x-msvideo' }))).toBe('fail')
    expect(worstState(checkVideo({ mimeType: 'video/mp4', width: 640, height: 360 }))).toBe('warn')
  })
})
