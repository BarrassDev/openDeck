import fs from "fs"
import path from "path"
import { app } from "electron"
import type {
    ModuleManifest,
    ModuleContext,
    ModuleActionHandler,
    ModuleProvider,
    ModuleStatus,
    ProviderOption,
} from "../shared/types"
import { variableStore } from "./variable-store"
import { stateStore } from "./state-store"

export interface RegisteredModule {
    manifest: ModuleManifest
    dir: string
    ctx: ModuleContext
    status: ModuleStatus
    actions: Record<string, ModuleActionHandler>
    providers: Record<string, ModuleProvider>
    init?: (ctx: ModuleContext) => void | Promise<void>
    dispose?: () => void | Promise<void>
    onSettingsChanged?: (ctx: ModuleContext) => void | Promise<void>
}

type StatusListener = (moduleName: string, status: ModuleStatus) => void

export function getModulesDir(): string {
    const isDev = !app.isPackaged
    return isDev
        ? path.join(process.cwd(), "modules")
        : path.join(process.resourcesPath, "modules")
}

class ModuleRegistry {
    private modules = new Map<string, RegisteredModule>()
    private statusListeners = new Set<StatusListener>()

    private createContext(name: string): ModuleContext {
        const prefix = `${name}.`
        const ctx: ModuleContext = {
            moduleName: name,
            // Always read live so edits in Settings apply without a restart
            get settings() {
                return variableStore.forModule(name)
            },
            setState: (key, value) => {
                stateStore.set(prefix + key, value)
            },
            getState: (key) => stateStore.get(prefix + key),
            clearState: (sub) => {
                stateStore.clearPrefix(prefix + (sub || ""))
            },
            setStatus: (status) => {
                const mod = this.modules.get(name)
                if (!mod) return
                mod.status = { ...mod.status, ...status, updatedAt: Date.now() }
                for (const l of this.statusListeners) {
                    try { l(name, mod.status) } catch (err) { console.error(err) }
                }
            },
            log: (...args) => console.log(`[${name}]`, ...args),
            warn: (...args) => console.warn(`[${name}]`, ...args),
        }
        return ctx
    }

    has(name: string): boolean {
        return this.modules.has(name)
    }

    get(name: string): RegisteredModule | undefined {
        return this.modules.get(name)
    }

    async register(manifest: ModuleManifest, exported: any, dir: string): Promise<RegisteredModule> {
        const name = manifest.name
        const existing = this.modules.get(name)
        if (existing?.dispose) {
            try { await existing.dispose() } catch (err) { console.error(`[${name}] dispose failed:`, err) }
        }

        const ctx = this.createContext(name)
        const mod: RegisteredModule = {
            manifest,
            dir,
            ctx,
            status: {},
            actions: exported.actions || {},
            providers: exported.providers || {},
            init: typeof exported.init === "function" ? exported.init : undefined,
            dispose: typeof exported.dispose === "function" ? exported.dispose : undefined,
            onSettingsChanged: typeof exported.onSettingsChanged === "function" ? exported.onSettingsChanged : undefined,
        }
        this.modules.set(name, mod)
        console.log(`Module loaded: ${name} v${manifest.version} (${Object.keys(mod.actions).length} actions)`)

        if (mod.init) {
            try {
                await mod.init(ctx)
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                console.error(`[${name}] init failed:`, message)
                ctx.setStatus({ connected: false, message: `Init failed: ${message}` })
            }
        }
        return mod
    }

    resolve(actionId: string): RegisteredModule | undefined {
        for (const mod of this.modules.values()) {
            if (actionId in mod.actions) return mod
        }
        return undefined
    }

    getAll(): RegisteredModule[] {
        return Array.from(this.modules.values())
    }

    getAllActions(): string[] {
        const actions: string[] = []
        for (const mod of this.modules.values()) {
            actions.push(...Object.keys(mod.actions))
        }
        return actions
    }

    async getProviderOptions(moduleName: string, provider: string, arg?: string): Promise<ProviderOption[]> {
        const mod = this.modules.get(moduleName)
        if (!mod) throw new Error(`Module not found: ${moduleName}`)
        const fn = mod.providers[provider]
        if (!fn) throw new Error(`Provider not found: ${moduleName}/${provider}`)
        const result = await fn(mod.ctx, arg)
        if (!Array.isArray(result)) return []
        return result
            .filter(o => o && typeof o.value === "string")
            .map(o => ({ value: o.value, label: typeof o.label === "string" ? o.label : undefined }))
    }

    /** Called after the user edits variables in Settings. `only` limits it to the modules that changed. */
    async notifySettingsChanged(only?: string[]): Promise<void> {
        for (const mod of this.modules.values()) {
            if (!mod.onSettingsChanged) continue
            if (only && !only.includes(mod.manifest.name)) continue
            try {
                await mod.onSettingsChanged(mod.ctx)
            } catch (err) {
                console.error(`[${mod.manifest.name}] onSettingsChanged failed:`, err)
            }
        }
    }

    onStatus(listener: StatusListener): () => void {
        this.statusListeners.add(listener)
        return () => this.statusListeners.delete(listener)
    }

    async disposeAll(): Promise<void> {
        for (const mod of this.modules.values()) {
            if (!mod.dispose) continue
            try { await mod.dispose() } catch (err) { console.error(`[${mod.manifest.name}] dispose failed:`, err) }
        }
    }
}

export const moduleRegistry = new ModuleRegistry()

/**
 * Discover modules in the modules directory. Safe to call again after a plugin
 * install: already-registered modules are skipped.
 */
export async function loadModules(): Promise<void> {
    const modulesDir = getModulesDir()

    if (!fs.existsSync(modulesDir)) {
        console.log("No modules directory found, skipping module loading")
        return
    }

    const entries = fs.readdirSync(modulesDir, { withFileTypes: true })

    for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith("__") || entry.name.startsWith(".")) continue

        const modulePath = path.join(modulesDir, entry.name)
        const manifestPath = path.join(modulePath, "manifest.json")

        if (!fs.existsSync(manifestPath)) {
            console.warn(`Skipping ${entry.name}: no manifest.json found`)
            continue
        }

        try {
            const manifestRaw = fs.readFileSync(manifestPath, "utf-8")
            const manifest: ModuleManifest = JSON.parse(manifestRaw)
            if (!manifest.name) {
                console.warn(`Skipping ${entry.name}: manifest has no name`)
                continue
            }
            if (moduleRegistry.has(manifest.name)) continue

            const indexPath = path.join(modulePath, "index.js")
            if (!fs.existsSync(indexPath)) {
                console.warn(`Skipping ${entry.name}: no index.js found`)
                continue
            }

            const mod = require(indexPath)
            const moduleExport = mod.default || mod
            await moduleRegistry.register(manifest, moduleExport, modulePath)
        } catch (err) {
            console.error(`Failed to load module ${entry.name}:`, err)
        }
    }

    console.log(
        `Loaded ${moduleRegistry.getAll().length} module(s), ${moduleRegistry.getAllActions().length} action(s) available`
    )
}
