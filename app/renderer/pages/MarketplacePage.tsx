import React, { useState, useEffect, useCallback } from "react"

interface RegistryPlugin {
    id: string
    name: string
    description: string
    author: string
    version: string
    tags?: string[]
    repo: string
    cloneUrl: string
    subdirectory?: string
    homepage?: string
    license?: string
    bundled?: boolean
}

interface Registry {
    version: number
    plugins: RegistryPlugin[]
}

type InstallState = "idle" | "installing" | "installed" | "error"

const API_PORT = 4020

function apiBase() {
    return `http://${window.location.hostname}:${API_PORT}`
}

export default function MarketplacePage() {
    const [plugins, setPlugins] = useState<RegistryPlugin[]>([])
    const [installedIds, setInstalledIds] = useState<Set<string>>(new Set())
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [search, setSearch] = useState("")
    const [installStates, setInstallStates] = useState<Record<string, InstallState>>({})
    const [installErrors, setInstallErrors] = useState<Record<string, string>>({})

    const fetchRegistry = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const [registryRes, installedRes] = await Promise.all([
                fetch(`${apiBase()}/api/marketplace`),
                fetch(`${apiBase()}/api/marketplace/installed`),
            ])
            if (!registryRes.ok) {
                const body = await registryRes.json().catch(() => ({}))
                throw new Error(body.error || `Registry fetch failed (${registryRes.status})`)
            }
            const registry: Registry = await registryRes.json()
            const { installed }: { installed: string[] } = await installedRes.json()
            setPlugins(registry.plugins || [])
            setInstalledIds(new Set(installed))
        } catch (err) {
            setError(err instanceof Error ? err.message : "Unknown error")
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        fetchRegistry()
    }, [fetchRegistry])

    const install = useCallback(async (plugin: RegistryPlugin) => {
        setInstallStates(s => ({ ...s, [plugin.id]: "installing" }))
        setInstallErrors(e => { const n = { ...e }; delete n[plugin.id]; return n })
        try {
            const res = await fetch(`${apiBase()}/api/marketplace/install`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    cloneUrl: plugin.cloneUrl,
                    pluginId: plugin.id,
                    subdirectory: plugin.subdirectory,
                }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.error || `Install failed (${res.status})`)
            }
            setInstallStates(s => ({ ...s, [plugin.id]: "installed" }))
            setInstalledIds(s => new Set([...s, plugin.id]))
        } catch (err) {
            setInstallStates(s => ({ ...s, [plugin.id]: "error" }))
            setInstallErrors(e => ({ ...e, [plugin.id]: err instanceof Error ? err.message : "Unknown error" }))
        }
    }, [])

    const filtered = plugins.filter(p => {
        const q = search.toLowerCase()
        if (!q) return true
        return (
            p.name.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            p.author.toLowerCase().includes(q) ||
            p.tags?.some(t => t.toLowerCase().includes(q))
        )
    })

    return (
        <div className="marketplace-page">
            <div className="marketplace-header">
                <div className="marketplace-title-row">
                    <h2>Plugin Marketplace</h2>
                    <button
                        className="settings-btn small"
                        onClick={fetchRegistry}
                        disabled={loading}
                        title="Refresh"
                    >
                        {loading ? "Loading…" : "↻ Refresh"}
                    </button>
                </div>
                <p className="marketplace-hint">
                    Community plugins for OpenDeck. Install from GitHub repos — each plugin runs locally on your machine.{" "}
                    <a
                        className="marketplace-link"
                        href="https://github.com/BarrassDev/opendeck-plugins"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Submit your plugin ↗
                    </a>
                </p>
                <input
                    className="settings-input marketplace-search"
                    type="search"
                    placeholder="Search plugins…"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                />
            </div>

            {error && (
                <div className="marketplace-error">
                    <strong>Could not load registry:</strong> {error}
                    <br />
                    <small>Check your internet connection or try refreshing.</small>
                </div>
            )}

            {!error && !loading && filtered.length === 0 && (
                <p className="marketplace-empty">
                    {search ? `No plugins match "${search}"` : "No plugins found in registry."}
                </p>
            )}

            <div className="marketplace-grid">
                {filtered.map(plugin => {
                    const isInstalled = installedIds.has(plugin.id)
                    const state = installStates[plugin.id] ?? (isInstalled ? "installed" : "idle")
                    const errMsg = installErrors[plugin.id]

                    return (
                        <div key={plugin.id} className={`marketplace-card ${plugin.bundled ? "bundled" : ""}`}>
                            <div className="marketplace-card-top">
                                <div className="marketplace-card-meta">
                                    <span className="marketplace-card-name">{plugin.name}</span>
                                    <span className="marketplace-card-version">v{plugin.version}</span>
                                    {plugin.bundled && (
                                        <span className="marketplace-badge bundled-badge">Built-in</span>
                                    )}
                                </div>
                                <span className="marketplace-card-author">by {plugin.author}</span>
                            </div>

                            <p className="marketplace-card-desc">{plugin.description}</p>

                            {plugin.tags && plugin.tags.length > 0 && (
                                <div className="marketplace-tags">
                                    {plugin.tags.map(tag => (
                                        <button
                                            key={tag}
                                            className="marketplace-tag"
                                            onClick={() => setSearch(tag)}
                                        >
                                            {tag}
                                        </button>
                                    ))}
                                </div>
                            )}

                            {errMsg && (
                                <div className="marketplace-install-error">{errMsg}</div>
                            )}

                            <div className="marketplace-card-footer">
                                <a
                                    className="marketplace-link"
                                    href={plugin.homepage || plugin.repo}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    View repo ↗
                                </a>
                                {plugin.license && (
                                    <span className="marketplace-license">{plugin.license}</span>
                                )}
                                {state === "installed" && (
                                    <span className="marketplace-installed-badge">✓ Installed</span>
                                )}
                                {state === "installing" && (
                                    <span className="marketplace-installing">Installing…</span>
                                )}
                                {(state === "idle" || state === "error") && !plugin.bundled && (
                                    <button
                                        className="settings-btn small"
                                        onClick={() => install(plugin)}
                                    >
                                        Install
                                    </button>
                                )}
                            </div>
                        </div>
                    )
                })}
            </div>

            {!error && (
                <p className="marketplace-footer-note">
                    Plugins are cloned from their Git repositories into your local <code>modules/</code> directory.
                    Restart OpenDeck after installing to reload all modules.
                </p>
            )}
        </div>
    )
}
