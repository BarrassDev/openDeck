import React, { useEffect } from "react"
import Grid from "../components/Grid"
import { useDeckConfig } from "../hooks/useDeckConfig"
import { useSocket, isElectron } from "../hooks/useSocket"
import { useKioskMode } from "../hooks/useKioskMode"
import { DEFAULT_COLUMNS, DEFAULT_ROWS } from "../../shared/types"

export default function ControlPage() {
    const { pages, currentPageIndex, setCurrentPageIndex, displayImage } = useDeckConfig()
    const { connected, reconnectAttempts } = useSocket()

    // Remote devices run as a kiosk: always awake, fullscreen, no browser gestures
    const kiosk = useKioskMode(!isElectron)

    const safeIndex = Math.min(currentPageIndex, Math.max(0, pages.length - 1))
    const currentPage = pages[safeIndex]
    const columns = currentPage?.columns || DEFAULT_COLUMNS
    const rows = currentPage?.rows || DEFAULT_ROWS

    useEffect(() => {
        if (safeIndex !== currentPageIndex) setCurrentPageIndex(safeIndex)
    }, [safeIndex, currentPageIndex, setCurrentPageIndex])

    if (!currentPage) {
        return <div className="control-page"><p className="settings-hint">No pages configured.</p></div>
    }

    return (
        <div
            className={`control-page${isElectron ? "" : " kiosk"}`}
            style={{ "--cols": columns, "--rows": rows } as React.CSSProperties}
        >
            <div className="sd-device">
                <div className="sd-device-frame">
                    {displayImage && (
                        <img className="sd-display-image" src={displayImage} alt="" draggable={false} />
                    )}
                    <Grid buttons={currentPage.grid} columns={columns} rows={rows} />
                </div>
            </div>

            <nav className="sd-page-bar">
                <div className="sd-page-tabs">
                    {pages.map((page, index) => (
                        <button
                            key={page.name + index}
                            className={`sd-page-tab ${index === safeIndex ? "active" : ""}`}
                            onClick={() => setCurrentPageIndex(index)}
                        >
                            {page.name}
                        </button>
                    ))}
                </div>
                {!isElectron && (
                    <div className="sd-kiosk-controls">
                        <span
                            className={`sd-conn-dot ${connected ? "on" : "off"}`}
                            title={connected ? "Connected" : "Disconnected"}
                        />
                        {kiosk.fullscreenSupported && !kiosk.isStandalone && (
                            <button
                                className={`sd-fullscreen-btn ${kiosk.isFullscreen ? "active" : ""}`}
                                onClick={kiosk.toggleFullscreen}
                                title={kiosk.isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                            >
                                ⛶
                            </button>
                        )}
                    </div>
                )}
            </nav>

            {!isElectron && !connected && (
                <div className="sd-offline">
                    <div className="sd-offline-card">
                        <div className="sd-offline-spinner" />
                        <strong>Reconnecting to OpenDeck…</strong>
                        <span>
                            {reconnectAttempts > 3
                                ? "Make sure the desktop app is running and both devices are on the same network."
                                : "Hang tight."}
                        </span>
                    </div>
                </div>
            )}
        </div>
    )
}
