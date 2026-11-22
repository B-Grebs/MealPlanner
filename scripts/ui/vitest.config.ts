import { defineConfig } from "vitest/config";

// Renders the real app in jsdom against a running `wrangler dev` (see scripts/ui/render.test.tsx).
export default defineConfig({
  test: { include: ["scripts/ui/*.test.tsx"], environment: "jsdom", testTimeout: 30_000, root: "." },
});
