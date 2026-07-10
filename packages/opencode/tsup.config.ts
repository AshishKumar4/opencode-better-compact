import { defineConfig } from "tsup"

export default defineConfig([
    {
        entry: { index: "index.ts" },
        format: ["esm"],
        dts: false,
        clean: true,
        sourcemap: false,
        noExternal: ["@better-compact/core", "@opencode-ai/sdk", "jsonc-parser"],
    },
    {
        entry: { tui: "tui.tsx" },
        format: ["esm"],
        dts: false,
        clean: false,
        sourcemap: false,
        external: ["@opencode-ai/plugin", "@opencode-ai/plugin/tui", "@opentui/core", "@opentui/solid", "solid-js"],
        noExternal: ["@better-compact/core", "@opencode-ai/sdk", "jsonc-parser"],
    },
])
