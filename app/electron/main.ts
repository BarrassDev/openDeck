import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, clipboard, shell } from "electron"
import os from "os"
import path from "path"
import { startServer } from "./server"
import { loadModules, moduleRegistry } from "./module-loader"
import { registerClaudeLinkIpc } from "./claude-link"

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let trayHintShown = false

const PORT = 4020
const isDev = process.env.OPENDECK_DEV === "1"

// Only one OpenDeck at a time: a second launch just brings the existing window back
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
    app.quit()
}

function iconPath(): string {
    // Built renderer assets live next to the compiled main process (dist/renderer), inside the asar when packaged
    return path.join(__dirname, "../../renderer/icons/icon-192.png")
}

function showWindow() {
    if (!mainWindow) {
        void createWindow()
        return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
}

function lanUrl(): string {
    const interfaces = os.networkInterfaces()
    const addresses: string[] = []
    for (const iface of Object.values(interfaces)) {
        for (const info of iface || []) {
            if (info.family === "IPv4" && !info.internal) addresses.push(info.address)
        }
    }
    addresses.sort((a, b) => {
        const score = (ip: string) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : 2)
        return score(a) - score(b)
    })
    return addresses.length ? `http://${addresses[0]}:${PORT}` : `http://localhost:${PORT}`
}

function quitApp() {
    isQuitting = true
    app.quit()
}

function createTray() {
    if (tray) return
    let image = nativeImage.createFromPath(iconPath())
    if (image.isEmpty()) {
        // Fallback: a plain 16x16 accent square so the tray entry still exists
        const size = 16
        const buf = Buffer.alloc(size * size * 4)
        for (let i = 0; i < size * size; i++) buf.set([0xf2, 0x65, 0x58, 0xff], i * 4) // BGRA
        image = nativeImage.createFromBitmap(buf, { width: size, height: size })
    } else {
        image = image.resize({ width: 16, height: 16 })
    }
    tray = new Tray(image)
    tray.setToolTip("OpenDeck")

    const menu = Menu.buildFromTemplate([
        { label: "Open OpenDeck", click: showWindow },
        { type: "separator" },
        { label: "Copy device URL", click: () => clipboard.writeText(lanUrl()) },
        { label: "Open in browser", click: () => { void shell.openExternal(`http://localhost:${PORT}`) } },
        { type: "separator" },
        { label: "Quit OpenDeck", click: quitApp },
    ])
    tray.setContextMenu(menu)
    tray.on("click", showWindow)
    tray.on("double-click", showWindow)
}

async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 700,
        title: "OpenDeck",
        icon: iconPath(),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js"),
        },
    })

    if (isDev) {
        mainWindow.loadURL("http://localhost:5173")
    } else {
        mainWindow.loadURL(`http://localhost:${PORT}`)
    }

    // Closing the window keeps OpenDeck running in the tray so devices stay connected
    mainWindow.on("close", (event) => {
        console.log(`window close requested (isQuitting=${isQuitting})`)
        if (isQuitting) return
        event.preventDefault()
        mainWindow?.hide()
        console.log("window hidden to tray")
        if (!trayHintShown && tray && process.platform === "win32") {
            trayHintShown = true
            tray.displayBalloon({
                title: "OpenDeck is still running",
                content: "Your deck stays available to connected devices. Use the tray icon to reopen or quit.",
                iconType: "info",
            })
        }
    })

    mainWindow.on("closed", () => {
        mainWindow = null
    })
}

ipcMain.handle("dialog:pickFile", async (_event, options: {
    title?: string
    filters?: { name: string; extensions: string[] }[]
    defaultPath?: string
} = {}) => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
        title: options.title ?? "Select a file or application",
        defaultPath: options.defaultPath ?? "C:\\",
        filters: options.filters ?? [
            { name: "Applications", extensions: ["exe", "lnk", "bat", "cmd"] },
            { name: "All Files", extensions: ["*"] },
        ],
        properties: ["openFile"],
    })
    return result.canceled ? null : result.filePaths[0]
})

registerClaudeLinkIpc()

app.on("second-instance", () => {
    showWindow()
})

app.whenReady().then(async () => {
    if (!gotLock) return

    // Load integration modules
    await loadModules()

    // Start HTTP + WebSocket server
    startServer(PORT)

    createTray()

    // Create Electron window
    await createWindow()

    // Smoke-test hook: close the window shortly after start to exercise the tray path
    if (process.env.OPENDECK_SMOKE_CLOSE) {
        setTimeout(() => { console.log("smoke: closing window"); mainWindow?.close() }, 3000)
        if (process.env.OPENDECK_SMOKE_CLOSE === "quit") {
            setTimeout(() => { console.log("smoke: tray quit"); quitApp() }, 6000)
        }
    }

    console.log(`OpenDeck running — control surface at http://localhost:${PORT}`)
})

app.on("will-quit", () => console.log("will-quit"))
app.on("quit", (_e, code) => console.log(`quit (exit code ${code})`))

let disposing = false
app.on("before-quit", (event) => {
    console.log("before-quit")
    isQuitting = true
    if (disposing) return
    disposing = true
    event.preventDefault()
    const timeout = new Promise<void>(resolve => setTimeout(resolve, 3000))
    Promise.race([moduleRegistry.disposeAll(), timeout]).finally(() => {
        tray?.destroy()
        tray = null
        app.quit()
    })
})

// The app lives in the tray; closing windows never ends the process (Quit is in the tray menu)
app.on("window-all-closed", () => {
    // intentionally empty
})

app.on("activate", () => {
    showWindow()
})
