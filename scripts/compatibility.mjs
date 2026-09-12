import fs from 'node:fs'
const manifest = JSON.parse(fs.readFileSync(new URL('../compatibility.json', import.meta.url), 'utf8'))
if (!Array.isArray(manifest.supported) || !manifest.supported.includes('0.1.5-rc.1')) throw new Error('rc.1 must remain supported')
if (!Array.isArray(manifest.preview) || !manifest.preview.includes('0.1.5-rc.2')) throw new Error('rc.2 must remain preview until its full lane passes')
const tested = process.env.DSH_VERSION_UNDER_TEST
if (tested) {
  const expected = process.env.DSH_COMPAT_MODE === 'preview' ? manifest.preview : manifest.supported
  if (!expected.includes(tested)) throw new Error(`${tested} is not declared in ${process.env.DSH_COMPAT_MODE === 'preview' ? 'preview' : 'supported'} compatibility`)
}
console.log(`compatibility manifest OK${tested ? ` (${tested})` : ''}`)
