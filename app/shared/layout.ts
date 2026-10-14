import { DEFAULT_COLUMNS, DEFAULT_ROWS, MAX_SPAN, type DeckButton } from "./types"

export interface PlacedSlot {
    /** Slot index in the page grid array */
    index: number
    button: DeckButton | null
    col: number
    row: number
    w: number
    h: number
    /** True when another (earlier) slot spans over this one; it is not rendered */
    covered: boolean
    coveredBy?: number
}

function clampInt(n: unknown, min: number, max: number): number {
    const v = Math.floor(Number(n))
    if (!Number.isFinite(v)) return min
    return Math.max(min, Math.min(max, v))
}

/** Effective span for a button at a position, clamped to the grid edges */
export function spanOf(button: DeckButton | null | undefined, col: number, row: number, columns: number, rows: number) {
    const w = clampInt(button?.span?.w ?? 1, 1, Math.min(MAX_SPAN, columns - col))
    const h = clampInt(button?.span?.h ?? 1, 1, Math.min(MAX_SPAN, rows - row))
    return { w, h }
}

/**
 * Place every slot of a page. Slots are processed in order; a slot that spans extra
 * cells covers the later slots underneath, which are returned with `covered: true`
 * (their buttons stay in the config but are hidden).
 */
export function layoutGrid(
    buttons: (DeckButton | null | undefined)[],
    columns: number = DEFAULT_COLUMNS,
    rows: number = DEFAULT_ROWS,
): PlacedSlot[] {
    const total = columns * rows
    const coveredBy = new Map<number, number>()
    const out: PlacedSlot[] = []
    for (let i = 0; i < total; i++) {
        const col = i % columns
        const row = Math.floor(i / columns)
        const button = buttons[i] || null
        if (coveredBy.has(i)) {
            out.push({ index: i, button, col, row, w: 1, h: 1, covered: true, coveredBy: coveredBy.get(i) })
            continue
        }
        const { w, h } = spanOf(button, col, row, columns, rows)
        for (let dr = 0; dr < h; dr++) {
            for (let dc = 0; dc < w; dc++) {
                if (dr === 0 && dc === 0) continue
                const j = (row + dr) * columns + col + dc
                if (!coveredBy.has(j)) coveredBy.set(j, i)
            }
        }
        out.push({ index: i, button, col, row, w, h, covered: false })
    }
    return out
}

/** Whether a slot shows something on the live deck */
export function isLiveSlot(button: DeckButton | null | undefined): boolean {
    return !!button && !button.disabled && (!!button.action || !!button.widget)
}

/** Whether a slot has any content worth showing in the editor */
export function hasContent(button: DeckButton | null | undefined): boolean {
    return !!button && !!(button.action || button.label || button.icon || button.widget)
}

/** Inline grid placement style for a placed slot */
export function placementStyle(slot: PlacedSlot): Record<string, string | number> {
    const style: Record<string, string | number> = {
        gridColumn: `${slot.col + 1} / span ${slot.w}`,
        gridRow: `${slot.row + 1} / span ${slot.h}`,
    }
    if (slot.w > 1 || slot.h > 1) style.aspectRatio = "auto"
    return style
}
