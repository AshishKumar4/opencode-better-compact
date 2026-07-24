// Injected at build time by tsup from package.json. Source and test runs have
// no define, so they fall back to "dev".
declare const __BC_VERSION__: string | undefined

export const PLUGIN_VERSION: string =
    typeof __BC_VERSION__ === "string" ? __BC_VERSION__ : "dev"
