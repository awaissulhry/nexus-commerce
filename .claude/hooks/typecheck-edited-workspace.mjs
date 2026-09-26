#!/usr/bin/env node
// PostToolUse hook: typecheck the workspace that holds the edited file, when that check is fast.
// Measured 2026-09-26 (tsc --noEmit, cold): shared 1s, events 0s, database 6s, factory 6-8s, api 15-18s, web 43-44s.
// api and web are skipped as too slow for every edit — run `npm run typecheck -w @nexus/api|web` yourself.
// Exit 2 shows the errors to Claude (the edit already happened). Anything unexpected exits 0, silently.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const FAST = new Set(['@nexus/shared', '@nexus/events', '@nexus/database', '@nexus/factory'])

let file
try { file = JSON.parse(readFileSync(0, 'utf8')).tool_input?.file_path } catch { process.exit(0) }
if (!file || !/\.(ts|tsx|mts|cts)$/.test(file) || /\/(node_modules|dist|generated)\//.test(file)) process.exit(0)

// The nearest package.json names the workspace. Works in worktrees too: the path is absolute.
let dir = dirname(file)
let pkg
while (dir !== dirname(dir)) {
  if (existsSync(join(dir, 'package.json'))) { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); break }
  dir = dirname(dir)
}
if (!pkg || !FAST.has(pkg.name) || !existsSync(join(dir, 'tsconfig.json'))) process.exit(0)

let tsc
try { tsc = createRequire(join(dir, 'package.json')).resolve('typescript/bin/tsc') } catch { process.exit(0) }
// --incremental false: apps/factory tracks its tsbuildinfo in git, and other sessions share it.
const run = spawnSync(process.execPath, [tsc, '--noEmit', '--incremental', 'false', '-p', 'tsconfig.json'],
  { cwd: dir, encoding: 'utf8', timeout: 50_000 })
if (run.error || run.status === 0) process.exit(0)
const errors = `${run.stdout}${run.stderr}`.split('\n').filter(line => line.includes('error TS'))
if (errors.length === 0) process.exit(0)
process.stderr.write(`typecheck ${pkg.name}: ${errors.length} error(s)\n${errors.slice(0, 20).join('\n')}\n`)
process.exit(2)
