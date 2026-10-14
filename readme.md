# OpenDeck

**OpenDeck** is an open-source alternative to the **Stream Deck**.  
Instead of dedicated hardware, OpenDeck provides a **web-based control surface** accessible from any device on your local network — iPad, tablet, phone, or any browser.

Built with **Electron**, **React**, **Express**, and **WebSockets**.

> **Version 2** adds module-scoped settings, a kiosk-style mobile app, a richer module API with live state, first-class OBS and Elgato Wave Link integrations, a full per-button editor, and live button faces.

---

## How It Works

```
Tablet / Phone / Browser (installable PWA, kiosk mode)
       │
       │  HTTP + WebSocket (port 4020)
       ▼
  Electron Desktop App
       │
       ├── Express server (serves UI + WebSocket)
       ├── Config store (persists settings to disk)
       ├── Module registry (loads plugins, scopes settings, collects live state)
       ├── Action dispatcher (routes button presses to modules)
       ├── State store (module state → every connected device)
       └── Face poller (HTTP values for live button faces)
       │
       ▼
  Modules (OBS, Wave Link, HTTP webhooks, media keys, macros, …)
```

1. **Electron starts** → loads modules from `/modules`, starts an Express + WebSocket server on port `4020`, opens the React UI.
2. **Any device** on the local network opens `http://<your-ip>:4020` in a browser to get the control surface.
3. **Button press** → WebSocket message → action dispatcher → module handler → external system.
4. **Feedback and live state** flow back over WebSocket: success/error glow, plus any state modules publish (OBS streaming, Wave Link mute, …) which buttons can show on their faces.
5. **Config sync** — settings edited on the desktop app are persisted to disk and broadcast to all connected clients in real time.

Multiple devices can connect simultaneously. Remote clients are read-only for configuration — only the Electron app can edit settings (the server rejects config writes from non-loopback connections).

---

## Installation

```bash
git clone https://github.com/BarrassDev/openDeck
cd openDeck
npm install
npm run install:modules   # installs per-module dependencies (obs-websocket-js, ws)
```

### Development

```bash
npm run dev
```

This starts three concurrent processes:
- TypeScript compiler in watch mode (Electron backend)
- Vite dev server on port 5173 (React UI with hot reload)
- Electron app (waits for both to be ready, then launches)

### Production Build

```bash
npm run build
npm start
```

### Tests

```bash
npm run build:electron && npm test
```

Runs the unit tests for the face resolver, template rendering, and config migration.

---

## Usage

1. Run `npm run dev` (or `npm start` after building)
2. The Electron window opens with the control surface
3. Click **📲 Connect** to get a QR code / URL for other devices
4. On a phone or tablet, open the URL and use **Add to Home Screen** — OpenDeck installs as a full-screen app
5. Use **Editor** to design buttons, **Modules** to configure integrations, **Plugins** to install community modules
6. Or link Claude from the **Modules** page and ask it to set everything up for you (see *Using OpenDeck with Claude*)

### Mobile / tablet kiosk mode

Remote devices run as a kiosk:

- **Always awake** — the Screen Wake Lock API keeps the display on while connected (re-acquired whenever the tab becomes visible again).
- **Fullscreen** — entered automatically on the first tap. When installed as a home-screen app the page is already fullscreen (`display: fullscreen` in the web manifest).
- **No browser gestures** — pinch-zoom, double-tap zoom, pull-to-refresh and the long-press context menu are blocked so every touch goes to a button.
- **Auto-reconnect** — the socket reconnects immediately when the device wakes or the network returns; an overlay shows while disconnected.
- **Fits any screen** — the grid scales to the viewport honouring the page's column/row ratio and safe-area insets.

> iOS honours the Wake Lock API from Safari 16.4. Older devices will still sleep per their system setting.

---

## Using OpenDeck with Claude (MCP)

OpenDeck ships an [MCP](https://modelcontextprotocol.io) server so an AI assistant can set the deck up for you: connect OBS, pick real scene names, build pages, add live faces, install plugins and hand you the device URL.

### One-click linking

Open **Modules** in the desktop app. The **Claude assistant** card at the top detects Claude Code and Claude Desktop and links them with one click:

- **Link Claude Code** runs `claude mcp add` for your user, so `opendeck` is available in every project. Type `/mcp` in Claude Code to confirm.
- **Link Claude Desktop** adds the server to `claude_desktop_config.json`. Restart Claude Desktop afterwards.

The MCP server runs on the OpenDeck binary itself (`ELECTRON_RUN_AS_NODE=1`), so no separate Node.js install is needed. The card also shows the manual command and a JSON snippet for other MCP clients (Cursor, Windsurf, ...).

Then just ask, for example:

> Set up OpenDeck for streaming: connect OBS, add a scene button for every scene, a mute button for my mic, and a red LIVE face while streaming. Then give me the URL for my iPad.

### Developing in this repo

`.mcp.json` registers the server for Claude Code automatically when you open this folder (run `npm run build` first so `dist/mcp/opendeck-mcp.cjs` exists). The desktop app must be running; the assistant can start it with the `launch_opendeck` tool when linked from the app.

### Tools

| Tool | Purpose |
|------|---------|
| `opendeck_status`, `launch_opendeck`, `get_connect_info` | Is the app running, module status, device URLs |
| `list_modules`, `list_actions`, `get_options`, `get_state` | Discover integrations, actions, live choices (OBS scenes, Wave Link channels) and live state |
| `get_config`, `set_module_settings` | Read the deck, store module settings such as the OBS password |
| `add_page`, `update_page`, `remove_page` | Manage pages and grid sizes |
| `set_button`, `clear_button`, `swap_buttons` | Design tiles (label, icon, action, payload, press mode, live face rules, span and widgets) |
| `run_action`, `press_button` | Test things immediately |
| `list_marketplace`, `install_plugin` | Community plugins |

Resources: `opendeck://config`, `opendeck://modules`, `opendeck://state`. Prompt: `setup_deck`.

The server talks to the app over its local HTTP API (`GET/PUT /api/config`, `POST /api/actions/:id`); writes are only accepted from the same machine.

---

## Project Structure

```
openDeck/
├── app/
│   ├── mcp/
│   │   └── server.ts                # MCP server for Claude Code / Claude Desktop (bundled to dist/mcp)
│   │
│   ├── electron/                    # Backend (Electron main process)
│   │   ├── main.ts                  # Electron entry — window, server, modules, dispose on quit
│   │   ├── claude-link.ts           # One-click MCP registration with Claude Code / Desktop
│   │   ├── server.ts                # Express HTTP + WebSocket server, state broadcast
│   │   ├── module-loader.ts         # Module registry, contexts, lifecycle, providers
│   │   ├── action-dispatcher.ts     # Routes actions to modules, runs sequences
│   │   ├── config-store.ts          # Persists config (pages, variables, image), migrates v1
│   │   ├── variable-store.ts        # Module-scoped variables
│   │   ├── state-store.ts           # Live state published by modules
│   │   └── face-poller.ts           # Polls HTTP sources for live faces
│   │
│   ├── renderer/                    # Frontend (React + Vite)
│   │   ├── public/                  # PWA manifest, service worker, icons
│   │   ├── App.tsx                  # Root — navigation, remote vs local detection
│   │   ├── pages/
│   │   │   ├── ControlPage.tsx      # Deck view (kiosk mode on remote devices)
│   │   │   ├── SettingsPage.tsx     # Editor: canvas, inspector, pages, display image
│   │   │   ├── ModulesPage.tsx      # Per-module settings, variables, status, actions
│   │   │   └── MarketplacePage.tsx  # Community plugin installer
│   │   ├── components/
│   │   │   ├── Grid.tsx / DeckButton.tsx   # Live grid, press modes, resolved faces
│   │   │   ├── PreviewGrid.tsx      # Editor grid with drag-and-drop
│   │   │   ├── ButtonEditor.tsx     # Tabbed editor: Look / Action / Live / Behaviour
│   │   │   ├── FaceEditor.tsx       # Live faces: templates, HTTP source, state rules
│   │   │   ├── BehaviourEditor.tsx  # Press modes, release/long-press, sequences
│   │   │   ├── PayloadForm.tsx      # Schema-driven params with live option providers
│   │   │   ├── ActionPicker.tsx     # Searchable action picker
│   │   │   └── EmojiPalette.tsx
│   │   └── hooks/
│   │       ├── useSocket.tsx        # WebSocket with subscribe() and fast reconnect
│   │       ├── useDeckConfig.tsx    # Config state, clipboard, persistence, server sync
│   │       ├── useModuleState.tsx   # Live state + module status
│   │       ├── useModules.tsx       # Module manifests + option providers
│   │       └── useKioskMode.tsx     # Wake lock, fullscreen, gesture blocking
│   │
│   └── shared/                      # Types & logic shared between backend and frontend
│       ├── types/                   # DeckButton, ButtonFace, ModuleManifest, ModuleContext, messages
│       ├── face.ts                  # resolveFace(), templates, readPath()
│       ├── migrate.ts               # v1 → v2 variable migration
│       └── action-protocol/         # Message serialization helpers
│
├── modules/                         # Integration plugins (loaded at startup)
│   ├── obs-control/                 # OBS Studio (API v2, live state, option providers)
│   ├── wavelink/                    # Elgato Wave Link 3 (API v2, live state)
│   ├── http-actions/                # HTTP GET/POST requests
│   ├── media-controls/              # Windows media key simulation
│   ├── macro/                       # Hotkeys, typing, launching
│   └── app-launcher/                # Open apps/files
│
├── scripts/
│   ├── install-modules.js           # npm install inside every module with a package.json
│   └── test-face.js                 # Unit tests
└── registry/                        # Plugin marketplace registry
```

---

## Features

### Button editor

Click any slot in **Editor** to open the inspector. Drag buttons between slots to rearrange them. Shortcuts: `Ctrl+C` / `Ctrl+V` copy and paste, `Ctrl+D` duplicate, `Delete` clears, arrow keys move the selection, `Esc` closes.

The inspector has four tabs:

| Tab | What you set |
|-----|--------------|
| **Look** | Label, label position (bottom/top/center/hidden), text size, emoji (with palette) or image (upload / URL / fill), background and text colours |
| **Action** | The action to run and its parameters. Parameters backed by a module provider (OBS scenes, Wave Link channels, …) show a live dropdown with a refresh button; you can always type a custom value |
| **Live** | Live image template, live label template, an HTTP value source, and state override rules (see below) |
| **Behaviour** | Press mode (tap / hold / long press), the release or long-press action, and extra steps to run afterwards with per-step delays |

Pages can have any grid size from 3×2 to 8×6, and can be renamed, reordered, and deleted.

### Live button faces

Faces can react to module state and external values:

- **Templates** — `{{module.key}}` anywhere in the live image or label template, e.g. `Scene: {{obs-control.currentScene}}` or `{{wavelink.channel.Music.image}}`.
- **Polled value** — give the button an HTTP URL (plus an optional JSON path such as `item.album.images.0.url` and an interval). The desktop app polls it and exposes the result as `{{value}}`. Point the live image template at `{{value}}` to show, for example, the current Spotify album art.
- **State overrides** — rules like *when `obs-control.streaming` is on, show 🔴 with label "LIVE" on a red background*. Rules can match on/off or an exact value; the first match wins.

Every module documents the state keys it publishes on the **Modules** page, and the editor suggests both documented keys and whatever is live right now.

### Multi-cell tiles and widgets

Any tile can span several cells (**Widget** tab, Size). A tile grows to the right and downward and hides whatever is in the cells it covers. Besides plain buttons there are three widget types:

| Widget | Typical size | What it does |
|--------|--------------|--------------|
| **Slider** | 3x1 or 1x3 | Drag to set a value. Reads the current value from a state key (e.g. `wavelink.channel.Music.level`) and sends the tile's action with the dragged value in the chosen parameter (e.g. `wavelink.setChannelLevel` with `level`, or `obs.setVolume` with `volume`). Sends are throttled while dragging. |
| **Panel** | 2x2 | Image plus text lines. The image comes from the Look tab or a live image template (`{{value}}` from a polled URL); lines are templates. Good for a Spotify "now playing" panel. |
| **Info** | 2x1 | Small title, big value, sub line, all templates. Built-in keys `{{clock.time}}`, `{{clock.seconds}}`, `{{clock.date}}`, `{{clock.weekday}}`; OBS publishes `streamTime`, `recordTime`, `fps`, `cpu`, `bitrateKbps`, `droppedFrames` while connected. Poll a URL on the Live tab for viewer counts and show it with `{{value}}`. |

The Widget tab has presets for a clock, a stream timer, an HTTP now-playing panel and a Wave Link level slider.

### Press modes

| Mode | Behaviour |
|------|-----------|
| Tap | Runs the action on press |
| Hold | Runs the action on press and the *release action* on release (push-to-talk, momentary scene) |
| Long press | Tap runs the action; holding for 0.6 s runs the *long-press action* instead |

Any button can also run a **sequence** of extra actions after the main one, each with an optional delay — a simple macro system.

### Module-scoped variables

Every variable belongs to exactly one module. Modules only ever see their own settings; nothing is shared. Configure them on the **Modules** page:

- **Settings** declared by the module manifest are shown as a typed form (passwords are masked).
- **Custom variables** are free key/value pairs for that module.
- Variables from OpenDeck 1.x that cannot be matched to a module are listed as **Unassigned** so you can assign or delete them. Known keys (`obs_host`, `obs_password`) migrate automatically.

### Display image

A background image can be set for the device frame via **Editor → Display Image**.

### Config sync

All configuration (pages, buttons, variables, display image) is:
- **Persisted to disk** in Electron's `userData` directory as `opendeck-config.json` (v2 format, migrated from v1 automatically)
- **Broadcast to all connected clients** via WebSocket when changed
- **Sent to new clients** on connection, together with a snapshot of live state and module status
- **Write-protected on remote clients** — the server only accepts `config.update` from loopback connections

---

## WebSocket Protocol

Communication between the UI and Electron backend uses JSON messages over WebSocket.

### Client → Server

| Type             | Description                                  |
|------------------|----------------------------------------------|
| `button.press`   | Run an action. `payload` carries the button's parameters plus `buttonId`, `__pressType`, and optionally `__sequence` (extra steps) |
| `page.change`    | User switched pages                          |
| `device.connect` | Device connected (sends userAgent)           |
| `config.update`  | Full config update (desktop app only)        |

### Server → Client

| Type              | Description                                 |
|-------------------|---------------------------------------------|
| `button.feedback` | Action result — `success` or `error`, with `buttonId` |
| `config.sync`     | Full config broadcast (pages, variables, image) |
| `state.snapshot`  | Complete live state map, sent on connect    |
| `state.update`    | Changed state keys (`null` = removed)       |
| `module.status`   | A module's connection status changed        |
| `page.update`     | Page change acknowledged                    |

### HTTP API

| Endpoint | Description |
|----------|-------------|
| `GET /api/modules` | Loaded modules with actions, parameter schemas, settings schema, state keys, providers and status |
| `GET /api/modules/:name/options/:provider?arg=` | Live option list from a module provider (e.g. OBS scenes) |
| `GET /api/state` | Current live state map |
| `GET /api/network` | LAN addresses for the Connect dialog |
| `GET /api/config`, `PUT /api/config` | Read / replace config (write: loopback only; used by the MCP server) |
| `POST /api/actions/:id` | Run an action with a JSON payload (loopback only) |
| `GET /api/marketplace`, `GET /api/marketplace/installed`, `POST /api/marketplace/install` | Plugin marketplace |

---

## Module Guide

Modules are the integration layer. Each module is a folder inside `/modules` containing a manifest and handler file. Modules that need npm packages ship their own `package.json`; `npm run install:modules` installs them.

```
modules/
  my-module/
    manifest.json    # Declares the module, actions, parameter schemas, settings, state keys
    index.js         # Implements the handlers
    package.json     # Optional: dependencies
```

### manifest.json (API v2)

```json
{
  "name": "my-module",
  "version": "1.0.0",
  "apiVersion": 2,
  "icon": "🧩",
  "description": "What this module does",
  "config": {
    "apiKey": { "type": "string", "description": "API key", "secret": true },
    "host":   { "type": "string", "default": "http://127.0.0.1:8000" }
  },
  "stateKeys": {
    "connected": "true while connected",
    "volume.<device>": "device volume 0-100"
  },
  "actions": ["mymod.doSomething"],
  "actionDetails": {
    "mymod.doSomething": {
      "description": "Do something",
      "params": {
        "device": { "type": "select", "description": "Device", "optionsFrom": "devices", "allowCustom": true, "required": true },
        "level":  { "type": "number", "min": 0, "max": 100 }
      }
    }
  }
}
```

Parameter types: `string`, `textarea`, `number`, `boolean`, `select`, `file`. A `select` can list static `options` or name a provider with `optionsFrom`; `dependsOn` passes another parameter's value to the provider (e.g. sources depend on the chosen scene).

### index.js (API v2)

```js
module.exports = {
  // Called once after load. Open connections, publish initial state.
  async init(ctx) {
    ctx.log("starting with", ctx.settings)        // only this module's variables
    ctx.setState("connected", true)                // published as "my-module.connected"
    ctx.setStatus({ connected: true, message: "Ready" })
  },

  // Called when the user edits this module's settings.
  async onSettingsChanged(ctx) { /* reconnect with ctx.settings */ },

  // Called on app quit / reload.
  async dispose() { /* close connections */ },

  // Live option lists for the editor.
  providers: {
    devices: async (ctx, arg) => [{ value: "mic", label: "Microphone" }],
  },

  actions: {
    "mymod.doSomething": async (payload, ctx) => {
      // payload = button parameters (+ legacy payload.__variables = ctx.settings)
      ctx.setState(`volume.${payload.device}`, payload.level)
    },
  },
}
```

`ModuleContext` provides: `moduleName`, `settings` (live, scoped), `setState(key, value)`, `getState(key)`, `clearState(prefix?)`, `setStatus({ connected, message })`, `log()`, `warn()`.

Legacy (API v1) modules — plain `{ actions }` objects that read `payload.__variables` — still load unchanged; they simply receive only their own variables now.

### Included Modules

| Module           | Highlights |
|------------------|------------|
| `obs-control`    | Persistent connection with auto-reconnect; streaming / recording / replay buffer / virtual cam / studio mode; scenes, transitions, audio mute and volume, source visibility, filters, text sources, browser refresh, media control, screenshots, hotkeys, profiles, scene collections. Live state for everything above. Live option lists for scenes, inputs, scene items, transitions, filters, hotkeys, profiles. |
| `wavelink`       | Elgato Wave Link **2.x and 3.x** (detected automatically). Microphone mute / effects, output (Monitor/Stream) mute / level, channel mute / level per mix / effects / effects bypass, mix mute / level, monitor-mix switching. Live state for every channel and mix (levels, mute, colours, icons). Wave Link 2 listens on port 1824; Wave Link 3 is found via `ws-info.json` or ports 1884–1893. Mic gain, Mic/PC mix and main-output selection need Wave Link 3. |
| `media-controls` | Windows media keys (play/pause, next, previous, volume, mute). |
| `http-actions`   | HTTP GET/POST. |
| `macro`          | Hotkeys, key presses, typing text, launching apps/URLs. |
| `app-launcher`   | Open any file, app or folder. |

**OBS** needs OBS 28+ with *Tools → WebSocket Server Settings* enabled. Set the password on the **Modules** page.

**Wave Link** 2.0.6+ or 3.x must be running. Channel and mix names are the ones shown in the Wave Link mixer; on Wave Link 2 the mixes are `Monitor` and `Stream`.

---

## Scripts

| Script                    | Description                                     |
|---------------------------|-------------------------------------------------|
| `npm run dev`             | Start all dev servers (TypeScript, Vite, Electron) |
| `npm run build`           | Build both Electron backend and React renderer  |
| `npm run build:electron`  | Compile TypeScript backend only                 |
| `npm run build:renderer`  | Build React frontend via Vite only              |
| `npm run build:mcp`       | Typecheck and bundle the MCP server             |
| `npm run mcp`             | Run the MCP server on stdio (for manual testing) |
| `npm run install:modules` | Install dependencies for bundled modules        |
| `npm test`                | Run unit tests (after `build:electron`)         |
| `npm start`               | Launch the Electron app (requires build first)  |
| `npm run dist`            | Package the Windows installer                   |

---

## Tech Stack

| Component  | Technology           | Purpose                           |
|------------|----------------------|-----------------------------------|
| Desktop    | Electron 28          | Window management, native access  |
| Frontend   | React 18 + Vite 5    | Control surface UI, installable PWA |
| Server     | Express 4            | Serves UI to remote devices       |
| Realtime   | ws (WebSocket)       | Button presses, config sync, live state |
| Language   | TypeScript 5.3       | Type safety across the stack      |
| Styling    | CSS (custom)         | Stream Deck-inspired dark theme   |

---

## License

MIT License
