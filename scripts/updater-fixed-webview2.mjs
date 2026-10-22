import { publishUpdater } from './hfgj-release.mjs'

publishUpdater(true).catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
