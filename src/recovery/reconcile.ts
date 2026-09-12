import type { RunManifest } from './store.ts'
import { fullHead } from '../git/repository.ts'
import { snapshotDirty, snapshotHash } from '../git/fingerprints.ts'

export interface RecoveryCheckpoint {
  schemaVersion: 1
  head: string
  ownership: string[]
  changedPaths: string[]
  fingerprint: string
  phase: string
  role?: string
  completedTaskIds?: string[]
  safeBoundary?: boolean
  at: string
}

export async function diagnoseResume(repo: string, manifest: RunManifest, checkpoint: RecoveryCheckpoint) {
  if (manifest.terminal) return { resumable: false as const, reason: 'run is terminal' }
  const head = await fullHead(repo)
  if (head !== checkpoint.head) return { resumable: false as const, reason: 'HEAD drift' }
  const snapshot = await snapshotDirty(repo)
  if (snapshotHash(snapshot) !== checkpoint.fingerprint) return { resumable: false as const, reason: 'working tree fingerprint drift' }
  if (JSON.stringify([...(manifest.ownership ?? [])].sort()) !== JSON.stringify([...checkpoint.ownership].sort())) {
    return { resumable: false as const, reason: 'ownership checkpoint drift' }
  }
  if (checkpoint.phase === 'PREFLIGHT') return { resumable: true as const, reason: 'checkpoint matches', resumeFrom: 'PREFLIGHT' as const, completedTaskIds: [] }
  if (checkpoint.phase === 'WORKERS' && checkpoint.safeBoundary) {
    return { resumable: true as const, reason: 'safe worker boundary matches', resumeFrom: 'WORKERS' as const, completedTaskIds: checkpoint.completedTaskIds ?? [] }
  }
  if (checkpoint.phase === 'VALIDATING' || checkpoint.phase === 'REVIEWING') {
    return { resumable: true as const, reason: 'final tree checkpoint matches', resumeFrom: 'VALIDATING' as const, completedTaskIds: checkpoint.completedTaskIds ?? [] }
  }
  return { resumable: false as const, reason: `phase ${checkpoint.phase} cannot be resumed without guessing mutation state` }
}

export function interruptManifest(manifest: RunManifest): RunManifest {
  if (!manifest.terminal) {
    manifest.phase = 'INTERRUPTED'
    manifest.terminal = false
    manifest.updatedAt = new Date().toISOString()
  }
  return manifest
}
