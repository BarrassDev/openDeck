// OBS Control Module (API v2) — persistent connection to OBS via obs-websocket-js (v5)
// Requires OBS 28+ with WebSocket Server enabled (Tools → WebSocket Server Settings).
//
// Settings (Settings → Modules → obs-control):
//   host        ws://localhost:4455
//   password    (optional)
//   autoConnect "true" | "false" — connect at startup and keep reconnecting
//
// Published state (prefix "obs-control."):
//   connected, streaming, recording, recordingPaused, replayBuffer, virtualCam,
//   studioMode, currentScene, previewScene, muted.<input>, volume.<input> (dB)

let OBSWebSocket = null
let obs = null
let connected = false
let connecting = null
let reconnectTimer = null
let statsTimer = null
let lastBytes = null
let wantConnection = false
let moduleCtx = null
// Bumped by disconnect(); an in-flight connect() that sees a newer generation discards itself
let generation = 0

const RECONNECT_MS = 5000

async function loadLib() {
    if (OBSWebSocket) return
    const mod = await import("obs-websocket-js")
    OBSWebSocket = mod.default || mod.OBSWebSocket
}

function readSettings(ctx) {
    const s = (ctx && ctx.settings) || {}
    return {
        host: (s.host || "").trim() || "ws://127.0.0.1:4455",
        password: (s.password || "").trim() || undefined,
        autoConnect: String(s.autoConnect ?? "true").toLowerCase() !== "false",
    }
}

function scheduleReconnect(ctx) {
    if (reconnectTimer || !wantConnection) return
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        if (!wantConnection || connected) return
        connect(ctx).catch(() => { /* status already reported */ })
    }, RECONNECT_MS)
}

const STATS_MS = 2000

function stopStats(ctx) {
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null }
    lastBytes = null
    for (const key of ["streamTime", "recordTime", "fps", "cpu", "bitrateKbps", "droppedFrames"]) ctx.setState(key, undefined)
}

async function pollStats(ctx) {
    const client = obs
    if (!client || !connected) return
    try {
        if (ctx.getState("streaming")) {
            const s = await client.call("GetStreamStatus")
            ctx.setState("streamTime", String(s.outputTimecode || "").replace(/\.\d+$/, ""))
            if (lastBytes && typeof s.outputBytes === "number") {
                const kbps = Math.max(0, Math.round(((s.outputBytes - lastBytes.bytes) * 8) / Math.max(1, Date.now() - lastBytes.at)))
                ctx.setState("bitrateKbps", kbps)
            }
            if (typeof s.outputBytes === "number") lastBytes = { bytes: s.outputBytes, at: Date.now() }
            ctx.setState("droppedFrames", s.outputSkippedFrames || 0)
        } else {
            ctx.setState("streamTime", undefined)
            ctx.setState("bitrateKbps", undefined)
            lastBytes = null
        }
        if (ctx.getState("recording")) {
            const r = await client.call("GetRecordStatus")
            ctx.setState("recordTime", String(r.outputTimecode || "").replace(/\.\d+$/, ""))
        } else {
            ctx.setState("recordTime", undefined)
        }
        const stats = await client.call("GetStats")
        ctx.setState("fps", Math.round(stats.activeFps || 0))
        ctx.setState("cpu", Math.round((stats.cpuUsage || 0) * 10) / 10)
    } catch (err) {
        ctx.warn("stats poll:", err && err.message)
    }
}

function startStats(ctx) {
    stopStats(ctx)
    statsTimer = setInterval(() => { pollStats(ctx).catch(() => {}) }, STATS_MS)
}

function markDisconnected(ctx, reason) {
    connected = false
    obs = null
    stopStats(ctx)
    ctx.setState("connected", false)
    ctx.setStatus({ connected: false, message: reason })
}

function wireEvents(client, ctx) {
    client.on("ConnectionClosed", () => {
        markDisconnected(ctx, "Connection closed")
        scheduleReconnect(ctx)
    })
    client.on("ConnectionError", (err) => {
        ctx.warn("Connection error:", err && err.message)
    })
    client.on("CurrentProgramSceneChanged", (e) => ctx.setState("currentScene", e.sceneName))
    client.on("CurrentPreviewSceneChanged", (e) => ctx.setState("previewScene", e.sceneName))
    client.on("StreamStateChanged", (e) => ctx.setState("streaming", !!e.outputActive))
    client.on("RecordStateChanged", (e) => {
        ctx.setState("recording", !!e.outputActive)
        if (e.outputState === "OBS_WEBSOCKET_OUTPUT_PAUSED") ctx.setState("recordingPaused", true)
        if (e.outputState === "OBS_WEBSOCKET_OUTPUT_RESUMED" || !e.outputActive) ctx.setState("recordingPaused", false)
    })
    client.on("ReplayBufferStateChanged", (e) => ctx.setState("replayBuffer", !!e.outputActive))
    client.on("VirtualcamStateChanged", (e) => ctx.setState("virtualCam", !!e.outputActive))
    client.on("StudioModeStateChanged", (e) => ctx.setState("studioMode", !!e.studioModeEnabled))
    client.on("InputMuteStateChanged", (e) => ctx.setState(`muted.${e.inputName}`, !!e.inputMuted))
    client.on("InputVolumeChanged", (e) => ctx.setState(`volume.${e.inputName}`, round(e.inputVolumeDb)))
    client.on("InputNameChanged", (e) => {
        ctx.setState(`muted.${e.oldInputName}`, undefined)
        ctx.setState(`volume.${e.oldInputName}`, undefined)
        refreshInputs(ctx).catch(() => {})
    })
    client.on("InputRemoved", (e) => {
        ctx.setState(`muted.${e.inputName}`, undefined)
        ctx.setState(`volume.${e.inputName}`, undefined)
    })
    client.on("InputCreated", () => refreshInputs(ctx).catch(() => {}))
}

function round(n) {
    return typeof n === "number" ? Math.round(n * 10) / 10 : n
}

async function refreshInputs(ctx) {
    const client = obs
    if (!client) return
    const { inputs } = await client.call("GetInputList")
    for (const input of inputs || []) {
        try {
            const mute = await client.call("GetInputMute", { inputName: input.inputName })
            ctx.setState(`muted.${input.inputName}`, !!mute.inputMuted)
            const vol = await client.call("GetInputVolume", { inputName: input.inputName })
            ctx.setState(`volume.${input.inputName}`, round(vol.inputVolumeDb))
        } catch {
            // Not an audio input — ignore
        }
    }
}

async function refreshState(ctx) {
    const client = obs
    if (!client) return
    const safe = async (fn) => { try { await fn() } catch (err) { ctx.warn("state refresh:", err.message) } }
    await safe(async () => ctx.setState("streaming", !!(await client.call("GetStreamStatus")).outputActive))
    await safe(async () => {
        const r = await client.call("GetRecordStatus")
        ctx.setState("recording", !!r.outputActive)
        ctx.setState("recordingPaused", !!r.outputPaused)
    })
    await safe(async () => ctx.setState("replayBuffer", !!(await client.call("GetReplayBufferStatus")).outputActive))
    await safe(async () => ctx.setState("virtualCam", !!(await client.call("GetVirtualCamStatus")).outputActive))
    await safe(async () => ctx.setState("studioMode", !!(await client.call("GetStudioModeEnabled")).studioModeEnabled))
    await safe(async () => ctx.setState("currentScene", (await client.call("GetCurrentProgramScene")).currentProgramSceneName))
    await safe(async () => {
        const studio = ctx.getState("studioMode")
        if (studio) ctx.setState("previewScene", (await client.call("GetCurrentPreviewScene")).currentPreviewSceneName)
    })
    await safe(() => refreshInputs(ctx))
}

async function connect(ctx) {
    if (connected && obs) return obs
    if (connecting) return connecting

    const gen = ++generation
    const attempt = (async () => {
        try {
            await loadLib()
            const { host, password } = readSettings(ctx)
            const client = new OBSWebSocket()
            await client.connect(host, password)
            if (gen !== generation) {
                // Settings changed (or disconnect was requested) while connecting
                try { await client.disconnect() } catch { /* ignore */ }
                throw new Error("Connection attempt superseded")
            }
            obs = client
            connected = true
            wireEvents(client, ctx)
            ctx.setState("connected", true)
            ctx.setStatus({ connected: true, message: `Connected to ${host}` })
            ctx.log(`Connected to ${host}`)
            refreshState(ctx).then(() => pollStats(ctx)).catch(() => {})
            startStats(ctx)
            return client
        } catch (err) {
            if (gen !== generation) throw err
            const message = (err && err.message) || (err && err.code ? `code ${err.code}` : "") || "connection refused"
            markDisconnected(ctx, `Cannot reach OBS at ${readSettings(ctx).host}: ${message}`)
            scheduleReconnect(ctx)
            throw new Error(`Failed to connect to OBS: ${message}`)
        }
    })()
    connecting = attempt
    attempt.catch(() => {}).then(() => { if (connecting === attempt) connecting = null })
    return attempt
}

async function disconnect(ctx) {
    wantConnection = false
    generation++
    connecting = null
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    const client = obs
    obs = null
    connected = false
    stopStats(ctx)
    if (client) {
        try { await client.disconnect() } catch { /* ignore */ }
    }
    ctx.setState("connected", false)
    ctx.setStatus({ connected: false, message: "Disconnected" })
}

/** Get a live client for an action, connecting on demand */
async function getOBS(ctx) {
    wantConnection = true
    return connect(ctx)
}

function requireString(payload, key, label) {
    const value = payload && payload[key]
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`Payload must include '${key}'${label ? ` (${label})` : ""}`)
    }
    return value.trim()
}

async function getSceneItemId(client, scene, source) {
    const { sceneItemId } = await client.call("GetSceneItemId", { sceneName: scene, sourceName: source })
    return sceneItemId
}

const MEDIA_ACTIONS = {
    play: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY",
    pause: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE",
    restart: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART",
    stop: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP",
    next: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT",
    previous: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS",
}

module.exports = {
    async init(ctx) {
        moduleCtx = ctx
        ctx.setState("connected", false)
        const { autoConnect } = readSettings(ctx)
        if (autoConnect) {
            wantConnection = true
            connect(ctx).catch(() => { /* reported via status */ })
        } else {
            ctx.setStatus({ connected: false, message: "Auto-connect disabled" })
        }
    },

    async onSettingsChanged(ctx) {
        // Reconnect with the new host/password
        const { autoConnect } = readSettings(ctx)
        if (connected || connecting) await disconnect(ctx)
        if (autoConnect) {
            wantConnection = true
            connect(ctx).catch(() => {})
        }
    },

    async dispose() {
        if (moduleCtx) await disconnect(moduleCtx)
    },

    providers: {
        scenes: async (ctx) => {
            const o = await getOBS(ctx)
            const { scenes } = await o.call("GetSceneList")
            return (scenes || []).map(s => ({ value: s.sceneName })).reverse()
        },
        inputs: async (ctx) => {
            const o = await getOBS(ctx)
            const { inputs } = await o.call("GetInputList")
            return (inputs || []).map(i => ({ value: i.inputName, label: `${i.inputName} (${i.inputKind})` }))
        },
        audioInputs: async (ctx) => {
            const o = await getOBS(ctx)
            const { inputs } = await o.call("GetInputList")
            const out = []
            for (const i of inputs || []) {
                try {
                    await o.call("GetInputMute", { inputName: i.inputName })
                    out.push({ value: i.inputName })
                } catch { /* no audio */ }
            }
            return out
        },
        sceneItems: async (ctx, scene) => {
            if (!scene) return []
            const o = await getOBS(ctx)
            const { sceneItems } = await o.call("GetSceneItemList", { sceneName: scene })
            return (sceneItems || []).map(i => ({ value: i.sourceName }))
        },
        transitions: async (ctx) => {
            const o = await getOBS(ctx)
            const { transitions } = await o.call("GetSceneTransitionList")
            return (transitions || []).map(t => ({ value: t.transitionName }))
        },
        filters: async (ctx, source) => {
            if (!source) return []
            const o = await getOBS(ctx)
            const { filters } = await o.call("GetSourceFilterList", { sourceName: source })
            return (filters || []).map(f => ({ value: f.filterName }))
        },
        hotkeys: async (ctx) => {
            const o = await getOBS(ctx)
            const { hotkeys } = await o.call("GetHotkeyList")
            return (hotkeys || []).map(h => ({ value: h }))
        },
        profiles: async (ctx) => {
            const o = await getOBS(ctx)
            const { profiles } = await o.call("GetProfileList")
            return (profiles || []).map(p => ({ value: p }))
        },
        sceneCollections: async (ctx) => {
            const o = await getOBS(ctx)
            const { sceneCollections } = await o.call("GetSceneCollectionList")
            return (sceneCollections || []).map(c => ({ value: c }))
        },
    },

    actions: {
        "obs.connect": async (_payload, ctx) => { await getOBS(ctx) },
        "obs.disconnect": async (_payload, ctx) => { await disconnect(ctx) },

        // Streaming
        "obs.startStreaming": async (_p, ctx) => { await (await getOBS(ctx)).call("StartStream") },
        "obs.stopStreaming": async (_p, ctx) => { await (await getOBS(ctx)).call("StopStream") },
        "obs.toggleStreaming": async (_p, ctx) => { await (await getOBS(ctx)).call("ToggleStream") },

        // Recording
        "obs.startRecording": async (_p, ctx) => { await (await getOBS(ctx)).call("StartRecord") },
        "obs.stopRecording": async (_p, ctx) => { await (await getOBS(ctx)).call("StopRecord") },
        "obs.toggleRecording": async (_p, ctx) => { await (await getOBS(ctx)).call("ToggleRecord") },
        "obs.pauseRecording": async (_p, ctx) => { await (await getOBS(ctx)).call("PauseRecord") },
        "obs.resumeRecording": async (_p, ctx) => { await (await getOBS(ctx)).call("ResumeRecord") },
        "obs.toggleReplayBuffer": async (_p, ctx) => { await (await getOBS(ctx)).call("ToggleReplayBuffer") },
        "obs.saveReplayBuffer": async (_p, ctx) => { await (await getOBS(ctx)).call("SaveReplayBuffer") },

        // Outputs
        "obs.toggleVirtualCam": async (_p, ctx) => { await (await getOBS(ctx)).call("ToggleVirtualCam") },
        "obs.toggleStudioMode": async (_p, ctx) => {
            const o = await getOBS(ctx)
            const { studioModeEnabled } = await o.call("GetStudioModeEnabled")
            await o.call("SetStudioModeEnabled", { studioModeEnabled: !studioModeEnabled })
        },

        // Scenes
        "obs.switchScene": async (payload, ctx) => {
            const scene = requireString(payload, "scene")
            await (await getOBS(ctx)).call("SetCurrentProgramScene", { sceneName: scene })
        },
        "obs.setPreviewScene": async (payload, ctx) => {
            const scene = requireString(payload, "scene")
            await (await getOBS(ctx)).call("SetCurrentPreviewScene", { sceneName: scene })
        },
        "obs.triggerTransition": async (payload, ctx) => {
            const o = await getOBS(ctx)
            const transition = payload && typeof payload.transition === "string" ? payload.transition.trim() : ""
            if (transition) await o.call("SetCurrentSceneTransition", { transitionName: transition })
            await o.call("TriggerStudioModeTransition")
        },

        // Audio
        "obs.toggleMute": async (payload, ctx) => {
            const source = requireString(payload, "source", "audio source name")
            await (await getOBS(ctx)).call("ToggleInputMute", { inputName: source })
        },
        "obs.mute": async (payload, ctx) => {
            const source = requireString(payload, "source")
            await (await getOBS(ctx)).call("SetInputMute", { inputName: source, inputMuted: true })
        },
        "obs.unmute": async (payload, ctx) => {
            const source = requireString(payload, "source")
            await (await getOBS(ctx)).call("SetInputMute", { inputName: source, inputMuted: false })
        },
        "obs.setVolume": async (payload, ctx) => {
            const source = requireString(payload, "source")
            const volume = parseFloat(payload.volume)
            if (isNaN(volume)) throw new Error("Payload must include a numeric 'volume'")
            const useMul = payload.useMul === true || payload.useMul === "true"
            await (await getOBS(ctx)).call("SetInputVolume", useMul
                ? { inputName: source, inputVolumeMul: Math.max(0, Math.min(20, volume)) }
                : { inputName: source, inputVolumeDb: Math.max(-100, Math.min(26, volume)) })
        },
        "obs.adjustVolume": async (payload, ctx) => {
            const source = requireString(payload, "source")
            const delta = parseFloat(payload.delta)
            if (isNaN(delta)) throw new Error("Payload must include a numeric 'delta' (dB)")
            const o = await getOBS(ctx)
            const { inputVolumeDb } = await o.call("GetInputVolume", { inputName: source })
            const next = Math.max(-100, Math.min(26, inputVolumeDb + delta))
            await o.call("SetInputVolume", { inputName: source, inputVolumeDb: next })
        },

        // Sources
        "obs.toggleSource": async (payload, ctx) => {
            const scene = requireString(payload, "scene")
            const source = requireString(payload, "source")
            const o = await getOBS(ctx)
            const sceneItemId = await getSceneItemId(o, scene, source)
            const { sceneItemEnabled } = await o.call("GetSceneItemEnabled", { sceneName: scene, sceneItemId })
            await o.call("SetSceneItemEnabled", { sceneName: scene, sceneItemId, sceneItemEnabled: !sceneItemEnabled })
            ctx.setState(`visible.${scene}.${source}`, !sceneItemEnabled)
        },
        "obs.setSourceVisible": async (payload, ctx) => {
            const scene = requireString(payload, "scene")
            const source = requireString(payload, "source")
            const visible = payload.visible === true || payload.visible === "true"
            const o = await getOBS(ctx)
            const sceneItemId = await getSceneItemId(o, scene, source)
            await o.call("SetSceneItemEnabled", { sceneName: scene, sceneItemId, sceneItemEnabled: visible })
            ctx.setState(`visible.${scene}.${source}`, visible)
        },
        "obs.toggleFilter": async (payload, ctx) => {
            const source = requireString(payload, "source")
            const filter = requireString(payload, "filter")
            const o = await getOBS(ctx)
            const { filterEnabled } = await o.call("GetSourceFilter", { sourceName: source, filterName: filter })
            await o.call("SetSourceFilterEnabled", { sourceName: source, filterName: filter, filterEnabled: !filterEnabled })
            ctx.setState(`filter.${source}.${filter}`, !filterEnabled)
        },
        "obs.setText": async (payload, ctx) => {
            const source = requireString(payload, "source")
            const text = payload && typeof payload.text === "string" ? payload.text : ""
            await (await getOBS(ctx)).call("SetInputSettings", { inputName: source, inputSettings: { text }, overlay: true })
        },
        "obs.refreshBrowserSource": async (payload, ctx) => {
            const source = requireString(payload, "source")
            await (await getOBS(ctx)).call("PressInputPropertiesButton", { inputName: source, propertyName: "refreshnocache" })
        },
        "obs.mediaControl": async (payload, ctx) => {
            const source = requireString(payload, "source")
            const action = String(payload.mediaAction || "play").toLowerCase()
            const mediaAction = MEDIA_ACTIONS[action]
            if (!mediaAction) throw new Error(`Unknown media action: ${action}`)
            await (await getOBS(ctx)).call("TriggerMediaInputAction", { inputName: source, mediaAction })
        },
        "obs.screenshot": async (payload, ctx) => {
            const o = await getOBS(ctx)
            const source = payload && typeof payload.source === "string" && payload.source.trim()
                ? payload.source.trim()
                : (await o.call("GetCurrentProgramScene")).currentProgramSceneName
            const file = requireString(payload, "path", "output file path")
            const format = payload && typeof payload.format === "string" && payload.format ? payload.format : "png"
            await o.call("SaveSourceScreenshot", { sourceName: source, imageFormat: format, imageFilePath: file })
        },

        // Misc
        "obs.triggerHotkey": async (payload, ctx) => {
            const hotkey = requireString(payload, "hotkey")
            await (await getOBS(ctx)).call("TriggerHotkeyByName", { hotkeyName: hotkey })
        },
        "obs.setProfile": async (payload, ctx) => {
            const profile = requireString(payload, "profile")
            await (await getOBS(ctx)).call("SetCurrentProfile", { profileName: profile })
        },
        "obs.setSceneCollection": async (payload, ctx) => {
            const collection = requireString(payload, "collection")
            await (await getOBS(ctx)).call("SetCurrentSceneCollection", { sceneCollectionName: collection })
        },
    },
}
