import React, { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from "react"
import {
    DEFAULT_COLUMNS,
    DEFAULT_ROWS,
    type DeckPage,
    type DeckButton,
    type DeckVariable,
} from "../../shared/types"
import { migrateVariables } from "../../shared/migrate"
import { useSocket, isElectron } from "./useSocket"

const STORAGE_KEY = "opendeck-config"
const VARS_STORAGE_KEY = "opendeck-variables"
const DISPLAY_IMAGE_KEY = "opendeck-display-image"

export function emptyButton(id: string): DeckButton {
    return { id, label: "", icon: "", action: "" }
}

let nextId = Date.now() % 1_000_000
export function generateId(): string {
    return String(nextId++)
}

function makePage(name: string, columns = DEFAULT_COLUMNS, rows = DEFAULT_ROWS): DeckPage {
    return {
        name,
        columns,
        rows,
        grid: Array.from({ length: columns * rows }, () => emptyButton(generateId())),
    }
}

const defaultPages: DeckPage[] = (() => {
    const main = makePage("Main")
    main.grid[0] = { ...main.grid[0], label: "Stream", icon: "🎬", action: "obs.toggleStreaming", face: { states: [{ when: { key: "obs-control.streaming", truthy: true }, label: "LIVE", color: "#b3261e" }] } }
    main.grid[1] = { ...main.grid[1], label: "Record", icon: "⏺️", action: "obs.toggleRecording", face: { states: [{ when: { key: "obs-control.recording", truthy: true }, label: "REC", color: "#b3261e" }] } }
    main.grid[2] = { ...main.grid[2], label: "Mic", icon: "🎙️", action: "wavelink.toggleInputMute" }
    main.grid[3] = { ...main.grid[3], label: "Scene 1", icon: "1️⃣", action: "obs.switchScene" }
    main.grid[4] = { ...main.grid[4], label: "Scene 2", icon: "2️⃣", action: "obs.switchScene" }
    const media = makePage("Media")
    media.grid[0] = { ...media.grid[0], label: "Play/Pause", icon: "⏯️", action: "media.playPause" }
    media.grid[1] = { ...media.grid[1], label: "Next", icon: "⏭️", action: "media.next" }
    media.grid[2] = { ...media.grid[2], label: "Previous", icon: "⏮️", action: "media.previous" }
    media.grid[3] = { ...media.grid[3], label: "Vol Up", icon: "🔊", action: "media.volumeUp" }
    media.grid[4] = { ...media.grid[4], label: "Vol Down", icon: "🔉", action: "media.volumeDown" }
    media.grid[5] = { ...media.grid[5], label: "Mute", icon: "🔇", action: "media.mute" }
    return [main, media]
})()

/** Guarantee every page has a full grid of slots for its columns × rows */
function normalizePages(pages: DeckPage[]): DeckPage[] {
    return pages.map(page => {
        const columns = page.columns || DEFAULT_COLUMNS
        const rows = page.rows || DEFAULT_ROWS
        const total = columns * rows
        const grid = (page.grid || []).slice(0, Math.max(total, page.grid?.length || 0))
        while (grid.length < total) grid.push(emptyButton(generateId()))
        return { ...page, columns, rows, grid }
    })
}

function loadPages(): DeckPage[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw) {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed) && parsed.length > 0) return normalizePages(parsed)
        }
    } catch { /* use defaults */ }
    return defaultPages
}

function loadVariables(): DeckVariable[] {
    try {
        const raw = localStorage.getItem(VARS_STORAGE_KEY)
        if (raw) {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) return migrateVariables(parsed)
        }
    } catch { /* use defaults */ }
    return []
}

function persist(key: string, value: unknown) {
    try { localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value)) } catch { /* quota */ }
}

interface DeckConfigContextValue {
    pages: DeckPage[]
    currentPageIndex: number
    setCurrentPageIndex: (i: number) => void

    // Buttons
    updateButton: (pageIndex: number, buttonIndex: number, updates: Partial<DeckButton>) => void
    setButton: (pageIndex: number, buttonIndex: number, button: DeckButton) => void
    clearButton: (pageIndex: number, buttonIndex: number) => void
    swapButtons: (pageIndex: number, fromIndex: number, toIndex: number) => void
    duplicateButton: (pageIndex: number, fromIndex: number) => number | null
    toggleButton: (pageIndex: number, buttonIndex: number) => void
    clipboard: DeckButton | null
    copyButton: (button: DeckButton) => void
    pasteButton: (pageIndex: number, buttonIndex: number) => void

    // Pages
    addPage: (name: string) => void
    removePage: (pageIndex: number) => void
    renamePage: (pageIndex: number, name: string) => void
    movePage: (fromIndex: number, toIndex: number) => void
    setPageGrid: (pageIndex: number, columns: number, rows: number) => void

    // Variables (module-scoped)
    variables: DeckVariable[]
    addVariable: (module: string, key: string, value: string, description?: string) => void
    updateVariable: (index: number, updates: Partial<DeckVariable>) => void
    removeVariable: (index: number) => void
    setModuleVariable: (module: string, key: string, value: string) => void
    getModuleVariable: (module: string, key: string) => string | undefined

    displayImage: string
    setDisplayImage: (img: string) => void
}

const DeckConfigContext = createContext<DeckConfigContextValue>(null!)

export function DeckConfigProvider({ children }: { children: ReactNode }) {
    const [pages, setPages] = useState<DeckPage[]>(loadPages)
    const [currentPageIndex, setCurrentPageIndex] = useState(0)
    const [variables, setVariables] = useState<DeckVariable[]>(loadVariables)
    const [displayImage, setDisplayImageState] = useState<string>(() => {
        try { return localStorage.getItem(DISPLAY_IMAGE_KEY) || "" } catch { return "" }
    })
    const [clipboard, setClipboard] = useState<DeckButton | null>(null)
    const { send, subscribe, connected } = useSocket()

    // Set while a config.sync from the server is being applied, so the persist
    // effect below does not echo it straight back. Cleared by that effect.
    const applyingRemote = useRef(false)
    // Do not push anything until the server has told us what it has
    const hydrated = useRef(false)
    // Latest local values, for seeding a server that has no config yet
    const latest = useRef({ pages, variables, displayImage })
    latest.current = { pages, variables, displayImage }

    useEffect(() => {
        return subscribe(message => {
            if (message.type !== "config.sync" || !message.payload) return
            const p = message.payload as { pages?: DeckPage[]; variables?: DeckVariable[]; displayImage?: string }
            const serverHasPages = Array.isArray(p.pages) && p.pages.length > 0
            const serverHasConfig = serverHasPages
                || (Array.isArray(p.variables) && p.variables.length > 0)
                || (typeof p.displayImage === "string" && p.displayImage !== "")
            const firstSync = !hydrated.current
            hydrated.current = true

            if (!serverHasConfig) {
                // Fresh server: keep local config and seed the server with it
                if (firstSync && isElectron) {
                    const l = latest.current
                    send("config.update", undefined, {
                        pages: l.pages as unknown as Record<string, unknown>[],
                        variables: l.variables as unknown as Record<string, unknown>[],
                        displayImage: l.displayImage,
                    })
                }
                return
            }

            applyingRemote.current = true
            if (serverHasPages) setPages(normalizePages(p.pages!))
            if (Array.isArray(p.variables)) setVariables(migrateVariables(p.variables))
            if (typeof p.displayImage === "string") setDisplayImageState(p.displayImage)
            // Safety net in case nothing actually changed and the effect never runs
            setTimeout(() => { applyingRemote.current = false }, 250)
        })
    }, [subscribe, send])

    // Persist locally and push to the server on user-initiated changes
    useEffect(() => {
        persist(STORAGE_KEY, pages)
        persist(VARS_STORAGE_KEY, variables)
        persist(DISPLAY_IMAGE_KEY, displayImage)
        if (applyingRemote.current) {
            applyingRemote.current = false
            return
        }
        if (!isElectron || !hydrated.current || !connected) return
        send("config.update", undefined, {
            pages: pages as unknown as Record<string, unknown>[],
            variables: variables as unknown as Record<string, unknown>[],
            displayImage,
        })
    }, [pages, variables, displayImage, send, connected])

    // ---- buttons ----
    const editPage = useCallback((pageIndex: number, fn: (page: DeckPage) => DeckPage) => {
        setPages(prev => prev.map((p, i) => (i === pageIndex ? fn(p) : p)))
    }, [])

    const updateButton = useCallback((pageIndex: number, buttonIndex: number, updates: Partial<DeckButton>) => {
        editPage(pageIndex, page => ({
            ...page,
            grid: page.grid.map((b, bi) => (bi === buttonIndex ? { ...b, ...updates } : b)),
        }))
    }, [editPage])

    const setButton = useCallback((pageIndex: number, buttonIndex: number, button: DeckButton) => {
        editPage(pageIndex, page => {
            const grid = page.grid.slice()
            while (grid.length <= buttonIndex) grid.push(emptyButton(generateId()))
            grid[buttonIndex] = { ...button, id: grid[buttonIndex].id }
            return { ...page, grid }
        })
    }, [editPage])

    const clearButton = useCallback((pageIndex: number, buttonIndex: number) => {
        editPage(pageIndex, page => ({
            ...page,
            grid: page.grid.map((b, bi) => (bi === buttonIndex ? emptyButton(b.id) : b)),
        }))
    }, [editPage])

    const swapButtons = useCallback((pageIndex: number, fromIndex: number, toIndex: number) => {
        if (fromIndex === toIndex) return
        editPage(pageIndex, page => {
            const grid = page.grid.slice()
            const max = Math.max(fromIndex, toIndex)
            while (grid.length <= max) grid.push(emptyButton(generateId()))
            const a = grid[fromIndex]
            const b = grid[toIndex]
            // Keep ids attached to slots so polled face values stay with the slot
            grid[fromIndex] = { ...b, id: a.id }
            grid[toIndex] = { ...a, id: b.id }
            return { ...page, grid }
        })
    }, [editPage])

    const duplicateButton = useCallback((pageIndex: number, fromIndex: number): number | null => {
        const page = pages[pageIndex]
        if (!page) return null
        const source = page.grid[fromIndex]
        if (!source) return null
        const target = page.grid.findIndex((b, i) => i !== fromIndex && !b.action && !b.label && !b.icon)
        if (target === -1) return null
        setButton(pageIndex, target, { ...source })
        return target
    }, [pages, setButton])

    const toggleButton = useCallback((pageIndex: number, buttonIndex: number) => {
        editPage(pageIndex, page => ({
            ...page,
            grid: page.grid.map((b, bi) => (bi === buttonIndex ? { ...b, disabled: !b.disabled } : b)),
        }))
    }, [editPage])

    const copyButton = useCallback((button: DeckButton) => {
        setClipboard(JSON.parse(JSON.stringify(button)))
    }, [])

    const pasteButton = useCallback((pageIndex: number, buttonIndex: number) => {
        if (!clipboard) return
        setButton(pageIndex, buttonIndex, { ...clipboard })
    }, [clipboard, setButton])

    // ---- pages ----
    const addPage = useCallback((name: string) => {
        setPages(prev => [...prev, makePage(name)])
    }, [])

    const removePage = useCallback((pageIndex: number) => {
        setPages(prev => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== pageIndex)))
        setCurrentPageIndex(prev => Math.max(0, Math.min(prev, pages.length - 2)))
    }, [pages.length])

    const renamePage = useCallback((pageIndex: number, name: string) => {
        editPage(pageIndex, page => ({ ...page, name }))
    }, [editPage])

    const movePage = useCallback((fromIndex: number, toIndex: number) => {
        setPages(prev => {
            if (toIndex < 0 || toIndex >= prev.length || fromIndex === toIndex) return prev
            const next = prev.slice()
            const [moved] = next.splice(fromIndex, 1)
            next.splice(toIndex, 0, moved)
            return next
        })
        setCurrentPageIndex(toIndex)
    }, [])

    const setPageGrid = useCallback((pageIndex: number, columns: number, rows: number) => {
        editPage(pageIndex, page => normalizePages([{ ...page, columns, rows }])[0])
    }, [editPage])

    // ---- variables ----
    const addVariable = useCallback((module: string, key: string, value: string, description?: string) => {
        setVariables(prev => [...prev, { module, key, value, description }])
    }, [])

    const updateVariable = useCallback((index: number, updates: Partial<DeckVariable>) => {
        setVariables(prev => prev.map((v, i) => (i === index ? { ...v, ...updates } : v)))
    }, [])

    const removeVariable = useCallback((index: number) => {
        setVariables(prev => prev.filter((_, i) => i !== index))
    }, [])

    const setModuleVariable = useCallback((module: string, key: string, value: string) => {
        setVariables(prev => {
            const idx = prev.findIndex(v => v.module === module && v.key === key)
            if (idx === -1) return [...prev, { module, key, value }]
            return prev.map((v, i) => (i === idx ? { ...v, value } : v))
        })
    }, [])

    const getModuleVariable = useCallback((module: string, key: string) => {
        return variables.find(v => v.module === module && v.key === key)?.value
    }, [variables])

    const setDisplayImage = useCallback((img: string) => {
        setDisplayImageState(img)
    }, [])

    return (
        <DeckConfigContext.Provider value={{
            pages,
            currentPageIndex,
            setCurrentPageIndex,
            updateButton,
            setButton,
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
            variables,
            addVariable,
            updateVariable,
            removeVariable,
            setModuleVariable,
            getModuleVariable,
            displayImage,
            setDisplayImage,
        }}>
            {children}
        </DeckConfigContext.Provider>
    )
}

export function useDeckConfig() {
    return useContext(DeckConfigContext)
}
