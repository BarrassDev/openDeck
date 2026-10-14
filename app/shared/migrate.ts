import type { DeckVariable } from "./types"

/**
 * V1 variables were global. Known keys are moved to the module that used them;
 * everything else is left unassigned (module: "") for the user to sort out in
 * Settings > Modules.
 */
const LEGACY_VARIABLE_OWNERS: Record<string, { module: string; key: string }> = {
    obs_host: { module: "obs-control", key: "host" },
    obs_password: { module: "obs-control", key: "password" },
}

export function migrateVariables(vars: DeckVariable[]): DeckVariable[] {
    return vars
        .filter(v => v && typeof v.key === "string")
        .map(v => {
            if (typeof v.module === "string" && v.module) return v
            const legacy = LEGACY_VARIABLE_OWNERS[v.key]
            if (legacy) {
                return { ...v, key: legacy.key, module: legacy.module }
            }
            return { ...v, module: "" }
        })
}
