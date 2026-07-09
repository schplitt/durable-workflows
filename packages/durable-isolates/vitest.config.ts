import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Kernel tests spin up the real iso4 sandbox subprocess; keep them serial
    // and give the pool room to breathe.
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
})
