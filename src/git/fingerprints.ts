import { createHash } from 'node:crypto'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { changedPaths, fullHead } from './repository.ts'

export type PathFingerprint = { kind: 'missing'|'file'|'symlink'; sha256?: string; bytes?: number; target?: string }

export async function fingerprintPath(root: string, path: string): Promise<PathFingerprint> {
  const abs = join(root, path)
  try {
    const st = await lstat(abs)
    if (st.isSymbolicLink()) return { kind: 'symlink', target: await readlink(abs) }
    if (!st.isFile()) throw new Error(`owned path is not a regular file: ${path}`)
    const bytes = await readFile(abs)
    return { kind: 'file', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
}

export interface TreeSnapshot { head: string; paths: Record<string, PathFingerprint> }

export async function snapshotDirty(root: string): Promise<TreeSnapshot> {
  const head = await fullHead(root)
  const paths: Record<string, PathFingerprint> = {}
  for (const path of (await changedPaths(root)).sort()) paths[path] = await fingerprintPath(root, path)
  return { head, paths }
}

export async function ownedFingerprint(root: string, paths: readonly string[]): Promise<string> {
  const values: Array<[string, PathFingerprint]> = []
  for (const path of [...new Set(paths)].sort()) values.push([path, await fingerprintPath(root, path)])
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}

export function deltaPaths(before: TreeSnapshot, after: TreeSnapshot): string[] {
  if (before.head !== after.head) throw new Error(`HEAD drift: ${before.head} -> ${after.head}`)
  const keys = new Set([...Object.keys(before.paths), ...Object.keys(after.paths)])
  return [...keys]
    .filter(key => JSON.stringify(before.paths[key] ?? { kind: 'clean' }) !== JSON.stringify(after.paths[key] ?? { kind: 'clean' }))
    .sort()
}

export function snapshotHash(snapshot: TreeSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

/**
 * Fingerprint an explicit path list, including paths that are currently clean.
 *
 * `snapshotDirty` only records dirty paths, so a compare-and-swap over the files
 * a captured patch is about to overwrite needs its own read of exactly those
 * paths — clean ones included, because "clean" is itself the expected value.
 */
export async function pathFingerprints(root: string, paths: readonly string[]): Promise<Record<string, PathFingerprint>> {
  const out: Record<string, PathFingerprint> = {}
  for (const path of [...new Set(paths)].sort()) out[path] = await fingerprintPath(root, path)
  return out
}
