/**
 * JSON file-backed checkpoint cache store with gzip-compressed sidecar files
 * for large (> 64 KB) string payloads and batched/explicit index flushing.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

const LARGE_CACHE_BODY_THRESHOLD = 65536;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

function hashCacheKey(key) {
  return `${createHash('sha256').update(String(key)).digest('hex')}.body.gz`;
}

function isLargeBodyEntry(val) {
  return Boolean(
    val &&
    typeof val === 'object' &&
    typeof val.body === 'string' &&
    Buffer.byteLength(val.body, 'utf8') > LARGE_CACHE_BODY_THRESHOLD
  );
}

async function writeSidecarBody(sidecarDir, bodyFile, body) {
  await fs.mkdir(sidecarDir, { recursive: true });
  const payload = bodyFile.endsWith('.gz')
    ? await gzipAsync(Buffer.from(body, 'utf8'))
    : body;
  await fs.writeFile(path.join(sidecarDir, bodyFile), payload);
}

async function readSidecarBody(sidecarDir, bodyFile) {
  const filePath = path.join(sidecarDir, bodyFile);
  if (bodyFile.endsWith('.gz')) {
    const compressed = await fs.readFile(filePath);
    const decompressed = await gunzipAsync(compressed);
    return decompressed.toString('utf8');
  }
  return fs.readFile(filePath, 'utf8');
}

async function removeSidecarFile(sidecarDir, bodyFile) {
  if (!bodyFile) return;
  await fs.rm(path.join(sidecarDir, bodyFile), { force: true });
}

/**
 * Compacts a JSON file-backed cache store by removing entries matching `shouldRemove`
 * (plus orphaned sidecar files) and compressing any remaining uncompressed `.body`
 * sidecar files to `.body.gz`.
 *
 * @param {string} cachePath
 * @param {(ctx: { key: string, entry: object, body: string|null }) => boolean | Promise<boolean>} [shouldRemove]
 * @returns {Promise<{ total: number, removed: number, compressedSidecars: number, removedOrphanedSidecars: number, remaining: number }>}
 */
export async function compactFileCache(cachePath, shouldRemove) {
  let index;
  try {
    index = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { total: 0, removed: 0, compressedSidecars: 0, removedOrphanedSidecars: 0, remaining: 0 };
    }
    throw err;
  }

  const sidecarDir = `${cachePath}.d`;
  const total = Object.keys(index).length;
  let removed = 0;
  let compressedSidecars = 0;
  let removedOrphanedSidecars = 0;
  const referencedSidecars = new Set();

  for (const [key, entry] of Object.entries(index)) {
    let body = typeof entry?.body === 'string' ? entry.body : null;
    if (body === null && entry?.bodyFile) {
      try {
        body = await readSidecarBody(sidecarDir, entry.bodyFile);
      } catch {
        delete index[key];
        removed += 1;
        continue;
      }
    }

    if (shouldRemove && await shouldRemove({ key, entry, body })) {
      delete index[key];
      await removeSidecarFile(sidecarDir, entry?.bodyFile);
      removed += 1;
      continue;
    }

    if (entry?.bodyFile && !entry.bodyFile.endsWith('.gz') && typeof body === 'string') {
      const gzFile = `${entry.bodyFile}.gz`;
      await writeSidecarBody(sidecarDir, gzFile, body);
      await removeSidecarFile(sidecarDir, entry.bodyFile);
      entry.bodyFile = gzFile;
      compressedSidecars += 1;
    }

    if (entry?.bodyFile) {
      referencedSidecars.add(entry.bodyFile);
    }
  }

  try {
    const sidecarFiles = await fs.readdir(sidecarDir);
    for (const file of sidecarFiles) {
      if (!referencedSidecars.has(file)) {
        await removeSidecarFile(sidecarDir, file);
        removedOrphanedSidecars += 1;
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await fs.writeFile(cachePath, JSON.stringify(index, null, 2), 'utf8');
  return { total, removed, compressedSidecars, removedOrphanedSidecars, remaining: Object.keys(index).length };
}

/**
 * Creates a JSON file-backed checkpoint cache store keyed by suburb name or URL.
 * Large string `body` payloads (> 64 KB) are stored as gzip-compressed `.body.gz`
 * sidecar files under `${cachePath}.d/` so the main JSON index stays compact.
 *
 * @param {string} [cachePath='.scratch/places-sync-cache.json']
 * @param {{ autoFlush?: boolean, flushEvery?: number }} [options={}]
 * @returns {{ read: (key: string) => Promise<object|null>, write: (key: string, val: object) => Promise<void>, delete: (key: string) => Promise<void>, flush: () => Promise<void> }}
 */
export function createFileCacheStore(
  cachePath = path.resolve(process.cwd(), '.scratch/places-sync-cache.json'),
  { autoFlush = true, flushEvery = 1 } = {}
) {
  let memoryCache = null;
  let dirty = false;
  let pendingWrites = 0;
  const sidecarDir = `${cachePath}.d`;
  const effectiveFlushEvery = Number.isFinite(flushEvery) && flushEvery >= 1 ? Math.floor(flushEvery) : 1;

  async function externalizeLargeBody(key, entry) {
    const bodyFile = hashCacheKey(key);
    await writeSidecarBody(sidecarDir, bodyFile, entry.body);
    const { body: _omitted, ...rest } = entry;
    return { ...rest, bodyFile };
  }

  async function flushIndex() {
    if (!dirty || !memoryCache) return;
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(memoryCache, null, 2), 'utf8');
    dirty = false;
    pendingWrites = 0;
  }

  async function markDirtyAndMaybeFlush() {
    dirty = true;
    pendingWrites += 1;
    if (autoFlush && pendingWrites >= effectiveFlushEvery) {
      await flushIndex();
    }
  }

  async function loadAll() {
    if (memoryCache) return memoryCache;
    try {
      const raw = await fs.readFile(cachePath, 'utf8');
      memoryCache = JSON.parse(raw);
    } catch {
      memoryCache = {};
    }

    let migrated = false;
    for (const [key, entry] of Object.entries(memoryCache)) {
      if (isLargeBodyEntry(entry)) {
        memoryCache[key] = await externalizeLargeBody(key, entry);
        migrated = true;
      }
    }

    if (migrated) {
      dirty = true;
      await flushIndex();
    }

    return memoryCache;
  }

  return {
    async readMeta(key) {
      const data = await loadAll();
      const entry = data[key];
      return entry && typeof entry === 'object' ? { ...entry } : null;
    },
    async read(key) {
      const data = await loadAll();
      const entry = data[key];
      if (!entry) return null;
      if (entry && typeof entry === 'object' && entry.bodyFile && entry.body === undefined) {
        try {
          const body = await readSidecarBody(sidecarDir, entry.bodyFile);
          return { ...entry, body };
        } catch {
          return null;
        }
      }
      return entry;
    },
    async write(key, val) {
      const data = await loadAll();
      const prevBodyFile = data[key]?.bodyFile;
      let nextBodyFile = null;

      if (isLargeBodyEntry(val)) {
        const externalized = await externalizeLargeBody(key, val);
        nextBodyFile = externalized.bodyFile;
        data[key] = externalized;
      } else {
        data[key] = val;
      }

      if (prevBodyFile && prevBodyFile !== nextBodyFile) {
        await removeSidecarFile(sidecarDir, prevBodyFile);
      }

      await markDirtyAndMaybeFlush();
    },
    async delete(key) {
      const data = await loadAll();
      if (!(key in data)) return;
      const prevBodyFile = data[key]?.bodyFile;
      delete data[key];
      if (prevBodyFile) {
        await removeSidecarFile(sidecarDir, prevBodyFile);
      }
      await markDirtyAndMaybeFlush();
    },
    async flush() {
      await flushIndex();
    }
  };
}
