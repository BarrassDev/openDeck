import { DeckVariable } from "../shared/types"

/**
 * Module-scoped variables. Every variable belongs to exactly one module
 * (its `module` field). Variables without an owner are kept so the user can
 * assign them in Settings, but they are never handed to any module.
 */
class VariableStore {
    private variables: DeckVariable[] = []

    setAll(vars: DeckVariable[]) {
        this.variables = vars
            .filter(v => v && typeof v.key === "string")
            .map(v => ({
                key: v.key,
                value: typeof v.value === "string" ? v.value : String(v.value ?? ""),
                description: v.description,
                module: typeof v.module === "string" ? v.module : "",
            }))
    }

    getAll(): DeckVariable[] {
        return this.variables.slice()
    }

    /** Only the variables owned by `moduleName`, as a plain key/value record */
    forModule(moduleName: string): Record<string, string> {
        const record: Record<string, string> = {}
        for (const v of this.variables) {
            if (v.module === moduleName && v.key) record[v.key] = v.value
        }
        return record
    }

    get(moduleName: string, key: string): string | undefined {
        return this.variables.find(v => v.module === moduleName && v.key === key)?.value
    }
}

export const variableStore = new VariableStore()
