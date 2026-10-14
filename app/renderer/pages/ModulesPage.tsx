import React, { useState } from "react"
import { useDeckConfig } from "../hooks/useDeckConfig"
import { useModules, type ModuleInfo } from "../hooks/useModules"
import { useModuleState } from "../hooks/useModuleState"
import { FieldInput, normalizeParam } from "../components/PayloadForm"
import ClaudeLinkCard from "../components/ClaudeLinkCard"
import type { ParamDefinition, ParamSchema, ModuleStatus } from "../../shared/types"

/** Module variables are stored as strings; give typed fields their native value */
function coerceConfigValue(schema: ParamSchema, raw: string | undefined): unknown {
    if (raw === undefined) return undefined
    if (schema.type === "boolean") return raw === "true"
    if (schema.type === "number") return raw === "" ? undefined : Number(raw)
    return raw
}

function paramDescription(def: ParamDefinition): string {
    if (typeof def === "string") return def
    return def.description || ""
}

function paramTypeLabel(def: ParamDefinition): string {
    if (typeof def === "string") return "string"
    return def.type
}

function StatusDot({ status, apiVersion }: { status?: ModuleStatus; apiVersion: number }) {
    if (apiVersion < 2 || !status || status.connected === undefined) {
        return <span className="module-status neutral" title="This module does not report a connection">● ready</span>
    }
    return (
        <span className={`module-status ${status.connected ? "on" : "off"}`} title={status.message}>
            ● {status.connected ? "connected" : "disconnected"}
        </span>
    )
}

export default function ModulesPage() {
    const { modules, loading, error, refresh } = useModules()
    const { statuses } = useModuleState()
    const { variables, addVariable, updateVariable, removeVariable, setModuleVariable, getModuleVariable } = useDeckConfig()

    const unassigned = variables
        .map((v, index) => ({ v, index }))
        .filter(({ v }) => !v.module)

    return (
        <div className="modules-page">
            <div className="marketplace-header">
                <div className="marketplace-title-row">
                    <h2>Modules</h2>
                    <button className="settings-btn small" onClick={refresh} disabled={loading}>
                        {loading ? "Loading…" : "↻ Refresh"}
                    </button>
                </div>
                <p className="marketplace-hint">
                    Each module keeps its own settings and variables. A module can only see its own values; nothing is shared between modules.
                </p>
            </div>

            {error && <div className="marketplace-error">Could not load modules: {error}</div>}

            <ClaudeLinkCard />

            {unassigned.length > 0 && (
                <section className="settings-section module-card legacy">
                    <h3>Unassigned variables</h3>
                    <p className="settings-hint">
                        These were global variables from OpenDeck 1.x. Assign each one to the module that should receive it, or delete it.
                        Unassigned variables are not sent to any module.
                    </p>
                    <div className="settings-var-list">
                        {unassigned.map(({ v, index }) => (
                            <div key={index} className="settings-var-row">
                                <input className="settings-input var-key" value={v.key} onChange={e => updateVariable(index, { key: e.target.value })} placeholder="Key" />
                                <input className="settings-input var-value" value={v.value} onChange={e => updateVariable(index, { value: e.target.value })} placeholder="Value" />
                                <select className="settings-input var-module" value="" onChange={e => { if (e.target.value) updateVariable(index, { module: e.target.value }) }}>
                                    <option value="">Assign to module…</option>
                                    {modules.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
                                </select>
                                <button className="settings-btn icon danger" onClick={() => removeVariable(index)} title="Delete">✕</button>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {modules.map(mod => (
                <ModuleCard
                    key={mod.name}
                    mod={mod}
                    status={statuses[mod.name] || mod.status}
                    variables={variables}
                    addVariable={addVariable}
                    updateVariable={updateVariable}
                    removeVariable={removeVariable}
                    setModuleVariable={setModuleVariable}
                    getModuleVariable={getModuleVariable}
                />
            ))}
        </div>
    )
}

function ModuleCard({
    mod,
    status,
    variables,
    addVariable,
    updateVariable,
    removeVariable,
    setModuleVariable,
    getModuleVariable,
}: {
    mod: ModuleInfo
    status?: ModuleStatus
    variables: ReturnType<typeof useDeckConfig>["variables"]
    addVariable: ReturnType<typeof useDeckConfig>["addVariable"]
    updateVariable: ReturnType<typeof useDeckConfig>["updateVariable"]
    removeVariable: ReturnType<typeof useDeckConfig>["removeVariable"]
    setModuleVariable: ReturnType<typeof useDeckConfig>["setModuleVariable"]
    getModuleVariable: ReturnType<typeof useDeckConfig>["getModuleVariable"]
}) {
    const [showActions, setShowActions] = useState(false)
    const [newKey, setNewKey] = useState("")
    const [newValue, setNewValue] = useState("")
    const configKeys = Object.keys(mod.config)
    const customVars = variables
        .map((v, index) => ({ v, index }))
        .filter(({ v }) => v.module === mod.name && !configKeys.includes(v.key))
    const stateKeys = Object.entries(mod.stateKeys)

    const addCustom = () => {
        const key = newKey.trim()
        if (!key) return
        addVariable(mod.name, key, newValue)
        setNewKey("")
        setNewValue("")
    }

    return (
        <section className="settings-section module-card">
            <div className="module-card-head">
                <div className="module-card-title">
                    <span className="module-card-icon">{mod.icon || "🧩"}</span>
                    <div>
                        <h3>{mod.name} <span className="actions-module-version">v{mod.version}</span> <span className="actions-param-type">api v{mod.apiVersion}</span></h3>
                        {mod.description && <p className="actions-module-desc">{mod.description}</p>}
                    </div>
                </div>
                <div className="module-card-status">
                    <StatusDot status={status} apiVersion={mod.apiVersion} />
                    {status?.message && <span className="module-status-message">{status.message}</span>}
                </div>
            </div>

            {configKeys.length > 0 && (
                <div className="module-section">
                    <h4>Settings</h4>
                    <div className="payload-form">
                        {configKeys.map(key => {
                            const schema = normalizeParam(mod.config[key])
                            return (
                                <div key={key} className="payload-form-field">
                                    <label className="payload-form-label">
                                        <span className="payload-form-name">{key}{schema.required && <span className="payload-form-required"> *</span>}</span>
                                        {schema.description && <span className="payload-form-desc">{schema.description}</span>}
                                    </label>
                                    <FieldInput
                                        name={key}
                                        schema={schema}
                                        value={coerceConfigValue(schema, getModuleVariable(mod.name, key))}
                                        onChange={v => setModuleVariable(mod.name, key, v === undefined || v === null ? "" : String(v))}
                                        moduleName={mod.name}
                                    />
                                </div>
                            )
                        })}
                    </div>
                </div>
            )}

            <div className="module-section">
                <h4>Custom variables</h4>
                <p className="settings-hint">Extra key/value pairs delivered to this module only (as <code>payload.__variables</code> and <code>ctx.settings</code>).</p>
                {customVars.length > 0 && (
                    <div className="settings-var-list">
                        {customVars.map(({ v, index }) => (
                            <div key={index} className="settings-var-row">
                                <input className="settings-input var-key" value={v.key} onChange={e => updateVariable(index, { key: e.target.value })} placeholder="Key" />
                                <input className="settings-input var-value" value={v.value} onChange={e => updateVariable(index, { value: e.target.value })} placeholder="Value" />
                                <input className="settings-input var-desc" value={v.description || ""} onChange={e => updateVariable(index, { description: e.target.value })} placeholder="Description (optional)" />
                                <button className="settings-btn icon danger" onClick={() => removeVariable(index)} title="Remove">✕</button>
                            </div>
                        ))}
                    </div>
                )}
                <div className="settings-var-add">
                    <input className="settings-input var-key" value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="Key" onKeyDown={e => e.key === "Enter" && addCustom()} />
                    <input className="settings-input var-value" value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="Value" onKeyDown={e => e.key === "Enter" && addCustom()} />
                    <button className="settings-btn" onClick={addCustom}>+ Add</button>
                </div>
            </div>

            {stateKeys.length > 0 && (
                <div className="module-section">
                    <h4>Live state keys</h4>
                    <p className="settings-hint">Use these in a button's Live tab, prefixed with <code>{mod.name}.</code></p>
                    <div className="actions-params">
                        {stateKeys.map(([key, hint]) => (
                            <div key={key} className="actions-param-row">
                                <code className="actions-param-name">{mod.name}.{key}</code>
                                <span className="actions-param-desc">{hint}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div className="module-section">
                <button type="button" className="button-editor-advanced-toggle" onClick={() => setShowActions(s => !s)}>
                    {showActions ? "Hide actions" : `Show ${mod.actions.length} action(s)`}
                </button>
                {showActions && (
                    <div className="actions-list" style={{ marginTop: 10 }}>
                        {mod.actions.map(actionId => {
                            const detail = mod.actionDetails?.[actionId]
                            return (
                                <div key={actionId} className="actions-item">
                                    <div className="actions-item-header">
                                        <code className="actions-item-id">{actionId}</code>
                                        {detail?.description && <span className="actions-item-desc">{detail.description}</span>}
                                    </div>
                                    {detail?.params && Object.keys(detail.params).length > 0 && (
                                        <div className="actions-params">
                                            {Object.entries(detail.params).map(([param, def]) => (
                                                <div key={param} className="actions-param-row">
                                                    <code className="actions-param-name">{param}</code>
                                                    <span className="actions-param-type">{paramTypeLabel(def)}</span>
                                                    <span className="actions-param-desc">{paramDescription(def)}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                )}
            </div>
        </section>
    )
}
