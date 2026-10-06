import { context, getOctokit } from '@actions/github'

import { resolveUpdateLog } from './updatelog.mjs'

const UPDATE_TAG_NAME = 'updater'
const UPDATE_JSON_FILE = 'update-fixed-webview2.json'
const UPDATE_JSON_PROXY = 'update-fixed-webview2-proxy.json'
const HFGJ_STABLE_TAG_RE = /^v\\d+\\.\\d+\\.\\d+-hfgj\\.\\d+$/

const changelogTag = (tag) => tag.replace(/-hfgj\\.\\d+$/, '')

async function resolveUpdater() {
  if (process.env.GITHUB_TOKEN === undefined) {
    throw new Error('GITHUB_TOKEN is required')
  }

  const options = { owner: context.repo.owner, repo: context.repo.repo }
  const github = getOctokit(process.env.GITHUB_TOKEN)

  let targetTag = process.env.HFGJ_RELEASE_TAG?.trim()

  if (targetTag) {
    if (!HFGJ_STABLE_TAG_RE.test(targetTag)) {
      throw new Error(`Invalid HFGJ_RELEASE_TAG: ${targetTag}`)
    }
  } else {
    const { data: releases } = await github.rest.repos.listReleases({
      ...options,
      per_page: 100,
    })
    const stableRelease = releases.find(
      (release) =>
        !release.draft &&
        !release.prerelease &&
        HFGJ_STABLE_TAG_RE.test(release.tag_name),
    )
    if (!stableRelease) {
      throw new Error('No published HFGJ stable release found')
    }
    targetTag = stableRelease.tag_name
  }

  const { data: latestRelease } = await github.rest.repos.getReleaseByTag({
    ...options,
    tag: targetTag,
  })
  const tag = { name: targetTag }

  console.log(tag)
  console.log()

  const updateData = {
    name: tag.name,
    notes: await resolveUpdateLog(changelogTag(tag.name)),
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': { signature: '', url: '' },
      'windows-aarch64': { signature: '', url: '' },
      'windows-x86': { signature: '', url: '' },
      'windows-i686': { signature: '', url: '' },
    },
  }

  const promises = latestRelease.assets.map(async (asset) => {
    const { name, browser_download_url } = asset

    if (name.endsWith('x64_fixed_webview2-setup.exe')) {
      updateData.platforms['windows-x86_64'].url = browser_download_url
    }
    if (name.endsWith('x64_fixed_webview2-setup.exe.sig')) {
      const sig = await getSignature(browser_download_url)
      updateData.platforms['windows-x86_64'].signature = sig
    }

    if (name.endsWith('x86_fixed_webview2-setup.exe')) {
      updateData.platforms['windows-x86'].url = browser_download_url
      updateData.platforms['windows-i686'].url = browser_download_url
    }
    if (name.endsWith('x86_fixed_webview2-setup.exe.sig')) {
      const sig = await getSignature(browser_download_url)
      updateData.platforms['windows-x86'].signature = sig
      updateData.platforms['windows-i686'].signature = sig
    }

    if (name.endsWith('arm64_fixed_webview2-setup.exe')) {
      updateData.platforms['windows-aarch64'].url = browser_download_url
    }
    if (name.endsWith('arm64_fixed_webview2-setup.exe.sig')) {
      const sig = await getSignature(browser_download_url)
      updateData.platforms['windows-aarch64'].signature = sig
    }
  })

  await Promise.allSettled(promises)
  console.log(updateData)

  Object.entries(updateData.platforms).forEach(([key, value]) => {
    if (!value.url) {
      console.log(`[Error]: failed to parse release for "${key}"`)
      delete updateData.platforms[key]
    }
  })

  const updateDataNew = JSON.parse(JSON.stringify(updateData))

  Object.entries(updateDataNew.platforms).forEach(([key, value]) => {
    if (value.url) {
      updateDataNew.platforms[key].url = 'https://update.hwdns.net/' + value.url
    } else {
      console.log(`[Error]: updateDataNew.platforms.${key} is null`)
    }
  })

  const { data: updateRelease } = await github.rest.repos.getReleaseByTag({
    ...options,
    tag: UPDATE_TAG_NAME,
  })

  await github.rest.repos.updateRelease({
    ...options,
    release_id: updateRelease.id,
    make_latest: 'false',
  })

  for (const asset of updateRelease.assets) {
    if (asset.name === UPDATE_JSON_FILE) {
      await github.rest.repos.deleteReleaseAsset({
        ...options,
        asset_id: asset.id,
      })
    }

    if (asset.name === UPDATE_JSON_PROXY) {
      await github.rest.repos
        .deleteReleaseAsset({ ...options, asset_id: asset.id })
        .catch(console.error) // do not break the pipeline
    }
  }

  await github.rest.repos.uploadReleaseAsset({
    ...options,
    release_id: updateRelease.id,
    name: UPDATE_JSON_FILE,
    data: JSON.stringify(updateData, null, 2),
  })

  await github.rest.repos.uploadReleaseAsset({
    ...options,
    release_id: updateRelease.id,
    name: UPDATE_JSON_PROXY,
    data: JSON.stringify(updateDataNew, null, 2),
  })

  await github.rest.repos.updateRelease({
    ...options,
    release_id: latestRelease.id,
    make_latest: 'true',
  })
}

async function getSignature(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/octet-stream' },
  })

  return response.text()
}

resolveUpdater().catch((error) => {\n  console.error(error)\n  process.exitCode = 1\n})
