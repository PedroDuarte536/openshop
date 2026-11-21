import { defineConfig } from 'vitest/config';

// The builder and page tests render whole documents in jsdom; on a busy machine (CI, coverage) they can exceed
// Vitest's 5 s default even though they pass, so allow more time per test.
export default defineConfig({ test: { testTimeout: 20_000 } });
