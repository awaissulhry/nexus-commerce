import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// @nexus/factory-domain is pure logic with no I/O. Its source files (tests aside) may not import Node's I/O modules,
// a database, a queue, a network client or a provider SDK, call fetch, or read the environment. Ports (interfaces)
// live here; the adapters that do the I/O live in apps/factory-api.

const FORBIDDEN_MODULES = [
  /^(node:)?(fs|fs\/promises|net|tls|http|https|http2|dgram|dns|child_process|cluster|worker_threads|readline)$/,
  /^pg$/,
  /^@prisma\//,
  /^ioredis$/,
  /^bullmq$/,
  /^@aws-sdk\//,
  /^stripe$/,
  /^@nexus\/(factory-db|db-kit)(\/|$)/,
]

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

function impurities(source: string): string[] {
  const code = withoutComments(source)
  const found: string[] = []
  for (const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)) {
    const module = match[1] ?? ''
    if (FORBIDDEN_MODULES.some((rule) => rule.test(module))) found.push(module)
  }
  if (/\bprocess\.env\b/.test(code)) found.push('process.env')
  if (/(?<![.\w])fetch\s*\(/.test(code)) found.push('fetch()')
  return found
}

const sourceRoot = fileURLToPath(new URL('.', import.meta.url))

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('factory-domain purity', () => {
  it('finds I/O in planted source', () => {
    expect(impurities("import { readFileSync } from 'node:fs'")).toEqual(['node:fs'])
    expect(impurities("import pg from 'pg'\nconst x = await import('@prisma/client')")).toEqual(['pg', '@prisma/client'])
    expect(impurities("export * from '@nexus/factory-db/test-database'")).toEqual(['@nexus/factory-db/test-database'])
    expect(impurities('const url = process.env.FACTORY_API_URL')).toEqual(['process.env'])
    expect(impurities("await fetch('https://example.com')")).toEqual(['fetch()'])
  })

  it('leaves pure source alone', () => {
    expect(impurities("import { z } from 'zod'\nimport Decimal from 'decimal.js'\n// fetch('x') in a comment")).toEqual(
      [],
    )
    expect(impurities('client.fetch(query)')).toEqual([])
  })

  it('has no I/O in any source file of the package', () => {
    const offenders = sourceFiles(sourceRoot).flatMap((file) =>
      impurities(readFileSync(file, 'utf8')).map((what) => `${relative(sourceRoot, file)}: ${what}`),
    )
    expect(offenders).toEqual([])
  })
})
