import React from "react"

const GROUPS: { name: string; emoji: string[] }[] = [
    { name: "Stream", emoji: ["🎬", "⏺️", "⏹️", "🔴", "📹", "🎥", "📷", "🖥️", "🎮", "🕹️", "📺", "🎞️"] },
    { name: "Audio", emoji: ["🎙️", "🎤", "🔇", "🔈", "🔉", "🔊", "🎧", "🎚️", "🎛️", "🎵", "🎶", "🔔"] },
    { name: "Media", emoji: ["⏯️", "▶️", "⏸️", "⏭️", "⏮️", "⏩", "⏪", "🔁", "🔀", "⏏️", "🎼", "📻"] },
    { name: "Scenes", emoji: ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟", "🅰️", "🅱️"] },
    { name: "Status", emoji: ["✅", "❌", "⚠️", "🚫", "💡", "🔥", "⭐", "💬", "🚀", "⏱", "⏳", "🔒"] },
    { name: "Misc", emoji: ["🌐", "🔗", "📂", "📝", "🧰", "⚙️", "🛠️", "🔧", "🧪", "🏠", "💻", "📱"] },
]

export default function EmojiPalette({ onPick }: { onPick: (emoji: string) => void }) {
    return (
        <div className="emoji-palette">
            {GROUPS.map(group => (
                <div key={group.name} className="emoji-group">
                    <span className="emoji-group-name">{group.name}</span>
                    <div className="emoji-grid">
                        {group.emoji.map(e => (
                            <button
                                key={e}
                                type="button"
                                className="emoji-btn"
                                onClick={() => onPick(e)}
                                title={e}
                            >
                                {e}
                            </button>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    )
}
