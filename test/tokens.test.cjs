const fs = require('node:fs')
const path = require('node:path')
const client = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js'), 'utf8')
const themeSrc = fs.readFileSync(process.argv[3], 'utf8')
const used = [...new Set((client.match(/--dsw-alias-[a-z0-9-]+/g) || []))].sort()
const defined = new Set((themeSrc.match(/--dsw-alias-[a-z0-9-]+\s*:/g) || []).map((s) => s.replace(/\s*:$/, '')))
let bad = 0
for (const t of used) {
  const ok = defined.has(t)
  if (!ok) bad++
  console.log((ok ? 'OK     ' : 'UNDEF  ') + t)
}
console.log(bad === 0 ? `ALL ${used.length} TOKENS DEFINED` : `${bad} UNDEFINED OF ${used.length}`)
process.exitCode = bad ? 1 : 0