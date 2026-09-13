import { readFileSync, writeFileSync } from 'node:fs'

const version = '1.0.1'
const pkgPath = new URL('../package.json', import.meta.url)
const lockPath = new URL('../package-lock.json', import.meta.url)

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))

if (!lock.packages?.['']) {
  throw new Error('package-lock.json is missing the root package metadata')
}

pkg.version = version
lock.version = version
lock.packages[''].version = version

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)

console.log(`prepared ${pkg.name}@${version}`)
