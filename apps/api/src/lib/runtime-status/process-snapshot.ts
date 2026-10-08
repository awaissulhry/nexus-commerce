/**
 * What each process knows about itself, published to Redis so the API can report it.
 *
 * THE PROBLEM THIS EXISTS FOR
 * Production runs three processes from this codebase (src/runtime/): the HTTP API, the queue worker and the
 * cron scheduler. The status endpoints are served by the API, but much of what they describe lives in the
 * memory of another process: which crons the scheduler registered, how far its startup got, the Autopilot
 * sync worker's counters, each process's publish circuit breakers. Read from the API's own memory those
 * values are always empty, so screens said "not scheduled", "never ran" and "closed" about things the API
 * cannot see.
 *
 * HOW
 * Every process publishes a small JSON snapshot every PUBLISH_INTERVAL_MS to
 * `nexus:runtime:process:<role>:<instance>` with a TTL of SNAPSHOT_TTL_MS, and lists itself in the set
 * `nexus:runtime:processes`. A reader takes the snapshots whose key still exists: a key that expired belongs to
 * a process that stopped publishing. Sections are registered by the code that owns the value
 * (`registerStatusSection`), so a snapshot carries only what that process actually holds.
 *
 * A value no live snapshot carries is UNKNOWN. Readers return it as `null` together with an `UnknownValue`
 * that names the field, the process that owns it and why it could not be read — never as a default that
 * looks like a fact.
 */
import { hostname } from 'node:os'

export type ProcessRole = 'api' | 'worker' | 'scheduler'
export const PROCESS_ROLES: readonly ProcessRole[] = ['api', 'worker', 'scheduler']

/** How often each process republishes, and how long a snapshot outlives its last publish. */
export const PUBLISH_INTERVAL_MS = 5_000
export const SNAPSHOT_TTL_MS = 30_000
/** Every status command is bounded: the shared connection retries forever on an unreachable Redis. */
const COMMAND_TIMEOUT_MS = 1_500

let keyPrefix = 'nexus:runtime'
/** Test seam: suites sharing one Redis use their own key space. */
export function setStatusKeyPrefixForTests(prefix: string | undefined): void {
  keyPrefix = prefix ?? 'nexus:runtime'
}
export const statusKey = (suffix: string) => `${keyPrefix}:${suffix}`
export const processIndexKey = () => statusKey('processes')
export const snapshotKey = (member: string) => statusKey(`process:${member}`)

export interface ProcessSnapshot {
  v: 1
  role: ProcessRole
  instanceId: string
  pid: number
  startedAt: string
  publishedAt: string
  /** True once the process finished starting (for the scheduler: every cron is registered). */
  ready: boolean
  sections: Record<string, unknown>
}

/** A value the API cannot know, with the process that holds it and the reason. */
export interface UnknownValue {
  field: string
  owner: ProcessRole
  reason: string
}

/** The Redis commands this module uses. ioredis satisfies it; tests may pass a stand-in. */
export interface StatusRedis {
  status?: string
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>
  sadd(key: string, ...members: string[]): Promise<unknown>
  srem(key: string, ...members: string[]): Promise<unknown>
  smembers(key: string): Promise<string[]>
  mget(...keys: string[]): Promise<Array<string | null>>
  del(...keys: string[]): Promise<unknown>
  incr(key: string): Promise<number>
}

export type RedisAccess = { client: StatusRedis; reason?: undefined } | { client: null; reason: string }

export function currentProcessRole(): ProcessRole {
  const role = process.env.NEXUS_PROCESS_ROLE
  return role === 'worker' || role === 'scheduler' ? role : 'api'
}

const startedAt = new Date().toISOString()
const instanceId = `${process.env.RAILWAY_REPLICA_ID || hostname()}:${process.pid}`
const sections = new Map<string, () => unknown>()
let ready = false

/** Adds a named value to this process's snapshot. The provider runs on every publish; keep it cheap. */
export function registerStatusSection(name: string, provider: () => unknown): void {
  sections.set(name, provider)
}

export function markProcessReady(value = true): void {
  ready = value
}

export function localInstanceId(): string {
  return instanceId
}

export function buildLocalSnapshot(now = new Date()): ProcessSnapshot {
  const out: Record<string, unknown> = {}
  for (const [name, provider] of sections) {
    try {
      out[name] = provider()
    } catch (error) {
      out[name] = { error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { v: 1, role: currentProcessRole(), instanceId, pid: process.pid, startedAt, publishedAt: now.toISOString(), ready, sections: out }
}

let redisOverride: StatusRedis | null | undefined

/** Test seam: a client (or null for "no Redis") used instead of the shared queue connection. */
export function setStatusRedisForTests(client: StatusRedis | null | undefined): void {
  redisOverride = client
}

export async function statusRedis(): Promise<RedisAccess> {
  if (redisOverride !== undefined) {
    return redisOverride ? { client: redisOverride } : { client: null, reason: 'Redis is not available in this process' }
  }
  if (!process.env.REDIS_URL && !process.env.REDIS_HOST) {
    return { client: null, reason: 'Redis is not configured in the API (REDIS_URL is unset)' }
  }
  try {
    const { redis } = await import('../queue.js')
    const client = redis.connection as unknown as StatusRedis | null
    if (!client) return { client: null, reason: 'the API has no Redis connection' }
    if (client.status && client.status !== 'ready') return { client: null, reason: `the API's Redis connection is ${client.status}` }
    return { client }
  } catch (error) {
    return { client: null, reason: `the API could not open Redis: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function bounded<T>(work: Promise<T>, ms = COMMAND_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis did not answer within ${ms} ms`)), ms)
  })
  work.catch(() => {})
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

const memberOf = (snapshot: Pick<ProcessSnapshot, 'role' | 'instanceId'>) => `${snapshot.role}:${snapshot.instanceId}`

export async function publishLocalSnapshot(access?: RedisAccess): Promise<boolean> {
  const redis = access ?? (await statusRedis())
  if (!redis.client) return false
  const snapshot = buildLocalSnapshot()
  const member = memberOf(snapshot)
  await bounded(redis.client.set(snapshotKey(member), JSON.stringify(snapshot), 'PX', SNAPSHOT_TTL_MS))
  await bounded(redis.client.sadd(processIndexKey(), member))
  return true
}

/** On a clean shutdown, stop reporting at once instead of waiting for the TTL. */
export async function withdrawLocalSnapshot(): Promise<void> {
  const redis = await statusRedis()
  if (!redis.client) return
  const member = memberOf(buildLocalSnapshot())
  await bounded(redis.client.del(snapshotKey(member))).catch(() => {})
  await bounded(redis.client.srem(processIndexKey(), member)).catch(() => {})
}

export function parseSnapshot(raw: string): ProcessSnapshot | null {
  try {
    const value = JSON.parse(raw) as Partial<ProcessSnapshot>
    if (value?.v !== 1 || !value.role || !PROCESS_ROLES.includes(value.role) || typeof value.instanceId !== 'string') return null
    return { ...value, sections: value.sections ?? {}, ready: value.ready === true } as ProcessSnapshot
  } catch {
    return null
  }
}

export interface LiveProcesses {
  /** This process first (always fresh), then every other process whose snapshot has not expired. */
  snapshots: ProcessSnapshot[]
  /** Why other processes could not be read at all, or null when Redis answered. */
  redisUnavailable: string | null
}

export async function readLiveProcesses(): Promise<LiveProcesses> {
  const local = buildLocalSnapshot()
  const redis = await statusRedis()
  if (!redis.client) return { snapshots: [local], redisUnavailable: redis.reason }
  try {
    const members = await bounded(redis.client.smembers(processIndexKey()))
    const values = members.length ? await bounded(redis.client.mget(...members.map(snapshotKey))) : []
    const expired: string[] = []
    const snapshots = [local]
    members.forEach((member, index) => {
      const raw = values[index]
      if (!raw) {
        expired.push(member)
        return
      }
      const snapshot = parseSnapshot(raw)
      if (!snapshot || memberOf(snapshot) === memberOf(local)) return
      snapshots.push(snapshot)
    })
    if (expired.length) void bounded(redis.client.srem(processIndexKey(), ...expired)).catch(() => {})
    return { snapshots, redisUnavailable: null }
  } catch (error) {
    return { snapshots: [local], redisUnavailable: `Redis did not answer: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function snapshotsOf(live: LiveProcesses, role: ProcessRole): ProcessSnapshot[] {
  return live.snapshots.filter(snapshot => snapshot.role === role)
}

/** Why a role's value cannot be read: Redis is out of reach, or the role has no live heartbeat. */
export function missingRoleReason(live: LiveProcesses, role: ProcessRole): string {
  if (live.redisUnavailable) return `${live.redisUnavailable}, so the ${role} process's state cannot be read`
  return `no live heartbeat from the ${role} process in the last ${SNAPSHOT_TTL_MS / 1000} s: it is not running or cannot publish its status`
}

export function unknownFor(live: LiveProcesses, role: ProcessRole, field: string, reason?: string): UnknownValue {
  return { field, owner: role, reason: reason ?? missingRoleReason(live, role) }
}

/** One line per role: who is reporting, since when, and how fresh the report is. */
export function describeProcesses(live: LiveProcesses, now = Date.now()) {
  return Object.fromEntries(PROCESS_ROLES.map(role => {
    const instances = snapshotsOf(live, role).map(snapshot => ({
      instanceId: snapshot.instanceId,
      startedAt: snapshot.startedAt,
      uptimeSec: Math.max(0, Math.round((now - Date.parse(snapshot.startedAt)) / 1000)),
      publishedAt: snapshot.publishedAt,
      ready: snapshot.ready,
    }))
    return [role, instances.length ? { reporting: true, instances } : { reporting: false, instances, reason: missingRoleReason(live, role) }]
  })) as Record<ProcessRole, { reporting: boolean; instances: Array<{ instanceId: string; startedAt: string; uptimeSec: number; publishedAt: string; ready: boolean }>; reason?: string }>
}

// ── Build ───────────────────────────────────────────────────────────────────
//
// Which commit and Railway deployment a process runs. A process that started again under the SAME deployment was
// restarted by a crash or an out-of-memory kill, not by a deploy (the platform health watchdog tells the two apart).
// Neither value is a secret: Railway sets both on every service.

export function buildSection(env: NodeJS.ProcessEnv = process.env): { sha: string | null; deployment: string | null } {
  const sha = (env.RAILWAY_GIT_COMMIT_SHA ?? '').trim().slice(0, 12)
  const deployment = (env.RAILWAY_DEPLOYMENT_ID ?? '').trim()
  return { sha: /^[0-9a-f]{7,12}$/i.test(sha) ? sha : null, deployment: /^[A-Za-z0-9-]{1,64}$/.test(deployment) ? deployment : null }
}

// ── Environment flags ───────────────────────────────────────────────────────
//
// Feature flags are set per Railway service, so the API's process.env says nothing certain about the
// scheduler's. Each process publishes its own flags; a reader asks the process that acts on the flag.

const FLAG_NAME = /^NEXUS_(ENABLE|DISABLE)_[A-Z0-9_]+$/
const EXTRA_FLAGS = new Set(['ENABLE_QUEUE_WORKERS', 'NEXUS_AMAZON_ADS_MODE', 'NEXUS_WORKSPACES_ENABLED', 'NEXUS_REQUIRE_CRON_LEASE'])
/** Flags are short switches. Anything else is replaced, so a misfiled secret never leaves the process. */
const FLAG_VALUE = /^[A-Za-z0-9_.:-]{0,32}$/

export function flagSection(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !(FLAG_NAME.test(name) || EXTRA_FLAGS.has(name))) continue
    out[name] = FLAG_VALUE.test(value) ? value : '[set]'
  }
  return out
}

/** `raw` is the value that process sees (null = unset there); when `known` is false, `unknown` says why. */
export interface FlagReading { known: boolean; raw: string | null; unknown?: UnknownValue }

/** The raw value `role` sees for a flag (null = unset there), or unknown when that process is not reporting. */
export function readFlag(live: LiveProcesses, role: ProcessRole, name: string, field = name): FlagReading {
  const reporting = snapshotsOf(live, role).filter(snapshot => snapshot.sections.flags && typeof snapshot.sections.flags === 'object')
  if (!reporting.length) return { known: false, raw: null, unknown: unknownFor(live, role, field) }
  const newest = reporting.reduce((a, b) => (a.publishedAt >= b.publishedAt ? a : b))
  const raw = (newest.sections.flags as Record<string, string>)[name]
  return { known: true, raw: raw ?? null }
}
