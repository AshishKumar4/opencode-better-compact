import type { BetterCompactCommand, TuiApi } from "./types"

export function registerCommands(api: TuiApi, commands: BetterCompactCommand[]) {
    const keymap = (api as any).keymap
    if (keymap?.registerLayer) {
        keymap.registerLayer({
            commands: commands.map((command) => ({
                namespace: "palette",
                name: command.name,
                title: command.title,
                desc: command.description,
                category: "Better Compact",
                slashName: command.slashName,
                slashAliases: command.slashAliases,
                run: command.run,
            })),
        })
        return
    }

    api.command?.register(() =>
        commands.map((command) => ({
            title: command.title,
            value: command.name,
            description: command.description,
            category: "Better Compact",
            slash: { name: command.slashName, aliases: command.slashAliases },
            onSelect: command.run,
        })),
    )
}
