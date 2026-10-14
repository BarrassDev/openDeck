import React, { useMemo } from "react"
import { resolveFace, type ResolvedFace, type StateMap } from "../../shared/face"
import type { DeckButton as DeckButtonType } from "../../shared/types"

/** Shared face rendering, used by the live deck, widgets and the settings preview */
export function ButtonFaceView({ face }: { face: ResolvedFace }) {
    const image = face.iconType === "image" && face.icon
    return (
        <div className={`sd-button-face pos-${face.labelPosition} size-${face.fontSize}`}>
            {image ? (
                <img className="sd-button-img" src={face.icon} alt={face.label} draggable={false} />
            ) : face.icon ? (
                <span className="sd-button-icon">{face.icon}</span>
            ) : null}
            {face.showLabel && <span className="sd-button-label">{face.label}</span>}
        </div>
    )
}

export function faceStyle(face: ResolvedFace): React.CSSProperties {
    const style: React.CSSProperties = {}
    if (face.color) style.background = face.color
    if (face.textColor) style.color = face.textColor
    return style
}

export function useResolvedFace(button: DeckButtonType, state: StateMap): ResolvedFace {
    return useMemo(() => resolveFace(button, state), [button, state])
}
