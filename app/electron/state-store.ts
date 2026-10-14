/**
 * Live state published by modules (and the face poller). Keys are namespaced,
 * e.g. "obs-control.streaming" or "button.12.value". Changes are batched and
 * handed to a single listener (the WebSocket server) for broadcast.
 */
type Listener = (changes: Record<string, unknown>) => void

/** Primitives by identity, objects/arrays by content (polled JSON arrives as fresh objects) */
function sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (a && b && typeof a === "object" && typeof b === "object") {
        try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
    }
    return false
}

class StateStore {
    private state = new Map<string, unknown>()
    private pending: Record<string, unknown> = {}
    private flushTimer: ReturnType<typeof setTimeout> | null = null
    private listeners = new Set<Listener>()

    get(key: string): unknown {
        return this.state.get(key)
    }

    set(key: string, value: unknown): boolean {
        const has = this.state.has(key)
        if (value === undefined) {
            if (!has) return false
            this.state.delete(key)
            this.pending[key] = null
            this.scheduleFlush()
            return true
        }
        if (has && sameValue(this.state.get(key), value)) return false
        this.state.set(key, value)
        this.pending[key] = value
        this.scheduleFlush()
        return true
    }

    /** Delete every key starting with the prefix */
    clearPrefix(prefix: string) {
        for (const key of Array.from(this.state.keys())) {
            if (key.startsWith(prefix)) {
                this.state.delete(key)
                this.pending[key] = null
            }
        }
        this.scheduleFlush()
    }

    snapshot(): Record<string, unknown> {
        return Object.fromEntries(this.state)
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    private scheduleFlush() {
        if (this.flushTimer) return
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null
            const changes = this.pending
            this.pending = {}
            if (Object.keys(changes).length === 0) return
            for (const l of this.listeners) {
                try { l(changes) } catch (err) { console.error("State listener failed:", err) }
            }
        }, 16)
    }
}

export const stateStore = new StateStore()
