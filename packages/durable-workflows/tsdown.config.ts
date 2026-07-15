import { defineConfig } from 'tsdown'
import ApiSnapshot from 'tsnapi/rolldown'

export default defineConfig({
  entry: {
    index: './src/index.ts',
    internal: './src/internal.ts',
  },
  target: ['es2024'],
  format: 'esm',
  clean: true,
  dts: true,
  outDir: './dist',
  // The author-facing surface is a hand-authored ambient `.d.ts` (not a
  // compiled module — it declares the virtual `durable-workflows:workflow`
  // specifier), copied verbatim into dist.
  copy: ['src/workflow.d.ts'],
  plugins: [
    ApiSnapshot(),
  ],
})
