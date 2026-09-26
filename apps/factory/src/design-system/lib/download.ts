/**
 * Hand a file to the browser — once, for the platform.
 *
 * The Blob → object URL → anchor click → revoke dance was hand-rolled at every export (the studio's
 * product transfer drawer, the catalog transfer page, the variant template), each with its own
 * revoke timing and its own guess at the file name from the Blob's MIME type. The server already
 * names the file in `Content-Disposition`; `downloadResponse` reads that name instead of guessing.
 *
 * A Blob, never a data: URL — a data: URL is capped well below the size of a real catalogue
 * export, and fails by truncating rather than by erroring.
 */

/**
 * How long the object URL outlives the click. Revoking synchronously races the click (Safari
 * delivers an empty file), and one animation frame was the shortest delay seen to work. The URL
 * only has to live until the browser has resolved it, so the delay costs nothing but a Blob held
 * in memory a little longer; 40 s is well past that moment in every browser.
 */
export const REVOKE_AFTER_MS = 40_000

/** Strip any directory part and control characters; an empty result is no name. */
function cleanFileName(raw: string): string | null {
  const base = raw.split(/[/\\]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return clean && clean !== '.' && clean !== '..' ? clean : null
}

/** RFC 8187 ext-value: `charset'language'percent-encoded`. UTF-8 and ISO-8859-1 are the two defined charsets. */
function decodeExtValue(value: string): string | null {
  const match = /^([^']*)'[^']*'(.*)$/.exec(value)
  if (!match) return null
  const charset = match[1].toLowerCase()
  const encoded = match[2]
  try {
    if (charset === 'utf-8') return decodeURIComponent(encoded)
    if (charset === 'iso-8859-1') return encoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  } catch {
    return null // malformed percent-encoding: fall back to the plain `filename`
  }
  return null
}

/**
 * The file name a `Content-Disposition` header gives, or `null` when it gives none.
 *
 * `filename*` (RFC 6266 / 8187, e.g. `filename*=UTF-8''na%C3%AFve.xlsx`) wins over `filename`, as
 * the RFC says it must: servers send both so old clients get an ASCII name and new ones the real
 * one. `filename` may be a quoted string (with `\"` escapes, and `;` allowed inside) or a bare
 * token. Parameter names are case-insensitive. A directory part is dropped — a header is not
 * allowed to choose where the file lands.
 */
export function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null
  const params = new Map<string, string>()
  let i = header.indexOf(';')
  if (i < 0) return null
  while (i < header.length) {
    i++ // past ';'
    const eq = header.indexOf('=', i)
    if (eq < 0) break
    const name = header.slice(i, eq).trim().toLowerCase()
    i = eq + 1
    while (header[i] === ' ' || header[i] === '\t') i++
    let value = ''
    if (header[i] === '"') {
      i++
      while (i < header.length && header[i] !== '"') {
        if (header[i] === '\\' && i + 1 < header.length) i++
        value += header[i]
        i++
      }
      i++ // past the closing quote
      const next = header.indexOf(';', i)
      i = next < 0 ? header.length : next
    } else {
      const next = header.indexOf(';', i)
      value = header.slice(i, next < 0 ? header.length : next).trim()
      i = next < 0 ? header.length : next
    }
    if (name && !params.has(name)) params.set(name, value)
  }
  const extended = params.get('filename*')
  if (extended != null) {
    const decoded = decodeExtValue(extended)
    const clean = decoded == null ? null : cleanFileName(decoded)
    if (clean) return clean
  }
  const plain = params.get('filename')
  return plain == null ? null : cleanFileName(plain)
}

/** Save a Blob as `filename`. A no-op outside the browser. */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === 'undefined') return
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.hidden = true
  // In the document for the click: Firefox ignores a click on a detached anchor.
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS)
}

/**
 * Save a fetch `Response` body as a file named by its `Content-Disposition` header, else
 * `fallbackName`. Returns the name used, so the caller can say what was downloaded.
 *
 * Check `response.ok` first and read the server's error from the body there; a failed response
 * reaching this function throws rather than saving an error page as the operator's file.
 */
export async function downloadResponse(response: Response, fallbackName: string): Promise<string> {
  if (!response.ok) throw new Error(`The download failed (HTTP ${response.status}).`)
  const filename = filenameFromContentDisposition(response.headers.get('content-disposition')) ?? fallbackName
  downloadBlob(await response.blob(), filename)
  return filename
}
