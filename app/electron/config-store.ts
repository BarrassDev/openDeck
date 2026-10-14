import fs from "fs"
import path from "path"
import { app } from "electron"
import type { DeckPage, DeckVariable } from "../shared/types"
import { migrateVariables } from "../shared/migrate"

export { migrateVariables }

export interface StoredConfig {
    version: number
    pages: DeckPage[]
    variables: DeckVariable[]
    displayImage: string
}

const CONFIG_VERSION = 2
const CONFIG_FILE = path.join(app.getPath("userData"), "opendeck-config.json")

class ConfigStore {
    private config: StoredConfig = {
        version: CONFIG_VERSION,
        pages: [],
        variables: [],
        displayImage: "",
    }
    private loaded = false

    load(): StoredConfig {
        if (this.loaded) return this.config
        try {
            if (fs.existsSync(CONFIG_FILE)) {
                const raw = fs.readFileSync(CONFIG_FILE, "utf-8")
                const parsed = JSON.parse(raw)
                if (parsed && typeof parsed === "object") {
                    const version = typeof parsed.version === "number" ? parsed.version : 1
                    const variables = Array.isArray(parsed.variables) ? parsed.variables : []
                    this.config = {
                        version: CONFIG_VERSION,
                        pages: Array.isArray(parsed.pages) ? parsed.pages : [],
                        variables: version < 2 ? migrateVariables(variables) : variables,
                        displayImage: typeof parsed.displayImage === "string" ? parsed.displayImage : "",
                    }
                    if (version < 2) {
                        console.log(`Migrated config from v${version} to v${CONFIG_VERSION}`)
                        this.persist()
                    }
                }
            }
        } catch (err) {
            console.error("Failed to load config, using defaults:", err)
        }
        this.loaded = true
        return this.config
    }

    save(config: Partial<Omit<StoredConfig, "version">>) {
        if (config.pages !== undefined) this.config.pages = config.pages
        if (config.variables !== undefined) this.config.variables = config.variables
        if (config.displayImage !== undefined) this.config.displayImage = config.displayImage
        this.persist()
    }

    get(): StoredConfig {
        return this.config
    }

    private persist() {
        try {
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config), "utf-8")
        } catch (err) {
            console.error("Failed to save config:", err)
        }
    }
}

export const configStore = new ConfigStore()
