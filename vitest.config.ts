import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    server: {
      deps: {
        // node:sqlite is a Node.js 22+ built-in; vite can't bundle it, mark as external
        external: ["node:sqlite"],
      },
    },
    env: {
      // Use an in-memory DB for tests so we don't touch the real data file
      DATABASE_URL: ":memory:",
    },
  },
});
