import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Turns a remote browser tab into a kiosk-style control surface:
 *  - keeps the screen awake (Screen Wake Lock API, re-acquired after the tab is hidden/shown)
 *  - enters fullscreen on the first user gesture (browsers require one), unless the page
 *    is already running as an installed PWA (display-mode: standalone)
 *  - blocks pinch-zoom, double-tap zoom, pull-to-refresh and the long-press context menu
 */
export function useKioskMode(enabled: boolean) {
    const wakeLockRef = useRef<WakeLockSentinel | null>(null)
    const [wakeLockActive, setWakeLockActive] = useState(false)
    const [isFullscreen, setIsFullscreen] = useState(false)
    const [isStandalone] = useState(() => {
        if (typeof window === "undefined") return false
        const mq = window.matchMedia?.("(display-mode: standalone)").matches
        const iosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true
        return !!mq || iosStandalone
    })

    const wakeLockSupported = typeof navigator !== "undefined" && "wakeLock" in navigator
    const fullscreenSupported = typeof document !== "undefined" && (
        document.fullscreenEnabled || (document as any).webkitFullscreenEnabled
    )

    // ---- wake lock ----
    const requestWakeLock = useCallback(async () => {
        if (!enabled || !wakeLockSupported || document.visibilityState !== "visible") return
        if (wakeLockRef.current) return
        try {
            const sentinel = await navigator.wakeLock.request("screen")
            wakeLockRef.current = sentinel
            setWakeLockActive(true)
            sentinel.addEventListener("release", () => {
                wakeLockRef.current = null
                setWakeLockActive(false)
            })
        } catch (err) {
            // Typically NotAllowedError when the tab is not visible or on low battery
            console.warn("Wake lock unavailable:", err)
            setWakeLockActive(false)
        }
    }, [enabled, wakeLockSupported])

    useEffect(() => {
        if (!enabled) return
        void requestWakeLock()
        const onVisibility = () => { if (document.visibilityState === "visible") void requestWakeLock() }
        document.addEventListener("visibilitychange", onVisibility)
        // Some browsers silently drop the lock; re-check periodically
        const timer = setInterval(() => { if (!wakeLockRef.current) void requestWakeLock() }, 30_000)
        return () => {
            document.removeEventListener("visibilitychange", onVisibility)
            clearInterval(timer)
            wakeLockRef.current?.release().catch(() => { })
            wakeLockRef.current = null
            setWakeLockActive(false)
        }
    }, [enabled, requestWakeLock])

    // ---- fullscreen ----
    const enterFullscreen = useCallback(async () => {
        const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }
        try {
            if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" } as FullscreenOptions)
            else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen()
        } catch (err) {
            console.warn("Fullscreen request failed:", err)
        }
    }, [])

    const exitFullscreen = useCallback(async () => {
        const d = document as Document & { webkitExitFullscreen?: () => Promise<void> }
        try {
            if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen()
            else if ((d as any).webkitFullscreenElement && d.webkitExitFullscreen) await d.webkitExitFullscreen()
        } catch (err) {
            console.warn("Exit fullscreen failed:", err)
        }
    }, [])

    const toggleFullscreen = useCallback(() => {
        if (isFullscreen) void exitFullscreen()
        else void enterFullscreen()
    }, [isFullscreen, enterFullscreen, exitFullscreen])

    useEffect(() => {
        const update = () => {
            setIsFullscreen(!!(document.fullscreenElement || (document as any).webkitFullscreenElement))
        }
        update()
        document.addEventListener("fullscreenchange", update)
        document.addEventListener("webkitfullscreenchange", update)
        return () => {
            document.removeEventListener("fullscreenchange", update)
            document.removeEventListener("webkitfullscreenchange", update)
        }
    }, [])

    // Auto-enter fullscreen on the first gesture (not needed when installed as a PWA)
    useEffect(() => {
        if (!enabled || isStandalone || !fullscreenSupported) return
        let done = false
        const onGesture = () => {
            if (done) return
            done = true
            if (!document.fullscreenElement) void enterFullscreen()
            cleanup()
        }
        const cleanup = () => {
            document.removeEventListener("pointerup", onGesture)
            document.removeEventListener("touchend", onGesture)
            document.removeEventListener("keydown", onGesture)
        }
        document.addEventListener("pointerup", onGesture)
        document.addEventListener("touchend", onGesture)
        document.addEventListener("keydown", onGesture)
        return cleanup
    }, [enabled, isStandalone, fullscreenSupported, enterFullscreen])

    // ---- gesture blocking ----
    useEffect(() => {
        if (!enabled) return
        const prevent = (e: Event) => e.preventDefault()
        const preventPinch = (e: TouchEvent) => { if (e.touches.length > 1) e.preventDefault() }
        // Double-tap zoom is handled by CSS (touch-action: manipulation on body.kiosk)
        document.addEventListener("contextmenu", prevent)
        document.addEventListener("gesturestart", prevent)
        document.addEventListener("touchmove", preventPinch, { passive: false })
        document.body.classList.add("kiosk")
        return () => {
            document.removeEventListener("contextmenu", prevent)
            document.removeEventListener("gesturestart", prevent)
            document.removeEventListener("touchmove", preventPinch)
            document.body.classList.remove("kiosk")
        }
    }, [enabled])

    return {
        isStandalone,
        isFullscreen,
        fullscreenSupported: !!fullscreenSupported,
        toggleFullscreen,
        wakeLockSupported,
        wakeLockActive,
    }
}
