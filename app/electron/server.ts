import express from "express"
import http from "http"
import https from "https"
import os from "os"
import path from "path"
import fs from "fs"
import { execFile } from "child_process"
import { app as electronApp } from "electron"
import { WebSocketServer, WebSocket } from "ws"
import { ClientMessage } from "../shared/types"
import { parseMessage, createServerMessage } from "../shared/action-protocol"
import { dispatchAction } from "./action-dispatcher"
import { variableStore } from "./variable-store"
import { configStore } from "./config-store"
import { moduleRegistry, loadModules } from "./module-loader"

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

function getModulesDir(): string {
    const isDev = !electronApp.isPackaged
    return isDev
        ? path.join(process.cwd(), "modules")
        : path.join(process.resourcesPath, "modules")
}

function getInstalledPluginIds(): string[] {
    const modulesDir = getModulesDir()
    if (!fs.existsSync(modulesDir)) return []
    return fs.readdirSync(modulesDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
}

let wss: WebSocketServer | null = null

function broadcast(message: string) {
    if (!wss) return
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message)
        }
    }
}

export function startServer(port: number) {
    // Load persisted config
    configStore.load()
    const savedVars = configStore.get().variables
    if (savedVars.length > 0) {
        variableStore.setAll(savedVars)
    }

    const expressApp = express()
    const server = http.createServer(expressApp)

    // Allow cross-origin API requests (Vite dev server runs on a different port)
    expressApp.use("/api", (_req, res, next) => {
        res.header("Access-Control-Allow-Origin", "*")
        next()
    })

    // API: list loaded modules and their actions
    expressApp.get("/api/modules", (_req, res) => {
        const modules = moduleRegistry.getAll().map(m => ({
            name: m.manifest.name,
            version: m.manifest.version,
            description: m.manifest.description,
            actions: m.manifest.actions,
            actionDetails: m.manifest.actionDetails || {},
        }))
        res.json(modules)
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

    // API: install a plugin via git clone
    expressApp.use(express.json())
    expressApp.post("/api/marketplace/install", (req, res) => {
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

        const modulesDir = getModulesDir()
        const destDir = path.join(modulesDir, pluginId)

        if (fs.existsSync(destDir)) {
            res.status(409).json({ error: "Plugin already installed" })
            return
        }

        if (!fs.existsSync(modulesDir)) {
            fs.mkdirSync(modulesDir, { recursive: true })
        }

        if (subdirectory) {
            // Clone into a temp dir then copy the subdirectory out
            const tmpDir = path.join(modulesDir, `__tmp_${pluginId}_${Date.now()}`)
            execFile("git", ["clone", "--depth=1", cloneUrl, tmpDir], (cloneErr) => {
                if (cloneErr) {
                    res.status(500).json({ error: `git clone failed: ${cloneErr.message}` })
                    return
                }
                const srcSubdir = path.join(tmpDir, subdirectory)
                if (!fs.existsSync(srcSubdir)) {
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
                loadModules().then(() => {
                    res.json({ success: true, pluginId })
                })
            })
        } else {
            execFile("git", ["clone", "--depth=1", cloneUrl, destDir], (cloneErr) => {
                if (cloneErr) {
                    res.status(500).json({ error: `git clone failed: ${cloneErr.message}` })
                    return
                }
                loadModules().then(() => {
                    res.json({ success: true, pluginId })
                })
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

    // Set up keep-alive interval to send pings to all connected clients
    // This prevents mobile devices from auto-sleeping and keeps connections alive
    const keepAliveInterval = setInterval(() => {
        if (wss) {
            for (const client of wss.clients) {
                if (client.readyState === WebSocket.OPEN) {
                    // Use built-in WebSocket ping
                    client.ping()
                }
            }
        }
    }, 30000) // Send ping every 30 seconds

    wss.on("connection", (ws) => {
        console.log("Device connected")

        // Send current config to newly connected client
        const currentConfig = configStore.get()
        ws.send(createServerMessage("config.sync", {
            pages: currentConfig.pages as unknown as Record<string, unknown>[],
            variables: currentConfig.variables as unknown as Record<string, unknown>[],
            displayImage: currentConfig.displayImage,
        } as unknown as Record<string, unknown>))

        ws.on("message", async (raw) => {
            const message = parseMessage<ClientMessage>(raw.toString())
            if (!message) return

            switch (message.type) {
                case "button.press":
                    if (message.action) {
                        try {
                            await dispatchAction(message.action, message.payload)
                            ws.send(
                                createServerMessage("button.feedback", {
                                    action: message.action,
                                    status: "success",
                                })
                            )
                        } catch (err) {
                            const errorMessage = err instanceof Error ? err.message : "Unknown error"
                            ws.send(
                                createServerMessage("button.feedback", {
                                    action: message.action,
                                    status: "error",
                                    message: errorMessage,
                                })
                            )
                        }
                    }
                    break

                case "page.change":
                    // Acknowledge page change
                    ws.send(
                        createServerMessage("page.update", message.payload)
                    )
                    break

                case "device.connect":
                    console.log("Device registered:", message.payload)
                    break

                case "config.update": {
                    const p = message.payload || {}
                    // Save full config
                    configStore.save({
                        pages: Array.isArray(p.pages) ? p.pages as any : undefined,
                        variables: Array.isArray(p.variables) ? p.variables as any : undefined,
                        displayImage: typeof p.displayImage === "string" ? p.displayImage : undefined,
                    })
                    // Update variable store
                    if (Array.isArray(p.variables)) {
                        variableStore.setAll(p.variables as Array<{ key: string; value: string; description?: string }>)
                    }
                    // Broadcast to all other clients
                    const syncMsg = createServerMessage("config.sync", p)
                    for (const client of wss!.clients) {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(syncMsg)
                        }
                    }
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

    // Clean up keep-alive interval when server closes
    server.on("close", () => {
        clearInterval(keepAliveInterval)
    })

    return server
}
