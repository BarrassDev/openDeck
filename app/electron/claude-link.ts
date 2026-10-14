/**
 * One-click linking of the OpenDeck MCP server into Claude Code (CLI) and Claude Desktop,
 * so a user can ask Claude to set the deck up for them.
 *
 * The MCP server is a single bundled file (dist/mcp/opendeck-mcp.cjs, shipped as
 * resources/mcp/opendeck-mcp.cjs). It runs on this app's own binary with
 * ELECTRON_RUN_AS_NODE=1, so users do not need a separate Node install.
 *
 * Claude Code user-scope servers live in ~/.claude.json under "mcpServers". We prefer
 * the CLI (`claude mcp add`), but fall back to editing that file when the CLI cannot be
 * found on the app's PATH (common when launched from the installer or Start menu).
 */
import { app, ipcMain } from "electron"
import { spawn } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"

const SERVER_NAME = "opendeck"

export function getMcpServerPath(): string {
    return app.isPackaged
        ? path.join(process.resourcesPath, "mcp", "opendeck-mcp.cjs")
        : path.join(process.cwd(), "dist", "mcp", "opendeck-mcp.cjs")
}

export interface McpLaunchSpec {
    command: string
    args: string[]
    env: Record<string, string>
}

export function getMcpLaunchSpec(): McpLaunchSpec {
    return {
        command: process.execPath,
        args: [getMcpServerPath()],
        env: {
            ELECTRON_RUN_AS_NODE: "1",
            OPENDECK_APP_PATH: process.execPath,
            // In dev the Electron binary needs the project directory as its argument
            OPENDECK_APP_ARGS: JSON.stringify(app.isPackaged ? [] : [process.cwd()]),
        },
    }
}

/** Entry in the exact shape `claude mcp add` writes */
function mcpServerEntry() {
    const spec = getMcpLaunchSpec()
    return { type: "stdio", command: spec.command, args: spec.args, env: spec.env }
}

function q(s: string): string {
    return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

function cleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    return env
}

interface ShellResult { code: number | null; stdout: string; stderr: string }

function runShell(cmdline: string, timeoutMs = 20000): Promise<ShellResult> {
    return new Promise(resolve => {
        const child = spawn(cmdline, { shell: true, env: cleanEnv(), windowsHide: true })
        let stdout = ""
        let stderr = ""
        const timer = setTimeout(() => { child.kill(); resolve({ code: null, stdout, stderr: stderr + "\n(timed out)" }) }, timeoutMs)
        child.stdout.on("data", d => { stdout += d.toString() })
        child.stderr.on("data", d => { stderr += d.toString() })
        child.on("error", err => { clearTimeout(timer); resolve({ code: null, stdout, stderr: err.message }) })
        child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    })
}

// ---------- locating the Claude Code CLI ----------

function claudeCandidates(): string[] {
    const home = os.homedir()
    const out: string[] = []
    if (process.platform === "win32") {
        const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local")
        const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming")
        out.push(
            path.join(local, "Microsoft", "WinGet", "Links", "claude.exe"),
            path.join(home, ".local", "bin", "claude.exe"),
            path.join(roaming, "npm", "claude.cmd"),
            path.join(local, "Programs", "claude", "claude.exe"),
        )
    } else {
        out.push(
            path.join(home, ".local", "bin", "claude"),
            "/usr/local/bin/claude",
            "/opt/homebrew/bin/claude",
            path.join(home, ".npm-global", "bin", "claude"),
        )
    }
    return out
}

let cachedClaude: string | null | undefined

/** Absolute path to the claude executable, or null when it cannot be found */
async function findClaude(): Promise<string | null> {
    if (cachedClaude !== undefined) return cachedClaude
    const probe = await runShell(process.platform === "win32" ? "where claude" : "command -v claude", 8000)
    if (probe.code === 0) {
        const first = probe.stdout.split(/\r?\n/).map(l => l.trim()).find(l => l && fs.existsSync(l))
        if (first) return (cachedClaude = first)
    }
    for (const candidate of claudeCandidates()) {
        if (fs.existsSync(candidate)) return (cachedClaude = candidate)
    }
    return (cachedClaude = null)
}

// ---------- Claude Code user config (~/.claude.json) ----------

function claudeUserConfigPath(): string {
    return path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json")
}

function readClaudeUserConfig(): Record<string, any> | null {
    const p = claudeUserConfigPath()
    try {
        if (!fs.existsSync(p)) return null
        const parsed = JSON.parse(fs.readFileSync(p, "utf-8"))
        return parsed && typeof parsed === "object" ? parsed : null
    } catch {
        return null
    }
}

function cliEntry(): Record<string, any> | null {
    return readClaudeUserConfig()?.mcpServers?.[SERVER_NAME] ?? null
}

function cliEntryIsCurrent(): boolean {
    const entry = cliEntry()
    if (!entry) return false
    const want = mcpServerEntry()
    return entry.command === want.command
        && JSON.stringify(entry.args) === JSON.stringify(want.args)
        && JSON.stringify(entry.env || {}) === JSON.stringify(want.env)
}

/** Write the entry straight into ~/.claude.json (same shape the CLI uses) */
function writeCliEntry(remove = false): { ok: boolean; message: string } {
    const p = claudeUserConfigPath()
    let config: Record<string, any> = {}
    try {
        if (fs.existsSync(p)) {
            const parsed = JSON.parse(fs.readFileSync(p, "utf-8"))
            if (parsed && typeof parsed === "object") config = parsed
        }
    } catch (err) {
        return { ok: false, message: `Could not parse ${p}: ${(err as Error).message}` }
    }
    const servers = { ...(config.mcpServers || {}) }
    if (remove) delete servers[SERVER_NAME]
    else servers[SERVER_NAME] = mcpServerEntry()
    config.mcpServers = servers
    try {
        fs.writeFileSync(p, JSON.stringify(config, null, 2), "utf-8")
        return { ok: true, message: remove ? `Removed from ${p}.` : `Written to ${p}.` }
    } catch (err) {
        return { ok: false, message: `Could not write ${p}: ${(err as Error).message}` }
    }
}

/** The command a user would run by hand to link Claude Code */
export function claudeCodeCommand(scope: "user" | "project" = "user", claudeExe = "claude"): string {
    const spec = getMcpLaunchSpec()
    // Order matters: `-e` is variadic, so the server name must come first and `--` must end the list
    const envFlags = Object.entries(spec.env).map(([k, v]) => `-e ${q(`${k}=${v}`)}`).join(" ")
    return `${q(claudeExe)} mcp add --scope ${scope} --transport stdio ${SERVER_NAME} ${envFlags} -- ${q(spec.command)} ${spec.args.map(q).join(" ")}`
}

/** JSON snippet for Claude Desktop, Cursor, Windsurf, etc. */
export function mcpJsonSnippet(): Record<string, unknown> {
    const spec = getMcpLaunchSpec()
    return { mcpServers: { [SERVER_NAME]: { command: spec.command, args: spec.args, env: spec.env } } }
}

// ---------- Claude Desktop ----------

function claudeDesktopConfigPath(): string | null {
    if (process.platform === "win32") {
        return process.env.APPDATA ? path.join(process.env.APPDATA, "Claude", "claude_desktop_config.json") : null
    }
    if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Claude", "claude_desktop_config.json")
}

function readDesktopConfig(): { path: string | null; installed: boolean; config: Record<string, any> | null } {
    const p = claudeDesktopConfigPath()
    if (!p) return { path: null, installed: false, config: null }
    const installed = fs.existsSync(path.dirname(p))
    if (!installed) return { path: p, installed, config: null }
    try {
        const raw = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "{}"
        const parsed = JSON.parse(raw || "{}")
        return { path: p, installed, config: parsed && typeof parsed === "object" ? parsed : {} }
    } catch {
        return { path: p, installed, config: {} }
    }
}

// ---------- IPC surface ----------

export interface ClaudeLinkInfo {
    mcpPath: string
    mcpBuilt: boolean
    cli: { installed: boolean; path?: string; version?: string; linked: boolean; current: boolean; configPath: string; error?: string }
    desktop: { installed: boolean; configPath: string | null; linked: boolean }
    manualCommand: string
    manualJson: string
}

export async function getInfo(): Promise<ClaudeLinkInfo> {
    const mcpPath = getMcpServerPath()
    const claudeExe = await findClaude()
    let version: string | undefined
    if (claudeExe) {
        const v = await runShell(`${q(claudeExe)} --version`, 8000)
        version = v.code === 0 ? v.stdout.trim().split("\n")[0] : undefined
    }
    const desktop = readDesktopConfig()
    const configPath = claudeUserConfigPath()
    return {
        mcpPath,
        mcpBuilt: fs.existsSync(mcpPath),
        cli: {
            installed: !!claudeExe,
            path: claudeExe || undefined,
            version,
            linked: !!cliEntry(),
            current: cliEntryIsCurrent(),
            configPath,
            error: claudeExe
                ? undefined
                : `Claude Code CLI not found on PATH. Linking will write ${configPath} directly; install Claude Code from https://claude.com/claude-code to use it.`,
        },
        desktop: {
            installed: desktop.installed,
            configPath: desktop.path,
            linked: !!desktop.config?.mcpServers?.[SERVER_NAME],
        },
        manualCommand: claudeCodeCommand("user", claudeExe ? path.basename(claudeExe).replace(/\.(exe|cmd)$/i, "") : "claude"),
        manualJson: JSON.stringify(mcpJsonSnippet(), null, 2),
    }
}

export async function linkCli(): Promise<{ ok: boolean; message: string }> {
    if (!fs.existsSync(getMcpServerPath())) {
        return { ok: false, message: `MCP server not found at ${getMcpServerPath()}. Run "npm run build" first.` }
    }
    const claudeExe = await findClaude()
    const done = (via: string) => ({
        ok: true,
        message: `Linked ${via}. In Claude Code, type /mcp to confirm "${SERVER_NAME}" is connected, then ask Claude to set up your deck.`,
    })

    if (claudeExe) {
        // Replace any previous registration so path changes (updates) are picked up
        if (cliEntry()) await runShell(`${q(claudeExe)} mcp remove --scope user ${SERVER_NAME}`, 10000)
        const result = await runShell(claudeCodeCommand("user", claudeExe), 20000)
        if (result.code === 0 && cliEntryIsCurrent()) return done("with the Claude Code CLI")
        // CLI ran but the entry is missing or incomplete: fix the file directly
        const written = writeCliEntry()
        if (written.ok) return done(`(entry written to ${claudeUserConfigPath()})`)
        return { ok: false, message: (result.stderr || result.stdout || written.message).trim() }
    }

    const written = writeCliEntry()
    return written.ok ? done(`by writing ${claudeUserConfigPath()}`) : written
}

export async function unlinkCli(): Promise<{ ok: boolean; message: string }> {
    const claudeExe = await findClaude()
    if (claudeExe) {
        const result = await runShell(`${q(claudeExe)} mcp remove --scope user ${SERVER_NAME}`, 10000)
        if (result.code === 0 && !cliEntry()) return { ok: true, message: "Removed from Claude Code." }
    }
    const written = writeCliEntry(true)
    return written.ok ? { ok: true, message: "Removed from Claude Code." } : written
}

function linkDesktop(): { ok: boolean; message: string } {
    const desktop = readDesktopConfig()
    if (!desktop.path || !desktop.installed) {
        return { ok: false, message: "Claude Desktop does not appear to be installed (its config folder was not found)." }
    }
    if (!fs.existsSync(getMcpServerPath())) {
        return { ok: false, message: `MCP server not found at ${getMcpServerPath()}. Run "npm run build" first.` }
    }
    const config = desktop.config || {}
    const spec = getMcpLaunchSpec()
    config.mcpServers = { ...(config.mcpServers || {}), [SERVER_NAME]: { command: spec.command, args: spec.args, env: spec.env } }
    try {
        fs.writeFileSync(desktop.path, JSON.stringify(config, null, 2), "utf-8")
        return { ok: true, message: "Added to Claude Desktop. Fully quit and reopen Claude Desktop to load it." }
    } catch (err) {
        return { ok: false, message: `Could not write ${desktop.path}: ${(err as Error).message}` }
    }
}

function unlinkDesktop(): { ok: boolean; message: string } {
    const desktop = readDesktopConfig()
    if (!desktop.path || !desktop.config?.mcpServers?.[SERVER_NAME]) return { ok: true, message: "Not linked." }
    delete desktop.config.mcpServers[SERVER_NAME]
    try {
        fs.writeFileSync(desktop.path, JSON.stringify(desktop.config, null, 2), "utf-8")
        return { ok: true, message: "Removed from Claude Desktop." }
    } catch (err) {
        return { ok: false, message: `Could not write ${desktop.path}: ${(err as Error).message}` }
    }
}

export function registerClaudeLinkIpc() {
    ipcMain.handle("claude:info", () => getInfo())
    ipcMain.handle("claude:link", async (_event, target: "code" | "desktop") => {
        return target === "desktop" ? linkDesktop() : linkCli()
    })
    ipcMain.handle("claude:unlink", async (_event, target: "code" | "desktop") => {
        return target === "desktop" ? unlinkDesktop() : unlinkCli()
    })
}
