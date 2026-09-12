import { defineConfig } from 'tsdown'
const id = '@gilbertgt/dsh-plan-orchestrator'
const hostExternal = [
  '@deepseek-ai/cordis','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-plan-mode',
  '@deepseek-ai/dsh-settings','@deepseek-ai/dsh-subagent','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-sdk-client',
  '@deepseek-ai/dsh-session','@deepseek-ai/dsh-session-projection','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-commands','zod'
]
const clientExternal = ['react','react/jsx-runtime','react-dom','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-slots']
export default defineConfig([
  {
    name: id, entry: { index: 'src/index.ts' }, outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
    fixedExtension: false, dts: false, clean: true, deps: { neverBundle: hostExternal },
  },
  {
    name: `${id}/client`, entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', target: 'es2022',
    dts: false, sourcemap: true, clean: false, deps: { neverBundle: clientExternal },
    define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
