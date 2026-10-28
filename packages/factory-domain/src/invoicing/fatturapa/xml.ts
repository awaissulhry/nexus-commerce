/**
 * A minimal, deterministic XML writer: elements in the order given, two-space indentation, "\n" line ends, text
 * escaped. The FatturaPA schema fixes the order of every element, so the builder lists them in schema order.
 */
export interface XmlElement {
  readonly name: string
  readonly attributes: readonly (readonly [string, string])[]
  readonly text: string | null
  readonly children: readonly XmlElement[]
}

/** Absent children (null, undefined, false) are left out, so optional elements read naturally at the call site. */
export type XmlChild = XmlElement | null | undefined | false

export function el(
  name: string,
  content: string | readonly XmlChild[],
  attributes: readonly (readonly [string, string])[] = [],
): XmlElement {
  if (typeof content === 'string') return { name, attributes, text: content, children: [] }
  return { name, attributes, text: null, children: content.filter((child): child is XmlElement => !!child) }
}

/** An element only when the value is present. */
export function optional(name: string, value: string | null | undefined): XmlElement | null {
  return value === null || value === undefined ? null : el(name, value)
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}

function write(element: XmlElement, depth: number, out: string[]): void {
  const indent = '  '.repeat(depth)
  const attributes = element.attributes.map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`).join('')
  if (element.text !== null) {
    out.push(`${indent}<${element.name}${attributes}>${escapeText(element.text)}</${element.name}>`)
    return
  }
  if (element.children.length === 0) {
    out.push(`${indent}<${element.name}${attributes}/>`)
    return
  }
  out.push(`${indent}<${element.name}${attributes}>`)
  for (const child of element.children) write(child, depth + 1, out)
  out.push(`${indent}</${element.name}>`)
}

export function serializeXml(root: XmlElement): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>']
  write(root, 0, out)
  return `${out.join('\n')}\n`
}
