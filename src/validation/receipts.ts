import { createHash } from 'node:crypto'

export type ValidationStatus = 'PASS'|'FAIL'|'INCONCLUSIVE'|'UNSAFE_MUTATION'
export type ValidationDiagnostic = 'WINDOWS_SANDBOX_NESTED_PIPE_EPERM'
export interface ValidationSandboxFacts {
  mode?: string
  denied: boolean
  enforcement?: string
  runnerFailed?: boolean
}
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
  diagnostic?: ValidationDiagnostic
  stdout: { path: string; sha256: string; bytes: number; truncated: boolean }
  stderr: { path: string; sha256: string; bytes: number; truncated: boolean }
  sandbox?: ValidationSandboxFacts
  boundHead: string
  ownershipFingerprint: string
  complete: boolean
}

export const hashBytes = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

export function verifyReceiptHash(receipt: ValidationReceipt, stdout: Buffer, stderr: Buffer): boolean {
  return hashBytes(stdout) === receipt.stdout.sha256 && hashBytes(stderr) === receipt.stderr.sha256
}
