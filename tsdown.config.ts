import { defineConfig } from 'tsdown'

/** Host APIs are supplied by the installed DSH profile at runtime. */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'storage-compat': 'src/storage-compat.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  sourcemap: true,
  dts: false,
  clean: true,
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-storage',
    '@deepseek-ai/dsh-storage-domain',
    '@deepseek-ai/dsh-storage-sqlite',
    '@deepseek-ai/dsh-tools',
  ],
})
