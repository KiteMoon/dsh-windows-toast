/**
 * Generate and validate `market.json`, the DSH plugin-market index (format 1).
 *
 * The output is validated with the REAL validator, `parseMarketIndex` from
 * `@deepseek-ai/dsh-plugin-market-index`, extracted from the installed app.asar.
 * Restating the format by hand would test the restatement instead of the
 * document, and the format has enough rules (localized text requiring `en`,
 * declared-id references, canonical URLs, exact SemVer) that a hand-rolled check
 * would be both weaker and more likely to be wrong.
 *
 * Usage:
 *   node scripts/generate-market-index.mjs <repoDir> [validatorDir]
 *
 * `validatorDir` must contain a resolvable `semver`; extract the validator and
 * point this at it, or pass the pre-extracted copy.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const repo = process.argv[2] ?? join(HERE, '..')
const validatorSource = process.argv[3]

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))

/** Locate a real `semver` beside any Node on PATH, as the validator imports it. */
function findSemver() {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'node_modules', 'semver', 'index.js'),
    ...(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
      .filter((entry) => entry.trim() !== '')
      .map((entry) => join(entry, 'node_modules', 'npm', 'node_modules', 'semver', 'index.js')),
  ]
  return candidates.find((candidate) => {
    try {
      readFileSync(candidate)
      return true
    } catch {
      return false
    }
  })
}

/**
 * Publish timestamp: integer Unix **seconds**, as format 1 requires.
 *
 * Honours `SOURCE_DATE_EPOCH` when set, so a reproducible build does not rewrite
 * the file on every run and produce a spurious diff. Otherwise the current time
 * is used.
 */
const publishTimestamp = Number.parseInt(process.env.SOURCE_DATE_EPOCH ?? '', 10) || Math.floor(Date.now() / 1000)

/** Read a git field from the manifest's repository URL, normalised to https. */
function repositoryUrl() {
  const raw = pkg.repository?.url ?? ''
  return raw
    .replace(/^git\+/u, '')
    .replace(/\.git$/u, '')
    .replace(/^git:\/\//u, 'https://')
}

/**
 * Decide the version's `source`, and fail loudly rather than emit something
 * uninstallable.
 *
 * A git source needs the exact 40-hex commit, which only the push knows, so it
 * is supplied by the caller as `MARKET_COMMIT`. Falling back to npm without that
 * commit would be wrong for a git source and right only if the registry copy
 * genuinely exists, so the default is chosen to be truthful at every moment.
 */
function marketSource() {
  const requested = (process.env.MARKET_SOURCE ?? 'git').trim()
  if (requested === 'npm') return { type: 'npm' }
  if (requested !== 'git') {
    console.error(`MARKET_SOURCE must be "npm" or "git", got ${JSON.stringify(requested)}`)
    process.exit(1)
  }
  const commit = (process.env.MARKET_COMMIT ?? '').trim()
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    console.error('MARKET_SOURCE=git requires MARKET_COMMIT to be the lowercase 40-hex commit SHA.')
    console.error('')
    console.error('  MARKET_COMMIT=$(git rev-parse HEAD) node scripts/generate-market-index.mjs .')
    console.error('')
    console.error('Or set MARKET_SOURCE=npm once the package is published to the registry.')
    process.exit(1)
  }
  return { type: 'git', url: repositoryUrl(), commit }
}

const index = {
  format: 1,
  title: {
    en: 'KiteMoon DSH plugins',
    zh: 'KiteMoon DSH 插件',
  },
  description: {
    en: 'Third-party plugins for DeepSeek Harness by KiteMoon.',
    zh: 'KiteMoon 的 DeepSeek Harness 第三方插件。',
  },
  metadata: {
    categories: {
      notifications: { title: { en: 'Notifications', zh: '通知' } },
    },
    labels: {
      windows: { title: { en: 'Windows', zh: 'Windows' } },
      'no-dependencies': { title: { en: 'No dependencies', zh: '无依赖' } },
    },
  },
  plugins: [
    {
      name: pkg.name,
      title: {
        en: 'Windows Toast Notifications',
        zh: 'Windows Toast 通知',
      },
      description: {
        en: 'Toast notifications for review events. Approval toasts carry Approve and Reject buttons, and every event type has its own dismiss time.',
        zh: '为审核事件发送 Windows toast 通知。授权类通知自带「同意 / 拒绝」按钮，各类事件的消失时间可分别调整。',
      },
      // Relative references resolve against the index URL, which is what makes
      // the raw.githubusercontent.com copy self-contained.
      icon: 'icon.svg',
      author: pkg.author,
      homepage: 'https://github.com/KiteMoon/dsh-windows-toast',
      repository: { url: 'https://github.com/KiteMoon/dsh-windows-toast' },
      metadata: {
        category: 'notifications',
        keywords: ['toast', 'notification', 'approval', 'windows', 'winrt'],
        labels: ['windows', 'no-dependencies'],
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp,
          // The `source` decides what Discover actually runs. `npm` resolves to
          // `pnpm add <name>@<version>`, which 404s until the package is really
          // published; `git` resolves to a commit-pinned URL that works as soon
          // as the commit is pushed. Defaulting to `git` keeps the published
          // index truthful at every moment, and `MARKET_SOURCE=npm` switches it
          // once the registry copy exists.
          source: marketSource(),
          engines: { dsh: pkg.engines?.dsh },
        },
      ],
    },
  ],
}

const outPath = join(repo, 'market.json')
writeFileSync(outPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`wrote ${outPath}`)

// ---------------------------------------------------------------- validation

if (validatorSource === undefined) {
  console.log('\n[validate] SKIPPED: no validator supplied, so the document was only generated.')
  console.log('           To validate it with the real rule set, extract the shipped')
  console.log('           validator from your DSH installation and pass its path:')
  console.log('')
  console.log('             # inside a DSH source checkout')
  console.log('             node scripts/generate-market-index.mjs . \\')
  console.log('               packages/util/plugin-market-index/lib/index.js')
  console.log('')
  console.log('           The file to pass is @deepseek-ai/dsh-plugin-market-index.')
  console.log('           This script rewrites its one `semver` import so the shipped')
  console.log('           module runs unmodified rather than being reimplemented here.')
  process.exit(0)
}

const semverPath = findSemver()
if (semverPath === undefined) {
  console.log('\n[validate] SKIPPED: no `semver` found for the validator to import.')
  process.exit(0)
}

// The validator imports its semver dependency by bare specifier. Rewriting that
// one import to the resolved path lets the shipped module run unmodified, rather
// than reimplementing it.
const patched = readFileSync(validatorSource, 'utf8')
  .replace(/from\s+["']semver["']/u, `from ${JSON.stringify(`file://${semverPath.replace(/\\/gu, '/')}`)}`)

const staging = mkdtempSync(join(tmpdir(), 'dtn-market-'))
const stagedPath = join(staging, 'market-index.mjs')
writeFileSync(stagedPath, patched, 'utf8')

const { parseMarketIndex, marketInstallTarget } = await import(`file://${stagedPath.replace(/\\/gu, '/')}`)

const indexUrl = 'https://raw.githubusercontent.com/KiteMoon/dsh-windows-toast/main/market.json'
let parsed
try {
  parsed = parseMarketIndex(JSON.parse(readFileSync(outPath, 'utf8')), indexUrl)
} catch (error) {
  console.error(`\n[validate] FAILED: ${error.message}`)
  process.exit(1)
}

console.log('\n[validate] parseMarketIndex accepted the document')
console.log(`  title       : ${JSON.stringify(parsed.title)}`)
console.log(`  plugins     : ${parsed.plugins.length}`)
for (const plugin of parsed.plugins) {
  console.log(`  - ${plugin.name} (${plugin.versions.length} version(s))`)
  for (const version of plugin.versions) {
    const target = marketInstallTarget(plugin.name, version)
    console.log(`      ${version.version}  engines.dsh=${JSON.stringify(version.engines.dsh)}`)
    console.log(`      install spec: ${target.spec}`)
  }
  console.log(`      icon: ${plugin.icon}`)
}
console.log('\n[validate] OK')
