/**
 * Runs every check for this bundle.
 *
 * Usage:
 *   node test/run-all.mjs [options]
 *
 * Options:
 *   --theme <path>   Include the theme-token check against the shipped theme
 *                    source. That file lives inside app.asar in the Desktop
 *                    install, so it cannot be found automatically; without it
 *                    the check is reported as skipped rather than passed.
 *   --market <path>  Include the plugin-market index check against the shipped
 *                    validator, @deepseek-ai/dsh-plugin-market-index.
 *   --no-e2e         Skip the end-to-end suite. It really registers a protocol
 *                    handler and shows real toasts, so it is the only suite that
 *                    touches the machine's registry and Action Center.
 *
 * The interpreter is `process.execPath` rather than `node`, so the suite runs
 * under the same runtime that started it even when no `node` is on PATH — which
 * is the normal case under the Desktop app's bundled runtime.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const themePath = option('--theme')
const marketValidator = option('--market')
const skipE2e = args.includes('--no-e2e')

// `process.execPath` is already absolute, but quoting it keeps a path with
// spaces working when the runner is invoked through a shell wrapper.
const node = process.execPath

const runs = [
  ['compat', [join(HERE, 'compat.test.mjs')]],
  ['host', [join(HERE, 'host.test.mjs')]],
  ['client', [join(HERE, 'client.test.cjs')]],
  ['reveal', [join(HERE, 'reveal-http.test.mjs')]],
]

if (skipE2e) {
  console.log('[e2e] SKIPPED (--no-e2e)')
} else if (process.platform === 'win32') {
  runs.push(['e2e', [join(HERE, 'e2e.test.mjs')]])
} else {
  console.log('[e2e] SKIPPED (Windows-only: this plugin is Windows-only)')
}

if (themePath !== undefined && existsSync(themePath)) {
  runs.push(['tokens', [join(HERE, 'tokens.test.cjs'), join(HERE, '..', 'lib', 'client.js'), themePath]])
} else {
  console.log('[tokens] SKIPPED (pass --theme <path to dsh-client-ui-theme/lib/client.js>)')
}

if (marketValidator !== undefined && existsSync(marketValidator)) {
  runs.push(['market', [join(HERE, '..', 'scripts', 'verify-market-index.mjs'), join(HERE, '..'), marketValidator]])
} else {
  console.log('[market] SKIPPED (pass --market <path to dsh-plugin-market-index/lib/index.js>)')
}

const failed = []
for (const [label, argv] of runs) {
  console.log(`\n===== ${label} =====`)
  const result = spawnSync(node, argv, { stdio: 'inherit' })
  if (result.status !== 0) failed.push(label)
}

if (failed.length === 0) console.log('\nALL SUITES PASSED')
else console.log(`\nFAILED SUITE(S): ${failed.join(', ')}`)
process.exit(failed.length === 0 ? 0 : 1)
