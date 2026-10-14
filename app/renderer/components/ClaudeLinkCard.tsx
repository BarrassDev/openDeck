import React, { useCallback, useEffect, useState } from "react"
import type { ClaudeLinkInfo, LinkResult } from "../electron.d"

const EXAMPLE_PROMPTS = [
    "Set up OpenDeck for streaming: connect OBS, add scene buttons for every scene, a mute button for my mic, and a red LIVE face while streaming.",
    "Make a Media page with play/pause, next, previous and volume buttons, then give me the URL for my iPad.",
    "Add a Wave Link page: toggle mic mute, monitor mute, and volume nudges for the Music and Game channels.",
]

export default function ClaudeLinkCard() {
    const api = typeof window !== "undefined" ? window.electronAPI?.claude : undefined
    const [info, setInfo] = useState<ClaudeLinkInfo | null>(null)
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState<string | null>(null)
    const [result, setResult] = useState<LinkResult | null>(null)
    const [showManual, setShowManual] = useState(false)
    const [copied, setCopied] = useState<string | null>(null)

    const refresh = useCallback(() => {
        if (!api) { setLoading(false); return }
        setLoading(true)
        api.info().then(setInfo).catch(() => setInfo(null)).finally(() => setLoading(false))
    }, [api])

    useEffect(() => { refresh() }, [refresh])

    const act = async (label: string, fn: () => Promise<LinkResult>) => {
        setBusy(label)
        setResult(null)
        try {
            setResult(await fn())
        } catch (err) {
            setResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
        } finally {
            setBusy(null)
            refresh()
        }
    }

    const copy = async (what: string, value: string) => {
        try {
            await navigator.clipboard.writeText(value)
            setCopied(what)
            setTimeout(() => setCopied(null), 1500)
        } catch { /* clipboard unavailable */ }
    }

    if (!api) return null

    return (
        <section className="settings-section module-card claude-card">
            <div className="module-card-head">
                <div className="module-card-title">
                    <span className="module-card-icon">✨</span>
                    <div>
                        <h3>Claude assistant</h3>
                        <p className="actions-module-desc">
                            Link OpenDeck to Claude so you can ask it to set everything up for you: connect OBS, build pages, pick real scene names, add live faces and hand you the device URL.
                        </p>
                    </div>
                </div>
                <button className="settings-btn small" onClick={refresh} disabled={loading}>{loading ? "…" : "↻"}</button>
            </div>

            {info && !info.mcpBuilt && (
                <div className="marketplace-error">
                    The MCP server bundle is missing at <code>{info.mcpPath}</code>. Run <code>npm run build</code>.
                </div>
            )}

            <div className="claude-targets">
                <div className="claude-target">
                    <div className="claude-target-head">
                        <strong>Claude Code (CLI)</strong>
                        {info?.cli.linked ? (
                            <span className={`module-status ${info.cli.current ? "on" : "neutral"}`} title={info.cli.configPath}>
                                ● {info.cli.current ? "linked" : "linked (outdated path)"}
                            </span>
                        ) : (
                            <span className="module-status neutral">● not linked</span>
                        )}
                    </div>
                    <p className="settings-hint">
                        {info?.cli.installed
                            ? `${info.cli.version || "Claude Code"} found. Linking registers the "opendeck" MCP server for your user, so it works in any project.`
                            : (info?.cli.error || "Checking…")}
                    </p>
                    <div className="settings-display-actions">
                        <button
                            className="settings-btn"
                            disabled={!info?.mcpBuilt || !!busy}
                            onClick={() => act("code", () => api.link("code"))}
                        >
                            {busy === "code" ? "Linking…" : info?.cli.linked ? "Re-link" : "Link Claude Code"}
                        </button>
                        {info?.cli.linked && (
                            <button className="settings-btn icon danger" disabled={!!busy} onClick={() => act("code-un", () => api.unlink("code"))} title="Unlink">✕</button>
                        )}
                    </div>
                </div>

                <div className="claude-target">
                    <div className="claude-target-head">
                        <strong>Claude Desktop</strong>
                        {info?.desktop.installed ? (
                            <span className={`module-status ${info.desktop.linked ? "on" : "neutral"}`}>
                                ● {info.desktop.linked ? "linked" : "not linked"}
                            </span>
                        ) : (
                            <span className="module-status off">● not installed</span>
                        )}
                    </div>
                    <p className="settings-hint">
                        {info?.desktop.installed
                            ? "Adds OpenDeck to claude_desktop_config.json. Restart Claude Desktop afterwards."
                            : "Claude Desktop config folder not found."}
                    </p>
                    <div className="settings-display-actions">
                        <button
                            className="settings-btn"
                            disabled={!info?.desktop.installed || !info?.mcpBuilt || !!busy}
                            onClick={() => act("desktop", () => api.link("desktop"))}
                        >
                            {busy === "desktop" ? "Linking…" : info?.desktop.linked ? "Re-link" : "Link Claude Desktop"}
                        </button>
                        {info?.desktop.linked && (
                            <button className="settings-btn icon danger" disabled={!!busy} onClick={() => act("desktop-un", () => api.unlink("desktop"))} title="Unlink">✕</button>
                        )}
                    </div>
                </div>
            </div>

            {result && (
                <div className={result.ok ? "claude-result ok" : "marketplace-error"}>{result.message}</div>
            )}

            <div className="module-section">
                <h4>Try asking Claude</h4>
                <ul className="claude-prompts">
                    {EXAMPLE_PROMPTS.map(p => (
                        <li key={p}>
                            <span>{p}</span>
                            <button className="settings-btn icon small" title="Copy" onClick={() => copy(p, p)}>{copied === p ? "✓" : "📋"}</button>
                        </li>
                    ))}
                </ul>
            </div>

            <div className="module-section">
                <button type="button" className="button-editor-advanced-toggle" onClick={() => setShowManual(s => !s)}>
                    {showManual ? "Hide manual setup" : "Manual setup (other MCP clients)"}
                </button>
                {showManual && info && (
                    <div className="claude-manual">
                        <p className="settings-hint">Claude Code command:</p>
                        <div className="claude-code-row">
                            <code>{info.manualCommand}</code>
                            <button className="settings-btn icon small" onClick={() => copy("cmd", info.manualCommand)}>{copied === "cmd" ? "✓" : "📋"}</button>
                        </div>
                        <p className="settings-hint">JSON for Claude Desktop, Cursor, Windsurf and other MCP clients:</p>
                        <div className="claude-code-row">
                            <pre>{info.manualJson}</pre>
                            <button className="settings-btn icon small" onClick={() => copy("json", info.manualJson)}>{copied === "json" ? "✓" : "📋"}</button>
                        </div>
                    </div>
                )}
            </div>
        </section>
    )
}
