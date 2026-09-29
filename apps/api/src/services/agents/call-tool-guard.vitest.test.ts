/**
 * MCP.1 — guards that keep call-tool.ts the only door.
 *
 * 1. No source file outside call-tool.ts runs a registry tool's `handler` or
 *    `execute` itself. A new front door (the MCP endpoint, a job) that did
 *    would skip the permission check, the business binding and the money
 *    filter all at once.
 * 2. Every registered tool names permissions that exist. A typo would make a
 *    tool that nobody but an owner can call — or, worse, a check that passes
 *    because the typo matches nothing a role could hold.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isValidPermission } from '@nexus/shared/permissions'
import { listTools } from './tool-registry.js'

const SRC = fileURLToPath(new URL('../../', import.meta.url))
const DOOR = 'services/agents/call-tool.ts'

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(path)
  }
  return out
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('MCP.1 — one door for every tool', () => {
  it('only call-tool.ts runs a tool’s handler or execute', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file)
      if (rel === DOOR) continue
      const code = withoutComments(readFileSync(file, 'utf8'))
      const importsRegistry = /from '[^']*tool-registry\.js'/.test(code)
      // Any `…tool.handler(` anywhere, and any `.handler(` / `.execute(` in a
      // file that can look tools up.
      const direct = /\b\w*[tT]ool\??\.(handler|execute)\s*\(/.test(code)
      const viaRegistry = importsRegistry && /\.(handler|execute)\s*\(/.test(code)
      if (direct || viaRegistry) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('every tool requires at least one real permission', () => {
    const bad = listTools()
      .filter((tool) => tool.requires.length === 0 || !tool.requires.every(isValidPermission))
      .map((tool) => tool.name)
    expect(bad).toEqual([])
  })

  it('every tool-declared money key maps to a real field permission', () => {
    const bad = listTools().flatMap((tool) =>
      Object.entries(tool.restrictedFields ?? {})
        .filter(([, permission]) => !permission.startsWith('financials.') || !isValidPermission(permission))
        .map(([key]) => `${tool.name}.${key}`),
    )
    expect(bad).toEqual([])
  })
})
