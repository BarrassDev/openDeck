// Installs production dependencies for every bundled module that ships a package.json.
// Modules live outside the app's node_modules once packaged, so each one carries its own deps.
const fs = require("fs")
const path = require("path")
const { execSync } = require("child_process")

const modulesDir = path.join(__dirname, "..", "modules")
if (!fs.existsSync(modulesDir)) {
    console.log("No modules directory, nothing to install")
    process.exit(0)
}

for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(modulesDir, entry.name)
    const pkgPath = path.join(dir, "package.json")
    if (!fs.existsSync(pkgPath)) continue
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
    const deps = Object.keys(pkg.dependencies || {})
    if (deps.length === 0) continue
    console.log(`\n[modules] Installing ${deps.join(", ")} for ${entry.name}`)
    execSync("npm install --omit=dev --no-audit --no-fund", { cwd: dir, stdio: "inherit", shell: true })
}
console.log("\n[modules] Done")
