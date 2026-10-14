import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import "./styles/index.css"
import "./styles/v2.css"
import "./styles/widgets.css"
import { isElectron } from "./hooks/useSocket"
import "./electron.d"
const isDevServer = window.location.port === "5173"

// Register the service worker on remote devices only, so the page is installable
// as a home-screen app. The Electron window and the Vite dev server skip it.
if (!isElectron && !isDevServer && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch(err => {
            console.warn("Service worker registration failed:", err)
        })
    })
}

const root = ReactDOM.createRoot(document.getElementById("root")!)
root.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
)
