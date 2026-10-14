import React, { useRef, useState } from "react"
import type { DeckButton, IconType, LabelPosition, FontSize } from "../../shared/types"
import { useActionLookup } from "../hooks/useModules"
import { useModuleState } from "../hooks/useModuleState"
import ActionPicker from "./ActionPicker"
import PayloadForm from "./PayloadForm"
import EmojiPalette from "./EmojiPalette"
import FaceEditor, { ColorField } from "./FaceEditor"
import BehaviourEditor from "./BehaviourEditor"
import WidgetEditor from "./WidgetEditor"
import WidgetBody from "./WidgetBody"
import { faceStyle, useResolvedFace } from "./ButtonFaceView"
import { DEFAULT_COLUMNS, DEFAULT_ROWS } from "../../shared/types"

interface ButtonEditorProps {
    button: DeckButton
    onChange: (updates: Partial<DeckButton>) => void
    columns?: number
    rows?: number
    slotIndex?: number
}

type Tab = "look" | "action" | "live" | "behaviour" | "widget"

const TABS: { id: Tab; label: string }[] = [
    { id: "look", label: "Look" },
    { id: "action", label: "Action" },
    { id: "live", label: "Live" },
    { id: "behaviour", label: "Behaviour" },
    { id: "widget", label: "Widget" },
]

const MAX_IMAGE_SIZE = 50 * 1024 * 1024 // 50MB after base64

const LABEL_POSITIONS: { value: LabelPosition; label: string }[] = [
    { value: "bottom", label: "Bottom" },
    { value: "top", label: "Top" },
    { value: "center", label: "Center" },
    { value: "hidden", label: "Hidden" },
]

const FONT_SIZES: { value: FontSize; label: string }[] = [
    { value: "sm", label: "S" },
    { value: "md", label: "M" },
    { value: "lg", label: "L" },
]

export default function ButtonEditor({ button, onChange, columns = DEFAULT_COLUMNS, rows = DEFAULT_ROWS, slotIndex = 0 }: ButtonEditorProps) {
    const fileRef = useRef<HTMLInputElement>(null)
    const iconType: IconType = button.iconType || "emoji"
    const [tab, setTab] = useState<Tab>("look")
    const [advanced, setAdvanced] = useState(false)
    const [payloadError, setPayloadError] = useState("")
    const [showPalette, setShowPalette] = useState(false)

    const lookup = useActionLookup(button.action)
    const { state } = useModuleState()
    const face = useResolvedFace(button, state)

    const setFace = (updates: Record<string, unknown>) => {
        const next = { ...(button.face || {}), ...updates }
        for (const k of Object.keys(next)) {
            if ((next as Record<string, unknown>)[k] === undefined || (next as Record<string, unknown>)[k] === "") delete (next as Record<string, unknown>)[k]
        }
        onChange({ face: Object.keys(next).length ? next : undefined })
    }

    const handleActionChange = (actionId: string) => {
        onChange({ action: actionId, payload: undefined })
    }

    const payloadStr = button.payload ? JSON.stringify(button.payload, null, 2) : ""

    const handlePayloadJsonChange = (raw: string) => {
        if (!raw.trim()) {
            setPayloadError("")
            onChange({ payload: undefined })
            return
        }
        try {
            const parsed = JSON.parse(raw)
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                setPayloadError("")
                onChange({ payload: parsed })
            } else {
                setPayloadError("Must be a JSON object {}")
            }
        } catch {
            setPayloadError("Invalid JSON")
        }
    }

    const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        if (!file.type.startsWith("image/")) return

        const reader = new FileReader()
        reader.onload = () => {
            const result = reader.result as string
            if (result.length > MAX_IMAGE_SIZE) {
                alert("Image too large. Please use an image under 50MB.")
                return
            }
            onChange({ icon: result, iconType: "image" })
        }
        reader.readAsDataURL(file)
        e.target.value = ""
    }

    const handleIconTypeChange = (type: IconType) => {
        if (type === "emoji" && iconType === "image") {
            onChange({ iconType: "emoji", icon: "" })
        } else {
            onChange({ iconType: type })
        }
    }

    const labelPosition: LabelPosition = button.hideLabel ? "hidden" : (button.face?.labelPosition || "bottom")

    return (
        <div className="button-editor">
            {/* Live preview */}
            <div className="button-editor-preview-wrap">
                <div className={`sd-button preview-tile${face.fill ? " fill" : ""}${button.widget ? ` widget-${button.widget.type}` : ""}`} style={faceStyle(face)}>
                    <WidgetBody button={button} face={face} state={state} />
                </div>
                <div className="button-editor-preview-meta">
                    <strong>{face.label || "Untitled"}</strong>
                    <span>{lookup ? `${lookup.module.name} › ${lookup.detail.description}` : (button.action || "No action")}</span>
                    {button.pressMode && button.pressMode !== "tap" && <span className="preview-pill">{button.pressMode}</span>}
                    {button.widget && <span className="preview-pill">{button.widget.type}{button.span ? ` ${button.span.w}x${button.span.h}` : ""}</span>}
                    {button.face?.states?.length ? <span className="preview-pill">{button.face.states.length} live rule(s)</span> : null}
                </div>
            </div>

            <div className="editor-tabs">
                {TABS.map(t => (
                    <button
                        key={t.id}
                        type="button"
                        className={`editor-tab ${tab === t.id ? "active" : ""}`}
                        onClick={() => setTab(t.id)}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {tab === "look" && (
                <div className="editor-panel">
                    <label className="button-editor-field">
                        <span>Label</span>
                        <input
                            className="settings-input"
                            value={button.label}
                            onChange={e => onChange({ label: e.target.value })}
                            placeholder="Button label"
                        />
                    </label>

                    <div className="editor-row">
                        <div className="button-editor-field" style={{ flex: 2 }}>
                            <span>Label position</span>
                            <div className="button-editor-toggle">
                                {LABEL_POSITIONS.map(p => (
                                    <button
                                        key={p.value}
                                        type="button"
                                        className={`toggle-btn ${labelPosition === p.value ? "active" : ""}`}
                                        onClick={() => {
                                            if (p.value === "hidden") onChange({ hideLabel: true })
                                            else {
                                                onChange({ hideLabel: false })
                                                setFace({ labelPosition: p.value === "bottom" ? undefined : p.value })
                                            }
                                        }}
                                    >{p.label}</button>
                                ))}
                            </div>
                        </div>
                        <div className="button-editor-field" style={{ flex: 1 }}>
                            <span>Text size</span>
                            <div className="button-editor-toggle">
                                {FONT_SIZES.map(f => (
                                    <button
                                        key={f.value}
                                        type="button"
                                        className={`toggle-btn ${(button.face?.fontSize || "md") === f.value ? "active" : ""}`}
                                        onClick={() => setFace({ fontSize: f.value === "md" ? undefined : f.value })}
                                    >{f.label}</button>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="button-editor-field">
                        <span>Icon</span>
                        <div className="button-editor-toggle">
                            <button type="button" className={`toggle-btn ${iconType === "emoji" ? "active" : ""}`} onClick={() => handleIconTypeChange("emoji")}>Emoji</button>
                            <button type="button" className={`toggle-btn ${iconType === "image" ? "active" : ""}`} onClick={() => handleIconTypeChange("image")}>Image</button>
                        </div>
                    </div>

                    {iconType === "emoji" ? (
                        <div className="button-editor-field">
                            <div className="editor-row">
                                <input
                                    className="settings-input"
                                    value={button.icon || ""}
                                    onChange={e => onChange({ icon: e.target.value })}
                                    placeholder="e.g. 🎬 (or leave blank)"
                                />
                                <button type="button" className="settings-btn small" onClick={() => setShowPalette(p => !p)}>
                                    {showPalette ? "Hide" : "Pick"}
                                </button>
                            </div>
                            {showPalette && <EmojiPalette onPick={emoji => { onChange({ icon: emoji }); setShowPalette(false) }} />}
                        </div>
                    ) : (
                        <div className="button-editor-field">
                            <div className="button-editor-image-row">
                                {button.icon && button.iconType === "image" && (
                                    <img className="button-editor-preview" src={button.icon} alt="icon" />
                                )}
                                <button type="button" className="settings-btn" onClick={() => fileRef.current?.click()}>
                                    {button.icon && button.iconType === "image" ? "Change Image" : "Upload Image"}
                                </button>
                                {button.icon && button.iconType === "image" && (
                                    <button type="button" className="settings-btn icon danger" onClick={() => onChange({ icon: "" })} title="Remove image">✕</button>
                                )}
                                <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleImageUpload} />
                            </div>
                            <label className="button-editor-field" style={{ marginTop: 6 }}>
                                <span>Or image URL</span>
                                <input
                                    className="settings-input"
                                    value={button.icon?.startsWith("data:") ? "" : button.icon || ""}
                                    onChange={e => onChange({ icon: e.target.value, iconType: "image" })}
                                    placeholder="https://example.com/icon.png"
                                    spellCheck={false}
                                />
                            </label>
                            <div className="button-editor-field" style={{ marginTop: 6 }}>
                                <span>Fill button with image</span>
                                <div className="button-editor-toggle">
                                    <button type="button" className={`toggle-btn ${button.fillImage ? "active" : ""}`} onClick={() => onChange({ fillImage: true })}>On</button>
                                    <button type="button" className={`toggle-btn ${!button.fillImage ? "active" : ""}`} onClick={() => onChange({ fillImage: false })}>Off</button>
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="editor-row">
                        <ColorField label="Background" value={button.face?.color} onChange={v => setFace({ color: v })} />
                        <ColorField label="Text" value={button.face?.textColor} onChange={v => setFace({ textColor: v })} />
                    </div>
                </div>
            )}

            {tab === "action" && (
                <div className="editor-panel">
                    <div className="button-editor-field">
                        <span>Action</span>
                        <ActionPicker value={button.action} onChange={handleActionChange} />
                    </div>

                    {button.action && (
                        <div className="button-editor-field">
                            <div className="button-editor-payload-header">
                                <span>Parameters</span>
                                <button
                                    type="button"
                                    className="button-editor-advanced-toggle"
                                    onClick={() => setAdvanced(a => !a)}
                                    title="Toggle raw JSON editor"
                                >
                                    {advanced ? "← Form view" : "Edit JSON"}
                                </button>
                            </div>
                            {advanced ? (
                                <>
                                    <textarea
                                        className="settings-input payload-input"
                                        defaultValue={payloadStr}
                                        onBlur={e => handlePayloadJsonChange(e.target.value)}
                                        placeholder={'{ "key": "value" }'}
                                        rows={6}
                                        spellCheck={false}
                                    />
                                    {payloadError && <span className="payload-error">{payloadError}</span>}
                                </>
                            ) : (
                                <PayloadForm
                                    detail={lookup?.detail}
                                    payload={button.payload}
                                    onChange={p => onChange({ payload: p })}
                                    moduleName={lookup?.module.name}
                                />
                            )}
                        </div>
                    )}
                    {!button.action && (
                        <p className="settings-hint">Pick an action to configure its parameters. Live options (OBS scenes, Wave Link channels) load from the connected module.</p>
                    )}
                </div>
            )}

            {tab === "live" && (
                <div className="editor-panel">
                    <FaceEditor button={button} onChange={onChange} />
                </div>
            )}

            {tab === "behaviour" && (
                <div className="editor-panel">
                    <BehaviourEditor button={button} onChange={onChange} />
                </div>
            )}

            {tab === "widget" && (
                <div className="editor-panel">
                    <WidgetEditor button={button} onChange={onChange} columns={columns} rows={rows} slotIndex={slotIndex} />
                </div>
            )}
        </div>
    )
}
