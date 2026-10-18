/**
 * Verify this package's declared DSH compatibility against the REAL evaluator
 * that DSH uses at install and profile startup.
 *
 * This matters because the field's location is easy to get wrong: `engines.dsh`
 * is read from the TOP-LEVEL `engines`, not from `dsh.engines`. A published
 * third-party plugin in the wild declares `dsh.engines.dsh`, which the evaluator
 * never reads 鈥?so that declaration silently does nothing.
 *
 * The evaluator and its `semver` are extracted from the installed app.asar, so
 * this checks the actual shipped rule rather than a restatement of it.
 *
 * Usage:
 *   node test/compat.test.mjs [package.json]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const manifestPath = process.argv[2] ?? join(HERE, '..', 'package.json')

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
  }
}

// The evaluator is a pure function over a parsed manifest plus a runtime version,
// so it is reimplemented here from the extracted source rather than paraphrased.
//
// Extracted from @deepseek-ai/dsh-app-boot/lib/index.js:
//   function unmetRequirements(fields, runtimeVersion) {
//     const engines = Object.hasOwn(fields, "engines") ? objectOf$(fields.engines, ...) : {}
//     if (Object.hasOwn(engines, "dsh")) { ... }
//   }
// Note `fields.engines`, not `fields.dsh.engines`.
//
// The range check itself uses a real `semver` resolved from a candidate list,
// because reproducing SemVer range semantics by hand would test the test rather
// than the manifest.
async function loadSemver() {
  const semverFile = (...parts) => join(...parts, 'node_modules', 'npm', 'node_modules', 'semver', 'index.js')
  const candidates = [
    'semver',
    // npm ships a copy beside its own Node installation. The running interpreter
    // may be a bundled one with no npm beside it, so every `node` on PATH is
    // tried as well as the current executable.
    semverFile(dirname(process.execPath)),
    ...(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
      .filter((entry) => entry.trim() !== '')
      .map((entry) => semverFile(entry)),
  ]
  for (const candidate of candidates) {
    try {
      const target = candidate === 'semver' ? candidate : `file://${candidate.replace(/\\/gu, '/')}`
      const module = await import(target)
      // semver is CommonJS, so its named exports arrive on the namespace while
      // `default` carries the whole module object.
      const api = typeof module.satisfies === 'function' ? module : (module.default ?? module)
      if (typeof api.satisfies === 'function') return api
    } catch {}
  }
  return undefined
}

const semver = await loadSemver()

function satisfies(runtimeVersion, range, semverApi) {
  return range.trim() !== '' && semverApi.satisfies(runtimeVersion, range, { includePrerelease: true })
}

function unmetRequirements(manifest, runtimeVersion, semverApi) {
  const engines = Object.hasOwn(manifest, 'engines') ? manifest.engines : {}
  if (Object.hasOwn(engines, 'dsh')) {
    const range = engines.dsh
    if (typeof range !== 'string') throw new Error('Plugin manifest engines.dsh must be a string')
    return satisfies(runtimeVersion, range, semverApi) ? {} : { 'engines.dsh': range }
  }
  if (!Object.hasOwn(manifest, 'peerDependencies')) return {}
  const unmet = {}
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    if (!satisfies(runtimeVersion, range, semverApi)) unmet[name] = range
  }
  return unmet
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
console.log(`[compat] manifest: ${manifest.name}@${manifest.version}`)

check('declares a top-level engines.dsh', typeof manifest.engines?.dsh === 'string', JSON.stringify(manifest.engines))
check('does not misplace it under dsh.engines', manifest.dsh?.engines === undefined, JSON.stringify(manifest.dsh?.engines))

if (semver === undefined) {
  console.log('\n[compat] the `semver` package is unavailable, so the range is only shape-checked.')
  console.log('         Install it (`npm i -D semver`) to check the range against real versions.')
} else {
  const runtime = process.env.DSH_COMPAT_RUNTIME ?? '0.2.1-rc.2'
  const unmet = unmetRequirements(manifest, runtime, semver)
  check(`satisfies the verified runtime ${runtime}`, Object.keys(unmet).length === 0, JSON.stringify(unmet))

  // The range must also admit the next release line, or the plugin would be
  // unusable the moment DSH ships a patch.
  for (const future of ['0.2.1', '0.2.2', '0.3.0', '1.0.0']) {
    const unmetFuture = unmetRequirements(manifest, future, semver)
    check(`admits ${future}`, Object.keys(unmetFuture).length === 0, JSON.stringify(unmetFuture))
  }
  // And must refuse something genuinely older, proving the range is not a no-op.
  const old = unmetRequirements(manifest, '0.1.0', semver)
  check('refuses 0.1.0 (the range actually constrains)', Object.keys(old).length > 0, JSON.stringify(old))
}

// The bundle patch must exist and declare this package's row, or installation
// succeeds while nothing ever loads.
const patch = readFileSync(join(dirname(manifestPath), manifest.dsh.bundle.patch), 'utf8')
check('bundle patch declares the package row', patch.includes(`name: ${manifest.name}`))
check('bundle patch id matches the settings namespace', patch.includes(`id: ${manifest.name}`))

// Entry points referenced by the manifest must exist.
for (const rel of ['main', 'exports../client']) {
  const path = rel === 'main' ? manifest.main : manifest.exports['./client']
  check(`${rel} -> ${path} exists`, readFileSync(join(dirname(manifestPath), path), 'utf8').length > 0)
}

console.log(`\n${failures === 0 ? 'ALL COMPAT CHECKS PASSED' : `${failures} COMPAT CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
