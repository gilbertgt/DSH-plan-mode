import { createHash } from 'node:crypto'

export type ValidationStatus = 'PASS'|'FAIL'|'INCONCLUSIVE'|'UNSAFE_MUTATION'
export interface ValidationReceipt {
  schemaVersion: 1
  runId: string
  phase: string
  commandId: string
  command: string
  start: string
  end: string
  timeoutMs: number
  exitCode: number | null
  status: ValidationStatus
  stdout: { path: string; sha256: string; bytes: number; truncated: boolean }
  stderr: { path: string; sha256: string; bytes: number; truncated: boolean }
  boundHead: string
  ownershipFingerprint: string
  complete: boolean
}

export const hashBytes = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

export function verifyReceiptHash(receipt: ValidationReceipt, stdout: Buffer, stderr: Buffer): boolean {
  return hashBytes(stdout) === receipt.stdout.sha256 && hashBytes(stderr) === receipt.stderr.sha256
}
