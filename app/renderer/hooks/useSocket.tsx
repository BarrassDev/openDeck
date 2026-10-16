import React, {
    createContext,
    useContext,
    useEffect,
    useRef,
    useState,
    useCallback,
    useMemo,
    ReactNode,
} from "react"
import type { ClientMessage, ServerMessage } from "../../shared/types"

export const API_PORT = 4020

/** True inside the OpenDeck desktop window (the only place config can be edited) */
export const isElectron = navigator.userAgent.includes("Electron")

/** Base URL for HTTP API calls (Vite dev server runs on a different port) */
export function apiBase(): string {
    if (window.location.port === "5173") return `http://${window.location.hostname}:${API_PORT}`
    return `${window.location.protocol}//${window.location.host}`
}

/** Face images served by OpenDeck arrive as "/api/face-image/..." paths; point them at the server */
export function imageSrc(src: string): string {
    return src.startsWith("/api/") ? apiBase() + src : src
}

type MessageHandler = (message: ServerMessage) => void

interface SocketContextValue {
    send: (type: ClientMessage["type"], action?: string, payload?: Record<string, unknown>) => void
    /** Register a handler for every incoming message. Returns an unsubscribe function. */
    subscribe: (handler: MessageHandler) => () => void
    connected: boolean
    /** Number of reconnect attempts since the last successful connection */
    reconnectAttempts: number
}

const SocketContext = createContext<SocketContextValue>({
    send: () => { },
    subscribe: () => () => { },
    connected: false,
    reconnectAttempts: 0,
})

export function SocketProvider({ children }: { children: ReactNode }) {
    const wsRef = useRef<WebSocket | null>(null)
    const handlersRef = useRef<Set<MessageHandler>>(new Set())
    const [connected, setConnected] = useState(false)
    const [reconnectAttempts, setReconnectAttempts] = useState(0)
    const reconnectTimeout = useRef<ReturnType<typeof setTimeout>>()
    const closedByUs = useRef(false)

    const connect = useCallback(() => {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
        const host = window.location.port === "5173"
            ? `${window.location.hostname}:${API_PORT}`
            : window.location.host
        const ws = new WebSocket(`${protocol}//${host}`)

        ws.onopen = () => {
            setConnected(true)
            setReconnectAttempts(0)
            ws.send(JSON.stringify({
                type: "device.connect",
                payload: { userAgent: navigator.userAgent },
            }))
        }

        ws.onmessage = (event) => {
            let message: ServerMessage
            try {
                message = JSON.parse(event.data) as ServerMessage
            } catch {
                return
            }
            if (!message || typeof message.type !== "string") return
            for (const handler of handlersRef.current) {
                try { handler(message) } catch (err) { console.error("socket handler failed", err) }
            }
        }

        ws.onclose = () => {
            setConnected(false)
            if (closedByUs.current) return
            setReconnectAttempts(n => n + 1)
            // Back off a little, but never wait more than 5s so a woken tablet recovers quickly
            const delay = Math.min(5000, 1000 + Math.random() * 1000)
            reconnectTimeout.current = setTimeout(connect, delay)
        }

        ws.onerror = () => {
            ws.close()
        }

        wsRef.current = ws
    }, [])

    useEffect(() => {
        closedByUs.current = false
        connect()

        // When the page becomes visible again (tablet woke up), reconnect immediately if needed
        const onVisible = () => {
            if (document.visibilityState !== "visible") return
            const ws = wsRef.current
            if (!ws || ws.readyState === WebSocket.CLOSED) {
                clearTimeout(reconnectTimeout.current)
                connect()
            }
        }
        document.addEventListener("visibilitychange", onVisible)
        window.addEventListener("online", onVisible)

        return () => {
            closedByUs.current = true
            clearTimeout(reconnectTimeout.current)
            document.removeEventListener("visibilitychange", onVisible)
            window.removeEventListener("online", onVisible)
            wsRef.current?.close()
        }
    }, [connect])

    const send = useCallback((type: ClientMessage["type"], action?: string, payload?: Record<string, unknown>) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            const message: ClientMessage = { type, action, payload }
            wsRef.current.send(JSON.stringify(message))
        }
    }, [])

    const subscribe = useCallback((handler: MessageHandler) => {
        handlersRef.current.add(handler)
        return () => { handlersRef.current.delete(handler) }
    }, [])

    // Stable value: consumers (every deck tile) only re-render when the connection state changes,
    // not on every incoming message
    const value = useMemo(
        () => ({ send, subscribe, connected, reconnectAttempts }),
        [send, subscribe, connected, reconnectAttempts],
    )

    return (
        <SocketContext.Provider value={value}>
            {children}
        </SocketContext.Provider>
    )
}

export function useSocket() {
    return useContext(SocketContext)
}
