import React, { useState, useEffect, useCallback } from "react"
import { QRCodeSVG } from "qrcode.react"
import { SocketProvider, apiBase, isElectron } from "./hooks/useSocket"
import { DeckConfigProvider } from "./hooks/useDeckConfig"
import { ModulesProvider } from "./hooks/useModules"
import { ModuleStateProvider } from "./hooks/useModuleState"
import ControlPage from "./pages/ControlPage"
import SettingsPage from "./pages/SettingsPage"
import ModulesPage from "./pages/ModulesPage"
import MarketplacePage from "./pages/MarketplacePage"

type View = "deck" | "settings" | "modules" | "marketplace"

function ConnectModal({ onClose }: { onClose: () => void }) {
    const [addresses, setAddresses] = useState<string[]>([])
    const [port, setPort] = useState(4020)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        fetch(`${apiBase()}/api/network`)
            .then(res => res.json())
            .then(data => {
                setAddresses(data.addresses || [])
                setPort(data.port || 4020)
            })
            .catch(() => setAddresses([]))
            .finally(() => setLoading(false))
    }, [])

    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (e.target === e.currentTarget) onClose()
    }, [onClose])

    const url = addresses.length > 0 ? `http://${addresses[0]}:${port}` : ""

    return (
        <div className="connect-backdrop" onClick={handleBackdropClick}>
            <div className="connect-modal">
                <div className="connect-header">
                    <h2>Connect a Device</h2>
                    <button className="connect-close" onClick={onClose}>✕</button>
                </div>
                <p className="connect-hint">
                    Scan the QR code or open the URL on any device on your local network.
                    On a phone or tablet use <strong>Add to Home Screen</strong> to run OpenDeck as a full-screen app.
                </p>
                {loading ? (
                    <p className="connect-hint">Detecting network…</p>
                ) : addresses.length === 0 ? (
                    <p className="connect-hint">No network interfaces found.</p>
                ) : (
                    <>
                        <div className="connect-qr">
                            <QRCodeSVG value={url} size={180} bgColor="transparent" fgColor="#e8e8e8" />
                        </div>
                        <div className="connect-urls">
                            {addresses.map(addr => {
                                const fullUrl = `http://${addr}:${port}`
                                return (
                                    <div key={addr} className="connect-url-row">
                                        <code className="connect-url">{fullUrl}</code>
                                    </div>
                                )
                            })}
                        </div>
                    </>
                )}
            </div>
        </div>
    )
}

export default function App() {
    const [view, setView] = useState<View>("deck")
    const [showConnect, setShowConnect] = useState(false)

    const nav = (v: View, label: string) => (
        <button
            className={`app-nav-btn ${view === v ? "active" : ""}`}
            onClick={() => setView(v)}
        >
            {label}
        </button>
    )

    return (
        <SocketProvider>
            <DeckConfigProvider>
                <ModulesProvider>
                    <ModuleStateProvider>
                        <div className={`app${isElectron ? "" : " app-remote"}`}>
                            {isElectron && (
                                <header className="app-header">
                                    <h1>OpenDeck</h1>
                                    <nav className="app-nav">
                                        <button
                                            className="app-nav-btn"
                                            onClick={() => setShowConnect(true)}
                                            title="Connect a device"
                                        >
                                            📲 Connect
                                        </button>
                                        {nav("deck", "Deck")}
                                        {nav("settings", "Editor")}
                                        {nav("modules", "Modules")}
                                        {nav("marketplace", "Plugins")}
                                    </nav>
                                </header>
                            )}
                            <main>
                                {(!isElectron || view === "deck") && <ControlPage />}
                                {isElectron && view === "settings" && <SettingsPage />}
                                {isElectron && view === "modules" && <ModulesPage />}
                                {isElectron && view === "marketplace" && <MarketplacePage />}
                            </main>
                            {showConnect && <ConnectModal onClose={() => setShowConnect(false)} />}
                            {isElectron && (
                                <footer className="app-footer">
                                    <a href="https://github.com/BarrassDev/openDeck" target="_blank" rel="noopener noreferrer">
                                        Developed by Joshua Barrass
                                    </a>
                                </footer>
                            )}
                        </div>
                    </ModuleStateProvider>
                </ModulesProvider>
            </DeckConfigProvider>
        </SocketProvider>
    )
}
