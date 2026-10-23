import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  assertNotOlder,
  completeRelease,
  pinnedCoreVersion,
  publishUpdater,
  releaseFiles,
  VARIANTS,
  verifyArtifacts,
  updaterMatches,
} from './hfgj-release.mjs'

const tag = 'v2.5.8-hfgj.1'
const sha = 'a'.repeat(40)
const core = 'v1.19.32-hfgj.abc123'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hfgj-artifacts-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  for (const variant of VARIANTS) {
    const files = releaseFiles(tag)[variant].map((name) => {
      const data = Buffer.from(`signed package fixture: ${name}`)
      fs.writeFileSync(path.join(directory, name), data)
      return {
        name,
        size: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      }
    })
    fs.writeFileSync(
      path.join(directory, `manifest-${variant}.json`),
      JSON.stringify({
        tag,
        source_sha: sha,
        variant,
        core_version: core,
        files,
      }),
    )
  }
  return directory
}

function changeManifest(directory, variant, change) {
  const file = path.join(directory, `manifest-${variant}.json`)
  const manifest = JSON.parse(fs.readFileSync(file))
  change(manifest)
  fs.writeFileSync(file, JSON.stringify(manifest))
}

test('release requires both installers, macOS updater archive, and every signature', () => {
  const assets = Object.values(releaseFiles(tag))
    .flat()
    .map((name) => ({ name, size: 1 }))
  const release = { tag_name: tag, assets, draft: false, prerelease: false }
  assert.equal(completeRelease(release, tag), true)
  for (const asset of assets) {
    assert.equal(
      completeRelease(
        { ...release, assets: assets.filter((entry) => entry !== asset) },
        tag,
      ),
      false,
    )
  }
  assert.equal(completeRelease({ ...release, draft: true }, tag), false)
  assert.throws(() => releaseFiles('v2.5.8-alpha'), /Invalid/)
})

test('accepts exactly the three validated variants and rejects tampered packages', (t) => {
  const directory = fixture(t)
  assert.equal(verifyArtifacts(directory, tag, sha).length, 10)
  fs.appendFileSync(
    path.join(directory, releaseFiles(tag)['windows-x64'][0]),
    'tampered',
  )
  assert.throws(
    () => verifyArtifacts(directory, tag, sha),
    /integrity mismatch/,
  )
})

test('rejects artifacts from another source or different pinned cores', (t) => {
  const directory = fixture(t)
  assert.throws(
    () => verifyArtifacts(directory, tag, 'b'.repeat(40)),
    /identity mismatch/,
  )
  changeManifest(directory, 'macos-arm64', (manifest) => {
    manifest.core_version = 'v1.19.33-hfgj.def456'
  })
  assert.throws(
    () => verifyArtifacts(directory, tag, sha),
    /different core versions/,
  )
})

test('rejects a missing macOS updater archive before publication', (t) => {
  const directory = fixture(t)
  fs.unlinkSync(path.join(directory, releaseFiles(tag)['macos-arm64'][1]))
  assert.throws(() => verifyArtifacts(directory, tag, sha), /ENOENT/)
})

test('stable core pin and metadata ordering prevent accidental channel changes or downgrade', () => {
  assert.equal(pinnedCoreVersion(core), core)
  assert.throws(() => pinnedCoreVersion('Alpha'), /Invalid/)
  assert.doesNotThrow(() => assertNotOlder('v2.5.8-hfgj.10', 'v2.5.8-hfgj.9'))
  assert.throws(() => assertNotOlder('v2.5.7-hfgj.99', tag), /older/)
})

test('updater publishes only supported platforms with signatures and fails before writes on missing assets', async (t) => {
  const previous = { fetch: globalThis.fetch, env: { ...process.env } }
  t.after(() => {
    globalThis.fetch = previous.fetch
    process.env = previous.env
  })
  Object.assign(process.env, {
    GITHUB_REPOSITORY: 'hfgj/clash-verge-rev',
    GITHUB_TOKEN: 'fixture',
    HFGJ_RELEASE_TAG: tag,
  })
  const release = {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: '2026-10-22T00:00:00Z',
    assets: Object.values(releaseFiles(tag))
      .flat()
      .map((name) => ({
        name,
        size: 1,
        browser_download_url: `https://example.test/${name}`,
      })),
  }
  const writes = []
  const assertVersionMetadata = (filenames) => {
    for (const filename of filenames) {
      const upload = writes.find((write) =>
        write.url.endsWith(`?name=${filename}`),
      )
      assert.ok(upload, `Missing updater metadata: ${filename}`)
      const metadata = JSON.parse(upload.options.body.toString())
      assert.equal(
        Object.hasOwn(metadata, 'name'),
        false,
        `${filename}: name aliases version in the Tauri updater`,
      )
      assert.equal(metadata.version, tag.slice(1))
    }
  }
  globalThis.fetch = async (url, options = {}) => {
    if (options.method && options.method !== 'GET') {
      writes.push({ url, options })
      return Response.json({})
    }
    if (url.includes('example.test/')) return new Response('signed-fixture')
    if (url.endsWith('/releases?per_page=100')) return Response.json([release])
    if (url.endsWith('/releases/tags/updater'))
      return Response.json({ id: 7, assets: [] })
    if (url.includes('/releases/tags/')) return Response.json(release)
    throw new Error(`Unexpected request: ${url}`)
  }
  await publishUpdater(false)
  assertVersionMetadata(['update.json', 'update-proxy.json'])
  const normal = JSON.parse(
    writes
      .find((write) => write.url.endsWith('?name=update.json'))
      .options.body.toString(),
  )
  assert.deepEqual(Object.keys(normal.platforms).sort(), [
    'darwin-aarch64',
    'darwin-aarch64-app',
    'windows-x86_64',
    'windows-x86_64-nsis',
  ])
  assert.equal(normal.version, '2.5.8-hfgj.1')
  assert.equal(normal.platforms['darwin-aarch64'].signature, 'signed-fixture')
  assert.match(normal.platforms['darwin-aarch64'].url, /\.app\.tar\.gz$/)
  writes.length = 0
  await publishUpdater(true)
  assertVersionMetadata([
    'update-fixed-webview2.json',
    'update-fixed-webview2-proxy.json',
  ])
  const fixed = JSON.parse(
    writes
      .find((write) => write.url.endsWith('?name=update-fixed-webview2.json'))
      .options.body.toString(),
  )
  assert.deepEqual(Object.keys(fixed.platforms), ['windows-x86_64'])
  assert.match(
    fixed.platforms['windows-x86_64'].url,
    /_fixed_webview2-setup\.exe$/,
  )
  writes.length = 0
  release.assets = release.assets.filter(
    (asset) => !asset.name.endsWith('.sig'),
  )
  await assert.rejects(
    publishUpdater(false),
    /Missing updater asset or signature/,
  )
  assert.equal(writes.length, 0)
})

test('metadata recovery detects stale versions, missing signatures, and unsupported platform sets', () => {
  const data = {
    version: tag.slice(1),
    platforms: {
      'windows-x86_64': {
        signature: 'signed-fixture',
        url: `https://github.com/hfgj/clash-verge-rev/releases/download/${tag}/${releaseFiles(tag)['windows-x64-fixed'][0]}`,
      },
    },
  }
  assert.equal(
    updaterMatches(data, tag, true, false, 'hfgj/clash-verge-rev'),
    true,
  )
  assert.equal(
    updaterMatches(
      { ...data, version: '2.5.7-hfgj.4' },
      tag,
      true,
      false,
      'hfgj/clash-verge-rev',
    ),
    false,
  )
  assert.equal(
    updaterMatches(data, tag, true, true, 'hfgj/clash-verge-rev'),
    false,
  )
  data.platforms['windows-x86_64'].signature = ''
  assert.equal(
    updaterMatches(data, tag, true, false, 'hfgj/clash-verge-rev'),
    false,
  )
})

test('Fixed WebView2 keeps HFGJ update trust and Windows capabilities', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hfgj-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.mkdirSync(path.join(directory, 'src-tauri'))
  for (const file of [
    'tauri.conf.json',
    'tauri.windows.conf.json',
    'webview2.x64.json',
  ]) {
    fs.copyFileSync(
      `src-tauri/${file}`,
      path.join(directory, 'src-tauri', file),
    )
  }
  execFileSync(
    process.execPath,
    [
      path.resolve('scripts/hfgj-release.mjs'),
      'configure',
      'windows-x64-fixed',
    ],
    { cwd: directory },
  )
  const base = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json'))
  const standard = JSON.parse(
    fs.readFileSync('src-tauri/tauri.windows.conf.json'),
  )
  const fixed = JSON.parse(
    fs.readFileSync(path.join(directory, 'src-tauri/tauri.windows.conf.json')),
  )
  assert.equal(fixed.plugins.updater.pubkey, base.plugins.updater.pubkey)
  assert.deepEqual(fixed.plugins.updater.endpoints, [
    'https://github.com/hfgj/clash-verge-rev/releases/download/updater/update-fixed-webview2.json',
  ])
  assert.deepEqual(fixed.app, standard.app)
  assert.equal(fixed.bundle.windows.webviewInstallMode.type, 'fixedRuntime')
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(directory, '.hfgj-build-config.json')))
      .build.beforeBuildCommand,
    null,
  )
})
