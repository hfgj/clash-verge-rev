import fs from 'node:fs'

const read = (path) => fs.readFileSync(path, 'utf8')
const fail = (message) => {
  console.error(`[HFGJ CHECK] ${message}`)
  process.exitCode = 1
}
const pass = (message) => console.log(`[HFGJ CHECK] OK: ${message}`)

const packageJson = JSON.parse(read('package.json'))
const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'))
const cargoToml = read('src-tauri/Cargo.toml')
const cargoLock = read('Cargo.lock')
const enhance = read('src-tauri/src/enhance/mod.rs')
const tun = read('src-tauri/src/enhance/tun.rs')
const release = read('.github/workflows/release.yml')
const releaseVersion = read('scripts/release-version.mjs')
const prebuild = read('scripts/prebuild.mjs')
const coreUpgrade = read('src-tauri/src/feat/core_upgrade.rs')

const packageVersion = packageJson.version
const cargoVersion = cargoToml.match(/^version = "([^"]+)"/m)?.[1]
const lockVersion = cargoLock.match(/\[\[package\]\]\r?\nname = "clash-verge"\r?\nversion = "([^"]+)"/)?.[1]

if (packageVersion !== tauriConfig.version || packageVersion !== cargoVersion || packageVersion !== lockVersion) {
  fail(
    `version mismatch: package=${packageVersion}, tauri=${tauriConfig.version}, cargo=${cargoVersion}, lock=${lockVersion}`,
  )
} else {
  pass(`version files agree on ${packageVersion}`)
}

for (const key of ['dns-hijack', 'route-exclude-address']) {
  if (!enhance.includes(`HFGJ_CONFIG_OWNED_TUN_KEYS: &[&str] = &["dns-hijack", "route-exclude-address"]`)) {
    fail('HFGJ config-owned TUN allowlist is missing or changed')
    break
  }
}
if (
  enhance.includes('HFGJ_CONFIG_OWNED_TUN_KEYS: &[&str] = &["dns-hijack", "route-exclude-address"]')
) {
  pass('dns-hijack and route-exclude-address remain config-owned')
}

if (tun.includes('set_public_dns(') || tun.includes('restore_public_dns(')) {
  fail('TUN enhancement is modifying/restoring macOS system DNS')
} else {
  pass('TUN enhancement leaves macOS system DNS untouched')
}

const expectedEndpoint =
  'https://github.com/hfgj/clash-verge-rev/releases/download/updater/update.json'
const endpoints = tauriConfig.plugins?.updater?.endpoints ?? []
if (endpoints.length !== 1 || endpoints[0] !== expectedEndpoint) {
  fail(`unexpected updater endpoints: ${JSON.stringify(endpoints)}`)
} else {
  pass('updater endpoint is isolated to hfgj/clash-verge-rev')
}

const expectedPubkey =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ3RDFCQjg0NDBBRjMyNzMKUldSek1xOUFoTHZSUjNWclhpSFR2dGRPQmk2bjhCb0dCeFlUOVo2QkYzKzRTYVF0UWV3SGs0TjIK'
if (tauriConfig.plugins?.updater?.pubkey !== expectedPubkey) {
  fail('updater public key no longer matches the HFGJ signing key')
} else {
  pass('updater public key matches HFGJ key')
}

if (release.includes('https://github.com/clash-verge-rev/clash-verge-rev/releases/download')) {
  fail('release workflow still contains the upstream release download URL')
} else {
  pass('release download URLs are fork-aware')
}

if (!releaseVersion.includes('alpha|beta|rc|hfgj')) {
  fail('release-version.mjs no longer accepts hfgj prerelease identifiers')
} else {
  pass('release-version.mjs accepts HFGJ versions')
}

const hfgjMihomoMarkers = [
  'https://github.com/hfgj/mihomo/releases/download/HFGJ-Stable',
  'https://github.com/hfgj/mihomo/releases/download/HFGJ-Alpha',
]
for (const marker of hfgjMihomoMarkers) {
  if (!prebuild.includes(marker) || !coreUpgrade.includes(marker)) {
    fail(`Windows Mihomo source is not isolated to HFGJ: missing ${marker}`)
  }
}
if (
  hfgjMihomoMarkers.every(
    (marker) => prebuild.includes(marker) && coreUpgrade.includes(marker),
  )
) {
  pass('Windows bundled/core-upgrade Mihomo sources are isolated to hfgj/mihomo')
}

if (
  !prebuild.includes(
    "platform === 'win32' && (arch === 'x64' || arch === 'arm64')",
  ) ||
  !coreUpgrade.includes(
    'cfg!(target_os = "windows") && matches!(std::env::consts::ARCH, "x86_64" | "aarch64")',
  )
) {
  fail('HFGJ Mihomo source selection is no longer limited to Windows x64/arm64')
} else {
  pass('HFGJ Mihomo patch remains scoped to Windows x64/arm64')
}

if (process.exitCode) {
  process.exit(process.exitCode)
}
