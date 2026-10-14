import React, { useState } from "react"
import { DEFAULT_COLUMNS, DEFAULT_ROWS, type DeckButton as DeckButtonType } from "../../shared/types"
import { layoutGrid, hasContent, placementStyle } from "../../shared/layout"
import { useModuleState } from "../hooks/useModuleState"
import { faceStyle, useResolvedFace } from "./ButtonFaceView"
import WidgetBody from "./WidgetBody"
import DeckSlider from "./DeckSlider"

interface PreviewGridProps {
    buttons: DeckButtonType[]
    columns?: number
    rows?: number
    selectedIndex: number | null
    onSelect: (index: number) => void
    /** Called when a button is dragged onto another slot */
    onSwap?: (fromIndex: number, toIndex: number) => void
}

export default function PreviewGrid({
    buttons,
    columns = DEFAULT_COLUMNS,
    rows = DEFAULT_ROWS,
    selectedIndex,
    onSelect,
    onSwap,
}: PreviewGridProps) {
    const slots = layoutGrid(buttons, columns, rows)
    const [dragFrom, setDragFrom] = useState<number | null>(null)
    const [dragOver, setDragOver] = useState<number | null>(null)

    const dragProps = (index: number, draggable: boolean) => ({
        draggable: draggable && !!onSwap,
        onDragStart: (e: React.DragEvent) => {
            if (!draggable) return
            setDragFrom(index)
            e.dataTransfer.effectAllowed = "move"
            e.dataTransfer.setData("text/plain", String(index))
        },
        onDragEnd: () => { setDragFrom(null); setDragOver(null) },
        onDragOver: (e: React.DragEvent) => {
            if (dragFrom === null) return
            e.preventDefault()
            e.dataTransfer.dropEffect = "move"
            if (dragOver !== index) setDragOver(index)
        },
        onDragLeave: () => { if (dragOver === index) setDragOver(null) },
        onDrop: (e: React.DragEvent) => {
            e.preventDefault()
            const from = dragFrom ?? Number(e.dataTransfer.getData("text/plain"))
            setDragFrom(null)
            setDragOver(null)
            if (Number.isInteger(from) && from !== index && onSwap) {
                onSwap(from, index)
                onSelect(index)
            }
        },
    })

    return (
        <div
            className="sd-grid"
            style={{
                gridTemplateColumns: `repeat(${columns}, 1fr)`,
                gridTemplateRows: `repeat(${rows}, 1fr)`,
            }}
        >
            {slots.map(slot => {
                const key = slot.button?.id || `empty-${slot.index}`
                if (slot.covered) {
                    return <div key={key} className="sd-grid-slot covered" style={placementStyle(slot)} aria-hidden />
                }
                const index = slot.index
                const button = slot.button
                const isSelected = selectedIndex === index
                const content = hasContent(button)
                const classes = [
                    "sd-grid-slot",
                    slot.w > 1 || slot.h > 1 ? "span" : "",
                    dragOver === index && dragFrom !== index ? "drop-target" : "",
                    dragFrom === index ? "dragging" : "",
                ].filter(Boolean).join(" ")
                return (
                    <div key={key} className={classes} style={placementStyle(slot)} {...dragProps(index, content)}>
                        {button && content ? (
                            <PreviewTile button={button} w={slot.w} h={slot.h} selected={isSelected} onClick={() => onSelect(index)} />
                        ) : (
                            <button
                                type="button"
                                className={`sd-button-empty preview-empty ${isSelected ? "selected" : ""}`}
                                onClick={() => onSelect(index)}
                                aria-label={`Empty slot ${index + 1}`}
                            >
                                <span className="preview-empty-plus">+</span>
                            </button>
                        )}
                    </div>
                )
            })}
        </div>
    )
}

function PreviewTile({
    button,
    w,
    h,
    selected,
    onClick,
}: {
    button: DeckButtonType
    w: number
    h: number
    selected: boolean
    onClick: () => void
}) {
    const { state } = useModuleState()
    const face = useResolvedFace(button, state)
    const classes = `preview-button ${selected ? "selected" : ""} ${button.disabled ? "preview-disabled" : ""}`

    if (button.widget?.type === "slider") {
        return (
            <div className={`preview-slider-wrap ${classes}`} onClick={onClick} title={button.action || "No action"}>
                <DeckSlider button={button} w={w} h={h} readOnly />
                {!button.action && <span className="preview-warn" title="No action assigned">!</span>}
            </div>
        )
    }

    return (
        <button
            type="button"
            className={`sd-button ${classes}${face.fill ? " fill" : ""}${face.color ? " custom-bg" : ""}${button.widget ? ` widget-${button.widget.type}` : ""}`}
            style={faceStyle(face)}
            onClick={onClick}
            title={button.action || (button.widget ? `${button.widget.type} widget` : "No action")}
        >
            <WidgetBody button={button} face={face} state={state} />
            {!button.action && !button.widget && <span className="preview-warn" title="No action assigned">!</span>}
        </button>
    )
}
