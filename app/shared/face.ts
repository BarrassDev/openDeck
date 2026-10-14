import type { DeckButton, IconType, LabelPosition, FontSize } from "./types"

export type StateMap = Record<string, unknown>

export interface ResolvedFace {
    icon: string
    iconType: IconType
    label: string
    showLabel: boolean
    fill: boolean
    color?: string
    textColor?: string
    labelPosition: LabelPosition
    fontSize: FontSize
}

const TEMPLATE_RE = /\{\{\s*([^}]+?)\s*\}\}/g

export function stateKeyForButtonValue(buttonId: string): string {
    return `button.${buttonId}.value`
}

export function isImageIcon(icon?: string, iconType?: string): boolean {
    if (iconType === "image") return !!icon
    if (!icon) return false
    return icon.startsWith("data:image/") || icon.startsWith("http://") || icon.startsWith("https://")
}

function stringify(value: unknown): string {
    if (value === undefined || value === null) return ""
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    try { return JSON.stringify(value) } catch { return String(value) }
}

/** Replace {{key}} and {{value}} with values from the state map */
export function renderTemplate(template: string, state: StateMap, buttonId: string): string {
    if (!template) return ""
    return template.replace(TEMPLATE_RE, (_m, raw: string) => {
        const key = raw.trim()
        if (key === "value") return stringify(state[stateKeyForButtonValue(buttonId)])
        return stringify(state[key])
    })
}

function isTruthy(value: unknown): boolean {
    if (value === undefined || value === null) return false
    if (typeof value === "string") return value !== "" && value !== "false" && value !== "0"
    if (typeof value === "number") return value !== 0
    return !!value
}

function matches(cond: { key: string; equals?: string; truthy?: boolean }, state: StateMap): boolean {
    if (!cond.key) return false
    const value = state[cond.key]
    if (cond.equals !== undefined) {
        return stringify(value) === cond.equals
    }
    if (cond.truthy !== undefined) {
        return isTruthy(value) === cond.truthy
    }
    return isTruthy(value)
}

/** Compute what a button should display right now */
export function resolveFace(button: DeckButton, state: StateMap): ResolvedFace {
    const face = button.face || {}
    let icon = button.icon || ""
    let iconType: IconType = button.iconType || (isImageIcon(icon) ? "image" : "emoji")
    let label = button.label || ""
    let color = face.color
    let textColor = face.textColor

    if (face.imageTemplate) {
        const rendered = renderTemplate(face.imageTemplate, state, button.id).trim()
        if (rendered) {
            icon = rendered
            iconType = "image"
        }
    }
    if (face.labelTemplate) {
        const rendered = renderTemplate(face.labelTemplate, state, button.id)
        if (rendered.trim()) label = rendered
    }

    for (const alt of face.states || []) {
        if (!alt.when || !matches(alt.when, state)) continue
        if (alt.icon !== undefined && alt.icon !== "") {
            icon = alt.icon
            iconType = alt.iconType || (isImageIcon(alt.icon) ? "image" : "emoji")
        }
        if (alt.label !== undefined && alt.label !== "") label = alt.label
        if (alt.color) color = alt.color
        if (alt.textColor) textColor = alt.textColor
        break
    }

    const labelPosition: LabelPosition = button.hideLabel ? "hidden" : (face.labelPosition || "bottom")
    const showLabel = labelPosition !== "hidden" && !!label
    const image = isImageIcon(icon, iconType)

    return {
        icon,
        iconType: image ? "image" : "emoji",
        label,
        showLabel,
        fill: image && !!button.fillImage,
        color,
        textColor,
        labelPosition,
        fontSize: face.fontSize || "md",
    }
}

/** Read a dotted path ("a.b.0.c") from a parsed JSON value */
export function readPath(value: unknown, path?: string): unknown {
    if (!path) return value
    let current: unknown = value
    for (const part of path.split(".")) {
        if (!part) continue
        if (current === null || current === undefined) return undefined
        if (Array.isArray(current)) {
            const idx = Number(part)
            current = Number.isInteger(idx) ? current[idx] : undefined
        } else if (typeof current === "object") {
            current = (current as Record<string, unknown>)[part]
        } else {
            return undefined
        }
    }
    return current
}
