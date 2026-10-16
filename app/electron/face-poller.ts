import { createHash } from "crypto"
import type { DeckPage, DeckButton, FaceSource } from "../shared/types"
import { readPath, stateKeyForButtonValue } from "../shared/face"
import { stateStore } from "./state-store"

const DEFAULT_INTERVAL_MS = 10_000
const MIN_INTERVAL_MS = 2_000
const REQUEST_TIMEOUT_MS = 8_000
const MAX_VALUE_LENGTH = 200_000
/** Inline images above this size are served over HTTP instead of travelling through state */
const INLINE_IMAGE_LIMIT = 4_000

const DATA_IMAGE_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i

interface Consumer {
    buttonId: string
    path?: string
}

/** One HTTP request shared by every tile that polls the same URL with the same headers */
interface PollJob {
    key: string
    url: string
    headers: Record<string, string>
    intervalMs: number
    consumers: Map<string, Consumer>
    timer: ReturnType<typeof setInterval>
    inFlight: boolean
    /** Last parsed response, so a tile added to an existing job gets a value immediately */
    lastValue?: unknown
}

export interface FaceImage {
    hash: string
    contentType: string
    bytes: Buffer
}

function sourceKey(source: FaceSource): string {
    return JSON.stringify([source.url.trim(), source.headers || ""])
}

function parseHeaders(raw?: string): Record<string, string> {
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

/**
 * Polls HTTP sources declared on button faces and publishes the extracted
 * value to the state store as `button.<id>.value`, so faces can show e.g. a
 * Spotify album art URL or a "now playing" string via `{{value}}`.
 *
 * Tiles that share a URL share one request. Large inline images (base64 data
 * URIs such as album art) are kept here and published as a small
 * `/api/face-image/<id>?v=<hash>` URL, so a track change does not push a
 * 100 KB string through the state store, the WebSocket and every client's
 * React tree.
 */
class FacePoller {
    private jobs = new Map<string, PollJob>()
    private images = new Map<string, FaceImage>()

    configure(pages: DeckPage[]) {
        // Group wanted tiles by their shared request
        const groups = new Map<string, { url: string; headers: Record<string, string>; intervalMs: number; consumers: Map<string, Consumer> }>()
        for (const page of pages || []) {
            for (const button of page.grid || []) {
                const src = button?.face?.source
                if (!src || src.type !== "http" || typeof src.url !== "string" || !src.url.trim()) continue
                const key = sourceKey(src)
                const intervalMs = Math.max(MIN_INTERVAL_MS, Number(src.intervalMs) || DEFAULT_INTERVAL_MS)
                let group = groups.get(key)
                if (!group) {
                    group = { url: src.url.trim(), headers: parseHeaders(src.headers), intervalMs, consumers: new Map() }
                    groups.set(key, group)
                }
                group.intervalMs = Math.min(group.intervalMs, intervalMs)
                group.consumers.set(button.id, { buttonId: button.id, path: src.path })
            }
        }

        const wantedButtons = new Set<string>()
        for (const g of groups.values()) for (const id of g.consumers.keys()) wantedButtons.add(id)

        // Drop jobs whose request disappeared, and values of tiles that no longer poll
        for (const [key, job] of this.jobs) {
            const next = groups.get(key)
            if (!next) {
                clearInterval(job.timer)
                this.jobs.delete(key)
            }
            for (const id of job.consumers.keys()) {
                if (!wantedButtons.has(id)) this.forget(id)
            }
        }

        for (const [key, group] of groups) {
            const existing = this.jobs.get(key)
            if (existing) {
                const added = Array.from(group.consumers.values()).filter(c => {
                    const prev = existing.consumers.get(c.buttonId)
                    return !prev || prev.path !== c.path
                })
                existing.consumers = group.consumers
                if (existing.intervalMs !== group.intervalMs) {
                    clearInterval(existing.timer)
                    existing.intervalMs = group.intervalMs
                    existing.timer = setInterval(() => this.poll(existing), group.intervalMs)
                }
                // New or re-pathed tiles get a value from the last response without waiting
                if (added.length && existing.lastValue !== undefined) {
                    for (const c of added) this.publish(c, existing.lastValue)
                }
                continue
            }
            const job: PollJob = {
                key,
                url: group.url,
                headers: group.headers,
                intervalMs: group.intervalMs,
                consumers: group.consumers,
                inFlight: false,
                timer: setInterval(() => this.poll(job), group.intervalMs),
            }
            this.jobs.set(key, job)
            void this.poll(job)
        }
    }

    stop() {
        for (const job of this.jobs.values()) clearInterval(job.timer)
        this.jobs.clear()
        this.images.clear()
    }

    /** Image bytes behind a `/api/face-image/<buttonId>` URL */
    getImage(buttonId: string): FaceImage | undefined {
        return this.images.get(buttonId)
    }

    private forget(buttonId: string) {
        this.images.delete(buttonId)
        stateStore.set(stateKeyForButtonValue(buttonId), undefined)
    }

    private async poll(job: PollJob) {
        if (job.inFlight) return
        job.inFlight = true
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
            const res = await fetch(job.url, {
                headers: { "User-Agent": "OpenDeck", ...job.headers },
                signal: controller.signal,
            })
            const text = await res.text()
            let value: unknown = text
            const contentType = res.headers.get("content-type") || ""
            if (contentType.includes("json") || /^\s*[[{]/.test(text)) {
                try { value = JSON.parse(text) } catch { /* keep raw text */ }
            }
            job.lastValue = value
            for (const consumer of job.consumers.values()) this.publish(consumer, value)
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            console.warn(`[face-poller] ${job.url}: ${message}`)
        } finally {
            clearTimeout(timeout)
            job.inFlight = false
        }
    }

    private publish(consumer: Consumer, response: unknown) {
        let value = readPath(response, consumer.path)
        if (typeof value === "string" && value.length > INLINE_IMAGE_LIMIT) {
            const served = this.storeImage(consumer.buttonId, value)
            if (served) value = served
        } else {
            this.images.delete(consumer.buttonId)
        }
        if (typeof value === "string" && value.length > MAX_VALUE_LENGTH) {
            value = value.slice(0, MAX_VALUE_LENGTH)
        }
        stateStore.set(stateKeyForButtonValue(consumer.buttonId), value ?? null)
    }

    /** Keep a base64 image here and return the URL to publish instead, or null if it is not one */
    private storeImage(buttonId: string, dataUri: string): string | null {
        const match = DATA_IMAGE_RE.exec(dataUri)
        if (!match) return null
        const hash = createHash("sha1").update(dataUri).digest("hex").slice(0, 16)
        const current = this.images.get(buttonId)
        if (!current || current.hash !== hash) {
            this.images.set(buttonId, {
                hash,
                contentType: match[1].toLowerCase(),
                bytes: Buffer.from(match[2].replace(/\s+/g, ""), "base64"),
            })
        }
        return `/api/face-image/${encodeURIComponent(buttonId)}?v=${hash}`
    }
}

export const facePoller = new FacePoller()
