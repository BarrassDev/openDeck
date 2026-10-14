export type IconType = "emoji" | "image"

export type LabelPosition = "bottom" | "top" | "center" | "hidden"
export type FontSize = "sm" | "md" | "lg"
export type PressMode = "tap" | "hold" | "long"

/** A single action invocation (used for sequences, release and long-press actions) */
export interface ButtonAction {
    action: string
    payload?: Record<string, unknown>
    /** Delay before running this step (sequences only) */
    delayMs?: number
}

/** Condition evaluated against the live module state map */
export interface FaceCondition {
    /** State key, e.g. "obs-control.streaming" or "wavelink.channel.Music.muted" */
    key: string
    /** Match when the state value equals this (compared as strings) */
    equals?: string
    /** Match when the state value is truthy (true, non-empty, non-zero) */
    truthy?: boolean
}

/** Alternate face applied when a condition matches */
export interface ButtonFaceState {
    when: FaceCondition
    icon?: string
    iconType?: IconType
    label?: string
    color?: string
    textColor?: string
}

/** Live value source polled by the server and published as `button.<id>.value` */
export interface FaceSource {
    type: "http"
    url: string
    /** Dotted path into a JSON response, e.g. "item.album.images.0.url" */
    path?: string
    intervalMs?: number
    /** Optional headers as a JSON object string, e.g. {"Authorization":"Bearer ..."} */
    headers?: string
}

export interface ButtonFace {
    /** Background colour (any CSS colour) */
    color?: string
    textColor?: string
    labelPosition?: LabelPosition
    fontSize?: FontSize
    /** Template resolving to an image URL/data URI. Supports {{state.key}} and {{value}} */
    imageTemplate?: string
    /** Template resolving to the label text. Supports {{state.key}} and {{value}} */
    labelTemplate?: string
    source?: FaceSource
    states?: ButtonFaceState[]
}

/** How many grid cells a button occupies (1x1 by default) */
export interface ButtonSpan {
    w: number
    h: number
}

/**
 * Slider: drag to send a value. Reads the current value from `stateKey` and sends the
 * button's action with `payload[valueParam] = value` while dragging (throttled).
 */
export interface SliderWidget {
    type: "slider"
    stateKey?: string
    min?: number
    max?: number
    step?: number
    /** Payload field that receives the slider value (e.g. "level" or "volume") */
    valueParam?: string
    orientation?: "auto" | "horizontal" | "vertical"
    unit?: string
    showValue?: boolean
}

/** Panel: image plus lines of text (templates), e.g. album art + track + artist */
export interface PanelWidget {
    type: "panel"
    lines?: string[]
    imagePosition?: "left" | "top" | "fill" | "none"
}

/** Info tile: small title, big value, optional sub line (all templates) */
export interface InfoWidget {
    type: "info"
    title?: string
    value?: string
    sub?: string
}

export type ButtonWidget = SliderWidget | PanelWidget | InfoWidget

export interface DeckButton {
    id: string
    span?: ButtonSpan
    widget?: ButtonWidget
    label: string
    icon?: string
    iconType?: IconType
    fillImage?: boolean
    hideLabel?: boolean
    disabled?: boolean
    action: string
    payload?: Record<string, unknown>
    face?: ButtonFace
    pressMode?: PressMode
    /** Hold mode: fired when the button is released */
    releaseAction?: ButtonAction
    /** Long mode: fired instead of `action` when held for the long-press duration */
    longPressAction?: ButtonAction
    /** Extra steps run after the primary action */
    sequence?: ButtonAction[]
}

export interface DeckVariable {
    key: string
    value: string
    description?: string
    /** Owning module name. Empty/undefined = unassigned (not delivered to any module) */
    module?: string
}

export interface DeckPage {
    name: string
    grid: DeckButton[]
    columns?: number
    rows?: number
}

export interface DeckConfig {
    pages: DeckPage[]
    variables: DeckVariable[]
    displayImage?: string
}

export const DEFAULT_COLUMNS = 5
export const DEFAULT_ROWS = 3
export const LONG_PRESS_MS = 600
export const MAX_SPAN = 6
