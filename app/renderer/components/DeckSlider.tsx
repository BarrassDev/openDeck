import React, { useCallback, useEffect, useRef, useState } from "react"
import type { DeckButton, SliderWidget } from "../../shared/types"
import { useSocket } from "../hooks/useSocket"
import { useModuleState } from "../hooks/useModuleState"
import { faceStyle, useResolvedFace } from "./ButtonFaceView"

interface DeckSliderProps {
    button: DeckButton
    w: number
    h: number
    /** Preview mode: draws the slider but never sends anything */
    readOnly?: boolean
}

const SEND_INTERVAL_MS = 120
const SETTLE_MS = 900

function toNumber(raw: unknown): number | undefined {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw
    if (typeof raw === "string" && raw.trim() !== "" && !Number.isNaN(Number(raw))) return Number(raw)
    return undefined
}

export default function DeckSlider({ button, w, h, readOnly }: DeckSliderProps) {
    const widget = button.widget as SliderWidget
    const { send } = useSocket()
    const { state } = useModuleState()
    const face = useResolvedFace(button, state)

    const min = widget.min ?? 0
    const max = widget.max ?? 100
    const step = widget.step && widget.step > 0 ? widget.step : 1
    const unit = widget.unit ?? ""
    const vertical = widget.orientation === "vertical" || (widget.orientation !== "horizontal" && h > w)
    const remote = widget.stateKey ? toNumber(state[widget.stateKey]) : undefined

    const [local, setLocal] = useState<number | null>(null)
    const dragging = useRef(false)
    const lastSent = useRef(0)
    const pendingTimer = useRef<ReturnType<typeof setTimeout>>()
    const settleTimer = useRef<ReturnType<typeof setTimeout>>()
    const trackRef = useRef<HTMLDivElement>(null)

    const value = local ?? remote ?? min
    const ratio = max === min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)))

    const valueFromEvent = useCallback((e: React.PointerEvent | PointerEvent): number => {
        const el = trackRef.current
        if (!el) return value
        const rect = el.getBoundingClientRect()
        const p = vertical
            ? 1 - (e.clientY - rect.top) / Math.max(1, rect.height)
            : (e.clientX - rect.left) / Math.max(1, rect.width)
        const raw = min + Math.max(0, Math.min(1, p)) * (max - min)
        const stepped = Math.round(raw / step) * step
        const decimals = (String(step).split(".")[1] || "").length
        return Math.max(min, Math.min(max, Number(stepped.toFixed(decimals))))
    }, [vertical, min, max, step, value])

    const sendValue = useCallback((v: number, final: boolean) => {
        if (readOnly || !button.action) return
        const doSend = () => {
            lastSent.current = Date.now()
            send("button.press", button.action, {
                buttonId: button.id,
                ...(button.payload || {}),
                [widget.valueParam || "value"]: v,
                __pressType: "slider",
            })
        }
        clearTimeout(pendingTimer.current)
        if (final || Date.now() - lastSent.current >= SEND_INTERVAL_MS) doSend()
        else pendingTimer.current = setTimeout(doSend, SEND_INTERVAL_MS)
    }, [readOnly, button.action, button.id, button.payload, widget.valueParam, send])

    const onDown = (e: React.PointerEvent) => {
        if (readOnly || (e.button !== undefined && e.button !== 0)) return
        e.preventDefault()
        ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
        dragging.current = true
        clearTimeout(settleTimer.current)
        const v = valueFromEvent(e)
        setLocal(v)
        sendValue(v, false)
    }
    const onMove = (e: React.PointerEvent) => {
        if (!dragging.current) return
        const v = valueFromEvent(e)
        setLocal(v)
        sendValue(v, false)
    }
    const onUp = (e: React.PointerEvent) => {
        if (!dragging.current) return
        dragging.current = false
        const v = valueFromEvent(e)
        setLocal(v)
        sendValue(v, true)
        // Keep the dragged value briefly so the remote state can catch up without a jump
        settleTimer.current = setTimeout(() => setLocal(null), SETTLE_MS)
    }

    useEffect(() => () => {
        clearTimeout(pendingTimer.current)
        clearTimeout(settleTimer.current)
    }, [])

    const display = `${Number.isInteger(value) ? value : value.toFixed(1)}${unit}`
    const style = faceStyle(face)

    return (
        <div
            className={`sd-widget sd-slider ${vertical ? "vertical" : "horizontal"}${readOnly ? " readonly" : ""}${face.color ? " custom-bg" : ""}`}
            style={style}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onContextMenu={e => e.preventDefault()}
            role="slider"
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={value}
            aria-label={face.label || button.action}
        >
            <div className="sd-slider-head">
                {face.icon && face.iconType === "emoji" && <span className="sd-slider-icon">{face.icon}</span>}
                {face.label && <span className="sd-slider-label">{face.label}</span>}
                {widget.showValue !== false && <span className="sd-slider-value">{display}</span>}
            </div>
            <div className="sd-slider-track" ref={trackRef}>
                <div className="sd-slider-fill" style={vertical ? { height: `${ratio * 100}%` } : { width: `${ratio * 100}%` }} />
                <div className="sd-slider-thumb" style={vertical ? { bottom: `${ratio * 100}%` } : { left: `${ratio * 100}%` }} />
            </div>
        </div>
    )
}
