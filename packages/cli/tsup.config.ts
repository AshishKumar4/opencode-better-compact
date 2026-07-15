import { defineConfig } from "tsup"

// One self-contained CLI artifact: core is bundled, node builtins stay
// external by nature. dist/cli.js is the `better-compact` bin.
export default defineConfig({
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: false,
    banner: { js: "#!/usr/bin/env node" },
    noExternal: ["@better-compact/core"],
})
