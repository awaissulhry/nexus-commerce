/**
 * A small, strict XML reader for the documents the factory receives (B-W2a-62: a supplier's FatturaPA as SDI delivers
 * it). Elements, attributes, text, CDATA, comments and processing instructions; the five predefined entities and
 * character references. No DTD (a `<!DOCTYPE` is refused, so no entity can expand), no external anything. Element and
 * attribute names lose their namespace prefix (`p:FatturaElettronica` → `FatturaElettronica`): FatturaPA's elements are
 * unqualified and its root carries any prefix the sender chose. Pure: no I/O.
 */

export interface XmlNode {
  /** The local name (no prefix). */
  readonly name: string
  readonly attributes: Readonly<Record<string, string>>
  readonly children: readonly XmlNode[]
  /** The element's own text (its text and CDATA children joined), not trimmed. */
  readonly text: string
}

export class XmlReadError extends Error {
  override name = 'XmlReadError'
}

/** The most an XML may hold before it is read (FatturaPA's own limit is 5 MB, attachments included). */
export const MAX_XML_CHARS = 8_000_000
const MAX_DEPTH = 64

const localName = (name: string): string => name.slice(name.indexOf(':') + 1)

function decode(text: string, at: number): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (_whole, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16))
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10))
    switch (body) {
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'amp':
        return '&'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default:
        throw new XmlReadError(`Unknown entity &${body}; near character ${at}.`)
    }
  })
}

interface Open {
  name: string
  attributes: Record<string, string>
  children: XmlNode[]
  text: string
}

/** Reads an XML document into its root element; throws XmlReadError for anything that is not well formed. */
export function parseXml(source: string): XmlNode {
  if (source.length > MAX_XML_CHARS) throw new XmlReadError('The XML is too large to read.')
  const xml = source.replace(/^﻿/, '')
  const stack: Open[] = []
  let root: XmlNode | null = null
  let i = 0
  const n = xml.length
  while (i < n) {
    const lt = xml.indexOf('<', i)
    const textEnd = lt === -1 ? n : lt
    if (textEnd > i) {
      const raw = xml.slice(i, textEnd)
      if (stack.length > 0) stack[stack.length - 1]!.text += decode(raw, i)
      else if (raw.trim() !== '') throw new XmlReadError(`Text outside the root element near character ${i}.`)
    }
    if (lt === -1) break
    i = lt
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4)
      if (end === -1) throw new XmlReadError('A comment is not closed.')
      i = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9)
      if (end === -1) throw new XmlReadError('A CDATA section is not closed.')
      if (stack.length === 0) throw new XmlReadError('CDATA outside the root element.')
      stack[stack.length - 1]!.text += xml.slice(i + 9, end)
      i = end + 3
      continue
    }
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2)
      if (end === -1) throw new XmlReadError('A processing instruction is not closed.')
      i = end + 2
      continue
    }
    if (xml.startsWith('<!', i)) throw new XmlReadError('A DTD or declaration is not accepted in a received document.')
    if (xml.startsWith('</', i)) {
      const end = xml.indexOf('>', i + 2)
      if (end === -1) throw new XmlReadError('A closing tag is not finished.')
      const name = localName(xml.slice(i + 2, end).trim())
      const open = stack.pop()
      if (!open || open.name !== name) throw new XmlReadError(`The closing tag </${name}> does not match ${open ? `<${open.name}>` : 'any open element'}.`)
      const node: XmlNode = { name: open.name, attributes: open.attributes, children: open.children, text: open.text }
      if (stack.length > 0) stack[stack.length - 1]!.children.push(node)
      else if (root) throw new XmlReadError('More than one root element.')
      else root = node
      i = end + 1
      continue
    }
    // An opening (or empty) tag: the name, then attributes with quoted values.
    let j = i + 1
    const nameMatch = /^[A-Za-z_][\w.:-]*/.exec(xml.slice(j, j + 200))
    if (!nameMatch) throw new XmlReadError(`A tag without a name near character ${i}.`)
    const name = localName(nameMatch[0])
    j += nameMatch[0].length
    const attributes: Record<string, string> = {}
    for (;;) {
      while (j < n && /\s/.test(xml[j]!)) j++
      if (xml[j] === '>' || xml.startsWith('/>', j)) break
      const attribute = /^([A-Za-z_][\w.:-]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/.exec(xml.slice(j, j + 4096))
      if (!attribute) throw new XmlReadError(`A malformed attribute in <${name}> near character ${j}.`)
      const key = attribute[1]!
      if (!key.startsWith('xmlns')) attributes[localName(key)] = decode(attribute[3] ?? attribute[4] ?? '', j)
      j += attribute[0].length
    }
    if (j >= n) throw new XmlReadError(`The tag <${name}> is not finished.`)
    const empty = xml.startsWith('/>', j)
    i = j + (empty ? 2 : 1)
    if (empty) {
      const node: XmlNode = { name, attributes, children: [], text: '' }
      if (stack.length > 0) stack[stack.length - 1]!.children.push(node)
      else if (root) throw new XmlReadError('More than one root element.')
      else root = node
      continue
    }
    if (root && stack.length === 0) throw new XmlReadError('More than one root element.')
    if (stack.length >= MAX_DEPTH) throw new XmlReadError('The XML is nested too deeply.')
    stack.push({ name, attributes, children: [], text: '' })
  }
  if (stack.length > 0) throw new XmlReadError(`The element <${stack[stack.length - 1]!.name}> is not closed.`)
  if (!root) throw new XmlReadError('The document has no root element.')
  return root
}

/** The first child of that name (and so on down a path), or null. */
export function child(node: XmlNode | null | undefined, ...path: readonly string[]): XmlNode | null {
  let at: XmlNode | null = node ?? null
  for (const name of path) {
    if (!at) return null
    at = at.children.find((entry) => entry.name === name) ?? null
  }
  return at
}

/** Every child of that name (at the end of the path). */
export function children(node: XmlNode | null | undefined, ...path: readonly string[]): XmlNode[] {
  if (!node || path.length === 0) return []
  const parent = child(node, ...path.slice(0, -1))
  const last = path[path.length - 1]!
  return parent ? parent.children.filter((entry) => entry.name === last) : []
}

/** The trimmed text at the path, or null when the element is missing or empty. */
export function textAt(node: XmlNode | null | undefined, ...path: readonly string[]): string | null {
  const found = child(node, ...path)
  const value = found?.text.trim() ?? ''
  return value === '' ? null : value
}
