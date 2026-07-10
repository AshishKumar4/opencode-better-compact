import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import { compressDisabledByOpencode, type HostPermissionSnapshot } from "./lib/host-permissions"
import { Logger } from "./lib/logger"
import { createRuntimeState, secureSessionStorage } from "./lib/state"
import { securePrivateTree } from "./lib/private-storage"
import {
    createChatMessageTransformHandler,
    createChatMessageHandler,
    createCommandExecuteHandler,
    createEventHandler,
    createSystemPromptHandler,
    createTextCompleteHandler,
} from "./lib/hooks"
import { configureClientAuth, isSecureMode } from "./lib/auth"
import { startAutoUpdate } from "./lib/update"

const RUNTIME_REGISTRY = Symbol.for("better-compact.server.instances")

// A local file:// entry plus the npm plugin entry would run two competing
// engines against the same sessions; only the first instance per
// client+directory wins.
function registerServerInstance(client: object, directory: string): boolean {
    const root = globalThis as typeof globalThis & {
        [RUNTIME_REGISTRY]?: WeakMap<object, Set<string>>
    }
    root[RUNTIME_REGISTRY] ??= new WeakMap<object, Set<string>>()
    const directories = root[RUNTIME_REGISTRY].get(client) ?? new Set<string>()
    if (directories.has(directory)) return false
    directories.add(directory)
    root[RUNTIME_REGISTRY].set(client, directories)
    return true
}

const server: Plugin = (async (ctx) => {
    const loadConfig = () => getConfig(ctx, { warnings: false })
    const config = getConfig(ctx)

    if (!config.enabled) {
        return {}
    }

    if (!registerServerInstance(ctx.client, ctx.directory)) {
        try {
            await ctx.client.tui.showToast({
                body: {
                    title: "Duplicate Better Compact plugin",
                    message: "Remove the duplicate local or npm plugin entry and restart OpenCode.",
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
        return {}
    }

    const logger = new Logger(config.debug)
    await Promise.all([
        secureSessionStorage(),
        securePrivateTree(join(ctx.directory, ".opencode", "better-compact")),
    ])
    const runtime = createRuntimeState(ctx.client, logger)
    const hostPermissions: HostPermissionSnapshot = {
        global: undefined,
        agents: {},
    }

    if (isSecureMode()) {
        configureClientAuth(ctx.client)
    }

    logger.info("Better Compact initialized")

    startAutoUpdate(ctx, config.autoUpdate)

    return {
        "experimental.chat.system.transform": createSystemPromptHandler(runtime, logger, config),
        "experimental.chat.messages.transform": createChatMessageTransformHandler(
            ctx.client,
            runtime,
            logger,
            config,
            hostPermissions,
            ctx.directory,
            loadConfig,
        ),
        "experimental.text.complete": createTextCompleteHandler(),
        "chat.message": createChatMessageHandler(
            ctx.client,
            runtime,
            logger,
            config,
            ctx.directory,
            hostPermissions,
            loadConfig,
        ),
        "command.execute.before": createCommandExecuteHandler(
            ctx.client,
            runtime,
            logger,
            config,
            ctx.directory,
            hostPermissions,
            loadConfig,
        ),
        event: createEventHandler(runtime, logger),
        tool: {},
        config: async (opencodeConfig) => {
            if (
                config.compress.permission !== "deny" &&
                compressDisabledByOpencode(opencodeConfig.permission)
            ) {
                config.compress.permission = "deny"
            }

            const mutableConfig = opencodeConfig as typeof opencodeConfig & {
                compaction?: { auto?: boolean }
            }
            mutableConfig.compaction = {
                ...mutableConfig.compaction,
                auto: false,
            }

            hostPermissions.global = opencodeConfig.permission
            hostPermissions.agents = Object.fromEntries(
                Object.entries(opencodeConfig.agent ?? {}).map(([name, agent]) => [
                    name,
                    agent?.permission,
                ]),
            )
        },
    }
}) satisfies Plugin

export default server
