import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
// B-W2b-160 (COL-052): large uploads in parts.
import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import type { MultipartStoreAdapter, ObjectDigest, PartTarget, StoredPart } from '../../platform/files/multipart/port'
import { dirname, resolve, sep } from 'node:path'
import type { FactoryEnv } from '../../env'
import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'
import { TooLargeObjectError, type DownloadTarget, type FileStoreAdapter, type PresignedRequest, type PutTarget, type StoredObject, type UploadTarget } from '../../platform/files/port'
import { isStorageKey, normaliseContentType } from '../../platform/files/rules'

/**
 * The local file store (plan A1 §3.6 "Local: a filesystem adapter with the same interface, including fake presigned URLs
 * served by the API"): the store of an R2 account in FAKE mode, for local runs and tests only. Objects are files under
 * `root` at their storage key, each with a `.meta.json` beside it (the content type it was uploaded with).
 *
 * Its "presigned URLs" are paths on this API, `/local-files?token=<token>`, served by platform/files/routes.ts: the token is
 * the grant (method, key, expiry, and for an upload the content type, size and SHA-256; for a download the type and the
 * `Content-Disposition`) signed with HMAC-SHA-256 under a random key of this process. Like a presigned S3 PUT with its
 * checksum, an upload whose type, size or SHA-256 differs from the grant is refused. Nothing here touches the network.
 * Refused with FACTORY_ENV staging or production: there the files are on R2.
 *
 * B-W2b-160 (COL-052), large uploads in parts: an upload is a folder `.multipart/<upload id>/` under `root` (its key and
 * type in `upload.json`), each part a file named by its number, sent through the same `/local-files?token=…` PUT with a
 * grant that names the upload and the part (size and SHA-256 checked like a presigned UploadPart). Listing reads the
 * folder; completing joins the parts in number order into the object and removes the folder; aborting removes it.
 */

export const LOCAL_FILES_PATH = '/local-files'

/** A refusal of the local store's routes: 400 a body that does not match, 403 a bad or expired token, 404 no object. */
export class LocalFileError extends Error {
  override name = 'LocalFileError'
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message)
  }
}

interface Grant {
  readonly m: 'PUT' | 'GET'
  /** The storage key. */
  readonly k: string
  /** Expiry, epoch milliseconds. */
  readonly x: number
  /** Content type. */
  readonly t: string
  /** Upload: size and SHA-256 (hex). */
  readonly n?: number
  readonly s?: string
  /** Download: Content-Disposition. */
  readonly d?: string
  /** B-W2b-160: a part of a multipart upload: the upload id and the part number. */
  readonly u?: string
  readonly p?: number
}

export interface LocalFileStore extends FileStoreAdapter, MultipartStoreAdapter {
  readonly root: string
  /** PUT /local-files?token=…: stores the body when it matches the grant. */
  acceptUpload(token: string, upload: { readonly body: Buffer; readonly contentType: string | undefined }, now: Date): Promise<void>
  /** GET /local-files?token=…: the object with its type and disposition. */
  openDownload(token: string, now: Date): Promise<{ readonly body: Buffer; readonly contentType: string; readonly disposition: string }>
}

export interface LocalFileStoreOptions {
  /** The folder that holds the objects (FACTORY_LOCAL_FILES_DIR; tests use a temporary folder). */
  readonly root: string
  readonly environment: FactoryEnv['FACTORY_ENV']
  /** The token key; default 32 random bytes per process (tokens die with the process, uploads live 5 minutes). */
  readonly signingKey?: Buffer
}

const sha256Hex = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
/** B-W2b-160: a multipart upload id this store made (hex), so it is safe in a path. */
const UPLOAD_ID = /^[0-9a-f]{32}$/
/** The type a part is sent with (the browser's request needs one for the local route's body parser). */
const PART_TYPE = 'application/octet-stream'

export function localFileStore(options: LocalFileStoreOptions): LocalFileStore {
  if (options.environment !== 'local' && options.environment !== 'test') {
    throw new Error(`The local file store is for local and test runs only; with FACTORY_ENV=${options.environment} files are on R2.`)
  }
  const root = resolve(options.root)
  const signingKey = options.signingKey ?? randomBytes(32)

  const sign = (payload: string): Buffer => createHmac('sha256', signingKey).update(payload).digest()
  const tokenOf = (grant: Grant): string => {
    const payload = Buffer.from(JSON.stringify(grant)).toString('base64url')
    return `${payload}.${sign(payload).toString('base64url')}`
  }
  function grantOf(token: string, method: Grant['m'], now: Date): Grant {
    const [payload, signature, extra] = token.split('.')
    const expected = payload ? sign(payload) : Buffer.alloc(0)
    const given = Buffer.from(signature ?? '', 'base64url')
    if (!payload || extra !== undefined || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new LocalFileError(403, 'This link is not valid.')
    }
    const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Grant
    if (grant.m !== method || !isStorageKey(grant.k)) throw new LocalFileError(403, 'This link is not valid.')
    if (grant.x <= now.getTime()) throw new LocalFileError(403, 'This link has expired.')
    return grant
  }
  /** The object's file: only a key storageKeyFor makes, and only under root. */
  function pathOf(key: string): string {
    const path = resolve(root, key)
    if (!isStorageKey(key) || !path.startsWith(root + sep)) throw new LocalFileError(403, 'Not a storage key.')
    return path
  }
  function fakeAccountOnly(call: GatewayCall): void {
    if (call.account.mode !== 'FAKE') throw new ProviderError('The local file store serves FAKE accounts only.', { retryable: false })
  }
  /** Writes the object and its type beside it; the object appears whole (written aside, then renamed). */
  async function write(key: string, contentType: string, body: Buffer): Promise<void> {
    const path = pathOf(key)
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomBytes(6).toString('hex')}.part`
    await writeFile(temporary, body)
    await writeFile(`${path}.meta.json`, JSON.stringify({ contentType }))
    await rename(temporary, path)
  }
  /** B-W2b-160: the folder of a multipart upload this store started, or a refusal. */
  function uploadFolder(uploadId: string): string {
    if (!UPLOAD_ID.test(uploadId)) throw new LocalFileError(403, 'Not an upload of this store.')
    return resolve(root, '.multipart', uploadId)
  }
  async function uploadOf(uploadId: string): Promise<{ folder: string; key: string; contentType: string } | null> {
    const folder = uploadFolder(uploadId)
    try {
      const meta = JSON.parse(await readFile(`${folder}/upload.json`, 'utf8')) as { key: string; contentType: string }
      return { folder, key: meta.key, contentType: meta.contentType }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  async function partsOf(folder: string): Promise<StoredPart[]> {
    const names = (await readdir(folder)).filter((name) => /^[1-9][0-9]{0,4}$/.test(name))
    const parts: StoredPart[] = []
    for (const name of names) {
      const body = await readFile(`${folder}/${name}`)
      parts.push({ partNumber: Number(name), etag: `"${createHash('md5').update(body).digest('hex')}"`, sizeBytes: body.length, sha256: sha256Hex(body) })
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber)
  }

  const presigned = (method: Grant['m'], grant: Grant, headers: Record<string, string>): PresignedRequest => ({
    method,
    url: `${LOCAL_FILES_PATH}?token=${tokenOf(grant)}`,
    headers,
    expiresAt: new Date(grant.x),
  })

  return {
    root,
    async presignUpload(call: GatewayCall, target: UploadTarget): Promise<PresignedRequest> {
      fakeAccountOnly(call)
      pathOf(target.key)
      const grant: Grant = { m: 'PUT', k: target.key, x: target.now.getTime() + target.expiresInSeconds * 1000, t: target.contentType, n: target.sizeBytes, s: target.sha256 }
      return presigned('PUT', grant, { 'content-type': target.contentType })
    },
    async presignDownload(call: GatewayCall, target: DownloadTarget): Promise<PresignedRequest> {
      fakeAccountOnly(call)
      pathOf(target.key)
      return presigned('GET', { m: 'GET', k: target.key, x: target.now.getTime() + target.expiresInSeconds * 1000, t: target.contentType, d: target.disposition }, {})
    },
    async head(call: GatewayCall, key: string): Promise<StoredObject | null> {
      fakeAccountOnly(call)
      const path = pathOf(key)
      try {
        // Like a store's own checksum: computed from the bytes it holds, not from what was announced.
        const body = await readFile(path)
        const meta = JSON.parse(await readFile(`${path}.meta.json`, 'utf8')) as { contentType?: string }
        return { sizeBytes: body.length, contentType: meta.contentType ?? null, sha256: sha256Hex(body) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    async put(call: GatewayCall, target: PutTarget): Promise<void> {
      fakeAccountOnly(call)
      const body = Buffer.from(target.body.buffer, target.body.byteOffset, target.body.byteLength)
      if (sha256Hex(body) !== target.sha256) throw new ProviderError('The content does not match its SHA-256.', { retryable: false })
      await write(target.key, normaliseContentType(target.contentType), body)
    },
    async remove(call: GatewayCall, key: string): Promise<void> {
      fakeAccountOnly(call)
      const path = pathOf(key)
      await rm(path, { force: true })
      await rm(`${path}.meta.json`, { force: true })
    },
    async read(call: GatewayCall, key: string, maxBytes: number): Promise<Buffer | null> {
      fakeAccountOnly(call)
      const path = pathOf(key)
      const found = await stat(path).catch(() => null)
      if (!found?.isFile()) return null
      if (found.size > maxBytes) throw new TooLargeObjectError(`The object holds ${found.size} bytes; at most ${maxBytes} are read.`)
      return readFile(path)
    },
    async acceptUpload(token, upload, now) {
      const grant = grantOf(token, 'PUT', now)
      // B-W2b-160: a part of a multipart upload goes to its upload's folder (size and SHA-256 as signed).
      if (grant.u !== undefined && grant.p !== undefined) {
        const open = await uploadOf(grant.u)
        if (!open || open.key !== grant.k) throw new LocalFileError(404, 'This upload is no longer open.')
        if (upload.body.length !== grant.n) throw new LocalFileError(400, 'The part\'s size is not the one announced.')
        if (sha256Hex(upload.body) !== grant.s) throw new LocalFileError(400, 'The part does not match its SHA-256.')
        const temporary = `${open.folder}/${grant.p}.${randomBytes(6).toString('hex')}.part`
        await writeFile(temporary, upload.body)
        await rename(temporary, `${open.folder}/${grant.p}`)
        return
      }
      if (normaliseContentType(upload.contentType ?? '') !== grant.t) throw new LocalFileError(400, 'The content type is not the one announced.')
      if (upload.body.length !== grant.n) throw new LocalFileError(400, 'The size is not the one announced.')
      if (sha256Hex(upload.body) !== grant.s) throw new LocalFileError(400, 'The content does not match its SHA-256.')
      await write(grant.k, grant.t, upload.body)
    },
    async openDownload(token, now) {
      const grant = grantOf(token, 'GET', now)
      const path = pathOf(grant.k)
      const found = await stat(path).catch(() => null)
      if (!found?.isFile()) throw new LocalFileError(404, 'Not found.')
      return { body: await readFile(path), contentType: grant.t, disposition: grant.d ?? 'attachment' }
    },

    // ---- B-W2b-160 (COL-052): large uploads in parts ------------------------------------------------------------------
    async startMultipart(call: GatewayCall, target: { readonly key: string; readonly contentType: string }): Promise<string> {
      fakeAccountOnly(call)
      pathOf(target.key)
      const uploadId = randomBytes(16).toString('hex')
      const folder = uploadFolder(uploadId)
      await mkdir(folder, { recursive: true })
      await writeFile(`${folder}/upload.json`, JSON.stringify({ key: target.key, contentType: normaliseContentType(target.contentType) }))
      return uploadId
    },
    async presignPart(call: GatewayCall, target: PartTarget): Promise<PresignedRequest> {
      fakeAccountOnly(call)
      pathOf(target.key)
      uploadFolder(target.uploadId)
      const grant: Grant = { m: 'PUT', k: target.key, x: target.now.getTime() + target.expiresInSeconds * 1000, t: PART_TYPE, n: target.sizeBytes, s: target.sha256, u: target.uploadId, p: target.partNumber }
      return presigned('PUT', grant, { 'content-type': PART_TYPE })
    },
    async listParts(call: GatewayCall, key: string, uploadId: string): Promise<StoredPart[] | null> {
      fakeAccountOnly(call)
      const open = await uploadOf(uploadId)
      if (!open || open.key !== key) return null
      return partsOf(open.folder)
    },
    async completeMultipart(call: GatewayCall, key: string, uploadId: string, parts: readonly StoredPart[]): Promise<void> {
      fakeAccountOnly(call)
      const open = await uploadOf(uploadId)
      if (!open || open.key !== key) throw new ProviderError('No such upload.', { retryable: false, httpStatus: 404 })
      const held = new Map((await partsOf(open.folder)).map((part) => [part.partNumber, part]))
      const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber)
      for (const part of ordered) {
        if (held.get(part.partNumber)?.etag !== part.etag) throw new ProviderError(`Part ${part.partNumber} is not the one sent.`, { retryable: false, httpStatus: 400 })
      }
      const body = Buffer.concat(await Promise.all(ordered.map((part) => readFile(`${open.folder}/${part.partNumber}`))))
      await write(key, open.contentType, body)
      await rm(open.folder, { recursive: true, force: true })
    },
    async abortMultipart(call: GatewayCall, _key: string, uploadId: string): Promise<void> {
      fakeAccountOnly(call)
      await rm(uploadFolder(uploadId), { recursive: true, force: true })
    },
    async digest(call: GatewayCall, key: string): Promise<ObjectDigest | null> {
      fakeAccountOnly(call)
      const path = pathOf(key)
      const found = await stat(path).catch(() => null)
      if (!found?.isFile()) return null
      const hash = createHash('sha256')
      let sizeBytes = 0
      for await (const chunk of createReadStream(path)) {
        hash.update(chunk as Buffer)
        sizeBytes += (chunk as Buffer).length
      }
      const meta = JSON.parse(await readFile(`${path}.meta.json`, 'utf8')) as { contentType?: string }
      return { sizeBytes, contentType: meta.contentType ?? null, sha256: hash.digest('hex') }
    },
  }
}
