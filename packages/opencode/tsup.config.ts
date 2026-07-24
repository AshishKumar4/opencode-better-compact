import { defineConfig } from "tsup"
import { version } from "./package.json"

// Surfaced in the TUI so a stale cached bundle is visible at a glance.
const define = { __BC_VERSION__: JSON.stringify(version) }

export default defineConfig([
    {
        entry: { index: "index.ts" },
        format: ["esm"],
        dts: false,
        clean: true,
        sourcemap: false,
        define,
        noExternal: ["@better-compact/core", "@opencode-ai/sdk", "jsonc-parser"],
    },
    {
        entry: { tui: "tui.tsx" },
        format: ["esm"],
        dts: false,
        clean: false,
        sourcemap: false,
        external: ["@opencode-ai/plugin", "@opencode-ai/plugin/tui", "@opentui/core", "@opentui/solid", "solid-js"],
        define,
        noExternal: ["@better-compact/core", "@opencode-ai/sdk", "jsonc-parser"],
    },
])
