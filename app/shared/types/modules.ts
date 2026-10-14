/**
 * Param schema describes a single field in an action's payload form.
 *
 * Backward-compat: in older manifests, `params` was `Record<string, string>` where
 * the value was just a description. That format is still accepted — it gets coerced
 * to a `{ type: "string", description }` schema at runtime.
 */
import type { ModuleStatus } from "./messages"

export type ParamSchema =
    | StringParam
    | NumberParam
    | BooleanParam
    | SelectParam
    | FileParam
    | TextareaParam

interface ParamBase {
    description?: string
    placeholder?: string
    required?: boolean
    /** Mask the value in the UI (API keys, passwords) */
    secret?: boolean
}

export interface StringParam extends ParamBase {
    type: "string"
    default?: string
}

export interface TextareaParam extends ParamBase {
    type: "textarea"
    default?: string
    rows?: number
}

export interface NumberParam extends ParamBase {
    type: "number"
    default?: number
    min?: number
    max?: number
    step?: number
}

export interface BooleanParam extends ParamBase {
    type: "boolean"
    default?: boolean
}

export interface SelectParam extends ParamBase {
    type: "select"
    options?: { value: string; label?: string }[]
    default?: string
    /** Name of a module provider that returns options live (e.g. OBS scenes) */
    optionsFrom?: string
    /** Another param whose current value is passed to the provider as `arg` */
    dependsOn?: string
    /** Allow typing a value that is not in the option list */
    allowCustom?: boolean
}

export interface FileParam extends ParamBase {
    type: "file"
    default?: string
    /** File-extension filters used by the native picker */
    filters?: { name: string; extensions: string[] }[]
}

/** Either a rich schema or a legacy description string */
export type ParamDefinition = ParamSchema | string

export interface ActionDetail {
    description: string
    params?: Record<string, ParamDefinition>
}

export interface ModuleManifest {
    name: string
    version: string
    description?: string
    /** 1 = legacy (payload only), 2 = receives ModuleContext */
    apiVersion?: 1 | 2
    icon?: string
    actions: string[]
    actionDetails?: Record<string, ActionDetail>
    /** Module-scoped settings, rendered as a form in Settings > Modules */
    config?: Record<string, ParamDefinition>
    /** Documented state keys the module publishes (key suffix -> description), used by the face editor */
    stateKeys?: Record<string, string>
}

export interface ProviderOption {
    value: string
    label?: string
}

/**
 * Context handed to every v2 module handler. Settings are scoped to the
 * owning module; state keys are automatically prefixed with the module name.
 */
export interface ModuleContext {
    moduleName: string
    /** This module's variables only */
    settings: Record<string, string>
    /** Publish a live value. Key is prefixed: setState("streaming", true) -> "obs-control.streaming" */
    setState: (key: string, value: unknown) => void
    getState: (key: string) => unknown
    /** Remove every state key published by this module (optionally only those under a prefix) */
    clearState: (prefix?: string) => void
    setStatus: (status: ModuleStatus) => void
    log: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
}

export interface ModuleActionHandler {
    (payload: Record<string, unknown> | undefined, ctx: ModuleContext): Promise<void>
}

export interface ModuleProvider {
    (ctx: ModuleContext, arg?: string): Promise<ProviderOption[]>
}

export interface OpenDeckModule {
    manifest: ModuleManifest
    actions: Record<string, ModuleActionHandler>
    providers?: Record<string, ModuleProvider>
    init?: (ctx: ModuleContext) => void | Promise<void>
    dispose?: () => void | Promise<void>
    onSettingsChanged?: (ctx: ModuleContext) => void | Promise<void>
}
