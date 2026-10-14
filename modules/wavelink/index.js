// Elgato Wave Link Module (API v2) — supports Wave Link 2.x and 3.x.
//
// Both versions expose a local JSON-RPC 2.0 WebSocket, but with different methods:
//   Wave Link 2.x: port 1824, appID "egwl"  (getInputConfigs / setInputConfig / getOutputConfig ...)
//   Wave Link 3.x: port from ws-info.json or 1884–1893, appID "EWL" (getChannels / setChannel ...)
// The version is detected from getApplicationInfo after connecting.
//
// Published state (prefix "wavelink."):
//   connected, version, monitorMix, mainOutput,
//   input.<name>.muted / .gain / .micPcMix / .effect.<effect>,
//   output.<name>.muted / .level,
//   channel.<name>.muted / .level / .image / .color / .effect.<effect>,
//   channel.<name>.mix.<mix>.muted / .level,
//   mix.<name>.muted / .level
//
// Levels and gains are percentages (0–100) in actions and state. On Wave Link 2 the
// mixes are "Monitor" and "Stream"; a blank mix means Monitor.

const WebSocket = require("ws")
const fs = require("fs")
const path = require("path")

const V2_PORT = 1824
const V3_FALLBACK_PORTS = [1884, 1885, 1886, 1887, 1888, 1889, 1890, 1891, 1892, 1893]
const RECONNECT_MS = 5000
const REQUEST_TIMEOUT_MS = 5000
const HANDSHAKE_TIMEOUT_MS = 3000

const MIX_LOCAL = "com.elgato.mix.local"
const MIX_STREAM = "com.elgato.mix.stream"
const V2_MIX_NAMES = { [MIX_LOCAL]: "Monitor", [MIX_STREAM]: "Stream" }

// ---------- helpers ----------

function wsInfoPath() {
    const local = process.env.LOCALAPPDATA
        || (process.env.APPDATA ? path.join(path.dirname(process.env.APPDATA), "Local") : null)
    if (!local) return null
    return path.join(local, "Packages", "Elgato.WaveLink_g54w8ztgkx496", "LocalState", "ws-info.json")
}

function readWsInfoPort() {
    try {
        const file = wsInfoPath()
        if (!file || !fs.existsSync(file)) return null
        const parsed = JSON.parse(fs.readFileSync(file, "utf-8"))
        const port = Number(parsed && parsed.port)
        return Number.isInteger(port) && port > 0 ? port : null
    } catch {
        return null
    }
}

const clamp01 = (n) => Math.max(0, Math.min(1, n))
const pct = (v) => (typeof v === "number" ? Math.round(v * 100) : v)

function parsePercent(raw, label) {
    const n = parseFloat(raw)
    if (isNaN(n)) throw new Error(`Payload must include a numeric '${label}' (0–100)`)
    return clamp01(n / 100)
}

function parseBool(raw) {
    if (typeof raw === "boolean") return raw
    if (typeof raw === "string") return raw.toLowerCase() === "true"
    return !!raw
}

function sameName(a, b) {
    return typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase()
}

function toImage(data) {
    if (!data || typeof data !== "string") return ""
    if (data.startsWith("data:") || /^https?:\/\//i.test(data)) return data
    if (/^[A-Za-z0-9+/=\s]+$/.test(data) && data.length > 64) return `data:image/png;base64,${data.replace(/\s/g, "")}`
    return ""
}

function unsupported(what, version) {
    return new Error(`${what} is not available on Wave Link ${version}`)
}

// ---------- Wave Link 3 ----------

class V3Api {
    constructor(conn, ctx) {
        this.conn = conn
        this.ctx = ctx
        this.version = "3"
        this.inputDevices = []
        this.outputDevices = []
        this.mainOutput = null
        this.channels = []
        this.mixes = []
    }

    async load() {
        const [inputs, outputs, channels, mixes] = await Promise.all([
            this.conn.request("getInputDevices"),
            this.conn.request("getOutputDevices"),
            this.conn.request("getChannels"),
            this.conn.request("getMixes"),
        ])
        this.setInputDevices((inputs && inputs.inputDevices) || [])
        this.setOutputDevices((outputs && outputs.outputDevices) || [], outputs && outputs.mainOutput)
        this.setMixes((mixes && mixes.mixes) || [])
        this.setChannels((channels && channels.channels) || [])
    }

    onNotification(method, params) {
        switch (method) {
            case "inputDevicesChanged":
                if (Array.isArray(params.inputDevices)) this.setInputDevices(params.inputDevices)
                break
            case "inputDeviceChanged": {
                const dev = this.inputDevices.find(d => d.id === params.id)
                if (dev && Array.isArray(params.inputs)) {
                    for (const patch of params.inputs) {
                        const input = dev.inputs.find(i => i.id === patch.id)
                        if (input) Object.assign(input, patch)
                        else dev.inputs.push(patch)
                    }
                    this.publishInputs()
                }
                break
            }
            case "outputDevicesChanged":
                if (Array.isArray(params.outputDevices)) this.setOutputDevices(params.outputDevices, params.mainOutput)
                break
            case "outputDeviceChanged": {
                const dev = this.outputDevices.find(d => d.id === params.id)
                if (dev && Array.isArray(params.outputs)) {
                    for (const patch of params.outputs) {
                        const output = dev.outputs.find(o => o.id === patch.id)
                        if (output) Object.assign(output, patch)
                        else dev.outputs.push(patch)
                    }
                    this.publishOutputs()
                }
                break
            }
            case "channelsChanged":
                if (Array.isArray(params.channels)) this.setChannels(params.channels)
                break
            case "channelChanged": {
                const ch = this.channels.find(c => c.id === params.id)
                if (ch) {
                    const { mixes, ...rest } = params
                    Object.assign(ch, rest)
                    if (Array.isArray(mixes)) {
                        ch.mixes = ch.mixes || []
                        for (const patch of mixes) {
                            const mix = ch.mixes.find(m => m.mixId === patch.mixId)
                            if (mix) Object.assign(mix, patch)
                            else ch.mixes.push(patch)
                        }
                    }
                    this.publishChannel(ch)
                }
                break
            }
            case "mixesChanged":
                if (Array.isArray(params.mixes)) this.setMixes(params.mixes)
                break
            case "mixChanged": {
                const mix = this.mixes.find(m => m.id === params.id)
                if (mix) { Object.assign(mix, params); this.publishMix(mix) }
                break
            }
        }
    }

    // --- cache + state ---
    setInputDevices(devices) {
        this.inputDevices = devices.map(d => ({ ...d, inputs: Array.isArray(d.inputs) ? d.inputs.map(i => ({ ...i })) : [] }))
        this.ctx.clearState("input.")
        this.publishInputs()
    }

    publishInputs() {
        for (const dev of this.inputDevices) {
            for (const input of dev.inputs) {
                const key = `input.${input.name}`
                this.ctx.setState(`${key}.muted`, !!input.isMuted)
                if (input.gain && typeof input.gain.value === "number") this.ctx.setState(`${key}.gain`, pct(input.gain.value))
                if (input.micPcMix && typeof input.micPcMix.value === "number") this.ctx.setState(`${key}.micPcMix`, pct(input.micPcMix.value))
                for (const fx of [...(input.effects || []), ...(input.dspEffects || [])]) {
                    this.ctx.setState(`${key}.effect.${fx.name}`, !!fx.isEnabled)
                }
            }
        }
    }

    setOutputDevices(devices, mainOutput) {
        this.outputDevices = devices.map(d => ({ ...d, outputs: Array.isArray(d.outputs) ? d.outputs.map(o => ({ ...o })) : [] }))
        if (mainOutput) this.mainOutput = mainOutput
        this.ctx.clearState("output.")
        this.publishOutputs()
    }

    publishOutputs() {
        for (const dev of this.outputDevices) {
            for (const output of dev.outputs) {
                const key = `output.${output.name}`
                this.ctx.setState(`${key}.muted`, !!output.isMuted)
                if (typeof output.level === "number") this.ctx.setState(`${key}.level`, pct(output.level))
            }
        }
        const main = this.findMainOutput()
        this.ctx.setState("mainOutput", main ? main.output.name : "")
    }

    setChannels(channels) {
        this.channels = channels.map(c => ({ ...c, mixes: Array.isArray(c.mixes) ? c.mixes.map(m => ({ ...m })) : [] }))
        this.ctx.clearState("channel.")
        for (const ch of this.channels) this.publishChannel(ch)
    }

    publishChannel(ch) {
        const key = `channel.${ch.name}`
        this.ctx.setState(`${key}.muted`, !!ch.isMuted)
        if (typeof ch.level === "number") this.ctx.setState(`${key}.level`, pct(ch.level))
        const image = toImage(ch.image && ch.image.imgData)
        if (image) this.ctx.setState(`${key}.image`, image)
        for (const mix of ch.mixes || []) {
            const mixName = this.mixName(mix.mixId)
            this.ctx.setState(`${key}.mix.${mixName}.muted`, !!mix.isMuted)
            if (typeof mix.level === "number") this.ctx.setState(`${key}.mix.${mixName}.level`, pct(mix.level))
        }
        for (const fx of ch.effects || []) this.ctx.setState(`${key}.effect.${fx.name}`, !!fx.isEnabled)
    }

    setMixes(mixes) {
        this.mixes = mixes.map(m => ({ ...m }))
        this.ctx.clearState("mix.")
        for (const mix of this.mixes) this.publishMix(mix)
        for (const ch of this.channels) this.publishChannel(ch)
    }

    publishMix(mix) {
        const key = `mix.${mix.name}`
        this.ctx.setState(`${key}.muted`, !!mix.isMuted)
        if (typeof mix.level === "number") this.ctx.setState(`${key}.level`, pct(mix.level))
    }

    mixName(mixId) {
        const mix = this.mixes.find(m => m.id === mixId)
        return mix ? mix.name : mixId
    }

    // --- lookups ---
    findInput(name) {
        for (const dev of this.inputDevices) {
            for (const input of dev.inputs) {
                if (sameName(input.name, name) || input.id === name) return { device: dev, input }
            }
        }
        if (!name) {
            const dev = this.inputDevices.find(d => d.isWaveDevice && d.inputs.length) || this.inputDevices.find(d => d.inputs.length)
            if (dev) return { device: dev, input: dev.inputs[0] }
        }
        throw new Error(`Wave Link input not found: ${name || "(default)"}`)
    }

    findMainOutput() {
        if (!this.mainOutput) return null
        const dev = this.outputDevices.find(d => d.id === this.mainOutput.outputDeviceId)
        const output = dev && dev.outputs.find(o => o.id === this.mainOutput.outputId)
        return dev && output ? { device: dev, output } : null
    }

    findOutput(name) {
        if (!name) {
            const main = this.findMainOutput()
            if (main) return main
        }
        for (const dev of this.outputDevices) {
            for (const output of dev.outputs) {
                if (sameName(output.name, name) || output.id === name) return { device: dev, output }
            }
        }
        throw new Error(`Wave Link output not found: ${name || "(main output)"}`)
    }

    findChannel(name) {
        const ch = this.channels.find(c => sameName(c.name, name) || c.id === name)
        if (!ch) throw new Error(`Wave Link channel not found: ${name}`)
        return ch
    }

    findMix(name) {
        const mix = this.mixes.find(m => sameName(m.name, name) || m.id === name)
        if (!mix) throw new Error(`Wave Link mix not found: ${name}`)
        return mix
    }

    // --- unified interface ---
    listInputs() { return this.inputDevices.flatMap(d => d.inputs.map(i => ({ value: i.name, label: `${i.name} (${d.name})` }))) }
    listOutputs() { return this.outputDevices.flatMap(d => d.outputs.map(o => ({ value: o.name, label: `${o.name} (${d.name})` }))) }
    listChannels() { return this.channels.map(c => ({ value: c.name })) }
    listMixes() { return this.mixes.map(m => ({ value: m.name })) }
    inputEffects(name) {
        const { input } = this.findInput(name)
        return [...(input.effects || []), ...(input.dspEffects || [])].map(fx => ({ value: fx.name, label: fx.isSupported === false ? `${fx.name} (unsupported)` : fx.name }))
    }
    channelEffects(name) { return (this.findChannel(name).effects || []).map(fx => ({ value: fx.name })) }

    getInput(name) {
        const { input } = this.findInput(name)
        return { muted: !!input.isMuted, gain: input.gain ? input.gain.value : undefined, micPcMix: input.micPcMix ? input.micPcMix.value : undefined }
    }

    async setInput(name, patch) {
        const { device, input } = this.findInput(name)
        const body = { id: input.id }
        if (patch.muted !== undefined) body.isMuted = patch.muted
        if (patch.gain !== undefined) body.gain = { value: patch.gain }
        if (patch.micPcMix !== undefined) body.micPcMix = { value: patch.micPcMix }
        await this.conn.request("setInputDevice", { id: device.id, inputs: [body] })
        if (patch.muted !== undefined) input.isMuted = patch.muted
        if (patch.gain !== undefined) input.gain = { ...(input.gain || {}), value: patch.gain }
        if (patch.micPcMix !== undefined) input.micPcMix = { ...(input.micPcMix || {}), value: patch.micPcMix }
        this.publishInputs()
    }

    async toggleInputEffect(name, effectName) {
        const { device, input } = this.findInput(name)
        const soft = (input.effects || []).find(fx => sameName(fx.name, effectName))
        const dsp = (input.dspEffects || []).find(fx => sameName(fx.name, effectName))
        const fx = soft || dsp
        if (!fx) throw new Error(`Effect not found on input: ${effectName}`)
        const patch = soft ? { effects: [{ id: fx.id, isEnabled: !fx.isEnabled }] } : { dspEffects: [{ id: fx.id, isEnabled: !fx.isEnabled }] }
        await this.conn.request("setInputDevice", { id: device.id, inputs: [{ id: input.id, ...patch }] })
        fx.isEnabled = !fx.isEnabled
        this.publishInputs()
    }

    getOutput(name) {
        const { output } = this.findOutput(name)
        return { muted: !!output.isMuted, level: output.level }
    }

    async setOutput(name, patch) {
        const { device, output } = this.findOutput(name)
        const body = { id: output.id }
        if (patch.muted !== undefined) body.isMuted = patch.muted
        if (patch.level !== undefined) body.level = patch.level
        await this.conn.request("setOutputDevice", { outputDevice: { id: device.id, outputs: [body] } })
        if (patch.muted !== undefined) output.isMuted = patch.muted
        if (patch.level !== undefined) output.level = patch.level
        this.publishOutputs()
    }

    async setMainOutput(name) {
        const { device, output } = this.findOutput(name)
        await this.conn.request("setOutputDevice", { mainOutput: { outputDeviceId: device.id, outputId: output.id } })
        this.mainOutput = { outputDeviceId: device.id, outputId: output.id }
        this.publishOutputs()
    }

    getChannel(name, mixName) {
        const ch = this.findChannel(name)
        if (mixName) {
            const mix = this.findMix(mixName)
            const entry = (ch.mixes || []).find(m => m.mixId === mix.id) || { isMuted: false, level: 1 }
            return { muted: !!entry.isMuted, level: entry.level }
        }
        return { muted: !!ch.isMuted, level: typeof ch.level === "number" ? ch.level : 1 }
    }

    async setChannel(name, mixName, patch) {
        const ch = this.findChannel(name)
        if (mixName) {
            const mix = this.findMix(mixName)
            const body = { mixId: mix.id }
            if (patch.muted !== undefined) body.isMuted = patch.muted
            if (patch.level !== undefined) body.level = patch.level
            await this.conn.request("setChannel", { id: ch.id, mixes: [body] })
            const entry = (ch.mixes || []).find(m => m.mixId === mix.id)
            if (entry) Object.assign(entry, body)
            else ch.mixes.push({ mixId: mix.id, isMuted: !!patch.muted, level: patch.level ?? 1 })
        } else {
            const body = { id: ch.id }
            if (patch.muted !== undefined) body.isMuted = patch.muted
            if (patch.level !== undefined) body.level = patch.level
            await this.conn.request("setChannel", body)
            if (patch.muted !== undefined) ch.isMuted = patch.muted
            if (patch.level !== undefined) ch.level = patch.level
        }
        this.publishChannel(ch)
    }

    async toggleChannelEffect(name, effectName) {
        const ch = this.findChannel(name)
        const fx = (ch.effects || []).find(f => sameName(f.name, effectName))
        if (!fx) throw new Error(`Effect not found on channel: ${effectName}`)
        await this.conn.request("setChannel", { id: ch.id, effects: [{ id: fx.id, isEnabled: !fx.isEnabled }] })
        fx.isEnabled = !fx.isEnabled
        this.publishChannel(ch)
    }

    async toggleChannelEffectsBypass() { throw unsupported("Effects bypass", this.version) }

    getMix(name) {
        const mix = this.findMix(name)
        return { muted: !!mix.isMuted, level: typeof mix.level === "number" ? mix.level : 1 }
    }

    async setMix(name, patch) {
        const mix = this.findMix(name)
        const body = { id: mix.id }
        if (patch.muted !== undefined) body.isMuted = patch.muted
        if (patch.level !== undefined) body.level = patch.level
        await this.conn.request("setMix", body)
        Object.assign(mix, body)
        this.publishMix(mix)
    }

    getMonitorMix() { throw unsupported("Monitor mix switching", this.version) }
    async switchMonitorMix() { throw unsupported("Monitor mix switching", this.version) }
}

// ---------- Wave Link 2 ----------

class V2Api {
    constructor(conn, ctx) {
        this.conn = conn
        this.ctx = ctx
        this.version = "2"
        this.inputs = []          // getInputConfigs entries
        this.outputConfig = { [MIX_LOCAL]: { muted: false, level: 1 }, [MIX_STREAM]: { muted: false, level: 1 } }
        this.outputs = []         // { identifier, name }
        this.selectedOutput = ""
        this.monitorMix = MIX_LOCAL
        this.micGain = undefined
    }

    async load() {
        const [inputs, outputConfig, outputs, switchState, micConfig] = await Promise.all([
            this.conn.request("getInputConfigs"),
            this.conn.request("getOutputConfig"),
            this.conn.request("getOutputs", { mixerID: MIX_LOCAL }).catch(() => null),
            this.conn.request("getSwitchState").catch(() => null),
            this.conn.request("getMicrophoneConfig").catch(() => null),
        ])
        this.inputs = Array.isArray(inputs) ? inputs : []
        this.applyOutputConfig(outputConfig)
        if (outputs) {
            const list = outputs.outputs && !Array.isArray(outputs.outputs) ? (outputs.outputs.localMixer || []) : (outputs.outputs || [])
            this.outputs = list.map(o => ({ identifier: o.identifier, name: o.name }))
            if (outputs.selectedOutput) this.selectedOutput = this.selectedOutputId(outputs.selectedOutput)
        }
        if (switchState && switchState.value) this.monitorMix = switchState.value
        if (Array.isArray(micConfig) && micConfig[0] && typeof micConfig[0].gain === "number") this.micGain = micConfig[0].gain
        this.publishAll()
    }

    onNotification(method, params) {
        switch (method) {
            case "inputMuteChanged":
            case "inputVolumeChanged": {
                const input = this.inputs.find(i => i.identifier === params.identifier)
                if (!input) break
                const mixer = this.mixerArray(input, params.mixerID)
                if (!mixer) break
                if (method === "inputMuteChanged") mixer[0] = !!params.value
                else mixer[1] = Number(params.value)
                this.publishInput(input)
                break
            }
            case "outputMuteChanged":
            case "outputVolumeChanged": {
                const entry = this.outputConfig[params.mixerID]
                if (!entry) break
                if (method === "outputMuteChanged") entry.muted = !!params.value
                else entry.level = clamp01(Number(params.value) / 100)
                this.publishMixes()
                break
            }
            case "inputsChanged":
                this.conn.request("getInputConfigs").then(inputs => {
                    this.inputs = Array.isArray(inputs) ? inputs : []
                    this.ctx.clearState("channel.")
                    this.ctx.clearState("input.")
                    this.publishInputs()
                }).catch(() => {})
                break
            case "inputNameChanged": {
                const input = this.inputs.find(i => i.identifier === params.identifier)
                if (input) {
                    this.ctx.clearState(`channel.${input.name}.`)
                    input.name = params.value
                    this.publishInput(input)
                }
                break
            }
            case "filterChanged": {
                const input = this.inputs.find(i => i.identifier === params.identifier)
                const fx = input && (input.filters || []).find(f => f.filterID === params.filterID)
                if (fx) { fx.isActive = !!params.value; this.publishInput(input) }
                break
            }
            case "filterBypassStateChanged": {
                const input = this.inputs.find(i => i.identifier === params.identifier)
                const mixer = input && this.mixerArray(input, params.mixerID)
                if (mixer) { mixer[2] = !!params.value; this.publishInput(input) }
                break
            }
            case "filterAdded":
            case "filterRemoved":
                this.onNotification("inputsChanged", {})
                break
            case "selectedOutputChanged":
                this.selectedOutput = this.selectedOutputId(params.value)
                this.publishOutputs()
                break
            case "switchStateChanged":
            case "monitoringStateChanged":
                if (params && params.value) { this.monitorMix = params.value; this.publishMixes() }
                break
            case "microphoneConfigChanged":
            case "microphoneGainChanged":
                if (params && typeof params.gain === "number") { this.micGain = params.gain; this.publishInputs() }
                else if (params && typeof params.value === "number") { this.micGain = params.value; this.publishInputs() }
                break
        }
    }

    // --- helpers ---
    mixerId(mixName) {
        if (!mixName) return MIX_LOCAL
        const m = String(mixName).trim().toLowerCase()
        if (m === MIX_LOCAL || m === "monitor" || m === "local" || m === "headphones") return MIX_LOCAL
        if (m === MIX_STREAM || m === "stream") return MIX_STREAM
        throw new Error(`Wave Link mix not found: ${mixName} (use Monitor or Stream)`)
    }

    /** Wave Link 2.0.6 reports the selected output per mixer ({ localMixer, streamMixer }); older builds send a string */
    selectedOutputId(value) {
        if (typeof value === "string") return value
        if (value && typeof value === "object") return value.localMixer || value.streamMixer || ""
        return ""
    }

    mixerArray(input, mixerID) {
        if (mixerID === MIX_LOCAL) return input.localMixer
        if (mixerID === MIX_STREAM) return input.streamMixer
        return null
    }

    applyOutputConfig(cfg) {
        if (!cfg) return
        for (const mixerID of [MIX_LOCAL, MIX_STREAM]) {
            const key = mixerID === MIX_LOCAL ? "localMixer" : "streamMixer"
            const arr = cfg[key]
            if (Array.isArray(arr)) this.outputConfig[mixerID] = { muted: !!arr[0], level: clamp01(Number(arr[1]) / 100) }
        }
    }

    findChannel(name) {
        const ch = this.inputs.find(i => sameName(i.name, name) || i.identifier === name)
        if (!ch) throw new Error(`Wave Link channel not found: ${name}. Channels: ${this.inputs.map(i => i.name).join(", ")}`)
        return ch
    }

    findMicInput(name) {
        if (name) {
            const ch = this.inputs.find(i => sameName(i.name, name) || i.identifier === name)
            if (ch) return ch
            throw new Error(`Wave Link input not found: ${name}`)
        }
        const mic = this.inputs.find(i => i.isWaveMicInput) || this.inputs[0]
        if (!mic) throw new Error("No Wave Link inputs found")
        return mic
    }

    // --- state ---
    publishAll() {
        this.ctx.clearState("channel.")
        this.ctx.clearState("input.")
        this.ctx.clearState("mix.")
        this.ctx.clearState("output.")
        this.publishInputs()
        this.publishMixes()
        this.publishOutputs()
    }

    publishInputs() {
        for (const input of this.inputs) this.publishInput(input)
    }

    publishInput(input) {
        const key = `channel.${input.name}`
        const local = input.localMixer || [false, 100, false]
        const stream = input.streamMixer || [false, 100, false]
        this.ctx.setState(`${key}.muted`, !!local[0])
        this.ctx.setState(`${key}.level`, Math.round(Number(local[1])))
        this.ctx.setState(`${key}.mix.Monitor.muted`, !!local[0])
        this.ctx.setState(`${key}.mix.Monitor.level`, Math.round(Number(local[1])))
        this.ctx.setState(`${key}.mix.Stream.muted`, !!stream[0])
        this.ctx.setState(`${key}.mix.Stream.level`, Math.round(Number(stream[1])))
        this.ctx.setState(`${key}.effectsBypassed.Monitor`, !!local[2])
        this.ctx.setState(`${key}.effectsBypassed.Stream`, !!stream[2])
        if (input.bgColor) this.ctx.setState(`${key}.color`, input.bgColor)
        const image = toImage(input.iconData)
        if (image) this.ctx.setState(`${key}.image`, image)
        for (const fx of input.filters || []) this.ctx.setState(`${key}.effect.${fx.name}`, !!fx.isActive)
        if (input.isWaveMicInput) {
            const ikey = `input.${input.name}`
            this.ctx.setState(`${ikey}.muted`, !!local[0] && !!stream[0])
            if (typeof this.micGain === "number") this.ctx.setState(`${ikey}.gain`, pct(this.micGain))
            for (const fx of input.filters || []) this.ctx.setState(`${ikey}.effect.${fx.name}`, !!fx.isActive)
        }
    }

    publishMixes() {
        for (const mixerID of [MIX_LOCAL, MIX_STREAM]) {
            const name = V2_MIX_NAMES[mixerID]
            const entry = this.outputConfig[mixerID]
            this.ctx.setState(`mix.${name}.muted`, !!entry.muted)
            this.ctx.setState(`mix.${name}.level`, pct(entry.level))
            // Outputs are the mixer outputs in Wave Link 2
            this.ctx.setState(`output.${name}.muted`, !!entry.muted)
            this.ctx.setState(`output.${name}.level`, pct(entry.level))
        }
        this.ctx.setState("monitorMix", V2_MIX_NAMES[this.monitorMix] || this.monitorMix)
    }

    publishOutputs() {
        const sel = this.outputs.find(o => o.identifier === this.selectedOutput)
        this.ctx.setState("mainOutput", sel ? sel.name : (this.selectedOutput || ""))
    }

    // --- setters: Wave Link 2 does not reply to setters, so send and return at once ---
    async call(method, params) {
        this.conn.send(method, params)
    }

    // --- unified interface ---
    listInputs() { return this.inputs.filter(i => i.isWaveMicInput).map(i => ({ value: i.name })) }
    listOutputs() { return Object.values(V2_MIX_NAMES).map(n => ({ value: n, label: `${n} output` })) }
    listChannels() { return this.inputs.map(i => ({ value: i.name })) }
    listMixes() { return Object.values(V2_MIX_NAMES).map(n => ({ value: n })) }
    inputEffects(name) { return (this.findMicInput(name).filters || []).map(f => ({ value: f.name })) }
    channelEffects(name) { return (this.findChannel(name).filters || []).map(f => ({ value: f.name })) }

    getInput(name) {
        const mic = this.findMicInput(name)
        return { muted: !!(mic.localMixer && mic.localMixer[0]) && !!(mic.streamMixer && mic.streamMixer[0]), gain: this.micGain }
    }

    async setInput(name, patch) {
        const mic = this.findMicInput(name)
        if (patch.muted !== undefined) {
            for (const mixerID of [MIX_LOCAL, MIX_STREAM]) {
                await this.call("setInputConfig", { identifier: mic.identifier, mixerID, property: "Mute", value: patch.muted })
                const arr = this.mixerArray(mic, mixerID)
                if (arr) arr[0] = patch.muted
            }
        }
        if (patch.gain !== undefined) throw unsupported("Microphone gain", this.version)
        if (patch.micPcMix !== undefined) throw unsupported("Mic/PC mix", this.version)
        this.publishInput(mic)
    }

    async toggleInputEffect(name, effectName) {
        return this.toggleChannelEffect(this.findMicInput(name).name, effectName)
    }

    getOutput(name) {
        const mixerID = this.mixerId(name)
        return { ...this.outputConfig[mixerID] }
    }

    async setOutput(name, patch) {
        return this.setMix(name, patch)
    }

    async setMainOutput() { throw unsupported("Selecting the main output", this.version) }

    getChannel(name, mixName) {
        const ch = this.findChannel(name)
        const arr = this.mixerArray(ch, this.mixerId(mixName)) || [false, 100, false]
        return { muted: !!arr[0], level: clamp01(Number(arr[1]) / 100) }
    }

    async setChannel(name, mixName, patch) {
        const ch = this.findChannel(name)
        const mixerID = this.mixerId(mixName)
        const arr = this.mixerArray(ch, mixerID)
        if (patch.muted !== undefined) {
            await this.call("setInputConfig", { identifier: ch.identifier, mixerID, property: "Mute", value: patch.muted })
            if (arr) arr[0] = patch.muted
        }
        if (patch.level !== undefined) {
            const value = Math.round(clamp01(patch.level) * 100)
            await this.call("setInputConfig", { identifier: ch.identifier, mixerID, property: "Volume", value })
            if (arr) arr[1] = value
        }
        this.publishInput(ch)
    }

    async toggleChannelEffect(name, effectName) {
        const ch = this.findChannel(name)
        const fx = (ch.filters || []).find(f => sameName(f.name, effectName) || f.filterID === effectName)
        if (!fx) throw new Error(`Effect not found on ${ch.name}: ${effectName}`)
        await this.call("setFilter", { identifier: ch.identifier, filterID: fx.filterID, value: !fx.isActive })
        fx.isActive = !fx.isActive
        this.publishInput(ch)
    }

    async toggleChannelEffectsBypass(name, mixName) {
        const ch = this.findChannel(name)
        const mixerID = this.mixerId(mixName)
        const arr = this.mixerArray(ch, mixerID)
        const next = !(arr && arr[2])
        await this.call("setFilterBypass", { identifier: ch.identifier, mixerID, value: next })
        if (arr) arr[2] = next
        this.publishInput(ch)
    }

    getMix(name) {
        return { ...this.outputConfig[this.mixerId(name)] }
    }

    async setMix(name, patch) {
        const mixerID = this.mixerId(name)
        const entry = this.outputConfig[mixerID]
        if (patch.muted !== undefined) {
            await this.call("setOutputConfig", { mixerID, property: "Mute", value: patch.muted })
            entry.muted = patch.muted
        }
        if (patch.level !== undefined) {
            await this.call("setOutputConfig", { mixerID, property: "Output Level", value: Math.round(clamp01(patch.level) * 100) })
            entry.level = clamp01(patch.level)
        }
        this.publishMixes()
    }

    getMonitorMix() { return V2_MIX_NAMES[this.monitorMix] || this.monitorMix }

    async switchMonitorMix(mixName) {
        const mixerID = mixName ? this.mixerId(mixName) : (this.monitorMix === MIX_LOCAL ? MIX_STREAM : MIX_LOCAL)
        await this.call("switchMonitoring", { value: mixerID })
        this.monitorMix = mixerID
        this.publishMixes()
    }
}

// ---------- connection (discovery, JSON-RPC transport, reconnect) ----------

class WaveLinkConnection {
    constructor(ctx) {
        this.ctx = ctx
        this.ws = null
        this.api = null
        this.nextId = 1
        this.pending = new Map()
        this.connected = false
        this.connecting = null
        this.reconnectTimer = null
        this.wantConnection = false
        this.generation = 0
    }

    candidatePorts() {
        const ports = []
        const configured = Number(this.ctx.settings.port)
        if (Number.isInteger(configured) && configured > 0) ports.push(configured)
        const fromFile = readWsInfoPort()
        if (fromFile) ports.push(fromFile)
        ports.push(V2_PORT, ...V3_FALLBACK_PORTS)
        return Array.from(new Set(ports))
    }

    tryPort(port) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
                headers: { Origin: "streamdeck://" },
                handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
            })
            const fail = (err) => {
                ws.removeAllListeners()
                try { ws.terminate() } catch { /* ignore */ }
                reject(err instanceof Error ? err : new Error(String(err)))
            }
            ws.once("open", () => { ws.removeListener("error", fail); resolve(ws) })
            ws.once("error", fail)
        })
    }

    async connect() {
        if (this.connected && this.ws) return
        if (this.connecting) return this.connecting
        const gen = ++this.generation
        const superseded = () => gen !== this.generation
        const attempt = (async () => {
            const errors = []
            for (const port of this.candidatePorts()) {
                if (superseded()) throw new Error("Connection attempt superseded")
                let ws
                try {
                    ws = await this.tryPort(port)
                } catch (err) {
                    errors.push(`${port}: ${err.message}`)
                    continue
                }
                if (superseded()) {
                    try { ws.terminate() } catch { /* ignore */ }
                    throw new Error("Connection attempt superseded")
                }
                this.attach(ws)
                try {
                    const info = await this.request("getApplicationInfo")
                    const appId = String((info && info.appID) || "").toLowerCase()
                    if (appId !== "ewl" && appId !== "egwl") {
                        throw new Error(`Not Wave Link on port ${port}: ${JSON.stringify(info)}`)
                    }
                    this.api = appId === "egwl" ? new V2Api(this, this.ctx) : new V3Api(this, this.ctx)
                    await this.api.load()
                    if (superseded()) throw new Error("Connection attempt superseded")
                    this.connected = true
                    this.ctx.setState("connected", true)
                    this.ctx.setState("version", this.api.version)
                    this.ctx.setStatus({ connected: true, message: `Connected to Wave Link ${this.api.version} (${(info && (info.appName || info.name)) || "Elgato Wave Link"}, port ${port})` })
                    this.ctx.log(`Connected to Wave Link ${this.api.version} on port ${port}`)
                    return
                } catch (err) {
                    errors.push(`${port}: ${err.message}`)
                    this.detach()
                    if (superseded()) throw new Error("Connection attempt superseded")
                }
            }
            const refused = errors.filter(e => /ECONNREFUSED/.test(e)).length
            const other = errors.filter(e => !/ECONNREFUSED/.test(e))
            const message = other.length ? other.join("; ") : (errors.length ? `nothing listening on ${refused} port(s), is Wave Link running?` : "No ports tried")
            this.ctx.setState("connected", false)
            this.ctx.setStatus({ connected: false, message: `Wave Link not reachable (${message})` })
            this.ctx.warn("connect failed:", errors.join(" | "))
            this.scheduleReconnect()
            throw new Error(`Wave Link not reachable: ${message}`)
        })()
        this.connecting = attempt
        attempt.catch(() => {}).then(() => { if (this.connecting === attempt) this.connecting = null })
        return attempt
    }

    attach(ws) {
        this.ws = ws
        ws.on("message", (raw) => this.onMessage(raw))
        ws.on("close", () => this.onClose("Connection closed"))
        ws.on("error", (err) => this.ctx.warn("socket error:", err && err.message))
    }

    detach() {
        const ws = this.ws
        this.ws = null
        this.api = null
        if (ws) {
            ws.removeAllListeners()
            try { ws.close() } catch { /* ignore */ }
        }
        for (const [, p] of this.pending) {
            clearTimeout(p.timer)
            try { p.reject(new Error("Disconnected")) } catch { /* ignore */ }
        }
        this.pending.clear()
    }

    onClose(reason) {
        const was = this.connected
        this.connected = false
        this.detach()
        this.ctx.setState("connected", false)
        this.ctx.setStatus({ connected: false, message: reason })
        if (was) this.ctx.log(reason)
        this.scheduleReconnect()
    }

    scheduleReconnect() {
        if (this.reconnectTimer || !this.wantConnection) return
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            if (!this.wantConnection || this.connected) return
            this.connect().catch(() => {})
        }, RECONNECT_MS)
    }

    async disconnect() {
        this.wantConnection = false
        this.generation++
        this.connecting = null
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
        this.connected = false
        this.detach()
        this.ctx.setState("connected", false)
        this.ctx.setStatus({ connected: false, message: "Disconnected" })
    }

    async ensure() {
        this.wantConnection = true
        if (!this.connected) await this.connect()
        return this.api
    }

    /** Fire-and-forget request: error replies are logged, success replies ignored */
    send(method, params) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Not connected to Wave Link")
        const id = this.nextId++
        const timer = setTimeout(() => this.pending.delete(id), 3000)
        this.pending.set(id, {
            resolve: () => {},
            reject: (err) => { if (!/Disconnected/.test(err.message)) this.ctx.warn(`${method} rejected:`, err.message) },
            timer,
        })
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: params === undefined ? null : params }))
    }

    request(method, params) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error("Not connected to Wave Link"))
                return
            }
            const id = this.nextId++
            const timer = setTimeout(() => {
                this.pending.delete(id)
                reject(new Error(`Wave Link request timed out: ${method}`))
            }, REQUEST_TIMEOUT_MS)
            this.pending.set(id, { resolve, reject, timer })
            this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: params === undefined ? null : params }))
        })
    }

    onMessage(raw) {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)
            this.pending.delete(msg.id)
            clearTimeout(p.timer)
            if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
            else p.resolve(msg.result)
            return
        }
        if (msg && typeof msg.method === "string" && msg.method !== "realTimeChanges" && this.api) {
            try { this.api.onNotification(msg.method, msg.params || {}) } catch (err) { this.ctx.warn("notification failed:", err.message) }
        }
    }
}

// ---------- module ----------

let conn = null

function str(payload, key) {
    const v = payload && payload[key]
    return typeof v === "string" ? v.trim() : ""
}

function requireStr(payload, key) {
    const v = str(payload, key)
    if (!v) throw new Error(`Payload must include '${key}'`)
    return v
}

function delta(payload) {
    const n = parseFloat(payload && payload.delta)
    if (isNaN(n)) throw new Error("Payload must include a numeric 'delta' (percentage points)")
    return n / 100
}

async function ready(ctx) {
    if (!conn) conn = new WaveLinkConnection(ctx)
    return conn.ensure()
}

module.exports = {
    /** Test hook: the live connection */
    _connection: () => conn,

    async init(ctx) {
        conn = new WaveLinkConnection(ctx)
        ctx.setState("connected", false)
        conn.wantConnection = true
        conn.connect().catch(() => { /* reported via status */ })
    },

    async onSettingsChanged(ctx) {
        if (!conn) conn = new WaveLinkConnection(ctx)
        await conn.disconnect()
        conn.wantConnection = true
        conn.connect().catch(() => {})
    },

    async dispose() {
        if (conn) await conn.disconnect()
    },

    providers: {
        inputs: async (ctx) => (await ready(ctx)).listInputs(),
        outputs: async (ctx) => (await ready(ctx)).listOutputs(),
        channels: async (ctx) => (await ready(ctx)).listChannels(),
        mixes: async (ctx) => (await ready(ctx)).listMixes(),
        inputEffects: async (ctx, input) => (await ready(ctx)).inputEffects(input || ""),
        channelEffects: async (ctx, channel) => (channel ? (await ready(ctx)).channelEffects(channel) : []),
    },

    actions: {
        "wavelink.reconnect": async (_p, ctx) => {
            if (conn) await conn.disconnect()
            await ready(ctx)
        },

        // Inputs (microphones)
        "wavelink.setInputMute": async (payload, ctx) => {
            await (await ready(ctx)).setInput(str(payload, "input"), { muted: parseBool(payload.muted) })
        },
        "wavelink.toggleInputMute": async (payload, ctx) => {
            const api = await ready(ctx)
            const name = str(payload, "input")
            await api.setInput(name, { muted: !api.getInput(name).muted })
        },
        "wavelink.setInputGain": async (payload, ctx) => {
            await (await ready(ctx)).setInput(str(payload, "input"), { gain: parsePercent(payload.gain, "gain") })
        },
        "wavelink.adjustInputGain": async (payload, ctx) => {
            const api = await ready(ctx)
            const name = str(payload, "input")
            const current = api.getInput(name).gain
            if (typeof current !== "number") throw unsupported("Microphone gain", api.version)
            await api.setInput(name, { gain: clamp01(current + delta(payload)) })
        },
        "wavelink.setMicPcMix": async (payload, ctx) => {
            await (await ready(ctx)).setInput(str(payload, "input"), { micPcMix: parsePercent(payload.value, "value") })
        },
        "wavelink.toggleInputEffect": async (payload, ctx) => {
            await (await ready(ctx)).toggleInputEffect(str(payload, "input"), requireStr(payload, "effect"))
        },

        // Outputs (headphones / monitor)
        "wavelink.setOutputMute": async (payload, ctx) => {
            await (await ready(ctx)).setOutput(str(payload, "output"), { muted: parseBool(payload.muted) })
        },
        "wavelink.toggleOutputMute": async (payload, ctx) => {
            const api = await ready(ctx)
            const name = str(payload, "output")
            await api.setOutput(name, { muted: !api.getOutput(name).muted })
        },
        "wavelink.setOutputLevel": async (payload, ctx) => {
            await (await ready(ctx)).setOutput(str(payload, "output"), { level: parsePercent(payload.level, "level") })
        },
        "wavelink.adjustOutputLevel": async (payload, ctx) => {
            const api = await ready(ctx)
            const name = str(payload, "output")
            await api.setOutput(name, { level: clamp01((api.getOutput(name).level || 0) + delta(payload)) })
        },
        "wavelink.setMainOutput": async (payload, ctx) => {
            await (await ready(ctx)).setMainOutput(requireStr(payload, "output"))
        },

        // Channels (apps / sources in the mixer)
        "wavelink.setChannelMute": async (payload, ctx) => {
            await (await ready(ctx)).setChannel(requireStr(payload, "channel"), str(payload, "mix"), { muted: parseBool(payload.muted) })
        },
        "wavelink.toggleChannelMute": async (payload, ctx) => {
            const api = await ready(ctx)
            const name = requireStr(payload, "channel")
            const mix = str(payload, "mix")
            await api.setChannel(name, mix, { muted: !api.getChannel(name, mix).muted })
        },
        "wavelink.setChannelLevel": async (payload, ctx) => {
            await (await ready(ctx)).setChannel(requireStr(payload, "channel"), str(payload, "mix"), { level: parsePercent(payload.level, "level") })
        },
        "wavelink.adjustChannelLevel": async (payload, ctx) => {
            const api = await ready(ctx)
            const name = requireStr(payload, "channel")
            const mix = str(payload, "mix")
            const current = api.getChannel(name, mix).level
            await api.setChannel(name, mix, { level: clamp01((typeof current === "number" ? current : 1) + delta(payload)) })
        },
        "wavelink.toggleChannelEffect": async (payload, ctx) => {
            await (await ready(ctx)).toggleChannelEffect(requireStr(payload, "channel"), requireStr(payload, "effect"))
        },
        "wavelink.toggleChannelEffects": async (payload, ctx) => {
            await (await ready(ctx)).toggleChannelEffectsBypass(requireStr(payload, "channel"), str(payload, "mix"))
        },

        // Mixes (Monitor / Stream)
        "wavelink.setMixMute": async (payload, ctx) => {
            await (await ready(ctx)).setMix(requireStr(payload, "mix"), { muted: parseBool(payload.muted) })
        },
        "wavelink.toggleMixMute": async (payload, ctx) => {
            const api = await ready(ctx)
            const name = requireStr(payload, "mix")
            await api.setMix(name, { muted: !api.getMix(name).muted })
        },
        "wavelink.setMixLevel": async (payload, ctx) => {
            await (await ready(ctx)).setMix(requireStr(payload, "mix"), { level: parsePercent(payload.level, "level") })
        },
        "wavelink.adjustMixLevel": async (payload, ctx) => {
            const api = await ready(ctx)
            const name = requireStr(payload, "mix")
            const current = api.getMix(name).level
            await api.setMix(name, { level: clamp01((typeof current === "number" ? current : 1) + delta(payload)) })
        },
        "wavelink.switchMonitorMix": async (payload, ctx) => {
            await (await ready(ctx)).switchMonitorMix(str(payload, "mix"))
        },
    },
}
