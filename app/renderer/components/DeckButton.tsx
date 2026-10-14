import React, { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { useSocket } from "../hooks/useSocket"
import { useModuleState } from "../hooks/useModuleState"
import { LONG_PRESS_MS, type DeckButton as DeckButtonType, type ButtonAction } from "../../shared/types"
import { faceStyle, useResolvedFace } from "./ButtonFaceView"
import WidgetBody from "./WidgetBody"

export { ButtonFaceView, faceStyle, useResolvedFace } from "./ButtonFaceView"

type Feedback = "idle" | "success" | "error"

interface DeckButtonProps {
    button: DeckButtonType
}

export default function DeckButton({ button }: DeckButtonProps) {
    const { id, action, payload, pressMode = "tap", releaseAction, longPressAction, sequence } = button
    const { send, subscribe } = useSocket()
    const { state } = useModuleState()
    const face = useResolvedFace(button, state)

    const [feedback, setFeedback] = useState<Feedback>("idle")
    const [pressed, setPressed] = useState(false)
    const feedbackTimer = useRef<ReturnType<typeof setTimeout>>()
    const longTimer = useRef<ReturnType<typeof setTimeout>>()
    const longFired = useRef(false)
    const isDown = useRef(false)

    const fire = useCallback((step: ButtonAction | undefined, pressType: string, extra?: ButtonAction[]) => {
        if (!step || !step.action) return
        setFeedback("idle")
        send("button.press", step.action, {
            buttonId: id,
            ...(step.payload || {}),
            __pressType: pressType,
            ...(extra && extra.length ? { __sequence: extra } : {}),
        })
    }, [send, id])

    const primary: ButtonAction = useMemo(() => ({ action, payload }), [action, payload])
    const interactive = !!action || !!longPressAction || !!releaseAction

    const handleDown = (e: React.PointerEvent) => {
        if (!interactive) return
        if (e.button !== undefined && e.button !== 0) return
        isDown.current = true
        longFired.current = false
        setPressed(true)
        ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)

        if (pressMode === "tap") {
            fire(primary, "tap", sequence)
        } else if (pressMode === "hold") {
            fire(primary, "down", sequence)
        } else if (pressMode === "long") {
            clearTimeout(longTimer.current)
            longTimer.current = setTimeout(() => {
                if (!isDown.current) return
                longFired.current = true
                if (navigator.vibrate) navigator.vibrate(20)
                fire(longPressAction, "long")
            }, LONG_PRESS_MS)
        }
    }

    const handleUp = () => {
        if (!isDown.current) return
        isDown.current = false
        setPressed(false)
        clearTimeout(longTimer.current)

        if (pressMode === "hold") {
            fire(releaseAction, "up")
        } else if (pressMode === "long" && !longFired.current) {
            fire(primary, "tap", sequence)
        }
    }

    const handleCancel = () => {
        if (!isDown.current) return
        isDown.current = false
        setPressed(false)
        clearTimeout(longTimer.current)
        if (pressMode === "hold") fire(releaseAction, "up")
    }

    useEffect(() => {
        return subscribe(message => {
            if (message.type !== "button.feedback") return
            const p = message.payload || {}
            const mine = p.buttonId ? p.buttonId === id : p.action === action
            if (!mine) return
            const status = p.status as string
            if (status === "success" || status === "error") {
                setFeedback(status)
                clearTimeout(feedbackTimer.current)
                feedbackTimer.current = setTimeout(() => setFeedback("idle"), 1200)
            }
        })
    }, [subscribe, id, action])

    useEffect(() => () => {
        clearTimeout(feedbackTimer.current)
        clearTimeout(longTimer.current)
    }, [])

    const widgetClass = button.widget ? ` widget-${button.widget.type}` : ""

    return (
        <button
            className={`sd-button ${feedback} ${pressed ? "pressed" : ""}${face.fill ? " fill" : ""}${face.color ? " custom-bg" : ""}${interactive ? "" : " static"}${widgetClass}`}
            style={faceStyle(face)}
            onPointerDown={handleDown}
            onPointerUp={handleUp}
            onPointerCancel={handleCancel}
            onPointerLeave={handleCancel}
            onContextMenu={e => e.preventDefault()}
            aria-label={face.label || action}
        >
            <WidgetBody button={button} face={face} state={state} />
            {pressMode === "long" && <span className="sd-button-badge" aria-hidden>⏱</span>}
        </button>
    )
}
