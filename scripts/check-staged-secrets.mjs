#!/usr/bin/env node
/**
 * Secret guard for the staged change (runs first in .githooks/pre-commit).
 *
 * WHY
 * This repository is public. From April to August 2026 the production database password sat in
 * `.claude/settings.local.json`, inside allow rules, across several commits; it had to be rotated
 * (2026-09-26) and stays readable in history forever. The Amazon data protection answers of
 * 2026-10-09 promise that credentials never reach a repository again.
 *
 * THE RULE
 * A commit may not add:
 *   1. a value of a secret-looking key from a local .env file (exact match: the real value, any file);
 *   2. a known credential shape (Neon password, AWS access key, Amazon LWA token or secret, private key);
 *   3. a local secrets file itself (.env*, except .env.example / .sample / .template, and
 *      .claude/settings.local.json).
 * A line that must keep a fake credential carries `secret-guard: allow`.
 * Findings name the file, the line and the reason, never the value.
 *
 *   node scripts/check-staged-secrets.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

const top = git('rev-parse', '--show-toplevel').trim()
// A worktree has no .env of its own: the real values live in the main checkout.
const mainRoot = dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir').trim())

const ENV_FILES = [
  '.env', '.env.local', '.env.production', '.env.development',
  'apps/api/.env', 'apps/api/.env.local',
  'apps/web/.env', 'apps/web/.env.local', 'apps/web/.env.production',
  'apps/factory/.env', 'packages/database/.env', 'services/bidding-engine/.env',
]
const SECRET_KEY = /PASS|SECRET|TOKEN|KEY|PRIVATE|CREDENTIAL|DSN|DATABASE_URL|_URL$/i
const NOT_SECRET = /^(true|false|on|off|yes|no|\d+(\.\d+)?|https?:\/\/[^@\s]*|localhost.*|127\.0\.0\.1.*)$/i

/** key → values: each secret value, plus the password inside any URL with credentials. */
function localSecrets() {
  const found = new Map()
  const add = (key, value) => {
    if (value.length < 10 || NOT_SECRET.test(value)) return
    if (!found.has(value)) found.set(value, key)
  }
  for (const root of new Set([top, mainRoot])) {
    for (const rel of ENV_FILES) {
      const file = join(root, rel)
      if (!existsSync(file)) continue
      for (const raw of readFileSync(file, 'utf8').split('\n')) {
        const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
        if (!m) continue
        const key = m[1]
        const value = m[2].replace(/^(['"])(.*)\1$/, '$2').trim()
        const cred = value.match(/^[a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:([^@\s]+)@/i)
        if (cred) add(`${key} (password in URL)`, decodeURIComponent(cred[1]))
        if (SECRET_KEY.test(key)) add(key, value)
      }
    }
  }
  return found
}

const SHAPES = [
  ['Neon database password', /npg_[A-Za-z0-9]{12,}/],
  ['AWS access key id', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Amazon LWA refresh token', /Atzr\|[A-Za-z0-9_\-]{40,}/],
  ['Amazon LWA client secret', /amzn1\.oa2-cs\.v1\.[a-f0-9]{40,}/],
  ['private key', /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----/],
]
const SECRET_FILE = /(^|\/)(\.env(\.(?!example$|sample$|template$)[^/]+)?|\.claude\/settings\.local\.json)$/

const findings = []
const staged = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean)
for (const path of staged) if (SECRET_FILE.test(path)) findings.push(`${path}: a local secrets file is staged`)

const secrets = localSecrets()
const diff = git('diff', '--cached', '--no-color', '--no-ext-diff', '-U0', '--diff-filter=ACMR')
let file = null
let line = 0
for (const text of diff.split('\n')) {
  if (text.startsWith('+++ ')) { file = text.replace(/^\+\+\+ (b\/)?/, ''); continue }
  const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
  if (hunk) { line = Number(hunk[1]); continue }
  if (!text.startsWith('+') || file === null) continue
  const added = text.slice(1)
  if (!added.includes('secret-guard: allow')) {
    for (const [value, key] of secrets) if (added.includes(value)) findings.push(`${file}:${line}: the value of ${key} from a local .env file`)
    for (const [name, shape] of SHAPES) if (shape.test(added)) findings.push(`${file}:${line}: looks like a ${name}`)
  }
  line++
}

if (findings.length) {
  console.error('check-staged-secrets: this commit would publish a credential. Nothing was committed.\n')
  for (const f of [...new Set(findings)]) console.error(`  ${f}`)
  console.error('\nRemove it from the staged change (git restore --staged <file>) and read it from the environment instead.')
  process.exit(1)
}
