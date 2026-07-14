import { defineConfig } from "tsup"

// Publish build only: the workspace consumes src directly (see exports), so
// this bundles the pure, dependency-free ladder into a single ESM file plus
// bundled declarations for external consumers.
export default defineConfig({
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: false,
    treeshake: true,
})
