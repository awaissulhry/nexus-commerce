/**
 * FF1.9 — ArtifactStore
 *
 * Generic byte-level store for large export artifacts.
 * Fixes F8: exports >1 MB silently vanish because base64-in-Postgres overflows.
 *
 * Provider is selected by the SAME env-config convention as storage.service.ts:
 *
 *   STORAGE_PROVIDER=S3  (or unset + AWS creds)  → S3ArtifactStore (AWS S3)
 *   STORAGE_PROVIDER=R2                           → S3ArtifactStore (Cloudflare R2)
 *   STORAGE_PROVIDER=LOCAL (or unset)             → FsArtifactStore  ← default for dev/CI
 *
 * S3 env vars (mirror storage.service.ts keys):
 *   AWS_S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *
 * R2 env vars (mirror storage.service.ts keys):
 *   R2_BUCKET_NAME, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import fs from 'fs/promises'
import path from 'path'

// ── Interface ─────────────────────────────────────────────────────────────────

export interface ArtifactStore {
  /**
   * Persist `bytes` under `key`.
   * Returns an opaque handle that can be passed back to `get()` on the same store instance.
   */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<string>

  /**
   * Retrieve bytes by the handle returned from `put()`.
   * Returns `null` if the artifact is not found (never throws for a missing key).
   */
  get(handle: string): Promise<Uint8Array | null>
}

// ── Key sanitisation ──────────────────────────────────────────────────────────

/**
 * Replace any character that is not alphanumeric, dot, dash, or underscore with underscore.
 * Uses regex replace (not String.replaceAll — constraint) to produce a safe flat filename.
 */
function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_')
}

// ── FsArtifactStore ───────────────────────────────────────────────────────────

/**
 * Default output directory.
 * Mirrors storage.service.ts which uses process.cwd() from the monorepo root
 * so that the path resolves correctly on Railway.
 */
const DEFAULT_EXPORT_DIR = path.join(process.cwd(), 'apps/api/public/exports')

/**
 * Local filesystem implementation.
 * Handle format: `local:<safeFilename>`
 *
 * Safe to use in development and CI without any cloud credentials.
 */
export class FsArtifactStore implements ArtifactStore {
  private baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? DEFAULT_EXPORT_DIR
  }

  async put(key: string, bytes: Uint8Array, _contentType: string): Promise<string> {
    await fs.mkdir(this.baseDir, { recursive: true })
    const safeFilename = sanitizeKey(key)
    const filepath = path.join(this.baseDir, safeFilename)
    await fs.writeFile(filepath, bytes)
    return `local:${safeFilename}`
  }

  async get(handle: string): Promise<Uint8Array | null> {
    const prefix = 'local:'
    if (!handle.startsWith(prefix)) return null
    const relpath = handle.slice(prefix.length)
    const filepath = path.join(this.baseDir, relpath)
    try {
      const buf = await fs.readFile(filepath)
      // Explicitly copy into a plain Uint8Array.
      // Buffer extends Uint8Array but vitest toEqual distinguishes the constructor,
      // and downstream code should receive a canonical Uint8Array.
      const out = new Uint8Array(buf.byteLength)
      out.set(buf)
      return out
    } catch {
      // ENOENT or any other fs error → treat as not found
      return null
    }
  }
}

// ── S3ArtifactStore ───────────────────────────────────────────────────────────

/**
 * AWS S3 / Cloudflare R2 implementation.
 * Reads the same env vars as storage.service.ts so ops configure cloud storage once.
 * Handle format: the raw S3 object key (string).
 */
export class S3ArtifactStore implements ArtifactStore {
  private client: S3Client
  private bucket: string

  constructor() {
    const provider = process.env.STORAGE_PROVIDER ?? 'S3'

    if (provider === 'R2') {
      this.client = new S3Client({
        region: 'auto',
        endpoint: process.env.R2_ENDPOINT,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
        },
      })
      this.bucket = process.env.R2_BUCKET_NAME ?? ''
    } else {
      // S3 (default cloud path)
      this.client = new S3Client({
        region: process.env.AWS_REGION ?? 'us-east-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
        },
      })
      this.bucket = process.env.AWS_S3_BUCKET ?? ''
    }
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<string> {
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: bytes,
      ContentType: contentType,
    })
    await this.client.send(cmd)
    // Return the object key as the opaque handle
    return key
  }

  async get(handle: string): Promise<Uint8Array | null> {
    try {
      const cmd = new GetObjectCommand({
        Bucket: this.bucket,
        Key: handle,
      })
      const response = await this.client.send(cmd)
      if (!response.Body) return null

      // Collect streaming body into a Uint8Array
      const chunks: Uint8Array[] = []
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk)
      }
      const total = chunks.reduce((acc, c) => acc + c.length, 0)
      const out = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.length
      }
      return out
    } catch (err: unknown) {
      // S3 SDK v3 surfaces NoSuchKey via err.name; some older wrappers use err.Code
      const e = err as { name?: string; Code?: string }
      if (e?.name === 'NoSuchKey' || e?.Code === 'NoSuchKey') return null
      throw err
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Returns the appropriate ArtifactStore for the current environment.
 *
 * Selection logic (mirrors storage.service.ts initializeConfig):
 *   STORAGE_PROVIDER=S3  → S3ArtifactStore
 *   STORAGE_PROVIDER=R2  → S3ArtifactStore (R2 mode)
 *   anything else        → FsArtifactStore  (LOCAL — dev/CI default)
 */
export function getArtifactStore(): ArtifactStore {
  const provider = process.env.STORAGE_PROVIDER ?? 'LOCAL'
  if (provider === 'S3' || provider === 'R2') {
    return new S3ArtifactStore()
  }
  return new FsArtifactStore()
}
