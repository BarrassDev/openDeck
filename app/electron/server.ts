import express from "express"
import http from "http"
import https from "https"
import os from "os"
import path from "path"
import fs from "fs"
import { execFile } from "child_process"
import { WebSocketServer, WebSocket } from "ws"
import type { ClientMessage, DeckPage, DeckVariable } from "../shared/types"
import { parseMessage, createServerMessage } from "../shared/action-protocol"
import { dispatchAction, runSequence } from "./action-dispatcher"
import { variableStore } from "./variable-store"
import { configStore } from "./config-store"
import { moduleRegistry, loadModules, getModulesDir } from "./module-loader"
import { stateStore } from "./state-store"
import { facePoller } from "./face-poller"

const REGISTRY_URL = "https://raw.githubusercontent.com/BarrassDev/opendeck-plugins/main/registry.json"

function fetchJSON(url: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { "User-Agent": "OpenDeck-App" } }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`))
                res.resume()
                return
            }
            let data = ""
            res.on("data", (chunk: string) => { data += chunk })
            res.on("end", () => {
                try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
            })
        }).on("error", reject)
    })
}

function getInstalledPluginIds(): string[] {
    const modulesDir = getModulesDir()
    if (!fs.existsSync(modulesDir)) return []
    return fs.readdirSync(modulesDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith("__"))
        .map(e => e.name)
}

function isLoopback(address?: string): boolean {
    if (!address) return false
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"
}

function serializeModule(m: ReturnType<typeof moduleRegistry.getAll>[number]) {
    return {
        name: m.manifest.name,
        version: m.manifest.version,
        description: m.manifest.description,
        apiVersion: m.manifest.apiVersion ?? 1,
        icon: m.manifest.icon,
        actions: m.manifest.actions,
        actionDetails: m.manifest.actionDetails || {},
        config: m.manifest.config || {},
        stateKeys: m.manifest.stateKeys || {},
        providers: Object.keys(m.providers),
        status: m.status,
    }
}

let wss: WebSocketServer | null = null

function broadcast(message: string, except?: WebSocket) {
    if (!wss) return
    for (const client of wss.clients) {
        if (client !== except && client.readyState === WebSocket.OPEN) {
            client.send(message)
        }
    }
}

/** Serialize each module's variables so we can tell which modules actually changed */
function variablesByModule(vars: DeckVariable[]): Map<string, string> {
    const grouped = new Map<string, string[]>()
    for (const v of vars) {
        const mod = v.module || ""
        if (!grouped.has(mod)) grouped.set(mod, [])
        grouped.get(mod)!.push(`${v.key}=${v.value}`)
    }
    const out = new Map<string, string>()
    for (const [mod, entries] of grouped) out.set(mod, entries.sort().join("\n"))
    return out
}

function changedModules(prev: DeckVariable[], next: DeckVariable[]): string[] {
    const a = variablesByModule(prev)
    const b = variablesByModule(next)
    const changed = new Set<string>()
    for (const mod of new Set([...a.keys(), ...b.keys()])) {
        if (a.get(mod) !== b.get(mod)) changed.add(mod)
    }
    changed.delete("")
    return Array.from(changed)
}

function applyConfig(p: Record<string, unknown>) {
    const pages = Array.isArray(p.pages) ? (p.pages as DeckPage[]) : undefined
    const variables = Array.isArray(p.variables) ? (p.variables as DeckVariable[]) : undefined
    const displayImage = typeof p.displayImage === "string" ? p.displayImage : undefined

    configStore.save({ pages, variables, displayImage })

    if (variables) {
        const changed = changedModules(variableStore.getAll(), variables)
        variableStore.setAll(variables)
        // The editor sends the whole config on every edit; only modules whose
        // settings really changed get told (otherwise OBS/Wave Link would reconnect per keystroke)
        if (changed.length > 0) void moduleRegistry.notifySettingsChanged(changed)
    }
    if (pages) {
        facePoller.configure(pages)
    }
}

export function startServer(port: number) {
    // Load persisted config
    const saved = configStore.load()
    variableStore.setAll(saved.variables)
    facePoller.configure(saved.pages)

    const expressApp = express()
    const server = http.createServer(expressApp)

    // Allow cross-origin API requests (Vite dev server runs on a different port)
    expressApp.use("/api", (_req, res, next) => {
        res.header("Access-Control-Allow-Origin", "*")
        res.header("Access-Control-Allow-Headers", "Content-Type")
        next()
    })
    // Configs can carry base64 display images, so allow large bodies
    expressApp.use(express.json({ limit: "64mb" }))

    // API: full config (read anywhere; write only from this machine, e.g. the MCP server)
    expressApp.get("/api/config", (_req, res) => {
        res.json(configStore.get())
    })
    expressApp.put("/api/config", (req, res) => {
        if (!isLoopback(req.socket.remoteAddress)) {
            res.status(403).json({ error: "Config can only be changed from this computer" })
            return
        }
        const p = req.body as Record<string, unknown>
        if (!p || typeof p !== "object") {
            res.status(400).json({ error: "Body must be a JSON object" })
            return
        }
        if (p.pages !== undefined && (!Array.isArray(p.pages) || !p.pages.every(pg => pg && typeof pg === "object" && typeof (pg as DeckPage).name === "string" && Array.isArray((pg as DeckPage).grid)))) {
            res.status(400).json({ error: "pages must be an array of { name, grid[] }" })
            return
        }
        if (p.variables !== undefined && (!Array.isArray(p.variables) || !p.variables.every(v => v && typeof v === "object" && typeof (v as DeckVariable).key === "string"))) {
            res.status(400).json({ error: "variables must be an array of { module, key, value }" })
            return
        }
        applyConfig(p)
        const current = configStore.get()
        broadcast(createServerMessage("config.sync", {
            pages: current.pages as unknown as Record<string, unknown>[],
            variables: current.variables as unknown as Record<string, unknown>[],
            displayImage: current.displayImage,
        } as unknown as Record<string, unknown>))
        res.json({ ok: true })
    })

    // API: run an action (local tools only; devices use the WebSocket)
    expressApp.post("/api/actions/:actionId", async (req, res) => {
        if (!isLoopback(req.socket.remoteAddress)) {
            res.status(403).json({ error: "Actions over HTTP are only accepted from this computer" })
            return
        }
        const payload = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>
        try {
            await dispatchAction(req.params.actionId, payload)
            if (Array.isArray(payload.__sequence)) {
                await runSequence(payload.__sequence, typeof payload.buttonId === "string" ? payload.buttonId : undefined)
            }
            res.json({ ok: true })
        } catch (err) {
            res.status(400).json({ ok: false, error: err instanceof Error ? err.message : "Unknown error" })
        }
    })

    // API: list loaded modules, their actions, settings schema and status
    expressApp.get("/api/modules", (_req, res) => {
        res.json(moduleRegistry.getAll().map(serializeModule))
    })

    // API: live option lists (OBS scenes, Wave Link channels, ...) for the editor
    expressApp.get("/api/modules/:name/options/:provider", async (req, res) => {
        const { name, provider } = req.params
        const arg = typeof req.query.arg === "string" ? req.query.arg : undefined
        try {
            const options = await moduleRegistry.getProviderOptions(name, provider, arg)
            res.json({ options })
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error"
            res.status(502).json({ error: msg, options: [] })
        }
    })

    // API: current state snapshot
    expressApp.get("/api/state", (_req, res) => {
        res.json(stateStore.snapshot())
    })

    // API: proxy the community plugin registry (avoids CORS from renderer)
    expressApp.get("/api/marketplace", async (_req, res) => {
        try {
            const data = await fetchJSON(REGISTRY_URL)
            res.json(data)
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error"
            res.status(502).json({ error: `Failed to fetch registry: ${msg}` })
        }
    })

    // API: report which plugin IDs are already installed
    expressApp.get("/api/marketplace/installed", (_req, res) => {
        res.json({ installed: getInstalledPluginIds() })
    })

    // API: install a plugin via git clone (desktop only)
    expressApp.post("/api/marketplace/install", (req, res) => {
        if (!isLoopback(req.socket.remoteAddress)) {
            res.status(403).json({ error: "Plugins can only be installed from the desktop app" })
            return
        }

        const { cloneUrl, pluginId, subdirectory } = req.body as {
            cloneUrl?: string
            pluginId?: string
            subdirectory?: string
        }

        if (!cloneUrl || !pluginId) {
            res.status(400).json({ error: "cloneUrl and pluginId are required" })
            return
        }

        // Prevent path traversal — pluginId must be a simple directory name
        if (!/^[a-zA-Z0-9_-]+$/.test(pluginId)) {
            res.status(400).json({ error: "Invalid pluginId" })
            return
        }
        if (!/^https:\/\/[^\s]+$/.test(cloneUrl)) {
            res.status(400).json({ error: "cloneUrl must be an https URL" })
            return
        }

        const modulesDir = getModulesDir()
        const destDir = path.join(modulesDir, pluginId)

        if (fs.existsSync(destDir)) {
            res.status(409).json({ error: "Plugin already installed" })
            return
        }

        if (!fs.existsSync(modulesDir)) {
            fs.mkdirSync(modulesDir, { recursive: true })
        }

        const finish = () => {
            loadModules().then(() => {
                res.json({ success: true, pluginId })
            })
        }

        if (subdirectory) {
            // Clone into a temp dir then copy the subdirectory out
            const tmpDir = path.join(modulesDir, `__tmp_${pluginId}_${Date.now()}`)
            execFile("git", ["clone", "--depth=1", cloneUrl, tmpDir], (cloneErr) => {
                if (cloneErr) {
                    res.status(500).json({ error: `git clone failed: ${cloneErr.message}` })
                    return
                }
                const srcSubdir = path.resolve(tmpDir, subdirectory)
                if (!srcSubdir.startsWith(tmpDir) || !fs.existsSync(srcSubdir)) {
                    fs.rmSync(tmpDir, { recursive: true, force: true })
                    res.status(500).json({ error: `Subdirectory '${subdirectory}' not found in repo` })
                    return
                }
                try {
                    fs.cpSync(srcSubdir, destDir, { recursive: true })
                } catch (copyErr) {
                    fs.rmSync(tmpDir, { recursive: true, force: true })
                    res.status(500).json({ error: `Failed to copy plugin: ${(copyErr as Error).message}` })
                    return
                }
                fs.rmSync(tmpDir, { recursive: true, force: true })
                finish()
            })
        } else {
            execFile("git", ["clone", "--depth=1", cloneUrl, destDir], (cloneErr) => {
                if (cloneErr) {
                    res.status(500).json({ error: `git clone failed: ${cloneErr.message}` })
                    return
                }
                finish()
            })
        }
    })

    // API: get local network addresses for remote connection
    expressApp.get("/api/network", (_req, res) => {
        const interfaces = os.networkInterfaces()
        const addresses: string[] = []
        for (const [, iface] of Object.entries(interfaces)) {
            if (!iface) continue
            for (const info of iface) {
                if (info.family === "IPv4" && !info.internal) {
                    addresses.push(info.address)
                }
            }
        }
        // Sort: prioritize common LAN ranges (192.168.x, 10.x) over virtual adapters (172.x, 169.254.x)
        addresses.sort((a, b) => {
            const score = (ip: string) => {
                if (ip.startsWith("192.168.")) return 0
                if (ip.startsWith("10.")) return 1
                return 2
            }
            return score(a) - score(b)
        })
        res.json({ addresses, port })
    })

    // Serve the built React UI for remote devices
    const staticPath = path.join(__dirname, "../../renderer")
    expressApp.use(express.static(staticPath))

    // Fallback to index.html for SPA routing
    expressApp.get("*", (_req, res) => {
        res.sendFile(path.join(staticPath, "index.html"))
    })

    // WebSocket server
    wss = new WebSocketServer({ server })

    // Push live state and module status to every client
    const unsubscribeState = stateStore.subscribe(changes => {
        broadcast(createServerMessage("state.update", { changes }))
    })
    const unsubscribeStatus = moduleRegistry.onStatus((moduleName, status) => {
        broadcast(createServerMessage("module.status", { module: moduleName, status }))
    })

    // Keep-alive pings stop mobile devices from dropping idle sockets
    const keepAliveInterval = setInterval(() => {
        if (!wss) return
        for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) client.ping()
        }
    }, 30000)

    wss.on("connection", (ws, req) => {
        const remote = req.socket.remoteAddress
        const local = isLoopback(remote)
        console.log(`Device connected (${local ? "local" : remote})`)

        // Send current config, live state and module status to the new client
        const currentConfig = configStore.get()
        ws.send(createServerMessage("config.sync", {
            pages: currentConfig.pages as unknown as Record<string, unknown>[],
            variables: currentConfig.variables as unknown as Record<string, unknown>[],
            displayImage: currentConfig.displayImage,
        } as unknown as Record<string, unknown>))
        ws.send(createServerMessage("state.snapshot", { state: stateStore.snapshot() }))
        for (const m of moduleRegistry.getAll()) {
            ws.send(createServerMessage("module.status", { module: m.manifest.name, status: m.status }))
        }

        ws.on("message", async (raw) => {
            const message = parseMessage<ClientMessage>(raw.toString())
            if (!message) return

            switch (message.type) {
                case "button.press": {
                    if (!message.action) break
                    const payload = message.payload || {}
                    const buttonId = typeof payload.buttonId === "string" ? payload.buttonId : undefined
                    try {
                        await dispatchAction(message.action, payload)
                        if (Array.isArray(payload.__sequence)) {
                            await runSequence(payload.__sequence, buttonId)
                        }
                        ws.send(createServerMessage("button.feedback", {
                            buttonId,
                            action: message.action,
                            status: "success",
                        }))
                    } catch (err) {
                        const errorMessage = err instanceof Error ? err.message : "Unknown error"
                        console.warn(`Action failed (${message.action}): ${errorMessage}`)
                        ws.send(createServerMessage("button.feedback", {
                            buttonId,
                            action: message.action,
                            status: "error",
                            message: errorMessage,
                        }))
                    }
                    break
                }

                case "page.change":
                    ws.send(createServerMessage("page.update", message.payload))
                    break

                case "device.connect":
                    console.log("Device registered:", message.payload)
                    break

                case "config.update": {
                    if (!local) {
                        console.warn(`Ignored config.update from remote device ${remote}`)
                        break
                    }
                    const p = message.payload || {}
                    applyConfig(p)
                    // Broadcast to all other clients
                    broadcast(createServerMessage("config.sync", p), ws)
                    console.log("Config updated and broadcast to clients")
                    break
                }
            }
        })

        ws.on("close", () => {
            console.log("Device disconnected")
        })
    })

    server.listen(port, () => {
        console.log(`OpenDeck server listening on port ${port}`)
    })

    server.on("close", () => {
        clearInterval(keepAliveInterval)
        unsubscribeState()
        unsubscribeStatus()
        facePoller.stop()
    })

    return server
}
