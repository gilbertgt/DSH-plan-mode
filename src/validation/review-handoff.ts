import { readFile } from 'node:fs/promises'
import type { ValidationReceipt } from './receipts.ts'
import { verifyReceiptHash } from './receipts.ts'

export function receiptIndex(receipts: ValidationReceipt[]) {
  return receipts.map(receipt => ({
    commandId: receipt.commandId,
    command: receipt.command,
    status: receipt.status,
    exitCode: receipt.exitCode,
    start: receipt.start,
    end: receipt.end,
    timeoutMs: receipt.timeoutMs,
    boundHead: receipt.boundHead,
    ownershipFingerprint: receipt.ownershipFingerprint,
    stdout: { sha256: receipt.stdout.sha256, bytes: receipt.stdout.bytes, truncated: receipt.stdout.truncated },
    stderr: { sha256: receipt.stderr.sha256, bytes: receipt.stderr.bytes, truncated: receipt.stderr.truncated },
    complete: receipt.complete,
  }))
}

export async function assertTrustedReceipts(
  receipts: ValidationReceipt[],
  expectedHead: string,
  expectedOwnershipFingerprint?: string,
): Promise<true> {
  for (const receipt of receipts) {
    if (receipt.boundHead !== expectedHead) throw new Error(`stale validation receipt ${receipt.commandId}: HEAD ${receipt.boundHead}`)
    if (expectedOwnershipFingerprint !== undefined && receipt.ownershipFingerprint !== expectedOwnershipFingerprint) {
      throw new Error(`stale validation receipt ${receipt.commandId}: ownership fingerprint changed`)
    }
    if (receipt.status !== 'PASS' || !receipt.complete || receipt.stdout.truncated || receipt.stderr.truncated) {
      throw new Error(`validation receipt ${receipt.commandId} is not a complete PASS`)
    }
    if (receipt.stdout.bytes > 16 * 1024 * 1024 || receipt.stderr.bytes > 16 * 1024 * 1024) {
      throw new Error(`validation receipt ${receipt.commandId} exceeds hard stream cap`)
    }
    const [stdout, stderr] = await Promise.all([readFile(receipt.stdout.path), readFile(receipt.stderr.path)])
    if (stdout.length !== receipt.stdout.bytes || stderr.length !== receipt.stderr.bytes || !verifyReceiptHash(receipt, stdout, stderr)) {
      throw new Error(`tampered validation receipt ${receipt.commandId}`)
    }
  }
  return true
}
