/**
 * Assert that `market.json` survives validation with the fields it declares
 * intact — the validator drops members the format does not define, so a
 * mistyped field name would vanish silently and the index would still "pass".
 *
 * Run after generate-market-index.mjs. Usage:
 *   node scripts/verify-market-index.mjs <repoDir> <validatorPath>
 */
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const repo = process.argv[2]
const validatorSource = process.argv[3]

const semverCandidates = [
  join(dirname(process.execPath), 'node_modules', 'npm', 'node_modules', 'semver', 'index.js'),
  ...(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
    .filter(Boolean)
    .map((entry) => join(entry, 'node_modules', 'npm', 'node_modules', 'semver', 'index.js')),
]
const semverPath = semverCandidates.find((candidate) => {
  try { readFileSync(candidate); return true } catch { return false }
})
if (semverPath === undefined) {
  console.log('[verify] SKIPPED: no semver available')
  process.exit(0)
}

const patched = readFileSync(validatorSource, 'utf8')
  .replace(/from\s+["']semver["']/u, `from ${JSON.stringify(`file://${semverPath.replace(/\\/gu, '/')}`)}`)
const staging = mkdtempSync(join(tmpdir(), 'dtn-verify-'))
const stagedPath = join(staging, 'v.mjs')
writeFileSync(stagedPath, patched, 'utf8')
const { parseMarketIndex } = await import(`file://${stagedPath.replace(/\\/gu, '/')}`)

const raw = JSON.parse(readFileSync(join(repo, 'market.json'), 'utf8'))
const indexUrl = 'https://raw.githubusercontent.com/KiteMoon/dsh-windows-toast/main/market.json'
const parsed = parseMarketIndex(raw, indexUrl)

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
  }
}

const rawPlugin = raw.plugins[0]
const parsedPlugin = parsed.plugins[0]
const rawVersion = rawPlugin.versions[0]
const parsedVersion = parsedPlugin.versions[0]

console.log('[verify] every declared field survives validation')
check('plugin name', parsedPlugin.name === rawPlugin.name)
check('plugin title', JSON.stringify(parsedPlugin.title) === JSON.stringify(rawPlugin.title))
check('plugin icon resolved to an absolute URL', parsedPlugin.icon === `https://raw.githubusercontent.com/KiteMoon/dsh-windows-toast/main/icon.svg`, parsedPlugin.icon)
check('plugin author', parsedPlugin.author === rawPlugin.author, String(parsedPlugin.author))
check('plugin homepage', parsedPlugin.homepage === rawPlugin.homepage, String(parsedPlugin.homepage))
check('plugin repository', parsedPlugin.repository?.url === rawPlugin.repository.url, JSON.stringify(parsedPlugin.repository))
check('plugin metadata category', parsedPlugin.metadata?.category === rawPlugin.metadata.category, String(parsedPlugin.metadata?.category))
check('plugin keywords preserved', JSON.stringify(parsedPlugin.metadata?.keywords) === JSON.stringify(rawPlugin.metadata.keywords), JSON.stringify(parsedPlugin.metadata?.keywords))
check('plugin labels preserved', JSON.stringify(parsedPlugin.metadata?.labels) === JSON.stringify(rawPlugin.metadata.labels), JSON.stringify(parsedPlugin.metadata?.labels))
check('version source survived', JSON.stringify(parsedVersion.source) === JSON.stringify(rawVersion.source), JSON.stringify(parsedVersion.source))
if (rawVersion.source.type === 'npm') {
  check('npm source has no stray git fields', parsedVersion.source.url === undefined && parsedVersion.source.commit === undefined)
} else {
  check('git source is commit-pinned', /^[0-9a-f]{40}$/u.test(parsedVersion.source.commit ?? ''), String(parsedVersion.source.commit))
  check('git source url is https', /^https:/u.test(parsedVersion.source.url ?? ''), String(parsedVersion.source.url))
}
check('version engines.dsh', parsedVersion.engines.dsh === rawVersion.engines.dsh, String(parsedVersion.engines.dsh))
check('publishTimestamp is integer seconds', Number.isInteger(parsedVersion.publishTimestamp) && parsedVersion.publishTimestamp > 1_600_000_000, String(parsedVersion.publishTimestamp))

console.log('\n[verify] index-level metadata')
check('index title has en', typeof parsed.title.en === 'string')
check('category declared', parsed.metadata?.categories?.notifications !== undefined)
check('label windows declared', parsed.metadata?.labels?.windows !== undefined)
check('label no-dependencies declared', parsed.metadata?.labels?.['no-dependencies'] !== undefined)

// A reference to an undeclared id is the classic silent failure here.
console.log('\n[verify] declared-id references resolve')
const category = parsedPlugin.metadata?.category
check('category reference resolves', category === undefined || parsed.metadata.categories[category] !== undefined, String(category))
for (const label of parsedPlugin.metadata?.labels ?? []) {
  check(`label "${label}" resolves`, parsed.metadata.labels[label] !== undefined)
}

console.log(`\n${failures === 0 ? 'ALL MARKET INDEX CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
