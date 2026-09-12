import { describe, expect, it } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MediaPreview, mediaUrl } from './MediaPreview'
import { MediaStrip } from './MediaStrip'
describe('Mixed media rendering', () => {
  it('uses explicit playback, alternative video sources, captions and escaped transcripts', () => {
    const html = renderToStaticMarkup(h(MediaPreview, { type: 'VIDEO', url: 'https://cdn.example/movie.mp4', label: 'Jacket demonstration', sources: [{ url: 'https://cdn.example/movie.webm', mimeType: 'video/webm' }, { url: 'https://cdn.example/movie.mp4', mimeType: 'video/mp4' }], captions: [{ url: 'https://cdn.example/it.vtt', label: 'Italiano', language: 'it', default: true }], transcript: '<script>content</script>' }))
    expect(html).toContain('controls=""'); expect(html).toContain('playsinline=""'); expect(html).not.toContain('autoplay')
    expect(html).toContain('type="video/webm"'); expect(html).toContain('srcLang="it"'); expect(html).toContain('&lt;script&gt;content&lt;/script&gt;')
  })
  it('retains safe external-video and unknown-file links without loading an iframe', () => {
    const html = renderToStaticMarkup(h(MediaPreview, { type: 'EXTERNAL_VIDEO', url: 'https://video.example/watch/1', label: 'Demo' }))
    expect(html).toContain('Open video'); expect(html).not.toContain('<iframe')
    expect(renderToStaticMarkup(h(MediaPreview, { type: 'NEW_TYPE', url: 'https://cdn.example/file.new', label: 'Asset' }))).toContain('Open original')
  })
  it('rejects executable and malformed protocols and accepts ordinary file URLs', () => {
    for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'java\nscript:alert(1)', 'file:///etc/passwd']) expect(mediaUrl(value)).toBeUndefined()
    expect(mediaUrl('/local/movie.mp4')).toBe('/local/movie.mp4')
    expect(mediaUrl('https://cdn.example/movie.mp4')).toBe('https://cdn.example/movie.mp4')
  })
  it('renders video placeholders without requesting an empty image URL and announces the full count', () => {
    const html = renderToStaticMarkup(h(MediaStrip, { label: 'Jacket', limit: 1, items: [{ id: 'video', type: 'VIDEO', preview: null }, { id: 'image', type: 'IMAGE', preview: 'https://cdn.example/photo.jpg' }] }))
    expect(html).toContain('Jacket, 2 media items'); expect(html).toContain('+1'); expect(html).not.toContain('<img')
  })
})
