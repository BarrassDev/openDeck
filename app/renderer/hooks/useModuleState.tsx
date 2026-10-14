import React, { createContext, useContext, useEffect, useState, ReactNode } from "react"
import type { ModuleStatus } from "../../shared/types"
import type { StateMap } from "../../shared/face"
import { useSocket } from "./useSocket"

interface ModuleStateContextValue {
    /** Live state published by modules and the face poller, keyed "module.key" */
    state: StateMap
    /** Connection status per module */
    statuses: Record<string, ModuleStatus>
}

const ModuleStateContext = createContext<ModuleStateContextValue>({ state: {}, statuses: {} })

export function ModuleStateProvider({ children }: { children: ReactNode }) {
    const { subscribe } = useSocket()
    const [state, setState] = useState<StateMap>({})
    const [statuses, setStatuses] = useState<Record<string, ModuleStatus>>({})

    useEffect(() => {
        return subscribe(message => {
            const p = message.payload || {}
            switch (message.type) {
                case "state.snapshot": {
                    const snapshot = p.state
                    if (snapshot && typeof snapshot === "object") setState({ ...(snapshot as StateMap) })
                    break
                }
                case "state.update": {
                    const changes = p.changes
                    if (!changes || typeof changes !== "object") break
                    setState(prev => {
                        const next = { ...prev }
                        for (const [key, value] of Object.entries(changes as StateMap)) {
                            if (value === null || value === undefined) delete next[key]
                            else next[key] = value
                        }
                        return next
                    })
                    break
                }
                case "module.status": {
                    const name = p.module
                    if (typeof name === "string" && p.status && typeof p.status === "object") {
                        setStatuses(prev => ({ ...prev, [name]: p.status as ModuleStatus }))
                    }
                    break
                }
            }
        })
    }, [subscribe])

    // Built-in clock values for info tiles: clock.time, clock.seconds, clock.date, clock.weekday
    useEffect(() => {
        const tick = () => {
            const now = new Date()
            const next: StateMap = {
                "clock.time": now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                "clock.seconds": now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
                "clock.date": now.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }),
                "clock.weekday": now.toLocaleDateString([], { weekday: "long" }),
            }
            setState(prev => {
                let changed = false
                for (const [k, v] of Object.entries(next)) if (prev[k] !== v) { changed = true; break }
                return changed ? { ...prev, ...next } : prev
            })
        }
        tick()
        const timer = setInterval(tick, 1000)
        return () => clearInterval(timer)
    }, [])

    return (
        <ModuleStateContext.Provider value={{ state, statuses }}>
            {children}
        </ModuleStateContext.Provider>
    )
}

export function useModuleState() {
    return useContext(ModuleStateContext)
}
