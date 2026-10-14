import type { DeckPage, DeckButton, FaceSource } from "../shared/types"
import { readPath, stateKeyForButtonValue } from "../shared/face"
import { stateStore } from "./state-store"

const DEFAULT_INTERVAL_MS = 10_000
const MIN_INTERVAL_MS = 2_000
const REQUEST_TIMEOUT_MS = 8_000
const MAX_VALUE_LENGTH = 200_000

interface PollJob {
    buttonId: string
    source: FaceSource
    timer: ReturnType<typeof setInterval>
    inFlight: boolean
}

/**
 * Polls HTTP sources declared on button faces and publishes the extracted
 * value to the state store as `button.<id>.value`, so faces can show e.g. a
 * Spotify album art URL or a "now playing" string via `{{value}}`.
 */
class FacePoller {
    private jobs = new Map<string, PollJob>()

    configure(pages: DeckPage[]) {
        const wanted = new Map<string, DeckButton>()
        for (const page of pages || []) {
            for (const button of page.grid || []) {
                const src = button?.face?.source
                if (src && src.type === "http" && typeof src.url === "string" && src.url.trim()) {
                    wanted.set(button.id, button)
                }
            }
        }

        // Stop jobs that disappeared or changed
        for (const [id, job] of this.jobs) {
            const next = wanted.get(id)
            if (!next || JSON.stringify(next.face!.source) !== JSON.stringify(job.source)) {
                clearInterval(job.timer)
                this.jobs.delete(id)
                if (!next) stateStore.set(stateKeyForButtonValue(id), undefined)
            }
        }

        // Start new jobs
        for (const [id, button] of wanted) {
            if (this.jobs.has(id)) continue
            const source = button.face!.source!
            const interval = Math.max(MIN_INTERVAL_MS, Number(source.intervalMs) || DEFAULT_INTERVAL_MS)
            const job: PollJob = {
                buttonId: id,
                source,
                inFlight: false,
                timer: setInterval(() => this.poll(job), interval),
            }
            this.jobs.set(id, job)
            void this.poll(job)
        }
    }

    stop() {
        for (const job of this.jobs.values()) clearInterval(job.timer)
        this.jobs.clear()
    }

    private parseHeaders(raw?: string): Record<string, string> {
        if (!raw) return {}
        try {
            const parsed = JSON.parse(raw)
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                const out: Record<string, string> = {}
                for (const [k, v] of Object.entries(parsed)) out[k] = String(v)
                return out
            }
        } catch { /* ignore malformed headers */ }
        return {}
    }

    private async poll(job: PollJob) {
        if (job.inFlight) return
        job.inFlight = true
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
            const res = await fetch(job.source.url, {
                headers: { "User-Agent": "OpenDeck", ...this.parseHeaders(job.source.headers) },
                signal: controller.signal,
            })
            const text = await res.text()
            let value: unknown = text
            const contentType = res.headers.get("content-type") || ""
            if (contentType.includes("json") || /^\s*[[{]/.test(text)) {
                try { value = JSON.parse(text) } catch { /* keep raw text */ }
            }
            value = readPath(value, job.source.path)
            if (typeof value === "string" && value.length > MAX_VALUE_LENGTH) {
                value = value.slice(0, MAX_VALUE_LENGTH)
            }
            stateStore.set(stateKeyForButtonValue(job.buttonId), value ?? null)
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            console.warn(`[face-poller] ${job.source.url}: ${message}`)
        } finally {
            clearTimeout(timeout)
            job.inFlight = false
        }
    }
}

export const facePoller = new FacePoller()
