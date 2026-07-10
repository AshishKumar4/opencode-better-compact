import { defineConfig } from "tsup"

// One self-contained artifact for ~/.pi/agent/extensions drop-in and for the
// npm pi package: core is bundled, pi's own packages stay external because pi
// provides them at runtime.
export default defineConfig({
    entry: { extension: "src/extension.ts" },
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: false,
    external: [/^@earendil-works\//],
    noExternal: ["@better-compact/core"],
})
