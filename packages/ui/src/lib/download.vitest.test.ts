import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadBlob, downloadResponse, filenameFromContentDisposition, REVOKE_AFTER_MS } from './download'

describe('filenameFromContentDisposition', () => {
  it('reads a quoted name, with escapes and a ; inside the quotes', () => {
    expect(filenameFromContentDisposition('attachment; filename="nexus-products.xlsx"')).toBe('nexus-products.xlsx')
    expect(filenameFromContentDisposition('attachment; filename="a \\"b\\"; c.xlsx"')).toBe('a "b"; c.xlsx')
  })

  it('reads an unquoted name, with any case and spacing', () => {
    expect(filenameFromContentDisposition('attachment; filename=export.csv')).toBe('export.csv')
    expect(filenameFromContentDisposition('Attachment;FILENAME = export.csv ; size=10')).toBe('export.csv')
  })

  it('prefers filename* (RFC 8187) over filename, in either order', () => {
    expect(filenameFromContentDisposition("attachment; filename=\"naive.xlsx\"; filename*=UTF-8''na%C3%AFve%20file.xlsx")).toBe('naïve file.xlsx')
    expect(filenameFromContentDisposition("attachment; filename*=utf-8'it'%E2%82%AC%20prezzi.xlsx; filename=\"EUR prezzi.xlsx\"")).toBe('€ prezzi.xlsx')
    expect(filenameFromContentDisposition("attachment; filename*=ISO-8859-1''caf%E9.csv")).toBe('café.csv')
  })

  it('falls back to filename when filename* cannot be decoded', () => {
    expect(filenameFromContentDisposition("attachment; filename=\"plain.xlsx\"; filename*=UTF-8''bad%E2%82.xlsx")).toBe('plain.xlsx')
    expect(filenameFromContentDisposition("attachment; filename=\"plain.xlsx\"; filename*=KOI8-R''x.xlsx")).toBe('plain.xlsx')
  })

  it('gives no name when the header gives none', () => {
    expect(filenameFromContentDisposition(null)).toBeNull()
    expect(filenameFromContentDisposition(undefined)).toBeNull()
    expect(filenameFromContentDisposition('')).toBeNull()
    expect(filenameFromContentDisposition('attachment')).toBeNull()
    expect(filenameFromContentDisposition('inline; size=100')).toBeNull()
    expect(filenameFromContentDisposition('attachment; filename=""')).toBeNull()
  })

  it('never lets a header choose a directory', () => {
    expect(filenameFromContentDisposition('attachment; filename="../../etc/passwd"')).toBe('passwd')
    expect(filenameFromContentDisposition('attachment; filename="C:\\\\Users\\\\x\\\\a.xlsx"')).toBe('a.xlsx')
    expect(filenameFromContentDisposition('attachment; filename=".."')).toBeNull()
  })
})

/** A document just big enough to watch one anchor being clicked. */
function fakeDocument() {
  const events: string[] = []
  const anchor = {
    href: '', download: '', rel: '', hidden: false,
    click: () => events.push(`click ${anchor.download} ${anchor.href}`),
    remove: () => events.push('remove'),
  }
  const doc = {
    createElement: (tag: string) => { events.push(`create ${tag}`); return anchor },
    body: { appendChild: () => events.push('append') },
  }
  return { doc, anchor, events }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('downloadBlob', () => {
  it('clicks an attached, hidden anchor and revokes the URL only after the delay', () => {
    vi.useFakeTimers()
    const { doc, anchor, events } = fakeDocument()
    vi.stubGlobal('document', doc)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:nexus/1')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    downloadBlob(new Blob(['x']), 'nexus-products.xlsx')

    expect(events).toEqual(['create a', 'append', 'click nexus-products.xlsx blob:nexus/1', 'remove'])
    expect(anchor.hidden).toBe(true)
    expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(REVOKE_AFTER_MS - 1)
    expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(revoke).toHaveBeenCalledWith('blob:nexus/1')
  })

  it('is a no-op outside the browser', () => {
    const create = vi.spyOn(URL, 'createObjectURL')
    downloadBlob(new Blob(['x']), 'a.csv')
    expect(create).not.toHaveBeenCalled()
  })
})

describe('downloadResponse', () => {
  it('names the file from Content-Disposition, else the fallback', async () => {
    // Only the revoke timer is faked; reading the Response body must run on the real event loop.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { doc, events } = fakeDocument()
    vi.stubGlobal('document', doc)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:nexus/2')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const named = new Response('data', { headers: { 'Content-Disposition': 'attachment; filename="server-name.zip"' } })
    expect(await downloadResponse(named, 'fallback.xlsx')).toBe('server-name.zip')
    expect(await downloadResponse(new Response('data'), 'fallback.xlsx')).toBe('fallback.xlsx')
    expect(events.filter((e) => e.startsWith('click'))).toEqual(['click server-name.zip blob:nexus/2', 'click fallback.xlsx blob:nexus/2'])
  })

  it('refuses to save a failed response as the file', async () => {
    const create = vi.spyOn(URL, 'createObjectURL')
    await expect(downloadResponse(new Response('{"error":"nope"}', { status: 500 }), 'x.xlsx')).rejects.toThrow('HTTP 500')
    expect(create).not.toHaveBeenCalled()
  })
})
