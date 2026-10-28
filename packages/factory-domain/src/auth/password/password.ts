import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { Issue } from '../../core/errors'

/**
 * Office passwords (plan A1 §3.10; features PLT-047, PLT-070): what a new password must be, and how it is stored.
 * Ported from Commerce (apps/api/src/lib/auth/password.ts): a length floor and ceiling checked before any hashing, a
 * check against the account's own name and well-known passwords, a self-describing hash that a later, stronger
 * setting can replace on the next sign-in (`needsRehash`), and a verify that answers in the same time whether or not
 * there is a stored hash. Commerce hashes with argon2id (a native package); the factory uses scrypt from node:crypto.
 *
 * Stored form (PHC string format): `$scrypt$ln=15,r=8,p=3$<salt>$<hash>`, salt 16 random bytes, hash 32 bytes, both
 * base64url without padding. The password is NFKC-normalized first, so the same characters typed on another keyboard
 * or system give the same hash.
 */

export const PASSWORD_MIN_LENGTH = 12
/** Longer input is refused before hashing: scrypt over a huge string would cost CPU for nothing. */
export const PASSWORD_MAX_LENGTH = 256

export interface ScryptParams {
  /** log2 of the CPU and memory cost N. */
  readonly logN: number
  readonly r: number
  readonly p: number
}

/** OWASP Password Storage Cheat Sheet (scrypt): N=2^15 (32 MiB), r=8, p=3. About 150 ms per hash on a laptop. */
export const SCRYPT_PARAMS: ScryptParams = Object.freeze({ logN: 15, r: 8, p: 3 })

const SALT_BYTES = 16
const HASH_BYTES = 32
/** Bounds for parameters read back from a stored hash, so a tampered row cannot make a verify run for minutes. */
const LIMITS = { logN: [10, 20], r: [1, 32], p: [1, 16] } as const
const FORMAT = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9_-]{16,64})\$([A-Za-z0-9_-]{32,128})$/

/**
 * Well-known passwords of the allowed length, from public breach top lists (a stand-in for the breached-password
 * check until a k-anonymity lookup exists; compared without case).
 */
const COMMON = new Set([
  '123456789012',
  '1234567890123',
  '12345678901234',
  '123456789abc',
  'abc123456789',
  'password1234',
  'password12345',
  'password123456',
  'passwordpassword',
  'qwertyuiop123',
  'qwertyuiopasdf',
  'qwerty123456',
  'iloveyou1234',
  'welcome12345',
  'administrator',
  'letmein12345',
  'changeme1234',
  'football1234',
  'baseball1234',
  'monkey123456',
  'dragon123456',
  'sunshine1234',
  'princess1234',
  'starwars1234',
  'trustno11234',
  '111111111111',
  '000000000000',
  'aaaaaaaaaaaa',
  'abcdefghijkl',
  'qazwsxedcrfv',
  '1q2w3e4r5t6y',
  'zaq12wsxcde3',
])

const normalize = (password: string): string => password.normalize('NFKC')

export interface PasswordContext {
  /** The account's email; a password that contains its name part is refused. */
  readonly email?: string | undefined
  readonly displayName?: string | undefined
}

/**
 * What is wrong with a new password, as issues at `password` (empty: it is accepted). The message is for the person.
 */
export function passwordProblems(password: unknown, context: PasswordContext = {}): Issue[] {
  const at = (message: string): Issue[] => [{ path: 'password', message }]
  if (typeof password !== 'string') return at('Enter a password.')
  const value = normalize(password)
  const length = [...value].length
  if (length < PASSWORD_MIN_LENGTH) return at(`Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  if (length > PASSWORD_MAX_LENGTH) return at(`Use at most ${PASSWORD_MAX_LENGTH} characters.`)
  if (value.trim() === '') return at('A password cannot be only spaces.')
  const lower = value.toLowerCase()
  if (new Set(lower).size < 4) return at('Use more different characters.')
  if (COMMON.has(lower)) return at('This password is too common; choose another.')
  const parts = [context.email?.split('@')[0], context.email, ...(context.displayName?.split(/\s+/) ?? [])]
    .map((part) => part?.trim().toLowerCase() ?? '')
    .filter((part) => part.length >= 4)
  if (parts.some((part) => lower.includes(part))) return at('Do not use your name or email in the password.')
  return []
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const N = 2 ** params.logN
  // Node refuses scrypt above maxmem (default 32 MiB); the need is about 128 * N * r bytes.
  const maxmem = 256 * N * params.r
  return new Promise((resolve, reject) => {
    scrypt(normalize(password), salt, HASH_BYTES, { N, r: params.r, p: params.p, maxmem }, (error, key) => (error ? reject(error) : resolve(key)))
  })
}

function checkParams(params: ScryptParams): void {
  for (const key of ['logN', 'r', 'p'] as const) {
    const [min, max] = LIMITS[key]
    if (!Number.isInteger(params[key]) || params[key] < min || params[key] > max) throw new Error(`scrypt ${key} must be ${min} to ${max}.`)
  }
}

/** The stored form of a new password. Check `passwordProblems` first; this only refuses an overlong input. */
export async function hashPassword(password: string, params: ScryptParams = SCRYPT_PARAMS): Promise<string> {
  checkParams(params)
  if (typeof password !== 'string' || [...password].length > PASSWORD_MAX_LENGTH) throw new Error('The password is too long to hash.')
  const salt = randomBytes(SALT_BYTES)
  const hash = await derive(password, salt, params)
  return `$scrypt$ln=${params.logN},r=${params.r},p=${params.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export interface PasswordCheck {
  readonly ok: boolean
  /** The hash was made with other parameters than SCRYPT_PARAMS: store a new one after a successful check. */
  readonly needsRehash: boolean
}

interface Parsed {
  readonly params: ScryptParams
  readonly salt: Buffer
  readonly hash: Buffer
}

function parse(stored: string): Parsed | null {
  const match = FORMAT.exec(stored)
  if (!match) return null
  const params = { logN: Number(match[1]), r: Number(match[2]), p: Number(match[3]) }
  try {
    checkParams(params)
  } catch {
    return null
  }
  const hash = Buffer.from(match[5]!, 'base64url')
  if (hash.length !== HASH_BYTES) return null
  return { params, salt: Buffer.from(match[4]!, 'base64url'), hash }
}

const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 7)

/**
 * Checks a password against its stored form in constant time (timingSafeEqual). Without a usable stored form (no
 * account, no password, a damaged row) or with an overlong input it still runs one scrypt with the current
 * parameters, so the answer takes the same time whether the account exists or not; then it answers no.
 */
export async function verifyPassword(password: unknown, stored: string | null | undefined): Promise<PasswordCheck> {
  const parsed = typeof stored === 'string' ? parse(stored) : null
  const usable = typeof password === 'string' && [...password].length <= PASSWORD_MAX_LENGTH
  if (!parsed || !usable) {
    await derive(usable ? password : '', DUMMY_SALT, SCRYPT_PARAMS)
    return { ok: false, needsRehash: false }
  }
  const candidate = await derive(password, parsed.salt, parsed.params)
  const ok = timingSafeEqual(candidate, parsed.hash)
  const current = parsed.params.logN === SCRYPT_PARAMS.logN && parsed.params.r === SCRYPT_PARAMS.r && parsed.params.p === SCRYPT_PARAMS.p
  return { ok, needsRehash: ok && !current }
}
