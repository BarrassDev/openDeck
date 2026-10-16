import React from "react"
import type { DeckButton } from "../../shared/types"
import { renderTemplate, type ResolvedFace, type StateMap } from "../../shared/face"
import { ButtonFaceView } from "./ButtonFaceView"
import { imageSrc } from "../hooks/useSocket"

interface WidgetBodyProps {
    button: DeckButton
    face: ResolvedFace
    state: StateMap
}

/** Inner content of a deck tile: normal face, panel (image + lines) or info tile */
export default function WidgetBody({ button, face, state }: WidgetBodyProps) {
    const widget = button.widget

    if (widget?.type === "panel") {
        const image = face.iconType === "image" ? face.icon : ""
        const pos = widget.imagePosition || (image ? "left" : "none")
        const lines = (widget.lines || [])
            .map(t => renderTemplate(t, state, button.id).trim())
            .filter(Boolean)
        if (lines.length === 0 && face.label) lines.push(face.label)
        return (
            <div className={`sd-panel pos-${pos}`}>
                {pos !== "none" && (
                    image
                        ? <img className="sd-panel-img" src={imageSrc(image)} alt="" draggable={false} />
                        : face.icon ? <span className="sd-panel-emoji">{face.icon}</span> : <span className="sd-panel-img placeholder" />
                )}
                <div className="sd-panel-lines">
                    {lines.map((line, i) => (
                        <span key={i} className={i === 0 ? "primary" : "secondary"}>{line}</span>
                    ))}
                </div>
            </div>
        )
    }

    if (widget?.type === "info") {
        const title = renderTemplate(widget.title || face.label || "", state, button.id).trim()
        const value = renderTemplate(widget.value || "", state, button.id).trim()
        const sub = renderTemplate(widget.sub || "", state, button.id).trim()
        return (
            <div className="sd-info">
                {title && <span className="sd-info-title">{title}</span>}
                <span className={`sd-info-value${value.length > 12 ? " long" : ""}`}>{value || "—"}</span>
                {sub && <span className="sd-info-sub">{sub}</span>}
            </div>
        )
    }

    return <ButtonFaceView face={face} />
}
