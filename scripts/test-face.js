// Unit tests for the pure face resolver and config migration.
// Run: npm run build:electron && npm test
const assert = require("assert")
const path = require("path")

const face = require(path.join(__dirname, "..", "dist", "electron", "shared", "face.js"))
const { resolveFace, renderTemplate, readPath } = face

let passed = 0
function test(name, fn) {
    try {
        fn()
        passed++
        console.log(`  ok  ${name}`)
    } catch (err) {
        console.error(`FAIL  ${name}\n      ${err.message}`)
        process.exitCode = 1
    }
}

const base = { id: "7", label: "Mic", icon: "🎙️", action: "obs.toggleMute" }

test("plain button keeps its own icon and label", () => {
    const r = resolveFace(base, {})
    assert.strictEqual(r.icon, "🎙️")
    assert.strictEqual(r.iconType, "emoji")
    assert.strictEqual(r.label, "Mic")
    assert.strictEqual(r.showLabel, true)
    assert.strictEqual(r.labelPosition, "bottom")
})

test("hideLabel hides the label", () => {
    const r = resolveFace({ ...base, hideLabel: true }, {})
    assert.strictEqual(r.showLabel, false)
    assert.strictEqual(r.labelPosition, "hidden")
})

test("template renders state keys", () => {
    assert.strictEqual(renderTemplate("Scene: {{obs-control.currentScene}}", { "obs-control.currentScene": "Main" }, "7"), "Scene: Main")
})

test("{{value}} reads the button's polled value", () => {
    assert.strictEqual(renderTemplate("{{value}}", { "button.7.value": "https://img/x.png" }, "7"), "https://img/x.png")
})

test("missing keys render empty", () => {
    assert.strictEqual(renderTemplate("[{{nope}}]", {}, "7"), "[]")
})

test("imageTemplate switches the face to an image", () => {
    const r = resolveFace({ ...base, face: { imageTemplate: "{{value}}" } }, { "button.7.value": "https://img/a.jpg" })
    assert.strictEqual(r.iconType, "image")
    assert.strictEqual(r.icon, "https://img/a.jpg")
})

test("empty imageTemplate result falls back to the static icon", () => {
    const r = resolveFace({ ...base, face: { imageTemplate: "{{value}}" } }, {})
    assert.strictEqual(r.icon, "🎙️")
    assert.strictEqual(r.iconType, "emoji")
})

test("labelTemplate overrides the label when it renders non-empty", () => {
    const r = resolveFace({ ...base, face: { labelTemplate: "{{wavelink.input.Wave:3.gain}}%" } }, { "wavelink.input.Wave:3.gain": 42 })
    assert.strictEqual(r.label, "42%")
})

test("state override applies when truthy", () => {
    const r = resolveFace(
        { ...base, face: { states: [{ when: { key: "obs-control.muted.Mic", truthy: true }, icon: "🔇", color: "#f04747", label: "Muted" }] } },
        { "obs-control.muted.Mic": true },
    )
    assert.strictEqual(r.icon, "🔇")
    assert.strictEqual(r.color, "#f04747")
    assert.strictEqual(r.label, "Muted")
})

test("state override does not apply when falsy", () => {
    const r = resolveFace(
        { ...base, face: { color: "#222", states: [{ when: { key: "obs-control.muted.Mic", truthy: true }, icon: "🔇" }] } },
        { "obs-control.muted.Mic": false },
    )
    assert.strictEqual(r.icon, "🎙️")
    assert.strictEqual(r.color, "#222")
})

test("equals condition compares as strings", () => {
    const r = resolveFace(
        { ...base, face: { states: [{ when: { key: "obs-control.currentScene", equals: "BRB" }, label: "On BRB" }] } },
        { "obs-control.currentScene": "BRB" },
    )
    assert.strictEqual(r.label, "On BRB")
})

test("empty equals matches only an empty value", () => {
    const btn = { ...base, face: { states: [{ when: { key: "k", equals: "" }, label: "EMPTY" }] } }
    assert.strictEqual(resolveFace(btn, { k: "Main" }).label, "Mic")
    assert.strictEqual(resolveFace(btn, { k: "" }).label, "EMPTY")
})

test("first matching state wins", () => {
    const r = resolveFace(
        { ...base, face: { states: [
            { when: { key: "a" }, label: "A" },
            { when: { key: "b" }, label: "B" },
        ] } },
        { a: true, b: true },
    )
    assert.strictEqual(r.label, "A")
})

test("fill requires an image", () => {
    assert.strictEqual(resolveFace({ ...base, fillImage: true }, {}).fill, false)
    assert.strictEqual(resolveFace({ ...base, fillImage: true, icon: "https://x/y.png", iconType: "image" }, {}).fill, true)
})

test("readPath walks objects and arrays", () => {
    const data = { item: { album: { images: [{ url: "first" }, { url: "second" }] } } }
    assert.strictEqual(readPath(data, "item.album.images.1.url"), "second")
    assert.strictEqual(readPath(data, "item.missing.url"), undefined)
    assert.strictEqual(readPath("raw", ""), "raw")
})

const layout = require(path.join(__dirname, "..", "dist", "electron", "shared", "layout.js"))

test("1x1 buttons place one per slot", () => {
    const slots = layout.layoutGrid([{ id: "a", label: "", icon: "", action: "x" }], 5, 3)
    assert.strictEqual(slots.length, 15)
    assert.strictEqual(slots.filter(s => s.covered).length, 0)
})

test("a 2x2 tile covers the slots to its right and below", () => {
    const grid = Array.from({ length: 15 }, (_, i) => ({ id: String(i), label: "", icon: "", action: "" }))
    grid[0].span = { w: 2, h: 2 }
    const slots = layout.layoutGrid(grid, 5, 3)
    assert.deepStrictEqual(slots.filter(s => s.covered).map(s => s.index), [1, 5, 6])
    assert.strictEqual(slots[0].w, 2)
    assert.strictEqual(slots[0].h, 2)
    assert.strictEqual(slots[1].coveredBy, 0)
})

test("spans are clipped at the grid edge", () => {
    const grid = Array.from({ length: 15 }, (_, i) => ({ id: String(i), label: "", icon: "", action: "" }))
    grid[4].span = { w: 3, h: 5 }
    const slots = layout.layoutGrid(grid, 5, 3)
    assert.strictEqual(slots[4].w, 1)
    assert.strictEqual(slots[4].h, 3)
    assert.deepStrictEqual(slots.filter(s => s.covered).map(s => s.index), [9, 14])
})

test("a covered slot cannot cover others itself", () => {
    const grid = Array.from({ length: 15 }, (_, i) => ({ id: String(i), label: "", icon: "", action: "" }))
    grid[0].span = { w: 2, h: 1 }
    grid[1].span = { w: 3, h: 3 }
    const slots = layout.layoutGrid(grid, 5, 3)
    assert.deepStrictEqual(slots.filter(s => s.covered).map(s => s.index), [1])
})

test("placementStyle spans columns and rows", () => {
    const style = layout.placementStyle({ index: 0, button: null, col: 1, row: 2, w: 3, h: 1, covered: false })
    assert.strictEqual(style.gridColumn, "2 / span 3")
    assert.strictEqual(style.gridRow, "3 / span 1")
    assert.strictEqual(style.aspectRatio, "auto")
})

const configStore = (() => {
    // config-store imports electron; test the migration function via a stub
    const Module = require("module")
    const original = Module._load
    Module._load = function (request, ...rest) {
        if (request === "electron") return { app: { getPath: () => __dirname } }
        return original.call(this, request, ...rest)
    }
    try {
        return require(path.join(__dirname, "..", "dist", "electron", "electron", "config-store.js"))
    } finally {
        Module._load = original
    }
})()

test("legacy obs variables migrate to the obs-control module", () => {
    const out = configStore.migrateVariables([
        { key: "obs_host", value: "ws://1.2.3.4:4455" },
        { key: "obs_password", value: "pw" },
        { key: "api_key", value: "abc" },
        { key: "already", value: "x", module: "wavelink" },
    ])
    assert.deepStrictEqual(out[0], { key: "host", value: "ws://1.2.3.4:4455", module: "obs-control" })
    assert.deepStrictEqual(out[1], { key: "password", value: "pw", module: "obs-control" })
    assert.strictEqual(out[2].module, "")
    assert.strictEqual(out[3].module, "wavelink")
})

console.log(`\n${passed} test(s) passed${process.exitCode ? ", with failures" : ""}`)
