import sanitizeHtml from 'sanitize-html'
import { MAX_INBOUND_HTML, MAX_INBOUND_TEXT } from './rules'

/**
 * Safe rendering of incoming mail (plan A1 §3.7 "Content": "HTML is sanitised on the way in … raw mail is never
 * shown"; feature COL-026: "HTML is sanitized on arrival and shown in a sandbox; remote images blocked until allowed"),
 * pure. The stored HTML holds formatting only:
 *   - no script, style sheet, form, frame, object, embed, media, meta or link element (their content is dropped);
 *   - no event handler, no class or id, and of inline styles only colour, alignment, weight, slant and decoration
 *     (no url(), no position): nothing can load, run or cover the page;
 *   - links only to http, https and mailto, opened apart (`rel="noopener noreferrer nofollow"`, `target="_blank"`);
 *   - pictures never load by themselves: a remote picture's address moves to `data-remote-src` (the screen loads it
 *     only when the person allows it), an inline one (`cid:`) to `data-cid`, anything else (a data: URL) is dropped;
 *   - the text outside the html element (what a broken mail puts there) is dropped.
 * The screen shows it in a sandboxed frame as well; this is the first wall, not the only one.
 */

const TAGS = [
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'caption',
  'center',
  'code',
  'col',
  'colgroup',
  'dd',
  'div',
  'dl',
  'dt',
  'em',
  'font',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
]

const CELL = ['align', 'valign', 'width', 'height', 'colspan', 'rowspan', 'style']
const COLOUR = [/^#[0-9a-f]{3,8}$/i, /^rgba?\(\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/i, /^[a-z]{3,20}$/i]

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: TAGS,
  allowedAttributes: {
    '*': ['style', 'dir', 'lang', 'title'],
    a: ['href', 'name', 'rel', 'target'],
    img: ['alt', 'width', 'height', 'data-remote-src', 'data-cid'],
    font: ['color'],
    table: ['align', 'width', 'border', 'cellpadding', 'cellspacing', 'style'],
    td: CELL,
    th: CELL,
    col: ['span', 'width'],
    colgroup: ['span', 'width'],
    ol: ['start', 'type'],
  },
  allowedStyles: {
    '*': {
      color: COLOUR,
      'background-color': COLOUR,
      'text-align': [/^(?:left|right|center|justify)$/],
      'font-weight': [/^(?:bold|bolder|normal|[1-9]00)$/],
      'font-style': [/^(?:italic|normal)$/],
      'text-decoration': [/^(?:underline|line-through|none)$/],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { a: ['http', 'https', 'mailto'], img: [] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'head', 'template', 'svg', 'math', 'iframe', 'object', 'xmp'],
  enforceHtmlBoundary: true,
  nestingLimit: 64,
  transformTags: {
    a: (_tagName, attribs) => ({
      tagName: 'a',
      attribs: { ...(attribs.href ? { href: attribs.href } : {}), ...(attribs.title ? { title: attribs.title } : {}), rel: 'noopener noreferrer nofollow', target: '_blank' },
    }),
    img: (_tagName, attribs) => {
      const src = (attribs.src ?? '').trim()
      const kept: Record<string, string> = {}
      for (const name of ['alt', 'width', 'height', 'title'] as const) if (attribs[name]) kept[name] = attribs[name]
      if (/^https?:\/\//i.test(src)) kept['data-remote-src'] = src
      else if (/^cid:/i.test(src)) kept['data-cid'] = src.slice(4)
      return { tagName: 'img', attribs: kept }
    },
  },
}

/** The mail's HTML as it may be stored and shown (see above); null when nothing is left, or more than MAX_INBOUND_HTML. */
export function sanitiseMailHtml(html: string | null | undefined): string | null {
  if (typeof html !== 'string' || html.trim() === '') return null
  const clean = sanitizeHtml(html, OPTIONS).trim()
  if (clean === '' || clean.length > MAX_INBOUND_HTML) return null
  return clean
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8}|#39);/gi, (whole, name: string) => {
    const lower = name.toLowerCase()
    if (lower.startsWith('#x') || lower.startsWith('#')) {
      const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10)
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[lower] ?? whole
  })
}

/** The text of an HTML mail (no part of plain text came with it): block ends become line breaks, tags go. */
export function textOfHtml(html: string | null | undefined): string {
  if (typeof html !== 'string') return ''
  const marked = html.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/\s*(?:p|div|tr|li|h[1-6]|blockquote|table)\s*>/gi, '\n')
  const text = sanitizeHtml(marked, { allowedTags: [], allowedAttributes: {}, nonTextTags: OPTIONS.nonTextTags ?? [] })
  return decodeEntities(text).replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * A mail's text as stored: line breaks as `\n`, no control characters but tab and line break, no trailing spaces, at
 * most MAX_INBOUND_TEXT characters (a cut is marked).
 */
export function cleanInboundText(text: string | null | undefined): string {
  if (typeof text !== 'string') return ''
  const clean = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+$/gm, '')
    .trim()
  return clean.length <= MAX_INBOUND_TEXT ? clean : `${clean.slice(0, MAX_INBOUND_TEXT - 2).trimEnd()} …`
}
