import React, { useMemo } from "react"
import type { DeckButton, ButtonFace, ButtonFaceState, FaceSource } from "../../shared/types"
import { stateKeyForButtonValue } from "../../shared/face"
import { useModules } from "../hooks/useModules"
import { useModuleState } from "../hooks/useModuleState"

interface FaceEditorProps {
    button: DeckButton
    onChange: (updates: Partial<DeckButton>) => void
}

const STATE_KEYS_LIST_ID = "opendeck-state-keys"

/** All state keys worth suggesting: documented by modules plus whatever is live right now */
export function useStateKeySuggestions(): { key: string; hint?: string }[] {
    const { modules } = useModules()
    const { state } = useModuleState()
    return useMemo(() => {
        const seen = new Map<string, string | undefined>()
        for (const key of Object.keys(state).sort()) {
            if (key.startsWith("button.")) continue
            seen.set(key, undefined)
        }
        for (const mod of modules) {
            for (const [suffix, hint] of Object.entries(mod.stateKeys)) {
                const key = `${mod.name}.${suffix}`
                if (!seen.has(key)) seen.set(key, hint)
            }
        }
        return Array.from(seen, ([key, hint]) => ({ key, hint }))
    }, [modules, state])
}

export function StateKeyDatalist() {
    const keys = useStateKeySuggestions()
    return (
        <datalist id={STATE_KEYS_LIST_ID}>
            {keys.map(k => <option key={k.key} value={k.key}>{k.hint}</option>)}
        </datalist>
    )
}

function preview(value: unknown): string {
    if (value === undefined) return "(no value yet)"
    const s = typeof value === "string" ? value : JSON.stringify(value)
    return s.length > 120 ? `${s.slice(0, 120)}…` : s
}

export default function FaceEditor({ button, onChange }: FaceEditorProps) {
    const face: ButtonFace = button.face || {}
    const { state } = useModuleState()
    const polled = state[stateKeyForButtonValue(button.id)]

    const setFace = (updates: Partial<ButtonFace>) => {
        const next: ButtonFace = { ...face, ...updates }
        // Drop empty keys so the config stays tidy
        for (const k of Object.keys(next) as (keyof ButtonFace)[]) {
            const v = next[k]
            if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) delete next[k]
        }
        onChange({ face: Object.keys(next).length ? next : undefined })
    }

    const source: FaceSource = face.source || { type: "http", url: "" }
    const setSource = (updates: Partial<FaceSource>) => {
        const next = { ...source, ...updates }
        setFace({ source: next.url.trim() ? next : undefined })
    }

    const states = face.states || []
    const setStateAt = (index: number, updates: Partial<ButtonFaceState>) => {
        setFace({ states: states.map((s, i) => (i === index ? { ...s, ...updates } : s)) })
    }
    const setCondition = (index: number, updates: Partial<ButtonFaceState["when"]>) => {
        const s = states[index]
        setStateAt(index, { when: { ...s.when, ...updates } })
    }

    return (
        <div className="face-editor">
            <StateKeyDatalist />

            <section className="editor-group">
                <h4>Live image</h4>
                <p className="settings-hint">
                    Show an image from a module value or a polled URL instead of the static icon.
                    Use <code>{"{{value}}"}</code> for the polled value below, or any state key such as <code>{"{{wavelink.channel.Music.image}}"}</code>.
                </p>
                <input
                    className="settings-input"
                    list={STATE_KEYS_LIST_ID}
                    value={face.imageTemplate || ""}
                    placeholder="{{value}} or https://… or {{module.key}}"
                    onChange={e => setFace({ imageTemplate: e.target.value })}
                    spellCheck={false}
                />
            </section>

            <section className="editor-group">
                <h4>Live label</h4>
                <p className="settings-hint">Template for the label text, e.g. <code>{"Scene: {{obs-control.currentScene}}"}</code>.</p>
                <input
                    className="settings-input"
                    list={STATE_KEYS_LIST_ID}
                    value={face.labelTemplate || ""}
                    placeholder="{{obs-control.currentScene}}"
                    onChange={e => setFace({ labelTemplate: e.target.value })}
                    spellCheck={false}
                />
            </section>

            <section className="editor-group">
                <h4>Polled value (HTTP)</h4>
                <p className="settings-hint">
                    The desktop app fetches this URL on a timer and exposes the result as <code>{"{{value}}"}</code>.
                    For JSON responses, set a path like <code>item.album.images.0.url</code> (Spotify) to pick one field.
                </p>
                <label className="button-editor-field">
                    <span>URL</span>
                    <input
                        className="settings-input"
                        value={source.url}
                        placeholder="https://api.example.com/now-playing"
                        onChange={e => setSource({ url: e.target.value })}
                        spellCheck={false}
                    />
                </label>
                <div className="editor-row">
                    <label className="button-editor-field" style={{ flex: 2 }}>
                        <span>JSON path</span>
                        <input
                            className="settings-input"
                            value={source.path || ""}
                            placeholder="item.album.images.0.url"
                            onChange={e => setSource({ path: e.target.value })}
                            spellCheck={false}
                        />
                    </label>
                    <label className="button-editor-field" style={{ flex: 1 }}>
                        <span>Every (s)</span>
                        <input
                            className="settings-input"
                            type="number"
                            min={2}
                            value={source.intervalMs ? Math.round(source.intervalMs / 1000) : 10}
                            onChange={e => setSource({ intervalMs: Math.max(2, Number(e.target.value) || 10) * 1000 })}
                        />
                    </label>
                </div>
                <label className="button-editor-field">
                    <span>Headers (JSON, optional)</span>
                    <input
                        className="settings-input"
                        value={source.headers || ""}
                        placeholder='{"Authorization": "Bearer …"}'
                        onChange={e => setSource({ headers: e.target.value })}
                        spellCheck={false}
                    />
                </label>
                {face.source && (
                    <div className="face-polled-value">
                        <span>Current value</span>
                        <code>{preview(polled)}</code>
                    </div>
                )}
            </section>

            <section className="editor-group">
                <div className="editor-group-header">
                    <h4>State overrides</h4>
                    <button
                        type="button"
                        className="settings-btn small"
                        onClick={() => setFace({ states: [...states, { when: { key: "", truthy: true } }] })}
                    >
                        + Add
                    </button>
                </div>
                <p className="settings-hint">
                    Change the face when a module value matches. The first matching rule wins.
                    Example: when <code>obs-control.streaming</code> is true, show a red "LIVE" face.
                </p>
                {states.length === 0 && <p className="payload-form-empty">No overrides yet.</p>}
                {states.map((s, i) => {
                    const mode = s.when.equals !== undefined ? "equals" : (s.when.truthy === false ? "falsy" : "truthy")
                    const live = s.when.key ? state[s.when.key] : undefined
                    return (
                        <div key={i} className="face-state-card">
                            <div className="face-state-head">
                                <span className="settings-inspector-eyebrow">Rule {i + 1}</span>
                                <span className="face-state-live" title="Current value of this key">
                                    now: <code>{preview(live)}</code>
                                </span>
                                <button
                                    type="button"
                                    className="settings-btn icon danger small"
                                    title="Remove rule"
                                    onClick={() => setFace({ states: states.filter((_, j) => j !== i) })}
                                >✕</button>
                            </div>
                            <div className="editor-row">
                                <label className="button-editor-field" style={{ flex: 2 }}>
                                    <span>When</span>
                                    <input
                                        className="settings-input"
                                        list={STATE_KEYS_LIST_ID}
                                        value={s.when.key}
                                        placeholder="obs-control.streaming"
                                        onChange={e => setCondition(i, { key: e.target.value })}
                                        spellCheck={false}
                                    />
                                </label>
                                <label className="button-editor-field" style={{ flex: 1 }}>
                                    <span>Is</span>
                                    <select
                                        className="settings-input"
                                        value={mode}
                                        onChange={e => {
                                            const m = e.target.value
                                            if (m === "equals") setStateAt(i, { when: { key: s.when.key, equals: "" } })
                                            else setStateAt(i, { when: { key: s.when.key, truthy: m === "truthy" } })
                                        }}
                                    >
                                        <option value="truthy">on / true</option>
                                        <option value="falsy">off / false</option>
                                        <option value="equals">equal to…</option>
                                    </select>
                                </label>
                                {mode === "equals" && (
                                    <label className="button-editor-field" style={{ flex: 1 }}>
                                        <span>Value</span>
                                        <input
                                            className="settings-input"
                                            value={s.when.equals || ""}
                                            placeholder="BRB"
                                            onChange={e => setCondition(i, { equals: e.target.value })}
                                        />
                                    </label>
                                )}
                            </div>
                            <div className="editor-row">
                                <label className="button-editor-field" style={{ flex: 1 }}>
                                    <span>Icon / image</span>
                                    <input
                                        className="settings-input"
                                        value={s.icon || ""}
                                        placeholder="🔴 or https://…"
                                        onChange={e => setStateAt(i, { icon: e.target.value })}
                                    />
                                </label>
                                <label className="button-editor-field" style={{ flex: 1 }}>
                                    <span>Label</span>
                                    <input
                                        className="settings-input"
                                        value={s.label || ""}
                                        placeholder="LIVE"
                                        onChange={e => setStateAt(i, { label: e.target.value })}
                                    />
                                </label>
                            </div>
                            <div className="editor-row">
                                <ColorField label="Background" value={s.color} onChange={v => setStateAt(i, { color: v })} />
                                <ColorField label="Text" value={s.textColor} onChange={v => setStateAt(i, { textColor: v })} />
                            </div>
                        </div>
                    )
                })}
            </section>
        </div>
    )
}

export function ColorField({ label, value, onChange }: { label: string; value?: string; onChange: (v: string | undefined) => void }) {
    const swatch = value && /^#[0-9a-f]{6}$/i.test(value) ? value : "#2a2a2e"
    return (
        <label className="button-editor-field color-field" style={{ flex: 1 }}>
            <span>{label}</span>
            <div className="color-field-row">
                <input
                    type="color"
                    value={swatch}
                    onChange={e => onChange(e.target.value)}
                    title={label}
                />
                <input
                    className="settings-input"
                    value={value || ""}
                    placeholder="default"
                    onChange={e => onChange(e.target.value || undefined)}
                    spellCheck={false}
                />
                {value && (
                    <button type="button" className="settings-btn icon small" title="Reset" onClick={() => onChange(undefined)}>✕</button>
                )}
            </div>
        </label>
    )
}
