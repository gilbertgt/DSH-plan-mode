import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ParsedValidationCommand } from '../contract/plan-artifact.ts'

const MARKER = '.planx-validation-dependencies.json'
const LOCKFILES: Record<ParsedValidationCommand['manager'], readonly string[]> = {
  npm: ['npm-shrinkwrap.json', 'package-lock.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'],
}

interface DependencyMarker {
  schemaVersion: 1
  manager: ParsedValidationCommand['manager']
  lockfile: string
  inputsSha256: string
}

interface LinkRecord {
  sourcePath: string
  destinationPath: string
  targetRelativeToSourceRoot: string
  directory: boolean
}

export interface MaterializeValidationDependenciesOptions {
  cwd: string
  runDir: string
  manager: ParsedValidationCommand['manager']
}

const sha256 = (...parts: Buffer[]): string => {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest('hex')
}

function confinedRelative(root: string, target: string): string {
  const rel = relative(root, target)
  if (!rel || rel === '.') return ''
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`validation dependency link escapes originating repository: ${target}`)
  }
  return rel
}

async function existingLockfile(root: string, manager: ParsedValidationCommand['manager']): Promise<string> {
  for (const name of LOCKFILES[manager]) {
    try {
      if ((await lstat(join(root, name))).isFile()) return name
    } catch {}
  }
  throw new Error(`validation dependency provisioning requires ${LOCKFILES[manager].join(' or ')} for ${manager}`)
}

async function dependencyInputs(root: string, manager: ParsedValidationCommand['manager'], lockfile?: string): Promise<{ lockfile: string; inputsSha256: string }> {
  const selected = lockfile ?? await existingLockfile(root, manager)
  let pkg: Buffer
  let lock: Buffer
  try { pkg = await readFile(join(root, 'package.json')) }
  catch (error) { throw new Error(`validation dependency provisioning requires readable package.json: ${(error as Error).message}`) }
  try { lock = await readFile(join(root, selected)) }
  catch (error) { throw new Error(`validation dependency provisioning requires readable ${selected}: ${(error as Error).message}`) }
  return { lockfile: selected, inputsSha256: sha256(pkg, Buffer.from(`\0${selected}\0`), lock) }
}

async function sourceRootFromRun(runDir: string): Promise<string> {
  let manifest: any
  try { manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) }
  catch (error) { throw new Error(`validation dependency provisioning requires run manifest: ${(error as Error).message}`) }
  if (typeof manifest?.repoRoot !== 'string' || !manifest.repoRoot) {
    throw new Error('validation dependency provisioning requires manifest.repoRoot')
  }
  return realpath(manifest.repoRoot)
}

async function copyTreeCollectingLinks(
  source: string,
  destination: string,
  sourceRoot: string,
  destinationRoot: string,
  links: LinkRecord[],
): Promise<void> {
  const sourceStat = await lstat(source)
  if (sourceStat.isSymbolicLink()) {
    const raw = await readlink(source)
    const target = await realpath(resolve(dirname(source), raw))
    const rel = confinedRelative(sourceRoot, target)
    const targetStat = await stat(target)
    if (!targetStat.isFile() && !targetStat.isDirectory()) {
      throw new Error(`validation dependency link target is unsupported: ${source}`)
    }
    links.push({
      sourcePath: source,
      destinationPath: destination,
      targetRelativeToSourceRoot: rel,
      directory: targetStat.isDirectory(),
    })
    return
  }
  if (sourceStat.isDirectory()) {
    await mkdir(destination, { recursive: true })
    for (const entry of await readdir(source, { withFileTypes: true })) {
      await copyTreeCollectingLinks(join(source, entry.name), join(destination, entry.name), sourceRoot, destinationRoot, links)
    }
    return
  }
  if (sourceStat.isFile()) {
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
    return
  }
  throw new Error(`validation dependency tree contains unsupported filesystem entry: ${source}`)
}

async function createMappedLinks(links: LinkRecord[], destinationRoot: string): Promise<void> {
  for (const link of links) {
    const mappedTarget = resolve(destinationRoot, link.targetRelativeToSourceRoot)
    const target = process.platform === 'win32' && link.directory
      ? mappedTarget
      : relative(dirname(link.destinationPath), mappedTarget) || '.'
    await mkdir(dirname(link.destinationPath), { recursive: true })
    try {
      await symlink(target, link.destinationPath, process.platform === 'win32' && link.directory ? 'junction' : link.directory ? 'dir' : 'file')
    } catch (error) {
      throw new Error(`validation dependency link could not be isolated: ${link.sourcePath}: ${(error as Error).message}`)
    }
  }
}

export async function materializeValidationDependencies(opts: MaterializeValidationDependenciesOptions): Promise<void> {
  const cwd = await realpath(opts.cwd)
  const sourceRoot = await sourceRootFromRun(opts.runDir)
  if (sourceRoot === cwd) throw new Error('validation dependency provisioning requires an isolated validation worktree')

  const destinationInputs = await dependencyInputs(cwd, opts.manager)
  const sourceInputs = await dependencyInputs(sourceRoot, opts.manager, destinationInputs.lockfile)
  if (sourceInputs.inputsSha256 !== destinationInputs.inputsSha256) {
    throw new Error(`validation dependency inputs differ from originating workspace (${destinationInputs.lockfile})`)
  }

  const destinationModules = join(cwd, 'node_modules')
  const markerPath = join(destinationModules, MARKER)
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as DependencyMarker
    if (marker.schemaVersion !== 1 || marker.manager !== opts.manager || marker.lockfile !== destinationInputs.lockfile || marker.inputsSha256 !== destinationInputs.inputsSha256) {
      throw new Error('validation dependency snapshot does not match the current package manager or lockfile')
    }
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    if (error instanceof SyntaxError) throw new Error('validation dependency snapshot marker is malformed')
  }

  try {
    await lstat(destinationModules)
    throw new Error('validation worktree already contains unmanaged node_modules')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }

  const sourceModules = join(sourceRoot, 'node_modules')
  let sourceModulesStat
  try { sourceModulesStat = await lstat(sourceModules) }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`validation dependencies unavailable: install ${opts.manager} project dependencies in the originating workspace before running /plan`)
    }
    throw error
  }
  if (!sourceModulesStat.isDirectory() || sourceModulesStat.isSymbolicLink()) {
    throw new Error('validation dependencies unavailable: originating node_modules must be a real directory, not a link')
  }

  const links: LinkRecord[] = []
  try {
    await copyTreeCollectingLinks(sourceModules, destinationModules, sourceRoot, cwd, links)
    await createMappedLinks(links, cwd)
    const marker: DependencyMarker = {
      schemaVersion: 1,
      manager: opts.manager,
      lockfile: destinationInputs.lockfile,
      inputsSha256: destinationInputs.inputsSha256,
    }
    await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    await rm(destinationModules, { recursive: true, force: true }).catch(() => {})
    throw new Error(`validation dependency materialization failed: ${(error as Error).message}`)
  }
}
