import { readFile, writeFile } from 'node:fs/promises'

const path = new URL('../packages/dsh-btw/lib/client.js', import.meta.url)
const source = await readFile(path, 'utf8')
if (source.startsWith('window.__ModuleLoader__')) process.exit(0)
const wrapped = `window.__ModuleLoader__.load({\n  id: "@deepseek-ai/dsh-btw",\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n${source}\n    return module.exports;\n  }\n});\n`
await writeFile(path, wrapped)
