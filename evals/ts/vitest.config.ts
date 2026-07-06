import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["**/*.test.ts"],
    // Engine tests share on-disk temp DBs; keep runs sequential for clean teardown.
    fileParallelism: false,
  },
});
