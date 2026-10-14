import React, { useState } from "react"
import type { ParamDefinition, ParamSchema, ActionDetail, SelectParam } from "../../shared/types"
import { useProviderOptions } from "../hooks/useModules"

interface PayloadFormProps {
    detail: ActionDetail | undefined
    payload: Record<string, unknown> | undefined
    onChange: (payload: Record<string, unknown> | undefined) => void
    /** Module owning the action; needed for live option providers */
    moduleName?: string
}

/** Coerce legacy `string` definitions into a normalized ParamSchema */
export function normalizeParam(def: ParamDefinition): ParamSchema {
    if (typeof def === "string") {
        return { type: "string", description: def }
    }
    return def
}

function setKey(
    payload: Record<string, unknown> | undefined,
    key: string,
    value: unknown,
): Record<string, unknown> | undefined {
    const next = { ...(payload || {}) }
    if (value === undefined || value === "" || value === null) {
        delete next[key]
    } else {
        next[key] = value
    }
    return Object.keys(next).length === 0 ? undefined : next
}

export default function PayloadForm({ detail, payload, onChange, moduleName }: PayloadFormProps) {
    const params = detail?.params

    if (!params || Object.keys(params).length === 0) {
        return (
            <p className="payload-form-empty">
                This action has no parameters.
            </p>
        )
    }

    return (
        <div className="payload-form">
            {Object.entries(params).map(([key, rawDef]) => {
                const schema = normalizeParam(rawDef)
                const currentValue = payload?.[key]
                const dependsOn = schema.type === "select" ? schema.dependsOn : undefined
                const dependsValue = dependsOn ? payload?.[dependsOn] : undefined
                return (
                    <ParamField
                        key={key}
                        name={key}
                        schema={schema}
                        value={currentValue}
                        onChange={v => onChange(setKey(payload, key, v))}
                        moduleName={moduleName}
                        dependsValue={typeof dependsValue === "string" ? dependsValue : undefined}
                    />
                )
            })}
        </div>
    )
}

export interface FieldProps {
    name: string
    schema: ParamSchema
    value: unknown
    onChange: (value: unknown) => void
    moduleName?: string
    /** Current value of the param this one depends on (passed to the provider) */
    dependsValue?: string
}

export function ParamField({ name, schema, value, onChange, moduleName, dependsValue }: FieldProps) {
    return (
        <div className="payload-form-field">
            <label className="payload-form-label">
                <span className="payload-form-name">
                    {name}
                    {schema.required && <span className="payload-form-required"> *</span>}
                </span>
                {schema.description && (
                    <span className="payload-form-desc">{schema.description}</span>
                )}
            </label>
            <FieldInput name={name} schema={schema} value={value} onChange={onChange} moduleName={moduleName} dependsValue={dependsValue} />
        </div>
    )
}

export function FieldInput({ schema, value, onChange, moduleName, dependsValue }: FieldProps) {
    switch (schema.type) {
        case "string": {
            const v = (value as string) ?? schema.default ?? ""
            return (
                <input
                    className="settings-input"
                    type={schema.secret ? "password" : "text"}
                    value={v}
                    placeholder={schema.placeholder}
                    onChange={e => onChange(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                />
            )
        }

        case "textarea": {
            const v = (value as string) ?? schema.default ?? ""
            return (
                <textarea
                    className="settings-input payload-input"
                    value={v}
                    placeholder={schema.placeholder}
                    rows={schema.rows ?? 3}
                    onChange={e => onChange(e.target.value)}
                    spellCheck={false}
                />
            )
        }

        case "number": {
            const v = value === undefined || value === null || value === ""
                ? (schema.default ?? "")
                : (value as number)
            return (
                <input
                    className="settings-input"
                    type="number"
                    value={v as number | string}
                    placeholder={schema.placeholder}
                    min={schema.min}
                    max={schema.max}
                    step={schema.step ?? 1}
                    onChange={e => {
                        const raw = e.target.value
                        if (raw === "") onChange(undefined)
                        else {
                            const num = Number(raw)
                            if (!Number.isNaN(num)) onChange(num)
                        }
                    }}
                />
            )
        }

        case "boolean": {
            const v = (value as boolean | undefined) ?? schema.default ?? false
            return (
                <div className="button-editor-toggle">
                    <button
                        type="button"
                        className={`toggle-btn ${v ? "active" : ""}`}
                        onClick={() => onChange(true)}
                    >On</button>
                    <button
                        type="button"
                        className={`toggle-btn ${!v ? "active" : ""}`}
                        onClick={() => onChange(false)}
                    >Off</button>
                </div>
            )
        }

        case "select":
            return <SelectInput schema={schema} value={value as string | undefined} onChange={onChange} moduleName={moduleName} dependsValue={dependsValue} />

        case "file":
            return <FilePicker schema={schema} value={value as string | undefined} onChange={onChange} />
    }
}

function SelectInput({
    schema,
    value,
    onChange,
    moduleName,
    dependsValue,
}: {
    schema: SelectParam
    value: string | undefined
    onChange: (v: unknown) => void
    moduleName?: string
    dependsValue?: string
}) {
    const live = useProviderOptions(
        schema.optionsFrom ? moduleName : undefined,
        schema.optionsFrom,
        schema.dependsOn ? (dependsValue || "") : undefined,
    )
    const staticOptions = schema.options || []
    const options = schema.optionsFrom ? live.options : staticOptions
    const v = value ?? schema.default ?? ""
    const known = options.some(o => o.value === v)
    const waitingOnDependency = !!schema.dependsOn && !dependsValue

    return (
        <div className="payload-form-select-row">
            <select
                className="settings-input"
                value={known ? v : (v ? "__custom__" : "")}
                onChange={e => {
                    if (e.target.value === "__custom__") return
                    onChange(e.target.value)
                }}
            >
                <option value="">{waitingOnDependency ? `Select ${schema.dependsOn} first…` : "Select…"}</option>
                {!known && v && <option value="__custom__">{v} (custom)</option>}
                {options.map(opt => (
                    <option key={opt.value} value={opt.value}>
                        {opt.label ?? opt.value}
                    </option>
                ))}
            </select>
            {schema.optionsFrom && (
                <button
                    type="button"
                    className="settings-btn small"
                    onClick={live.refresh}
                    disabled={live.loading}
                    title="Reload options from the module"
                >
                    {live.loading ? "…" : "↻"}
                </button>
            )}
            {schema.allowCustom && (
                <input
                    className="settings-input payload-form-custom"
                    value={v}
                    placeholder="or type a value"
                    onChange={e => onChange(e.target.value)}
                    spellCheck={false}
                />
            )}
            {live.error && schema.optionsFrom && (
                <span className="payload-form-provider-error" title={live.error}>
                    Live options unavailable: {live.error}
                </span>
            )}
        </div>
    )
}

function FilePicker({
    schema,
    value,
    onChange,
}: {
    schema: Extract<ParamSchema, { type: "file" }>
    value: string | undefined
    onChange: (v: unknown) => void
}) {
    const [picking, setPicking] = useState(false)
    const v = value ?? schema.default ?? ""
    const canPick = typeof window !== "undefined" && !!window.electronAPI?.pickFile

    const handlePick = async () => {
        if (!canPick) return
        setPicking(true)
        try {
            const picked = await window.electronAPI!.pickFile({
                title: "Select a file",
                defaultPath: v || undefined,
                filters: schema.filters,
            })
            if (picked) onChange(picked)
        } finally {
            setPicking(false)
        }
    }

    return (
        <div className="payload-form-file-row">
            <input
                className="settings-input"
                style={{ flex: 1 }}
                value={v}
                placeholder={schema.placeholder}
                onChange={e => onChange(e.target.value)}
                spellCheck={false}
            />
            {canPick && (
                <button
                    type="button"
                    className="settings-btn small"
                    onClick={handlePick}
                    disabled={picking}
                >
                    {picking ? "…" : "Browse"}
                </button>
            )}
        </div>
    )
}
