import { moduleRegistry } from "./module-loader"
import { variableStore } from "./variable-store"
import type { ButtonAction } from "../shared/types"

const MAX_SEQUENCE_STEPS = 32
const MAX_STEP_DELAY_MS = 60_000

/** Keys the client attaches for bookkeeping; never forwarded to modules */
const INTERNAL_KEYS = new Set(["__sequence", "__pressType"])

function stripInternal(payload?: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(payload || {})) {
        if (!INTERNAL_KEYS.has(k)) out[k] = v
    }
    return out
}

export async function dispatchAction(
    actionId: string,
    payload?: Record<string, unknown>
): Promise<void> {
    const trimmedId = (actionId || "").trim()
    if (!trimmedId) throw new Error("No action specified")

    const module = moduleRegistry.resolve(trimmedId)
    if (!module) {
        throw new Error(`No module found for action: ${trimmedId}`)
    }

    const handler = module.actions[trimmedId]
    if (!handler) {
        throw new Error(`Action not found: ${trimmedId}`)
    }

    // Only the owning module's variables are visible to the handler.
    const enrichedPayload = {
        ...stripInternal(payload),
        __variables: variableStore.forModule(module.manifest.name),
    }

    console.log(`Dispatching action: ${trimmedId}`)
    await handler(enrichedPayload, module.ctx)
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/** Run follow-up steps in order, honouring per-step delays */
export async function runSequence(steps: unknown, buttonId?: string): Promise<void> {
    if (!Array.isArray(steps)) return
    const safeSteps = steps.slice(0, MAX_SEQUENCE_STEPS) as ButtonAction[]
    for (const step of safeSteps) {
        if (!step || typeof step.action !== "string" || !step.action.trim()) continue
        const delay = Math.min(Math.max(0, Number(step.delayMs) || 0), MAX_STEP_DELAY_MS)
        if (delay > 0) await sleep(delay)
        await dispatchAction(step.action, { buttonId, ...(step.payload || {}) })
    }
}
