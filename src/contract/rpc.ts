export const RPC_METHODS = [
  'model-catalog', 'model-capability', 'route-validate', 'run-list', 'run-detail', 'run-cancel', 'run-resume',
  'run-cleanup', 'diagnostics', 'external-preflight',
] as const
export type RpcMethod = typeof RPC_METHODS[number]
export interface RpcEnvelope { ok: boolean; data?: unknown; error?: { code: string; message: string } }

export function assertRpcBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request body must be a JSON object')
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 256 * 1024) throw new Error('request body exceeds 256KiB')
  return value as Record<string, unknown>
}

export function boundedId(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 300 || value.includes('\0')) throw new Error(`${name} invalid`)
  return value
}
