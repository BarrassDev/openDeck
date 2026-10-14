export interface ClaudeLinkInfo {
    mcpPath: string
    mcpBuilt: boolean
    cli: { installed: boolean; path?: string; version?: string; linked: boolean; current: boolean; configPath: string; error?: string }
    desktop: { installed: boolean; configPath: string | null; linked: boolean }
    manualCommand: string
    manualJson: string
}

export interface LinkResult {
    ok: boolean
    message: string
}

declare global {
    interface Window {
        electronAPI?: {
            pickFile: (options?: {
                title?: string
                filters?: { name: string; extensions: string[] }[]
                defaultPath?: string
            }) => Promise<string | null>
            claude: {
                info: () => Promise<ClaudeLinkInfo>
                link: (target: "code" | "desktop") => Promise<LinkResult>
                unlink: (target: "code" | "desktop") => Promise<LinkResult>
            }
        }
    }
}
