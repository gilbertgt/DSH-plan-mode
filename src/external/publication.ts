import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { assertOwnedPaths } from '../git/ownership.ts'
import { fullHead, git, splitNul } from '../git/repository.ts'
import { atomicJson } from '../recovery/store.ts'
import type { ValidationReceipt } from '../validation/receipts.ts'
import { assertTrustedReceipts, receiptIndex } from '../validation/review-handoff.ts'
import { ghRaw, ghRepository, openPrForBranch, remotePr } from './github.ts'

export interface PublishGate {
  reviewPass: boolean
  validationCurrent: boolean
  ownershipPass: boolean
}

export interface ExternalPublicationMeta {
  issueNumber: number
  repository: string
  revision: number
  branch: string
}

export interface PublishExternalRunOptions {
  cwd: string
  runDir: string
  meta: ExternalPublicationMeta
  ownedPaths: string[]
  expectedHead: string
  expectedOwnershipFingerprint: string
  receipts: ValidationReceipt[]
}

export function assertPublishGate(gate: PublishGate): void {
  if (!gate.reviewPass || !gate.validationCurrent || !gate.ownershipPass) {
    throw new Error('publication gate requires Reviewer PASS + current validation + ownership PASS')
  }
}

export function assertNoForce(args: string[]): void {
  if (args.some(arg => arg === '--force' || arg === '-f' || arg.startsWith('--force-with-lease'))) {
    throw new Error('force push forbidden')
  }
}

function completionComment(meta: ExternalPublicationMeta, pr: number, head: string): string {
  const payload = {
    externalCompletion: {
      version: 1,
      revision: meta.revision,
      repository: meta.repository,
      issue: meta.issueNumber,
      pr,
      head,
    },
  }
  return [
    'IMPLEMENTATION COMPLETE',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n')
}

export async function publishExternalRun(opts: PublishExternalRunOptions): Promise<{ pr: number; head: string; url?: string }> {
  await assertTrustedReceipts(opts.receipts, opts.expectedHead, opts.expectedOwnershipFingerprint)
  if (await fullHead(opts.cwd) !== opts.expectedHead) {
    throw new Error('stale HEAD before publication')
  }
  assertPublishGate({ reviewPass: true, validationCurrent: true, ownershipPass: true })
  if (opts.ownedPaths.length === 0) {
    throw new Error('publication blocked: no run-owned changes')
  }

  await git(opts.cwd, ['add', '--', ...opts.ownedPaths])
  const staged = splitNul((await git(opts.cwd, ['diff', '--cached', '--name-only', '-z', '--'])).stdout)
  if (staged.length === 0) {
    throw new Error('publication blocked: no staged run-owned changes')
  }
  assertOwnedPaths(staged, opts.ownedPaths)

  const diff = (await git(opts.cwd, ['diff', '--cached', '--binary', '--no-ext-diff', '--'])).stdout
  const candidate = {
    version: 1,
    repository: opts.meta.repository,
    issue: opts.meta.issueNumber,
    revision: opts.meta.revision,
    branch: opts.meta.branch,
    expectedHead: opts.expectedHead,
    staged,
    stagedDiffSha256: createHash('sha256').update(diff).digest('hex'),
    receipts: receiptIndex(opts.receipts),
    at: new Date().toISOString(),
  }
  await atomicJson(join(opts.runDir, 'external-issue.json'), { candidate })

  await git(opts.cwd, [
    'commit',
    '-m',
    `Implement Issue #${opts.meta.issueNumber} external plan r${opts.meta.revision}`,
  ])
  const commit = await fullHead(opts.cwd)
  const pushArgs = ['push', 'origin', opts.meta.branch]
  assertNoForce(pushArgs)
  await git(opts.cwd, pushArgs)

  let pr = await openPrForBranch(opts.cwd, opts.meta.branch)
  if (!pr) {
    const repo = await ghRepository(opts.cwd)
    const base = repo?.defaultBranchRef?.name
    if (!base) throw new Error('default branch unavailable')
    await ghRaw(opts.cwd, [
      'pr',
      'create',
      '--base',
      base,
      '--head',
      opts.meta.branch,
      '--title',
      `Issue #${opts.meta.issueNumber}: external plan r${opts.meta.revision}`,
      '--body',
      `Implements the trusted external PlanArtifact revision ${opts.meta.revision} for Issue #${opts.meta.issueNumber}.\n\nReviewer: PASS. Host validation receipts are recorded by dsh-plan-orchestrator.`,
    ])
    pr = await openPrForBranch(opts.cwd, opts.meta.branch)
  }
  if (!pr?.number) throw new Error('PR create/reuse failed')

  const prNumber = Number(pr.number)
  const remote = await remotePr(opts.cwd, prNumber)
  if (remote?.headRefOid !== commit) {
    throw new Error(`remote PR head mismatch: ${remote?.headRefOid} != ${commit}`)
  }

  const externalCompletion = {
    version: 1,
    revision: opts.meta.revision,
    repository: opts.meta.repository,
    issue: opts.meta.issueNumber,
    pr: prNumber,
    head: commit,
  }
  await ghRaw(opts.cwd, [
    'issue',
    'comment',
    String(opts.meta.issueNumber),
    '--body',
    completionComment(opts.meta, prNumber, commit),
  ])
  await atomicJson(join(opts.runDir, 'external-issue.json'), {
    candidate,
    completion: externalCompletion,
    pr: { number: prNumber, url: remote?.url, head: commit },
  })
  return { pr: prNumber, head: commit, url: remote?.url }
}
