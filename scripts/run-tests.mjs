import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const mode = process.argv[2]
const roots = mode === 'unit'
  ? ['test/unit']
  : mode === 'integration'
    ? ['test/integration']
    : mode === 'platform'
      ? ['test/platform', 'test/integration']
      : mode === 'all'
        ? ['test/unit', 'test/integration']
        : undefined

if (!roots) {
  process.stderr.write('usage: node scripts/run-tests.mjs <unit|integration|platform|all>\n')
  process.exitCode = 2
} else {
  const files = []
  for (const root of roots) {
    const names = await readdir(root)
    for (const name of names) {
      if (name.endsWith('.test.mjs')) files.push(resolve(root, name))
    }
  }
  files.sort((a, b) => a.localeCompare(b))
  if (files.length === 0) throw new Error(`no test files found for ${mode}`)
  // Import test files directly instead of asking Node's CLI test runner to
  // isolate each file in a piped child process. node:test still owns TAP,
  // failure accounting, and the process exit code; only file isolation is
  // removed. This works on Node 22 and avoids the documented DSH Windows ACL
  // restriction on piped confined grandchildren.
  for (const file of files) await import(pathToFileURL(file).href)
}
