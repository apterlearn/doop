import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import type { S3Client } from '@aws-sdk/client-s3'

/**
 * Byte storage for uploaded assets. With bucket credentials configured the
 * bytes live in S3-compatible object storage — the env names match what a
 * Railway Bucket injects via variable references (BUCKET, ACCESS_KEY_ID,
 * SECRET_ACCESS_KEY, ENDPOINT, REGION); R2 or S3 work with the same names.
 * Without them (local development) bytes land under ./data/assets, next to
 * PGlite. Either way the assets table is the source of truth for what exists.
 */

const BUCKET = process.env.BUCKET
const DISK_DIR = path.join(process.cwd(), 'data', 'assets')

export const storageMode: 'bucket' | 'disk' = BUCKET ? 'bucket' : 'disk'

/* keys are `<nanoid>.<ext>`, optionally under the `thumb/` prefix (derived
   frame previews — a folder of their own so they can be purged or lifecycle-
   ruled without touching user uploads) or the `bg/` prefix (the curated
   background library, server/backgrounds.ts). Anything else is a bug, and in
   disk mode the check doubles as the path-traversal guard: known literal
   prefixes, no dots or slashes in the name. */
function assertKey(key: string) {
  if (!/^(thumb\/|bg\/)?[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(key)) throw new Error(`malformed storage key: ${key}`)
}

let s3: S3Client | undefined
async function client(): Promise<S3Client> {
  if (!s3) {
    /* loaded on demand so dev without a bucket never pays for the SDK */
    const { S3Client } = await import('@aws-sdk/client-s3')
    s3 = new S3Client({
      region: process.env.REGION || 'auto',
      endpoint: process.env.ENDPOINT,
      credentials:
        process.env.ACCESS_KEY_ID && process.env.SECRET_ACCESS_KEY
          ? { accessKeyId: process.env.ACCESS_KEY_ID, secretAccessKey: process.env.SECRET_ACCESS_KEY }
          : undefined,
    })
  }
  return s3
}

export async function putObject(key: string, body: Buffer, mime: string): Promise<void> {
  assertKey(key)
  if (BUCKET) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    await (await client()).send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: mime }))
    return
  }
  await fs.mkdir(path.dirname(path.join(DISK_DIR, key)), { recursive: true })
  await fs.writeFile(path.join(DISK_DIR, key), body)
}

export async function deleteObject(key: string): Promise<void> {
  assertKey(key)
  if (BUCKET) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
    await (await client()).send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
    return
  }
  await fs.rm(path.join(DISK_DIR, key), { force: true })
}

export async function getObject(key: string): Promise<Buffer | null> {
  assertKey(key)
  if (BUCKET) {
    try {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3')
      const out = await (await client()).send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
      return Buffer.from(await out.Body!.transformToByteArray())
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null
      throw e
    }
  }
  try {
    return await fs.readFile(path.join(DISK_DIR, key))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** Every key in the store, with its last-modified time. Keys are the same
 *  shape putObject takes — `thumb/` and `bg/` prefixed ones included — because
 *  the caller is what decides which of them it may touch. */
export async function listObjects(): Promise<{ key: string; lastModified: number }[]> {
  const objects: { key: string; lastModified: number }[] = []
  if (BUCKET) {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3')
    /* a bucket can hold millions of keys, so the walk is a page loop: the page
       is spent and dropped before the next is fetched, and only the mapping
       survives. `IsTruncated` with no token is the last page S3 will answer
       (an empty NextContinuationToken means the same), so the loop ends there
       rather than asking a question with no answer. */
    let token: string | undefined
    do {
      const page = await (await client()).send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token }))
      for (const object of page.Contents ?? []) {
        /* a versioned bucket's delete markers arrive without a Key; skipping
           one is right, there is no object behind it. LastModified is absent
           on nothing else a list returns, and 0 reads as "older than any
           cutoff" downstream, which is the safe direction for a GC. */
        if (object.Key) objects.push({ key: object.Key, lastModified: object.LastModified?.getTime() ?? 0 })
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    return objects
  }
  /* putObject creates the directory, so a fresh install has none and there is
     nothing to walk: absent is an empty store, not a failure. Any other error
     is thrown — the same rule getObject follows, where a read that fails is
     not a read that found nothing. */
  const top = await fs.readdir(DISK_DIR, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return undefined
    throw e
  })
  if (!top) return []
  /* A plain recursion rather than readdir's own `recursive`, for two reasons:
     the key has to come back POSIX-joined (`thumb/<id>.png`, the shape
     putObject and getObject are handed) however the platform spells its
     separator, and the filter is assertKey — the module's one statement of
     what a key may be — so nothing here restates the pattern. */
  const walk = async (dir: string, prefix: string, entries: Dirent[]): Promise<void> => {
    for (const entry of entries) {
      const key = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        const at = path.join(dir, entry.name)
        await walk(at, key, await fs.readdir(at, { withFileTypes: true }))
        continue
      }
      try {
        assertKey(key)
      } catch {
        continue /* not a key putObject could have written */
      }
      objects.push({ key, lastModified: (await fs.stat(path.join(dir, entry.name))).mtimeMs })
    }
  }
  await walk(DISK_DIR, '', top)
  return objects
}
