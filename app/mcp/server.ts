/**
 * OpenDeck MCP server.
 *
 * Lets an AI assistant (Claude Code, Claude Desktop, or any MCP client) set up and
 * operate OpenDeck on this machine: inspect modules, configure their settings,
 * design pages and buttons, pull live option lists (OBS scenes, Wave Link channels),
 * run actions, install plugins and hand out the URL for phones and tablets.
 *
 * Transport: stdio. Talks to the running desktop app over its local HTTP API.
 *   OPENDECK_URL       base URL (default http://127.0.0.1:4020)
 *   OPENDECK_APP_PATH  executable to start when the app is not running (set by the in-app linker)
 *   OPENDECK_APP_ARGS  JSON array of arguments for that executable
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { spawn } from "child_process"
import path from "path"
import type { DeckPage, DeckButton, DeckVariable, ParamDefinition } from "../shared/types"

const BASE = (process.env.OPENDECK_URL || "http://127.0.0.1:4020").replace(/\/$/, "")
const VERSION = "2.0.0"

// ---------- HTTP helpers ----------

class OpenDeckOffline extends Error { }

async function api<T = unknown>(route: string, init?: RequestInit): Promise<T> {
    let res: Response
    try {
        res = await fetch(`${BASE}${route}`, {
            ...init,
            headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
        })
    } catch (err) {
        throw new OpenDeckOffline(
            `OpenDeck is not reachable at ${BASE}. The desktop app must be running: call launch_opendeck, or start it manually, then retry.`
        )
    }
    const text = await res.text()
    let body: unknown = text
    try { body = text ? JSON.parse(text) : null } catch { /* keep text */ }
    if (!res.ok) {
        const msg = body && typeof body === "object" && "error" in (body as object)
            ? String((body as { error: unknown }).error)
            : `HTTP ${res.status}`
        throw new Error(msg)
    }
    return body as T
}

interface StoredConfig { version: number; pages: DeckPage[]; variables: DeckVariable[]; displayImage: string }
interface ModuleInfo {
    name: string; version: string; description?: string; apiVersion: number; icon?: string
    actions: string[]
    actionDetails: Record<string, { description: string; params?: Record<string, ParamDefinition> }>
    config: Record<string, ParamDefinition>
    stateKeys: Record<string, string>
    providers: string[]
    status: { connected?: boolean; message?: string }
}

const getConfig = () => api<StoredConfig>("/api/config")
const getModules = () => api<ModuleInfo[]>("/api/modules")

async function putConfig(patch: Partial<Pick<StoredConfig, "pages" | "variables" | "displayImage">>) {
    await api("/api/config", { method: "PUT", body: JSON.stringify(patch) })
}

// ---------- formatting ----------

function text(data: unknown) {
    return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] }
}

function fail(message: string) {
    return { content: [{ type: "text" as const, text: message }], isError: true }
}

function describeParam(def: ParamDefinition) {
    if (typeof def === "string") return { type: "string", description: def }
    const { type, description, required, placeholder } = def
    const out: Record<string, unknown> = { type, description, required, placeholder }
    if (def.type === "select") {
        if (def.options) out.options = def.options.map(o => o.value)
        if (def.optionsFrom) out.optionsFrom = def.optionsFrom
        if (def.dependsOn) out.dependsOn = def.dependsOn
        out.allowCustom = def.allowCustom
    }
    if (def.type === "number") { out.min = def.min; out.max = def.max }
    if ("default" in def) out.default = def.default
    if ("secret" in def && def.secret) out.secret = true
    return out
}

function summarizeButton(b: DeckButton, slot: number) {
    const out: Record<string, unknown> = { slot, label: b.label, action: b.action }
    if (b.icon) out.icon = b.iconType === "image" || b.icon.startsWith("data:") ? `<image ${b.icon.length} chars>` : b.icon
    if (b.payload) out.payload = b.payload
    if (b.disabled) out.disabled = true
    if (b.pressMode) out.pressMode = b.pressMode
    if (b.releaseAction) out.releaseAction = b.releaseAction
    if (b.longPressAction) out.longPressAction = b.longPressAction
    if (b.sequence?.length) out.sequence = b.sequence
    if (b.face) out.face = b.face
    if (b.span) out.span = b.span
    if (b.widget) out.widget = b.widget
    return out
}

function summarizePages(pages: DeckPage[]) {
    return pages.map((p, i) => ({
        page: i + 1,
        name: p.name,
        columns: p.columns || 5,
        rows: p.rows || 3,
        buttons: p.grid
            .map((b, j) => ({ b, j }))
            .filter(({ b }) => b.action || b.label || b.icon || b.widget)
            .map(({ b, j }) => summarizeButton(b, j + 1)),
    }))
}

function maskSecrets(vars: DeckVariable[], modules: ModuleInfo[]) {
    return vars.map(v => {
        const schema = modules.find(m => m.name === v.module)?.config?.[v.key]
        const secret = schema && typeof schema !== "string" && schema.secret
        return { module: v.module || "(unassigned)", key: v.key, value: secret && v.value ? "<set>" : v.value }
    })
}

// ---------- page / slot resolution ----------

function findPage(pages: DeckPage[], ref: string | number): number {
    if (typeof ref === "number") {
        if (ref >= 1 && ref <= pages.length) return ref - 1
        throw new Error(`Page ${ref} does not exist (there are ${pages.length} pages)`)
    }
    const idx = pages.findIndex(p => p.name.toLowerCase() === ref.toLowerCase())
    if (idx === -1) {
        const n = Number(ref)
        if (Number.isInteger(n)) return findPage(pages, n)
        throw new Error(`No page named "${ref}". Pages: ${pages.map(p => p.name).join(", ")}`)
    }
    return idx
}

let idCounter = Date.now() % 1_000_000
const newId = () => `mcp${idCounter++}`
const emptyButton = (id: string): DeckButton => ({ id, label: "", icon: "", action: "" })

function ensureSlots(page: DeckPage): DeckPage {
    const total = (page.columns || 5) * (page.rows || 3)
    const grid = page.grid.slice()
    while (grid.length < total) grid.push(emptyButton(newId()))
    return { ...page, grid }
}

function slotIndex(page: DeckPage, slot: number): number {
    const total = (page.columns || 5) * (page.rows || 3)
    if (!Number.isInteger(slot) || slot < 1 || slot > total) {
        throw new Error(`Slot must be between 1 and ${total} on page "${page.name}" (${page.columns || 5}x${page.rows || 3})`)
    }
    return slot - 1
}

// ---------- launching the app ----------

async function isRunning(): Promise<boolean> {
    try { await api("/api/state"); return true } catch { return false }
}

async function launchApp(): Promise<string> {
    if (await isRunning()) return "OpenDeck is already running."
    const exe = process.env.OPENDECK_APP_PATH
    if (!exe) {
        return "I do not know where OpenDeck is installed (OPENDECK_APP_PATH is not set). Start the OpenDeck desktop app manually, then retry."
    }
    let args: string[] = []
    try { args = JSON.parse(process.env.OPENDECK_APP_ARGS || "[]") } catch { args = [] }
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(exe, args, { detached: true, stdio: "ignore", env, cwd: args[0] && path.isAbsolute(args[0]) ? args[0] : undefined })
    child.unref()
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500))
        if (await isRunning()) return `OpenDeck started (${exe}).`
    }
    return `Started ${exe} but it has not answered on ${BASE} yet. Wait a few seconds and call opendeck_status.`
}

// ---------- server ----------

const INSTRUCTIONS = `You control OpenDeck, an open-source Stream Deck alternative running on this computer.
Typical setup flow:
1. opendeck_status (launch_opendeck if it is not running).
2. list_modules to see integrations (OBS, Wave Link, media keys, macros, HTTP, app launcher) and their settings/status.
3. set_module_settings for anything that needs credentials (e.g. obs-control password), then re-check status.
4. list_actions and get_options to discover actions and live choices (OBS scenes, Wave Link channels).
5. add_page / set_button to build the deck. Slots are 1-based, left-to-right, top-to-bottom. Give buttons a label, an emoji icon, an action and its payload. Use face.states for live feedback (e.g. red "LIVE" while obs-control.streaming is true).
6. Tiles can span cells (span {w,h}) and become widgets: a 3x1 slider bound to a state key plus a set action (e.g. wavelink.setChannelLevel with valueParam "level"), a 2x2 panel with a live image and text lines (e.g. album art from an HTTP source via {{value}}), or an info tile (time via {{clock.time}}, stream timer via {{obs-control.streamTime}}, viewers from a polled URL).
7. get_connect_info to tell the user which URL (or QR) to open on a phone or tablet.
Changes apply immediately and are saved by the app.`

const server = new McpServer(
    { name: "opendeck", version: VERSION },
    { instructions: INSTRUCTIONS }
)

const pageRef = z.union([z.string(), z.number()]).describe("Page name or 1-based page number")

const actionStep = z.object({
    action: z.string().describe("Action id, e.g. obs.switchScene"),
    payload: z.record(z.string(), z.unknown()).optional(),
    delayMs: z.number().int().min(0).optional().describe("Wait before this step (sequences only)"),
})

const faceSchema = z.object({
    color: z.string().optional().describe("Background CSS colour"),
    textColor: z.string().optional(),
    labelPosition: z.enum(["bottom", "top", "center", "hidden"]).optional(),
    fontSize: z.enum(["sm", "md", "lg"]).optional(),
    imageTemplate: z.string().optional().describe("Image URL or template, e.g. {{value}} or {{wavelink.channel.Music.image}}"),
    labelTemplate: z.string().optional().describe("Label template, e.g. Scene: {{obs-control.currentScene}}"),
    source: z.object({
        type: z.literal("http"),
        url: z.string(),
        path: z.string().optional().describe("Dotted JSON path, e.g. item.album.images.0.url"),
        intervalMs: z.number().int().min(2000).optional(),
        headers: z.string().optional().describe("JSON object string of request headers"),
    }).optional(),
    states: z.array(z.object({
        when: z.object({
            key: z.string().describe("State key, e.g. obs-control.streaming"),
            equals: z.string().optional(),
            truthy: z.boolean().optional(),
        }),
        icon: z.string().optional(),
        label: z.string().optional(),
        color: z.string().optional(),
        textColor: z.string().optional(),
    })).optional(),
})

const sliderWidget = z.object({
    type: z.literal("slider"),
    stateKey: z.string().optional().describe("State key holding the current value, e.g. wavelink.channel.Music.level"),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    valueParam: z.string().optional().describe("Action parameter that receives the dragged value, e.g. level"),
    orientation: z.enum(["auto", "horizontal", "vertical"]).optional(),
    unit: z.string().optional(),
    showValue: z.boolean().optional(),
})
const panelWidget = z.object({
    type: z.literal("panel"),
    lines: z.array(z.string()).optional().describe("Text lines (templates); first is shown larger"),
    imagePosition: z.enum(["left", "top", "fill", "none"]).optional(),
})
const infoWidget = z.object({
    type: z.literal("info"),
    title: z.string().optional(),
    value: z.string().optional().describe("Template, e.g. {{clock.time}} or {{obs-control.streamTime}}"),
    sub: z.string().optional(),
})

const buttonSchema = z.object({
    span: z.object({ w: z.number().int().min(1).max(6), h: z.number().int().min(1).max(6) }).optional().describe("Cells occupied (covers later slots to the right/below)"),
    widget: z.union([sliderWidget, panelWidget, infoWidget]).optional().describe("Make the tile a slider, a panel (image + lines) or an info tile instead of a plain button"),
    label: z.string().optional(),
    icon: z.string().optional().describe("Emoji, or an image URL / data URI when iconType is image"),
    iconType: z.enum(["emoji", "image"]).optional(),
    fillImage: z.boolean().optional(),
    hideLabel: z.boolean().optional(),
    disabled: z.boolean().optional(),
    action: z.string().optional().describe("Action id from list_actions"),
    payload: z.record(z.string(), z.unknown()).optional().describe("Action parameters"),
    pressMode: z.enum(["tap", "hold", "long"]).optional(),
    releaseAction: actionStep.optional().describe("Hold mode: runs on release"),
    longPressAction: actionStep.optional().describe("Long mode: runs after a long press"),
    sequence: z.array(actionStep).optional().describe("Extra steps run after the main action"),
    face: faceSchema.optional(),
})

// --- status & discovery ---

server.registerTool("opendeck_status", {
    title: "OpenDeck status",
    description: "Check whether the OpenDeck desktop app is running, which modules are loaded and connected, and how devices can connect.",
    inputSchema: {},
}, async () => {
    if (!(await isRunning())) {
        return text({ running: false, hint: "Call launch_opendeck or start the OpenDeck app, then retry." })
    }
    const [modules, config, network] = await Promise.all([
        getModules(), getConfig(), api<{ addresses: string[]; port: number }>("/api/network"),
    ])
    return text({
        running: true,
        url: BASE,
        connectUrls: network.addresses.map(a => `http://${a}:${network.port}`),
        pages: config.pages.map(p => p.name),
        modules: modules.map(m => ({
            name: m.name, version: m.version, apiVersion: m.apiVersion,
            connected: m.status?.connected, status: m.status?.message,
            needsSettings: Object.keys(m.config || {}),
        })),
    })
})

server.registerTool("launch_opendeck", {
    title: "Launch OpenDeck",
    description: "Start the OpenDeck desktop app if it is not running.",
    inputSchema: {},
}, async () => text(await launchApp()))

server.registerTool("get_connect_info", {
    title: "Device connect info",
    description: "URLs a phone, tablet or browser on the same network should open to use the deck (add to home screen for a full-screen app).",
    inputSchema: {},
}, async () => {
    const network = await api<{ addresses: string[]; port: number }>("/api/network")
    return text({
        urls: network.addresses.map(a => `http://${a}:${network.port}`),
        tip: "Open the first URL on the device. On iOS/Android use Share > Add to Home Screen to get a fullscreen, always-awake app.",
    })
})

server.registerTool("list_modules", {
    title: "List modules",
    description: "Loaded integration modules with their settings schema, connection status, published live-state keys and option providers.",
    inputSchema: {},
}, async () => {
    const [modules, config] = await Promise.all([getModules(), getConfig()])
    return text(modules.map(m => ({
        name: m.name,
        version: m.version,
        description: m.description,
        apiVersion: m.apiVersion,
        status: m.status,
        settings: Object.fromEntries(Object.entries(m.config || {}).map(([k, d]) => [k, describeParam(d)])),
        currentSettings: Object.fromEntries(
            config.variables.filter(v => v.module === m.name).map(v => {
                const schema = m.config?.[v.key]
                const secret = schema && typeof schema !== "string" && schema.secret
                return [v.key, secret && v.value ? "<set>" : v.value]
            })
        ),
        stateKeys: Object.keys(m.stateKeys || {}).length ? m.stateKeys : undefined,
        providers: m.providers,
        actionCount: m.actions.length,
    })))
})

server.registerTool("list_actions", {
    title: "List actions",
    description: "Actions available for buttons, with their parameter schemas. Filter by module name or search text.",
    inputSchema: {
        module: z.string().optional().describe("Only this module"),
        search: z.string().optional().describe("Case-insensitive match on id or description"),
    },
}, async ({ module, search }) => {
    const modules = await getModules()
    const q = search?.toLowerCase()
    const out: unknown[] = []
    for (const m of modules) {
        if (module && m.name !== module) continue
        for (const id of m.actions) {
            const d = m.actionDetails?.[id]
            if (q && !id.toLowerCase().includes(q) && !(d?.description || "").toLowerCase().includes(q)) continue
            out.push({
                action: id,
                module: m.name,
                description: d?.description,
                params: d?.params ? Object.fromEntries(Object.entries(d.params).map(([k, v]) => [k, describeParam(v)])) : undefined,
            })
        }
    }
    return text(out)
})

server.registerTool("get_options", {
    title: "Live options",
    description: "Ask a module for live choices (e.g. obs-control/scenes, obs-control/sceneItems with arg=<scene>, wavelink/channels). Provider names come from list_modules.",
    inputSchema: {
        module: z.string(),
        provider: z.string(),
        arg: z.string().optional().describe("Dependency value, e.g. the scene name for sceneItems"),
    },
}, async ({ module, provider, arg }) => {
    try {
        const res = await api<{ options: { value: string; label?: string }[] }>(
            `/api/modules/${encodeURIComponent(module)}/options/${encodeURIComponent(provider)}${arg ? `?arg=${encodeURIComponent(arg)}` : ""}`
        )
        return text(res.options)
    } catch (err) {
        return fail(`Could not load options: ${(err as Error).message}`)
    }
})

server.registerTool("get_state", {
    title: "Live state",
    description: "Current live state published by modules (e.g. obs-control.streaming, wavelink.input.<name>.muted). Optional key prefix filter.",
    inputSchema: { prefix: z.string().optional() },
}, async ({ prefix }) => {
    const state = await api<Record<string, unknown>>("/api/state")
    const entries = Object.entries(state).filter(([k]) => !prefix || k.startsWith(prefix))
    return text(Object.fromEntries(entries.map(([k, v]) => [k, typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}…` : v])))
})

// --- config ---

server.registerTool("get_config", {
    title: "Get deck config",
    description: "Pages, buttons and module settings currently configured (secrets masked, images summarised).",
    inputSchema: {},
}, async () => {
    const [config, modules] = await Promise.all([getConfig(), getModules()])
    return text({
        pages: summarizePages(config.pages),
        variables: maskSecrets(config.variables, modules),
        displayImage: config.displayImage ? `<image ${config.displayImage.length} chars>` : null,
    })
})

server.registerTool("set_module_settings", {
    title: "Set module settings",
    description: "Set one or more settings/variables for a module (e.g. obs-control: { password: '...' }). Modules reconnect automatically.",
    inputSchema: {
        module: z.string(),
        settings: z.record(z.string(), z.string()).describe("Key/value pairs; values are strings"),
    },
}, async ({ module, settings }) => {
    const [config, modules] = await Promise.all([getConfig(), getModules()])
    if (!modules.some(m => m.name === module)) return fail(`Unknown module "${module}". Loaded: ${modules.map(m => m.name).join(", ")}`)
    const variables = config.variables.slice()
    for (const [key, value] of Object.entries(settings)) {
        const idx = variables.findIndex(v => v.module === module && v.key === key)
        if (idx === -1) variables.push({ module, key, value })
        else variables[idx] = { ...variables[idx], value }
    }
    await putConfig({ variables })
    return text(`Updated ${Object.keys(settings).join(", ")} for ${module}. Call opendeck_status in a few seconds to confirm the connection.`)
})

server.registerTool("add_page", {
    title: "Add page",
    description: "Create a new page of buttons.",
    inputSchema: {
        name: z.string(),
        columns: z.number().int().min(3).max(8).optional(),
        rows: z.number().int().min(2).max(6).optional(),
    },
}, async ({ name, columns = 5, rows = 3 }) => {
    const config = await getConfig()
    if (config.pages.some(p => p.name.toLowerCase() === name.toLowerCase())) return fail(`A page named "${name}" already exists`)
    const page: DeckPage = { name, columns, rows, grid: Array.from({ length: columns * rows }, () => emptyButton(newId())) }
    await putConfig({ pages: [...config.pages, page] })
    return text(`Added page "${name}" (${columns}x${rows}) as page ${config.pages.length + 1}.`)
})

server.registerTool("update_page", {
    title: "Update page",
    description: "Rename a page and/or change its grid size.",
    inputSchema: {
        page: pageRef,
        name: z.string().optional(),
        columns: z.number().int().min(3).max(8).optional(),
        rows: z.number().int().min(2).max(6).optional(),
    },
}, async ({ page, name, columns, rows }) => {
    const config = await getConfig()
    const idx = findPage(config.pages, page)
    const pages = config.pages.slice()
    pages[idx] = ensureSlots({ ...pages[idx], name: name ?? pages[idx].name, columns: columns ?? pages[idx].columns ?? 5, rows: rows ?? pages[idx].rows ?? 3 })
    await putConfig({ pages })
    return text(`Updated page ${idx + 1}: "${pages[idx].name}" ${pages[idx].columns}x${pages[idx].rows}.`)
})

server.registerTool("remove_page", {
    title: "Remove page",
    description: "Delete a page and all of its buttons.",
    inputSchema: { page: pageRef },
}, async ({ page }) => {
    const config = await getConfig()
    if (config.pages.length <= 1) return fail("Cannot remove the last page")
    const idx = findPage(config.pages, page)
    const name = config.pages[idx].name
    await putConfig({ pages: config.pages.filter((_, i) => i !== idx) })
    return text(`Removed page "${name}".`)
})

server.registerTool("set_button", {
    title: "Set button",
    description: "Create or update the button in a slot. Fields merge into the existing button unless replace is true. Slots are 1-based, left-to-right then top-to-bottom.",
    inputSchema: {
        page: pageRef,
        slot: z.number().int().min(1),
        button: buttonSchema,
        replace: z.boolean().optional().describe("Replace the whole button instead of merging"),
    },
}, async ({ page, slot, button, replace }) => {
    const [config, modules] = await Promise.all([getConfig(), getModules()])
    const idx = findPage(config.pages, page)
    const pages = config.pages.slice()
    const target = ensureSlots(pages[idx])
    const s = slotIndex(target, slot)
    if (button.action && !modules.some(m => m.actions.includes(button.action!))) {
        return fail(`Unknown action "${button.action}". Use list_actions to find valid ids.`)
    }
    const existing = target.grid[s]
    const next: DeckButton = replace
        ? { ...emptyButton(existing.id), ...button, label: button.label ?? "", action: button.action ?? "" }
        : { ...existing, ...button }
    if (next.icon && !next.iconType && (next.icon.startsWith("http") || next.icon.startsWith("data:"))) next.iconType = "image"
    target.grid[s] = next
    pages[idx] = target
    await putConfig({ pages })
    return text({ page: target.name, ...summarizeButton(next, slot) })
})

server.registerTool("clear_button", {
    title: "Clear button",
    description: "Empty a slot.",
    inputSchema: { page: pageRef, slot: z.number().int().min(1) },
}, async ({ page, slot }) => {
    const config = await getConfig()
    const idx = findPage(config.pages, page)
    const pages = config.pages.slice()
    const target = ensureSlots(pages[idx])
    const s = slotIndex(target, slot)
    target.grid[s] = emptyButton(target.grid[s].id)
    pages[idx] = target
    await putConfig({ pages })
    return text(`Cleared slot ${slot} on "${target.name}".`)
})

server.registerTool("swap_buttons", {
    title: "Swap buttons",
    description: "Swap the contents of two slots on a page.",
    inputSchema: { page: pageRef, from: z.number().int().min(1), to: z.number().int().min(1) },
}, async ({ page, from, to }) => {
    const config = await getConfig()
    const idx = findPage(config.pages, page)
    const pages = config.pages.slice()
    const target = ensureSlots(pages[idx])
    const a = slotIndex(target, from)
    const b = slotIndex(target, to)
    const ba = target.grid[a], bb = target.grid[b]
    target.grid[a] = { ...bb, id: ba.id }
    target.grid[b] = { ...ba, id: bb.id }
    pages[idx] = target
    await putConfig({ pages })
    return text(`Swapped slots ${from} and ${to} on "${target.name}".`)
})

// --- running things ---

server.registerTool("run_action", {
    title: "Run action",
    description: "Execute an action right now (useful to test a configuration, e.g. obs.switchScene with { scene: 'Main' }).",
    inputSchema: {
        action: z.string(),
        payload: z.record(z.string(), z.unknown()).optional(),
    },
}, async ({ action, payload }) => {
    try {
        await api(`/api/actions/${encodeURIComponent(action)}`, { method: "POST", body: JSON.stringify(payload || {}) })
        return text(`Ran ${action} successfully.`)
    } catch (err) {
        return fail(`${action} failed: ${(err as Error).message}`)
    }
})

server.registerTool("press_button", {
    title: "Press button",
    description: "Trigger a configured button as if it were pressed on the deck.",
    inputSchema: { page: pageRef, slot: z.number().int().min(1) },
}, async ({ page, slot }) => {
    const config = await getConfig()
    const idx = findPage(config.pages, page)
    const target = ensureSlots(config.pages[idx])
    const b = target.grid[slotIndex(target, slot)]
    if (!b.action) return fail(`Slot ${slot} on "${target.name}" has no action`)
    try {
        await api(`/api/actions/${encodeURIComponent(b.action)}`, {
            method: "POST",
            body: JSON.stringify({ buttonId: b.id, ...(b.payload || {}), ...(b.sequence?.length ? { __sequence: b.sequence } : {}) }),
        })
        return text(`Pressed "${b.label || b.action}".`)
    } catch (err) {
        return fail(`"${b.label || b.action}" failed: ${(err as Error).message}`)
    }
})

// --- plugins ---

server.registerTool("list_marketplace", {
    title: "List plugins",
    description: "Community plugins available to install, and which are already installed.",
    inputSchema: {},
}, async () => {
    const [registry, installed] = await Promise.all([
        api<{ plugins: { id: string; name: string; description: string; version: string; tags?: string[]; bundled?: boolean }[] }>("/api/marketplace"),
        api<{ installed: string[] }>("/api/marketplace/installed"),
    ])
    return text(registry.plugins.map(p => ({
        id: p.id, name: p.name, version: p.version, description: p.description, tags: p.tags,
        installed: installed.installed.includes(p.id) || !!p.bundled,
    })))
})

server.registerTool("install_plugin", {
    title: "Install plugin",
    description: "Install a community plugin by id (from list_marketplace). Requires git on this machine.",
    inputSchema: { pluginId: z.string() },
}, async ({ pluginId }) => {
    const registry = await api<{ plugins: { id: string; cloneUrl: string; subdirectory?: string }[] }>("/api/marketplace")
    const plugin = registry.plugins.find(p => p.id === pluginId)
    if (!plugin) return fail(`No plugin with id "${pluginId}"`)
    try {
        await api("/api/marketplace/install", {
            method: "POST",
            body: JSON.stringify({ cloneUrl: plugin.cloneUrl, pluginId: plugin.id, subdirectory: plugin.subdirectory }),
        })
        return text(`Installed ${pluginId}. Its actions are available now; run list_modules to see its settings.`)
    } catch (err) {
        return fail(`Install failed: ${(err as Error).message}`)
    }
})

// --- resources & prompts ---

server.registerResource("config", "opendeck://config", {
    title: "OpenDeck configuration",
    description: "Pages, buttons and module settings (secrets masked)",
    mimeType: "application/json",
}, async (uri) => {
    const [config, modules] = await Promise.all([getConfig(), getModules()])
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ pages: summarizePages(config.pages), variables: maskSecrets(config.variables, modules) }, null, 2) }] }
})

server.registerResource("modules", "opendeck://modules", {
    title: "OpenDeck modules",
    description: "Loaded modules, actions and parameter schemas",
    mimeType: "application/json",
}, async (uri) => {
    const modules = await getModules()
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(modules, null, 2) }] }
})

server.registerResource("state", "opendeck://state", {
    title: "OpenDeck live state",
    description: "Current values published by modules",
    mimeType: "application/json",
}, async (uri) => {
    const state = await api<Record<string, unknown>>("/api/state")
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(state, null, 2) }] }
})

server.registerPrompt("setup_deck", {
    title: "Set up my deck",
    description: "Guide the assistant through configuring OpenDeck from scratch for a streaming or productivity setup.",
    argsSchema: { goal: z.string().optional().describe("What the user wants, e.g. 'OBS streaming with mic mute and scene switching'") },
}, ({ goal }) => ({
    messages: [{
        role: "user",
        content: {
            type: "text",
            text: `Set up OpenDeck for me${goal ? `: ${goal}` : ""}.
Start with opendeck_status (launch it if needed). Check which modules are connected; ask me for any credentials you need (for example the OBS WebSocket password) and store them with set_module_settings. Use get_options to pick real scene/channel names rather than guessing. Build sensible pages with labelled emoji buttons, add live faces for stream/record/mute state, then finish with get_connect_info so I can open it on my phone or tablet.`,
        },
    }],
}))

async function main() {
    const transport = new StdioServerTransport()
    await server.connect(transport)
}

main().catch(err => {
    console.error("OpenDeck MCP server failed:", err)
    process.exit(1)
})
