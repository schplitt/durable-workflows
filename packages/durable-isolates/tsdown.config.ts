import { defineConfig } from 'tsdown'
import ApiSnapshot from 'tsnapi/rolldown'

export default defineConfig({
  entry: {
    'index': './src/index.ts',
    'internal': './src/internal.ts',
    'types/iso4': './src/types/iso4.ts',
  },
  target: ['es2024'],
  format: 'esm',
  clean: true,
  dts: true,
  outDir: './dist',
  plugins: [
    ApiSnapshot(),
  ],
})
