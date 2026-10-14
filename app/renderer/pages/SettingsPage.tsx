import React, { useState, useRef, useEffect } from "react"
import { useDeckConfig } from "../hooks/useDeckConfig"
import ButtonEditor from "../components/ButtonEditor"
import PreviewGrid from "../components/PreviewGrid"
import { DEFAULT_COLUMNS, DEFAULT_ROWS } from "../../shared/types"

const COLUMN_OPTIONS = [3, 4, 5, 6, 7, 8]
const ROW_OPTIONS = [2, 3, 4, 5, 6]

export default function SettingsPage() {
    const {
        pages,
        currentPageIndex,
        setCurrentPageIndex,
        updateButton,
        clearButton,
        swapButtons,
        duplicateButton,
        toggleButton,
        clipboard,
        copyButton,
        pasteButton,
        addPage,
        removePage,
        renamePage,
        movePage,
        setPageGrid,
        displayImage,
        setDisplayImage,
    } = useDeckConfig()

    const displayImageRef = useRef<HTMLInputElement>(null)
    const [newPageName, setNewPageName] = useState("")
    const [selectedButton, setSelectedButton] = useState<number | null>(null)
    const [renamingPage, setRenamingPage] = useState<number | null>(null)
    const [renameValue, setRenameValue] = useState("")

    const safePageIndex = Math.min(currentPageIndex, pages.length - 1)
    const currentPage = pages[safePageIndex]
    const columns = currentPage?.columns || DEFAULT_COLUMNS
    const rows = currentPage?.rows || DEFAULT_ROWS
    const totalSlots = columns * rows
    const selectedSlot = selectedButton !== null ? currentPage?.grid[selectedButton] : undefined

    useEffect(() => {
        if (selectedButton !== null && selectedButton >= totalSlots) setSelectedButton(null)
    }, [selectedButton, totalSlots])

    // Keyboard shortcuts while a button is selected
    useEffect(() => {
        if (selectedButton === null) return
        const handler = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null
            if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return
            const mod = e.ctrlKey || e.metaKey
            if (mod && e.key.toLowerCase() === "c" && selectedSlot) { copyButton(selectedSlot); e.preventDefault() }
            else if (mod && e.key.toLowerCase() === "v" && clipboard) { pasteButton(safePageIndex, selectedButton); e.preventDefault() }
            else if (mod && e.key.toLowerCase() === "d" && selectedSlot) { const t = duplicateButton(safePageIndex, selectedButton); if (t !== null) setSelectedButton(t); e.preventDefault() }
            else if (e.key === "Delete" || e.key === "Backspace") { clearButton(safePageIndex, selectedButton); e.preventDefault() }
            else if (e.key === "Escape") setSelectedButton(null)
            else if (e.key === "ArrowLeft" && selectedButton > 0) setSelectedButton(selectedButton - 1)
            else if (e.key === "ArrowRight" && selectedButton < totalSlots - 1) setSelectedButton(selectedButton + 1)
            else if (e.key === "ArrowUp" && selectedButton - columns >= 0) setSelectedButton(selectedButton - columns)
            else if (e.key === "ArrowDown" && selectedButton + columns < totalSlots) setSelectedButton(selectedButton + columns)
        }
        window.addEventListener("keydown", handler)
        return () => window.removeEventListener("keydown", handler)
    }, [selectedButton, selectedSlot, clipboard, copyButton, pasteButton, duplicateButton, clearButton, safePageIndex, columns, totalSlots])

    if (!currentPage) return null

    const handleAddPage = () => {
        const name = newPageName.trim()
        if (!name) return
        addPage(name)
        setNewPageName("")
        setCurrentPageIndex(pages.length)
        setSelectedButton(null)
    }

    const startRenamePage = (index: number) => {
        setRenamingPage(index)
        setRenameValue(pages[index].name)
    }

    const confirmRenamePage = () => {
        if (renamingPage !== null && renameValue.trim()) {
            renamePage(renamingPage, renameValue.trim())
        }
        setRenamingPage(null)
    }

    const handlePageSelect = (index: number) => {
        setCurrentPageIndex(index)
        setSelectedButton(null)
    }

    const hasContent = !!selectedSlot && !!(selectedSlot.action || selectedSlot.label || selectedSlot.icon)

    return (
        <div className="settings-page with-inspector">
            {/* Two-column workspace: deck preview (left) + inspector (right) */}
            <div className="settings-workspace">
                <div className="settings-canvas">
                    <div className="settings-canvas-header">
                        <h2>{currentPage.name}</h2>
                        <span className="settings-canvas-hint">
                            Click a button to edit · drag to rearrange · Ctrl+C / Ctrl+V / Ctrl+D · Delete clears
                        </span>
                    </div>
                    <div className="sd-device settings-canvas-device" style={{ "--cols": columns, "--rows": rows } as React.CSSProperties}>
                        <div className="sd-device-frame">
                            {displayImage && (
                                <img className="sd-display-image" src={displayImage} alt="" draggable={false} />
                            )}
                            <PreviewGrid
                                buttons={currentPage.grid}
                                columns={columns}
                                rows={rows}
                                selectedIndex={selectedButton}
                                onSelect={setSelectedButton}
                                onSwap={(from, to) => swapButtons(safePageIndex, from, to)}
                            />
                        </div>
                    </div>
                    <nav className="sd-page-bar settings-canvas-pagebar">
                        <div className="sd-page-tabs">
                            {pages.map((page, index) => (
                                <button
                                    key={page.name + index}
                                    className={`sd-page-tab ${index === safePageIndex ? "active" : ""}`}
                                    onClick={() => handlePageSelect(index)}
                                >
                                    {page.name}
                                </button>
                            ))}
                        </div>
                    </nav>
                </div>

                {/* Right: Inspector */}
                <aside className="settings-inspector">
                    {selectedButton === null || !selectedSlot ? (
                        <div className="settings-inspector-empty">
                            <div className="settings-inspector-empty-icon">⊕</div>
                            <p>Select a slot to edit its look, action, live face and press behaviour.</p>
                            {clipboard && <p className="settings-hint">Clipboard: {clipboard.label || clipboard.action || "button"}. Select a slot and press Ctrl+V.</p>}
                        </div>
                    ) : (
                        <>
                            <div className="settings-inspector-header">
                                <div className="settings-inspector-title">
                                    <span className="settings-inspector-eyebrow">
                                        {currentPage.name} · Slot {selectedButton + 1}
                                        {selectedSlot.disabled ? " · disabled" : ""}
                                    </span>
                                    <h3>{selectedSlot.label || (selectedSlot.action ? selectedSlot.action : "Empty slot")}</h3>
                                </div>
                                <button
                                    className="settings-btn icon"
                                    onClick={() => setSelectedButton(null)}
                                    title="Close (Esc)"
                                >✕</button>
                            </div>

                            <div className="settings-inspector-toolbar">
                                <button
                                    className="settings-btn icon small"
                                    onClick={() => { swapButtons(safePageIndex, selectedButton, selectedButton - 1); setSelectedButton(selectedButton - 1) }}
                                    disabled={selectedButton === 0}
                                    title="Swap with previous slot"
                                >◀</button>
                                <button
                                    className="settings-btn icon small"
                                    onClick={() => { swapButtons(safePageIndex, selectedButton, selectedButton + 1); setSelectedButton(selectedButton + 1) }}
                                    disabled={selectedButton >= totalSlots - 1}
                                    title="Swap with next slot"
                                >▶</button>
                                <button
                                    className="settings-btn icon small"
                                    onClick={() => copyButton(selectedSlot)}
                                    disabled={!hasContent}
                                    title="Copy (Ctrl+C)"
                                >📋</button>
                                <button
                                    className="settings-btn icon small"
                                    onClick={() => pasteButton(safePageIndex, selectedButton)}
                                    disabled={!clipboard}
                                    title="Paste (Ctrl+V)"
                                >📥</button>
                                <button
                                    className="settings-btn icon small"
                                    onClick={() => { const t = duplicateButton(safePageIndex, selectedButton); if (t !== null) setSelectedButton(t) }}
                                    disabled={!hasContent}
                                    title="Duplicate to the next empty slot (Ctrl+D)"
                                >⧉</button>
                                <button
                                    className={`settings-btn icon small ${!selectedSlot.disabled ? "active" : ""}`}
                                    onClick={() => toggleButton(safePageIndex, selectedButton)}
                                    disabled={!hasContent}
                                    title={!selectedSlot.disabled ? "Disable (hide on the deck)" : "Enable"}
                                >{!selectedSlot.disabled ? "👁️" : "🚫"}</button>
                                <div className="settings-inspector-toolbar-spacer" />
                                <button
                                    className="settings-btn icon small danger"
                                    onClick={() => clearButton(safePageIndex, selectedButton)}
                                    disabled={!hasContent}
                                    title="Clear slot (Delete)"
                                >🗑️</button>
                            </div>

                            <div className="settings-inspector-body">
                                <ButtonEditor
                                    key={selectedSlot.id}
                                    button={selectedSlot}
                                    onChange={updates => updateButton(safePageIndex, selectedButton, updates)}
                                    columns={columns}
                                    rows={rows}
                                    slotIndex={selectedButton}
                                />
                            </div>
                        </>
                    )}
                </aside>
            </div>

            {/* Pages */}
            <section className="settings-section">
                <h2>Pages</h2>
                <div className="settings-page-list">
                    {pages.map((page, index) => (
                        <div
                            key={index}
                            className={`settings-page-item ${index === safePageIndex ? "active" : ""}`}
                        >
                            {renamingPage === index ? (
                                <div className="settings-rename-row">
                                    <input
                                        className="settings-input"
                                        value={renameValue}
                                        onChange={e => setRenameValue(e.target.value)}
                                        onKeyDown={e => { if (e.key === "Enter") confirmRenamePage(); if (e.key === "Escape") setRenamingPage(null) }}
                                        autoFocus
                                    />
                                    <button className="settings-btn small" onClick={confirmRenamePage}>Save</button>
                                </div>
                            ) : (
                                <>
                                    <span className="settings-page-name" onClick={() => handlePageSelect(index)}>
                                        {page.name}
                                    </span>
                                    <div className="settings-page-grid">
                                        <select
                                            className="settings-input compact"
                                            value={page.columns || DEFAULT_COLUMNS}
                                            onChange={e => setPageGrid(index, Number(e.target.value), page.rows || DEFAULT_ROWS)}
                                            title="Columns"
                                        >
                                            {COLUMN_OPTIONS.map(c => <option key={c} value={c}>{c} cols</option>)}
                                        </select>
                                        <select
                                            className="settings-input compact"
                                            value={page.rows || DEFAULT_ROWS}
                                            onChange={e => setPageGrid(index, page.columns || DEFAULT_COLUMNS, Number(e.target.value))}
                                            title="Rows"
                                        >
                                            {ROW_OPTIONS.map(r => <option key={r} value={r}>{r} rows</option>)}
                                        </select>
                                    </div>
                                    <div className="settings-page-actions">
                                        <button className="settings-btn icon" onClick={() => movePage(index, index - 1)} disabled={index === 0} title="Move up">▲</button>
                                        <button className="settings-btn icon" onClick={() => movePage(index, index + 1)} disabled={index === pages.length - 1} title="Move down">▼</button>
                                        <button className="settings-btn icon" onClick={() => startRenamePage(index)} title="Rename">✏️</button>
                                        {pages.length > 1 && (
                                            <button
                                                className="settings-btn icon danger"
                                                onClick={() => { if (confirm(`Delete page "${page.name}"?`)) { removePage(index); setSelectedButton(null) } }}
                                                title="Delete"
                                            >🗑️</button>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                    ))}
                </div>
                <div className="settings-add-page">
                    <input
                        className="settings-input"
                        placeholder="New page name..."
                        value={newPageName}
                        onChange={e => setNewPageName(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleAddPage()}
                    />
                    <button className="settings-btn" onClick={handleAddPage}>Add Page</button>
                </div>
            </section>

            {/* Display Image */}
            <section className="settings-section">
                <h2>Display Image</h2>
                <p className="settings-hint">Background image for the device frame, shown behind the buttons on every device.</p>
                <div className="settings-display-image">
                    {displayImage && (
                        <div className="settings-display-preview-wrap">
                            <img className="settings-display-preview" src={displayImage} alt="Display" />
                        </div>
                    )}
                    <div className="settings-display-actions">
                        <button className="settings-btn" onClick={() => displayImageRef.current?.click()}>
                            {displayImage ? "Change Image" : "Upload Image"}
                        </button>
                        {displayImage && (
                            <button className="settings-btn danger" onClick={() => setDisplayImage("")}>
                                Remove
                            </button>
                        )}
                        <input
                            ref={displayImageRef}
                            type="file"
                            accept="image/*"
                            style={{ display: "none" }}
                            onChange={e => {
                                const file = e.target.files?.[0]
                                if (!file || !file.type.startsWith("image/")) return
                                const reader = new FileReader()
                                reader.onload = () => setDisplayImage(reader.result as string)
                                reader.readAsDataURL(file)
                                e.target.value = ""
                            }}
                        />
                    </div>
                </div>
            </section>
        </div>
    )
}
