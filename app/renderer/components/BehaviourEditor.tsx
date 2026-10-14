import React from "react"
import type { DeckButton, ButtonAction, PressMode } from "../../shared/types"
import { useActionLookup } from "../hooks/useModules"
import ActionPicker from "./ActionPicker"
import PayloadForm from "./PayloadForm"

interface BehaviourEditorProps {
    button: DeckButton
    onChange: (updates: Partial<DeckButton>) => void
}

const MODES: { value: PressMode; label: string; hint: string }[] = [
    { value: "tap", label: "Tap", hint: "Runs the action as soon as the button is pressed." },
    { value: "hold", label: "Hold", hint: "Runs the action on press and a second action on release (push-to-talk, momentary scenes)." },
    { value: "long", label: "Long press", hint: "Tap runs the action; holding for 0.6s runs a different action instead." },
]

/** Editor for one action + its parameters, reused for release, long-press and sequence steps */
export function ActionStepEditor({
    step,
    onChange,
    showDelay,
}: {
    step: ButtonAction
    onChange: (step: ButtonAction) => void
    showDelay?: boolean
}) {
    const lookup = useActionLookup(step.action)
    return (
        <div className="action-step">
            {showDelay && (
                <label className="button-editor-field action-step-delay">
                    <span>Wait (ms)</span>
                    <input
                        className="settings-input"
                        type="number"
                        min={0}
                        step={50}
                        value={step.delayMs ?? 0}
                        onChange={e => onChange({ ...step, delayMs: Math.max(0, Number(e.target.value) || 0) })}
                    />
                </label>
            )}
            <ActionPicker value={step.action} onChange={action => onChange({ ...step, action, payload: undefined })} />
            {step.action && (
                <PayloadForm
                    detail={lookup?.detail}
                    payload={step.payload}
                    onChange={payload => onChange({ ...step, payload })}
                    moduleName={lookup?.module.name}
                />
            )}
        </div>
    )
}

export default function BehaviourEditor({ button, onChange }: BehaviourEditorProps) {
    const mode: PressMode = button.pressMode || "tap"
    const sequence = button.sequence || []

    const setStep = (index: number, step: ButtonAction) => {
        onChange({ sequence: sequence.map((s, i) => (i === index ? step : s)) })
    }
    const moveStep = (from: number, to: number) => {
        if (to < 0 || to >= sequence.length) return
        const next = sequence.slice()
        const [s] = next.splice(from, 1)
        next.splice(to, 0, s)
        onChange({ sequence: next })
    }

    return (
        <div className="behaviour-editor">
            <section className="editor-group">
                <h4>Press mode</h4>
                <div className="button-editor-toggle">
                    {MODES.map(m => (
                        <button
                            key={m.value}
                            type="button"
                            className={`toggle-btn ${mode === m.value ? "active" : ""}`}
                            onClick={() => onChange({ pressMode: m.value === "tap" ? undefined : m.value })}
                        >
                            {m.label}
                        </button>
                    ))}
                </div>
                <p className="settings-hint">{MODES.find(m => m.value === mode)?.hint}</p>
            </section>

            {mode === "hold" && (
                <section className="editor-group">
                    <h4>On release</h4>
                    <ActionStepEditor
                        step={button.releaseAction || { action: "" }}
                        onChange={step => onChange({ releaseAction: step.action ? step : undefined })}
                    />
                </section>
            )}

            {mode === "long" && (
                <section className="editor-group">
                    <h4>On long press</h4>
                    <ActionStepEditor
                        step={button.longPressAction || { action: "" }}
                        onChange={step => onChange({ longPressAction: step.action ? step : undefined })}
                    />
                </section>
            )}

            <section className="editor-group">
                <div className="editor-group-header">
                    <h4>Then also run</h4>
                    <button
                        type="button"
                        className="settings-btn small"
                        onClick={() => onChange({ sequence: [...sequence, { action: "", delayMs: 0 }] })}
                    >
                        + Step
                    </button>
                </div>
                <p className="settings-hint">
                    Extra actions run in order after the main action (multi-action macros). Each step can wait first.
                </p>
                {sequence.length === 0 && <p className="payload-form-empty">No extra steps.</p>}
                {sequence.map((step, i) => (
                    <div key={i} className="sequence-step">
                        <div className="sequence-step-head">
                            <span className="settings-inspector-eyebrow">Step {i + 1}</span>
                            <div className="sequence-step-tools">
                                <button type="button" className="settings-btn icon small" title="Move up" disabled={i === 0} onClick={() => moveStep(i, i - 1)}>▲</button>
                                <button type="button" className="settings-btn icon small" title="Move down" disabled={i === sequence.length - 1} onClick={() => moveStep(i, i + 1)}>▼</button>
                                <button
                                    type="button"
                                    className="settings-btn icon small danger"
                                    title="Remove step"
                                    onClick={() => onChange({ sequence: sequence.filter((_, j) => j !== i) })}
                                >✕</button>
                            </div>
                        </div>
                        <ActionStepEditor step={step} onChange={s => setStep(i, s)} showDelay />
                    </div>
                ))}
            </section>
        </div>
    )
}
