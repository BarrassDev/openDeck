import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("electronAPI", {
    pickFile: (options?: {
        title?: string
        filters?: { name: string; extensions: string[] }[]
        defaultPath?: string
    }): Promise<string | null> =>
        ipcRenderer.invoke("dialog:pickFile", options),

    claude: {
        info: () => ipcRenderer.invoke("claude:info"),
        link: (target: "code" | "desktop") => ipcRenderer.invoke("claude:link", target),
        unlink: (target: "code" | "desktop") => ipcRenderer.invoke("claude:unlink", target),
    },
})
