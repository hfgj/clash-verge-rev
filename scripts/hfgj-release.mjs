import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveUpdateLog, resolveUpdateLogDefault } from './updatelog.mjs'

export const VARIANTS = ['windows-x64', 'macos-arm64', 'windows-x64-fixed']

export function releaseFiles(tag) {
  if (!/^v\d+\.\d+\.\d+-hfgj\.\d+$/.test(tag)) {
    throw new Error(`Invalid HFGJ release tag: ${tag}`)
  }
  const version = tag.slice(1)
  const win = `Clash.Verge_${version}_x64-setup.exe`
  const fixed = `Clash.Verge_${version}_x64_fixed_webview2-setup.exe`
  const mac = `Clash.Verge_${version}_aarch64`
  return {
    'windows-x64': [win, `${win}.sig`],
    'macos-arm64': [`${mac}.dmg`, `${mac}.app.tar.gz`, `${mac}.app.tar.gz.sig`],
    'windows-x64-fixed': [fixed, `${fixed}.sig`],
  }
}

export function pinnedCoreVersion(
  value = process.env.HFGJ_STABLE_CORE_VERSION,
) {
  if (!value) return undefined
  if (!/^v\d+\.\d+\.\d+-hfgj\.[0-9a-f]+$/.test(value)) {
    throw new Error('Invalid pinned HFGJ Stable core version')
  }
  return value
}

export function completeRelease(release, tag) {
  return Boolean(
    release &&
      !release.draft &&
      !release.prerelease &&
      release.tag_name === tag &&
      Object.values(releaseFiles(tag))
        .flat()
        .every((name) =>
          release.assets.some((asset) => asset.name === name && asset.size > 0),
        ),
  )
}

export function assertNotOlder(tag, latest) {
  const parts = (value) => value.match(/\d+/g).map(Number)
  const a = parts(tag)
  const b = parts(latest)
  for (let i = 0; i < a.length; i++) {
    if (a[i] > b[i]) return
    if (a[i] < b[i])
      throw new Error(`Refusing to replace ${latest} with older ${tag}`)
  }
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const hash = (data) => createHash('sha256').update(data).digest('hex')
const repo = () => {
  const value = process.env.GITHUB_REPOSITORY
  if (!/^[\w.-]+\/[\w.-]+$/.test(value ?? ''))
    throw new Error('GITHUB_REPOSITORY is required')
  return value
}

async function api(
  endpoint,
  { method = 'GET', body, missing = false, bytes = false } = {},
) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is required')
  const url = endpoint.startsWith('https://uploads.github.com/')
    ? endpoint
    : `https://api.github.com/repos/${repo()}/${endpoint}`
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      ...(body
        ? {
            'Content-Type': bytes
              ? 'application/octet-stream'
              : 'application/json',
          }
        : {}),
    },
    body: body ? (bytes ? body : JSON.stringify(body)) : undefined,
  })
  if (missing && response.status === 404) return null
  if (!response.ok)
    throw new Error(
      `GitHub ${method} ${endpoint}: ${response.status} ${await response.text()}`,
    )
  return response.status === 204 ? null : response.json()
}

const getRelease = (tag) =>
  api(`releases/tags/${encodeURIComponent(tag)}`, { missing: true })
const output = (values) => {
  for (const [key, value] of Object.entries(values)) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
  }
}

async function prepare() {
  const tag = process.env.HFGJ_RELEASE_TAG
  releaseFiles(tag)
  const sha = git('rev-parse', 'HEAD')
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid source SHA')
  if (process.env.HFGJ_SOURCE_SHA && sha !== process.env.HFGJ_SOURCE_SHA) {
    throw new Error('Checkout does not match the requested source SHA')
  }
  if (JSON.parse(fs.readFileSync('package.json')).version !== tag.slice(1)) {
    throw new Error('Source version does not match the release tag')
  }
  const rust = fs
    .readFileSync('rust-toolchain.toml', 'utf8')
    .match(/^channel\s*=\s*"(\d+\.\d+\.\d+)"/m)?.[1]
  if (!rust) throw new Error('A pinned Rust toolchain is required')
  const publish = process.env.HFGJ_PUBLISH === 'true'
  const run = process.env.HFGJ_ARTIFACT_RUN_ID ?? ''
  if (run && !/^\d+$/.test(run)) throw new Error('Invalid artifact run ID')
  if (publish) {
    git('fetch', 'origin', 'hfgj', `refs/tags/${tag}:refs/tags/${tag}`)
    if (git('rev-list', '-n', '1', tag) !== sha)
      throw new Error('Release tag points at another source commit')
    git('merge-base', '--is-ancestor', sha, 'origin/hfgj')
  }
  const complete = completeRelease(await getRelease(tag), tag)
  const build = !complete && (!publish || !run)
  let core = ''
  if (build) {
    const response = await fetch(
      'https://github.com/hfgj/mihomo/releases/download/HFGJ-Stable/version.txt',
    )
    if (!response.ok)
      throw new Error(
        `HFGJ Stable version discovery failed: ${response.status}`,
      )
    core = pinnedCoreVersion((await response.text()).trim())
    if (!core) throw new Error('HFGJ Stable version file is empty')
  }
  output({
    source_sha: sha,
    rust_version: rust,
    build_required: build,
    already_published: complete,
    core_version: core,
  })
}

function configure(variant) {
  if (!VARIANTS.includes(variant))
    throw new Error('Unsupported release variant')
  fs.writeFileSync(
    '.hfgj-build-config.json',
    JSON.stringify({ build: { beforeBuildCommand: null } }),
  )
  if (variant !== 'windows-x64-fixed') return
  const file = 'src-tauri/tauri.windows.conf.json'
  const standard = JSON.parse(fs.readFileSync(file))
  const fixed = JSON.parse(fs.readFileSync('src-tauri/webview2.x64.json'))
  const base = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json'))
  fixed.app = standard.app
  fixed.plugins = {
    updater: {
      ...base.plugins.updater,
      endpoints: [
        'https://github.com/hfgj/clash-verge-rev/releases/download/updater/update-fixed-webview2.json',
      ],
    },
  }
  fs.writeFileSync(file, `${JSON.stringify(fixed, null, 2)}\n`)
}

function collect(variant) {
  const tag = process.env.HFGJ_RELEASE_TAG
  const names = releaseFiles(tag)[variant]
  if (!names) throw new Error('Unsupported release variant')
  const target =
    variant === 'macos-arm64'
      ? 'aarch64-apple-darwin'
      : 'x86_64-pc-windows-msvc'
  const root = `target/${target}/release/bundle`
  const find = (directory, suffix) => {
    const matches = fs
      .readdirSync(`${root}/${directory}`)
      .filter((name) => name.endsWith(suffix))
    if (matches.length !== 1)
      throw new Error(`Expected one ${suffix} in ${directory}`)
    return `${root}/${directory}/${matches[0]}`
  }
  const installer =
    variant === 'macos-arm64' ? find('dmg', '.dmg') : find('nsis', '-setup.exe')
  const archive =
    variant === 'macos-arm64' ? find('macos', '.app.tar.gz') : installer
  const sources =
    variant === 'macos-arm64'
      ? [installer, archive, `${archive}.sig`]
      : [installer, `${installer}.sig`]
  const directory = `release-artifacts/${variant}`
  fs.mkdirSync(directory, { recursive: true })
  const core = pinnedCoreVersion(process.env.HFGJ_STABLE_CORE_VERSION)
  if (!core) throw new Error('Missing pinned core version')
  const binary = `src-tauri/sidecar/verge-mihomo-${target}${variant === 'macos-arm64' ? '' : '.exe'}`
  if (!execFileSync(binary, ['-v'], { encoding: 'utf8' }).includes(core)) {
    throw new Error('Bundled Mihomo does not match the pinned HFGJ core')
  }
  const files = sources.map((source, index) => {
    const data = fs.readFileSync(source)
    if (!data.length) throw new Error(`Empty release asset: ${source}`)
    fs.writeFileSync(path.join(directory, names[index]), data)
    return { name: names[index], size: data.length, sha256: hash(data) }
  })
  fs.writeFileSync(
    `${directory}/manifest-${variant}.json`,
    `${JSON.stringify(
      {
        tag,
        source_sha: git('rev-parse', 'HEAD'),
        variant,
        core_version: core,
        files,
      },
      null,
      2,
    )}\n`,
  )
}

export function verifyArtifacts(directory, tag, sha) {
  const specifications = releaseFiles(tag)
  const assets = []
  let core
  for (const variant of VARIANTS) {
    const manifestName = `manifest-${variant}.json`
    const manifest = JSON.parse(
      fs.readFileSync(path.join(directory, manifestName)),
    )
    if (
      manifest.tag !== tag ||
      manifest.source_sha !== sha ||
      manifest.variant !== variant
    ) {
      throw new Error(`Artifact identity mismatch: ${variant}`)
    }
    const version = pinnedCoreVersion(manifest.core_version)
    if (!version || (core && core !== version))
      throw new Error('Artifacts contain different core versions')
    core = version
    if (
      JSON.stringify(manifest.files.map((file) => file.name)) !==
      JSON.stringify(specifications[variant])
    ) {
      throw new Error(`Unexpected asset set: ${variant}`)
    }
    for (const file of manifest.files) {
      const filename = path.join(directory, file.name)
      if (!fs.lstatSync(filename).isFile())
        throw new Error(`Not a regular asset: ${file.name}`)
      const data = fs.readFileSync(filename)
      if (
        !data.length ||
        data.length !== file.size ||
        hash(data) !== file.sha256
      ) {
        throw new Error(`Asset integrity mismatch: ${file.name}`)
      }
      assets.push(filename)
    }
    assets.push(path.join(directory, manifestName))
  }
  return assets
}

async function releaseNotes(tag) {
  const notes = await resolveUpdateLog(tag.replace(/-hfgj\.\d+$/, '')).catch(
    () => resolveUpdateLogDefault(),
  )
  const base = `https://github.com/${repo()}/releases/download/${tag}`
  const files = releaseFiles(tag)
  return `${notes}\n\n## HFGJ downloads\n\n- [Windows x64](${base}/${files['windows-x64'][0]})\n- [Windows x64 Fixed WebView2](${base}/${files['windows-x64-fixed'][0]})\n- [macOS Apple Silicon](${base}/${files['macos-arm64'][0]})\n`
}

async function latestStable() {
  return (await api('releases?per_page=100')).find(
    (release) =>
      !release.draft &&
      !release.prerelease &&
      /^v\d+\.\d+\.\d+-hfgj\.\d+$/.test(release.tag_name),
  )
}

async function publish() {
  const tag = process.env.HFGJ_RELEASE_TAG
  const current = await getRelease(tag)
  if (completeRelease(current, tag)) return
  const latest = await latestStable()
  if (latest) assertNotOlder(tag, latest.tag_name)
  const assets = verifyArtifacts(
    'release-artifacts',
    tag,
    git('rev-parse', 'HEAD'),
  )
  fs.writeFileSync('.hfgj-release-notes.md', await releaseNotes(tag))
  if (!current) {
    execFileSync(
      'gh',
      [
        'release',
        'create',
        tag,
        '--repo',
        repo(),
        '--verify-tag',
        '--draft',
        '--title',
        `Clash Verge Rev ${tag}`,
        '--notes-file',
        '.hfgj-release-notes.md',
      ],
      { stdio: 'inherit' },
    )
  }
  execFileSync(
    'gh',
    ['release', 'upload', tag, '--repo', repo(), ...assets, '--clobber'],
    { stdio: 'inherit' },
  )
  execFileSync(
    'gh',
    [
      'release',
      'edit',
      tag,
      '--repo',
      repo(),
      '--draft=false',
      '--prerelease=false',
      '--latest',
      '--notes-file',
      '.hfgj-release-notes.md',
    ],
    { stdio: 'inherit' },
  )
}

const updaterPlatforms = (fixed) =>
  fixed
    ? { 'windows-x86_64': ['windows-x64-fixed', 0] }
    : {
        'windows-x86_64': ['windows-x64', 0],
        'windows-x86_64-nsis': ['windows-x64', 0],
        'darwin-aarch64': ['macos-arm64', 1],
        'darwin-aarch64-app': ['macos-arm64', 1],
      }

export function updaterMatches(data, tag, fixed, proxy, repository) {
  const platforms = updaterPlatforms(fixed)
  const names = releaseFiles(tag)
  return (
    data?.version === tag.slice(1) &&
    JSON.stringify(Object.keys(data.platforms ?? {}).sort()) ===
      JSON.stringify(Object.keys(platforms).sort()) &&
    Object.entries(platforms).every(([key, [variant, index]]) => {
      const asset = data.platforms[key]
      const prefix = proxy ? 'https://update.hwdns.net/' : ''
      return (
        typeof asset?.signature === 'string' &&
        asset.signature.trim().length > 0 &&
        asset.url ===
          `${prefix}https://github.com/${repository}/releases/download/${tag}/${names[variant][index]}`
      )
    })
  )
}

async function needsRelease() {
  const tag = process.env.HFGJ_RELEASE_TAG
  if (!completeRelease(await getRelease(tag), tag)) return true
  for (const fixed of [false, true]) {
    for (const proxy of [false, true]) {
      const name = `update${fixed ? '-fixed-webview2' : ''}${proxy ? '-proxy' : ''}.json`
      const response = await fetch(
        `https://github.com/${repo()}/releases/download/updater/${name}`,
      )
      if (!response.ok) return true
      const data = await response.json().catch(() => null)
      if (!updaterMatches(data, tag, fixed, proxy, repo())) return true
    }
  }
  return false
}

export async function publishUpdater(fixed = false) {
  const latest = await latestStable()
  const tag = process.env.HFGJ_RELEASE_TAG?.trim() || latest?.tag_name
  const specifications = releaseFiles(tag)
  if (latest) assertNotOlder(tag, latest.tag_name)
  const release = await getRelease(tag)
  if (!release || release.draft || release.prerelease)
    throw new Error('A published HFGJ stable release is required')
  const platforms = {}
  const select = async (variant, index, keys) => {
    const name = specifications[variant][index]
    const asset = release.assets.find((entry) => entry.name === name)
    const signature = release.assets.find(
      (entry) => entry.name === `${name}.sig`,
    )
    if (!asset?.size || !signature?.size)
      throw new Error(`Missing updater asset or signature: ${name}`)
    const response = await fetch(signature.browser_download_url)
    if (!response.ok)
      throw new Error(`Signature download failed: ${response.status}`)
    const text = (await response.text()).trim()
    if (!text) throw new Error('Empty updater signature')
    for (const key of keys)
      platforms[key] = { url: asset.browser_download_url, signature: text }
  }
  if (fixed) {
    await select('windows-x64-fixed', 0, ['windows-x86_64'])
  } else {
    await select('windows-x64', 0, ['windows-x86_64', 'windows-x86_64-nsis'])
    await select('macos-arm64', 1, ['darwin-aarch64', 'darwin-aarch64-app'])
  }
  const data = {
    version: tag.slice(1),
    notes: await releaseNotes(tag),
    pub_date: release.published_at,
    platforms,
  }
  const metadata = await getRelease('updater')
  if (!metadata) throw new Error('The HFGJ updater metadata release is missing')
  await api(`releases/${metadata.id}`, {
    method: 'PATCH',
    body: { make_latest: 'false' },
  })
  const filename = fixed ? 'update-fixed-webview2.json' : 'update.json'
  for (const proxy of [false, true]) {
    const name = proxy ? filename.replace('.json', '-proxy.json') : filename
    const body = structuredClone(data)
    if (proxy) {
      for (const value of Object.values(body.platforms))
        value.url = `https://update.hwdns.net/${value.url}`
    }
    const previous = metadata.assets.find((asset) => asset.name === name)
    if (previous)
      await api(`releases/assets/${previous.id}`, { method: 'DELETE' })
    await api(
      `https://uploads.github.com/repos/${repo()}/releases/${metadata.id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        body: Buffer.from(JSON.stringify(body, null, 2)),
        bytes: true,
      },
    )
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const command = process.argv[2]
    if (command === 'needs-release') console.log(await needsRelease())
    else if (command === 'prepare') await prepare()
    else if (command === 'configure') configure(process.argv[3])
    else if (command === 'collect') collect(process.argv[3])
    else if (command === 'publish') await publish()
    else throw new Error(`Unknown release command: ${command}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
