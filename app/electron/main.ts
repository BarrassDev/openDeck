import { app, BrowserWindow, ipcMain, dialog } from "electron"
import path from "path"
import { startServer } from "./server"
import { loadModules, moduleRegistry } from "./module-loader"
import { registerClaudeLinkIpc } from "./claude-link"

let mainWindow: BrowserWindow | null = null

const PORT = 4020
const isDev = process.env.OPENDECK_DEV === "1"

async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 700,
        title: "OpenDeck",
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

app.whenReady().then(async () => {
    // Load integration modules
    await loadModules()

    // Start HTTP + WebSocket server
    startServer(PORT)

    // Create Electron window
    await createWindow()

    console.log(`OpenDeck running — control surface at http://localhost:${PORT}`)
})

let disposing = false
app.on("before-quit", (event) => {
    if (disposing) return
    disposing = true
    event.preventDefault()
    const timeout = new Promise<void>(resolve => setTimeout(resolve, 3000))
    Promise.race([moduleRegistry.disposeAll(), timeout]).finally(() => app.quit())
})

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit()
    }
})

app.on("activate", () => {
    if (mainWindow === null) {
        createWindow()
    }
})
