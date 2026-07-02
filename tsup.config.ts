import { defineConfig } from "tsup"

export default defineConfig([
    {
        entry: { index: "index.ts" },
        format: ["esm"],
        dts: false,
        clean: true,
        sourcemap: true,
        noExternal: ["@opencode-ai/sdk", "jsonc-parser"],
    },
    {
        entry: { tui: "tui.tsx" },
        format: ["esm"],
        dts: false,
        clean: false,
        sourcemap: true,
        external: ["@opencode-ai/plugin", "@opencode-ai/plugin/tui", "@opentui/core", "@opentui/solid", "solid-js"],
        noExternal: ["@opencode-ai/sdk", "jsonc-parser"],
    },
])
