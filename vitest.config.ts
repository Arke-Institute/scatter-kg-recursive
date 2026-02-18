import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Workflow tests need longer timeouts (KG extraction can take a while)
    testTimeout: 300000,
    hookTimeout: 60000,

    // Run tests sequentially to avoid API rate limits
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
