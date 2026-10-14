import React from "react"
import DeckButton from "./DeckButton"
import DeckSlider from "./DeckSlider"
import { DEFAULT_COLUMNS, DEFAULT_ROWS, type DeckButton as DeckButtonType } from "../../shared/types"
import { layoutGrid, isLiveSlot, placementStyle } from "../../shared/layout"

interface GridProps {
    buttons: DeckButtonType[]
    columns?: number
    rows?: number
}

export default function Grid({ buttons, columns = DEFAULT_COLUMNS, rows = DEFAULT_ROWS }: GridProps) {
    const slots = layoutGrid(buttons, columns, rows)

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
                const button = slot.button
                const spanClass = slot.w > 1 || slot.h > 1 ? " span" : ""
                return (
                    <div key={key} className={`sd-grid-slot${spanClass}`} style={placementStyle(slot)}>
                        {button && isLiveSlot(button) ? (
                            button.widget?.type === "slider"
                                ? <DeckSlider button={button} w={slot.w} h={slot.h} />
                                : <DeckButton button={button} />
                        ) : (
                            <div className="sd-button-empty" />
                        )}
                    </div>
                )
            })}
        </div>
    )
}
