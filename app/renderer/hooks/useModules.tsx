import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react"
import type { ModuleManifest, ModuleStatus, ParamDefinition, ProviderOption } from "../../shared/types"
import { apiBase } from "./useSocket"

export interface ModuleInfo {
    name: string
    version: string
    description?: string
    apiVersion: number
    icon?: string
    actions: string[]
    actionDetails: NonNullable<ModuleManifest["actionDetails"]>
    config: Record<string, ParamDefinition>
    stateKeys: Record<string, string>
    providers: string[]
    status: ModuleStatus
}

interface ModulesContextValue {
    modules: ModuleInfo[]
    loading: boolean
    error: string | null
    refresh: () => void
}

const ModulesContext = createContext<ModulesContextValue | undefined>(undefined)

export function ModulesProvider({ children }: { children: ReactNode }) {
    const [modules, setModules] = useState<ModuleInfo[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const refresh = useCallback(() => {
        setLoading(true)
        setError(null)
        fetch(`${apiBase()}/api/modules`)
            .then(res => res.json())
            .then((data: Partial<ModuleInfo>[]) => setModules(data.map(m => ({
                name: m.name || "",
                version: m.version || "",
                description: m.description,
                apiVersion: m.apiVersion || 1,
                icon: m.icon,
                actions: m.actions || [],
                actionDetails: m.actionDetails || {},
                config: m.config || {},
                stateKeys: m.stateKeys || {},
                providers: m.providers || [],
                status: m.status || {},
            }))))
            .catch(err => setError(err instanceof Error ? err.message : "Failed to load modules"))
            .finally(() => setLoading(false))
    }, [])

    useEffect(() => {
        refresh()
    }, [refresh])

    return (
        <ModulesContext.Provider value={{ modules, loading, error, refresh }}>
            {children}
        </ModulesContext.Provider>
    )
}

export function useModules(): ModulesContextValue {
    const ctx = useContext(ModulesContext)
    if (!ctx) throw new Error("useModules must be used within ModulesProvider")
    return ctx
}

/** Look up an action and its module by action ID */
export function useActionLookup(actionId: string | undefined) {
    const { modules } = useModules()
    if (!actionId) return null
    for (const mod of modules) {
        if (mod.actionDetails && actionId in mod.actionDetails) {
            return { module: mod, detail: mod.actionDetails[actionId] }
        }
        if (mod.actions.includes(actionId)) {
            return { module: mod, detail: { description: actionId } }
        }
    }
    return null
}

// ---- live option providers (OBS scenes, Wave Link channels, ...) ----

const OPTIONS_TTL_MS = 20_000
const optionsCache = new Map<string, { at: number; options: ProviderOption[] }>()

export async function fetchProviderOptions(moduleName: string, provider: string, arg?: string, force = false): Promise<ProviderOption[]> {
    const key = `${moduleName}/${provider}/${arg ?? ""}`
    const cached = optionsCache.get(key)
    if (!force && cached && Date.now() - cached.at < OPTIONS_TTL_MS) return cached.options
    const url = `${apiBase()}/api/modules/${encodeURIComponent(moduleName)}/options/${encodeURIComponent(provider)}${arg ? `?arg=${encodeURIComponent(arg)}` : ""}`
    const res = await fetch(url)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `Failed to load options (${res.status})`)
    const options: ProviderOption[] = Array.isArray(body.options) ? body.options : []
    optionsCache.set(key, { at: Date.now(), options })
    return options
}

export function useProviderOptions(moduleName: string | undefined, provider: string | undefined, arg?: string) {
    const [options, setOptions] = useState<ProviderOption[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback((force = false) => {
        if (!moduleName || !provider) return
        setLoading(true)
        setError(null)
        fetchProviderOptions(moduleName, provider, arg, force)
            .then(setOptions)
            .catch(err => {
                setOptions([])
                setError(err instanceof Error ? err.message : "Failed to load options")
            })
            .finally(() => setLoading(false))
    }, [moduleName, provider, arg])

    useEffect(() => { load(false) }, [load])

    return { options, loading, error, refresh: () => load(true) }
}
