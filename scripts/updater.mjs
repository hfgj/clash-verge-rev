import { publishUpdater } from './hfgj-release.mjs'

publishUpdater(false).catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
