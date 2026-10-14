// Client → Server message types
export type ClientMessageType =
    | "button.press"
    | "page.change"
    | "device.connect"
    | "config.update"

// Server → Client message types
export type ServerMessageType =
    | "state.update"
    | "state.snapshot"
    | "module.status"
    | "button.feedback"
    | "page.update"
    | "config.sync"

export interface ClientMessage {
    type: ClientMessageType
    action?: string
    payload?: Record<string, unknown>
}

export interface ServerMessage {
    type: ServerMessageType
    payload?: Record<string, unknown>
}

export type PressType = "tap" | "down" | "up" | "long" | "sequence"

export interface ButtonFeedbackPayload {
    buttonId: string
    action: string
    status: "success" | "error" | "running"
    message?: string
}

export interface ModuleStatus {
    connected?: boolean
    message?: string
    updatedAt?: number
}
