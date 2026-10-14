import React from "react"
import { MAX_SPAN, type DeckButton, type ButtonWidget, type SliderWidget, type PanelWidget, type InfoWidget } from "../../shared/types"
import { useActionLookup } from "../hooks/useModules"
import { normalizeParam } from "./PayloadForm"
import { StateKeyDatalist } from "./FaceEditor"

interface WidgetEditorProps {
    button: DeckButton
    onChange: (updates: Partial<DeckButton>) => void
    columns: number
    rows: number
    slotIndex: number
}

const STATE_KEYS_LIST_ID = "opendeck-state-keys"

type WidgetKind = "button" | "slider" | "panel" | "info"

const KINDS: { value: WidgetKind; label: string; hint: string }[] = [
    { value: "button", label: "Button", hint: "A normal press button." },
    { value: "slider", label: "Slider", hint: "Drag to set a value, e.g. a Wave Link channel level or an OBS input volume. Make it 1x3 or 3x1." },
    { value: "panel", label: "Panel", hint: "Image plus text lines from live values, e.g. a 2x2 Spotify panel with album art, track and artist." },
    { value: "info", label: "Info", hint: "Title, big value and a sub line from live values, e.g. time, stream timer, viewers, FPS." },
]

const PRESETS: { label: string; apply: (b: DeckButton) => Partial<DeckButton> }[] = [
    {
        label: "Clock",
        apply: () => ({ widget: { type: "info", title: "{{clock.weekday}}", value: "{{clock.time}}", sub: "{{clock.date}}" }, span: { w: 2, h: 1 } }),
    },
    {
        label: "Stream timer",
        apply: () => ({
            widget: { type: "info", title: "Live", value: "{{obs-control.streamTime}}", sub: "{{obs-control.fps}} fps · {{obs-control.bitrateKbps}} kbps" },
            span: { w: 2, h: 1 },
            face: { states: [{ when: { key: "obs-control.streaming", truthy: true }, color: "#b3261e" }] },
        }),
    },
    {
        label: "Now playing (HTTP)",
        apply: (b) => ({
            widget: { type: "panel", lines: ["{{value}}"], imagePosition: "left" },
            span: { w: 2, h: 2 },
            face: { ...(b.face || {}), imageTemplate: "{{value}}" },
        }),
    },
    {
        label: "Wave Link level slider",
        apply: () => ({
            widget: { type: "slider", stateKey: "wavelink.channel.Music.level", min: 0, max: 100, step: 1, valueParam: "level", unit: "%" },
            span: { w: 3, h: 1 },
            label: "Music",
            action: "wavelink.setChannelLevel",
            payload: { channel: "Music", mix: "Monitor" },
        }),
    },
]

export default function WidgetEditor({ button, onChange, columns, rows, slotIndex }: WidgetEditorProps) {
    const kind: WidgetKind = button.widget?.type || "button"
    const col = slotIndex % columns
    const row = Math.floor(slotIndex / columns)
    const maxW = Math.min(MAX_SPAN, columns - col)
    const maxH = Math.min(MAX_SPAN, rows - row)
    const w = Math.min(maxW, button.span?.w || 1)
    const h = Math.min(maxH, button.span?.h || 1)
    const lookup = useActionLookup(button.action)
    const actionParams = lookup?.detail.params ? Object.keys(lookup.detail.params) : []

    const setKind = (next: WidgetKind) => {
        if (next === "button") { onChange({ widget: undefined }); return }
        if (button.widget?.type === next) return
        const widget: ButtonWidget =
            next === "slider" ? { type: "slider", min: 0, max: 100, step: 1, valueParam: actionParams[0] || "value" }
                : next === "panel" ? { type: "panel", lines: [], imagePosition: "left" }
                    : { type: "info", title: button.label || "", value: "" }
        const span = button.span || (next === "slider" ? { w: Math.min(3, maxW), h: 1 } : next === "panel" ? { w: Math.min(2, maxW), h: Math.min(2, maxH) } : { w: Math.min(2, maxW), h: 1 })
        onChange({ widget, span })
    }

    const setSpan = (nw: number, nh: number) => {
        onChange({ span: nw === 1 && nh === 1 ? undefined : { w: nw, h: nh } })
    }

    const setWidget = (updates: Record<string, unknown>) => {
        if (!button.widget) return
        const next: Record<string, unknown> = { ...(button.widget as unknown as Record<string, unknown>), ...updates }
        for (const k of Object.keys(next)) {
            if (next[k] === undefined || next[k] === "") delete next[k]
        }
        onChange({ widget: next as unknown as ButtonWidget })
    }

    const coveredCount = w * h - 1

    return (
        <div className="widget-editor">
            <StateKeyDatalist />

            <section className="editor-group">
                <h4>Type</h4>
                <div className="button-editor-toggle">
                    {KINDS.map(k => (
                        <button key={k.value} type="button" className={`toggle-btn ${kind === k.value ? "active" : ""}`} onClick={() => setKind(k.value)}>
                            {k.label}
                        </button>
                    ))}
                </div>
                <p className="settings-hint">{KINDS.find(k => k.value === kind)?.hint}</p>
            </section>

            <section className="editor-group">
                <h4>Size</h4>
                <div className="editor-row">
                    <label className="button-editor-field" style={{ flex: 1 }}>
                        <span>Width (cells)</span>
                        <select className="settings-input" value={w} onChange={e => setSpan(Number(e.target.value), h)}>
                            {Array.from({ length: maxW }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                    </label>
                    <label className="button-editor-field" style={{ flex: 1 }}>
                        <span>Height (cells)</span>
                        <select className="settings-input" value={h} onChange={e => setSpan(w, Number(e.target.value))}>
                            {Array.from({ length: maxH }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                    </label>
                </div>
                <p className="settings-hint">
                    {coveredCount > 0
                        ? `This tile covers ${coveredCount} neighbouring cell(s). Anything configured in those slots is hidden until you shrink it.`
                        : "Grow the tile to the right and downward; it is clipped at the grid edge."}
                </p>
            </section>

            {kind === "slider" && (
                <section className="editor-group">
                    <h4>Slider</h4>
                    <p className="settings-hint">
                        Choose the action on the <strong>Action</strong> tab (e.g. <code>wavelink.setChannelLevel</code>, <code>obs.setVolume</code>) and fill its fixed parameters there.
                        The slider then sends the chosen parameter with the dragged value.
                    </p>
                    <label className="button-editor-field">
                        <span>Current value from state key</span>
                        <input
                            className="settings-input"
                            list={STATE_KEYS_LIST_ID}
                            value={(button.widget as SliderWidget).stateKey || ""}
                            placeholder="wavelink.channel.Music.level"
                            onChange={e => setWidget({ stateKey: e.target.value })}
                            spellCheck={false}
                        />
                    </label>
                    <label className="button-editor-field">
                        <span>Parameter that receives the value</span>
                        {actionParams.length > 0 ? (
                            <select className="settings-input" value={(button.widget as SliderWidget).valueParam || ""} onChange={e => setWidget({ valueParam: e.target.value })}>
                                <option value="">Select…</option>
                                {actionParams.map(p => {
                                    const schema = normalizeParam(lookup!.detail.params![p])
                                    return <option key={p} value={p}>{p} ({schema.type})</option>
                                })}
                            </select>
                        ) : (
                            <input className="settings-input" value={(button.widget as SliderWidget).valueParam || ""} placeholder="level" onChange={e => setWidget({ valueParam: e.target.value })} />
                        )}
                    </label>
                    <div className="editor-row">
                        <label className="button-editor-field" style={{ flex: 1 }}>
                            <span>Min</span>
                            <input className="settings-input" type="number" value={(button.widget as SliderWidget).min ?? 0} onChange={e => setWidget({ min: Number(e.target.value) })} />
                        </label>
                        <label className="button-editor-field" style={{ flex: 1 }}>
                            <span>Max</span>
                            <input className="settings-input" type="number" value={(button.widget as SliderWidget).max ?? 100} onChange={e => setWidget({ max: Number(e.target.value) })} />
                        </label>
                        <label className="button-editor-field" style={{ flex: 1 }}>
                            <span>Step</span>
                            <input className="settings-input" type="number" min={0.01} step="any" value={(button.widget as SliderWidget).step ?? 1} onChange={e => setWidget({ step: Number(e.target.value) || 1 })} />
                        </label>
                        <label className="button-editor-field" style={{ flex: 1 }}>
                            <span>Unit</span>
                            <input className="settings-input" value={(button.widget as SliderWidget).unit || ""} placeholder="%" onChange={e => setWidget({ unit: e.target.value })} />
                        </label>
                    </div>
                    <div className="editor-row">
                        <label className="button-editor-field" style={{ flex: 1 }}>
                            <span>Orientation</span>
                            <select className="settings-input" value={(button.widget as SliderWidget).orientation || "auto"} onChange={e => setWidget({ orientation: e.target.value === "auto" ? undefined : e.target.value })}>
                                <option value="auto">Auto (by shape)</option>
                                <option value="horizontal">Horizontal</option>
                                <option value="vertical">Vertical</option>
                            </select>
                        </label>
                        <div className="button-editor-field" style={{ flex: 1 }}>
                            <span>Show value</span>
                            <div className="button-editor-toggle">
                                <button type="button" className={`toggle-btn ${(button.widget as SliderWidget).showValue !== false ? "active" : ""}`} onClick={() => setWidget({ showValue: undefined })}>On</button>
                                <button type="button" className={`toggle-btn ${(button.widget as SliderWidget).showValue === false ? "active" : ""}`} onClick={() => setWidget({ showValue: false })}>Off</button>
                            </div>
                        </div>
                    </div>
                </section>
            )}

            {kind === "panel" && (
                <section className="editor-group">
                    <h4>Panel</h4>
                    <p className="settings-hint">
                        The image comes from the <strong>Look</strong> tab (image icon) or the <strong>Live</strong> tab (live image template, e.g. <code>{"{{value}}"}</code> from a polled URL).
                        Lines are templates; the first line is shown larger.
                    </p>
                    <label className="button-editor-field">
                        <span>Image position</span>
                        <select className="settings-input" value={(button.widget as PanelWidget).imagePosition || "left"} onChange={e => setWidget({ imagePosition: e.target.value })}>
                            <option value="left">Left</option>
                            <option value="top">Top</option>
                            <option value="fill">Fill (text over image)</option>
                            <option value="none">No image</option>
                        </select>
                    </label>
                    <div className="editor-group-header">
                        <span className="payload-form-name">Lines</span>
                        <button type="button" className="settings-btn small" onClick={() => setWidget({ lines: [...((button.widget as PanelWidget).lines || []), ""] })}>+ Line</button>
                    </div>
                    {((button.widget as PanelWidget).lines || []).map((line, i) => (
                        <div key={i} className="editor-row">
                            <input
                                className="settings-input"
                                list={STATE_KEYS_LIST_ID}
                                value={line}
                                placeholder={i === 0 ? "{{value}} or Now playing" : "{{obs-control.currentScene}}"}
                                onChange={e => {
                                    const lines = [...((button.widget as PanelWidget).lines || [])]
                                    lines[i] = e.target.value
                                    setWidget({ lines })
                                }}
                                spellCheck={false}
                            />
                            <button type="button" className="settings-btn icon small danger" title="Remove line" onClick={() => setWidget({ lines: ((button.widget as PanelWidget).lines || []).filter((_, j) => j !== i) })}>✕</button>
                        </div>
                    ))}
                </section>
            )}

            {kind === "info" && (
                <section className="editor-group">
                    <h4>Info tile</h4>
                    <p className="settings-hint">
                        All three fields are templates. Built-in keys: <code>{"{{clock.time}}"}</code>, <code>{"{{clock.seconds}}"}</code>, <code>{"{{clock.date}}"}</code>, <code>{"{{clock.weekday}}"}</code>.
                        OBS publishes <code>streamTime</code>, <code>recordTime</code>, <code>fps</code>, <code>cpu</code>, <code>bitrateKbps</code>. Use the Live tab to poll a URL for viewer counts and show it with <code>{"{{value}}"}</code>.
                    </p>
                    <label className="button-editor-field">
                        <span>Title</span>
                        <input className="settings-input" list={STATE_KEYS_LIST_ID} value={(button.widget as InfoWidget).title || ""} placeholder="Viewers" onChange={e => setWidget({ title: e.target.value })} spellCheck={false} />
                    </label>
                    <label className="button-editor-field">
                        <span>Value</span>
                        <input className="settings-input" list={STATE_KEYS_LIST_ID} value={(button.widget as InfoWidget).value || ""} placeholder="{{value}}" onChange={e => setWidget({ value: e.target.value })} spellCheck={false} />
                    </label>
                    <label className="button-editor-field">
                        <span>Sub line</span>
                        <input className="settings-input" list={STATE_KEYS_LIST_ID} value={(button.widget as InfoWidget).sub || ""} placeholder="{{obs-control.streamTime}}" onChange={e => setWidget({ sub: e.target.value })} spellCheck={false} />
                    </label>
                </section>
            )}

            <section className="editor-group">
                <h4>Presets</h4>
                <div className="widget-presets">
                    {PRESETS.map(p => (
                        <button key={p.label} type="button" className="settings-btn small" onClick={() => onChange(p.apply(button))}>{p.label}</button>
                    ))}
                </div>
                <p className="settings-hint">Presets fill in the type, size and templates; adjust names (e.g. the Wave Link channel) afterwards.</p>
            </section>
        </div>
    )
}
