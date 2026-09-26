import { expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'

// PostgreSQL searches the caller's temporary schema FIRST for relation and type
// names unless search_path names pg_temp; a SECURITY DEFINER body that omits it
// lets any caller who can call it run code as the owner through a temp type.
const dir = new URL('../workspaces/', import.meta.url)
const files = readdirSync(dir).filter(file => file.endsWith('.sql')).map(file => ({ file, sql: readFileSync(new URL(file, dir), 'utf8') }))
const functions = files.flatMap(({ file, sql }) =>
  [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w."]+)\s*\(([\s\S]*?)\bAS\s+\$/gi)]
    .map(match => ({ file, name: match[1], header: match[2] })))
const definers = functions.filter(fn => /\bSECURITY\s+DEFINER\b/i.test(fn.header))

it('parses every SECURITY DEFINER declaration in the shared policies (positive control)', () => {
  const declared = files.flatMap(({ sql }) => sql.split('\n')).filter(line => !/^\s*--/.test(line) && /\bSECURITY\s+DEFINER\b/i.test(line))
  expect(definers.length).toBe(declared.length)
  expect(definers.length).toBeGreaterThan(40)
  expect(definers.map(fn => fn.name)).toEqual(expect.arrayContaining(['public.nexus_ebay_quarantine_manifest', 'public.nexus_rewrap_ebay_quarantine']))
})
it('pins every SECURITY DEFINER search_path with pg_temp last', () => {
  const unsafe = definers.filter(fn => {
    const path = /\bSET\s+search_path\s*=\s*([^\n]*?)(?=\s+(?:SET\b|AS\b|$))/i.exec(fn.header)?.[1]
    return !path || path.split(',').map(part => part.trim().toLowerCase()).at(-1) !== 'pg_temp'
  }).map(fn => `${fn.file}: ${fn.name}`)
  expect(unsafe).toEqual([])
})
