import { describe, it, expect } from 'vitest'
import { validateVideo } from './videoValidation'

describe('validateVideo', () => {
  it('passes a clean 1080p MP4', () => {
    expect(validateVideo({ width: 1920, height: 1080, durationSec: 30, mimeType: 'video/mp4', fileSize: 20 * 1048576 })).toEqual([])
  })

  it('flags an unsupported format as an error', () => {
    const w = validateVideo({ mimeType: 'video/x-msvideo' })
    expect(w.some((x) => x.level === 'error')).toBe(true)
  })

  it('warns on low resolution', () => {
    const w = validateVideo({ width: 640, height: 360, mimeType: 'video/mp4' })
    expect(w.some((x) => x.message.includes('Low resolution'))).toBe(true)
  })

  it('warns on non-16:9 aspect', () => {
    const w = validateVideo({ width: 1080, height: 1080, mimeType: 'video/mp4' })
    expect(w.some((x) => x.message.includes('16:9'))).toBe(true)
  })

  it('warns on long duration and oversize file', () => {
    const w = validateVideo({ width: 1920, height: 1080, durationSec: 600, fileSize: 200 * 1048576, mimeType: 'video/mp4' })
    expect(w.some((x) => x.message.includes('long'))).toBe(true)
    expect(w.some((x) => x.message.includes('150 MB'))).toBe(true)
  })

  it('is lenient when metadata is missing', () => {
    expect(validateVideo({})).toEqual([])
  })
})
