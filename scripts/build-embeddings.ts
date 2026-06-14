/**
 * Build the semantic index for a translation: npm run data:index [-- <id>]
 * Downloads the embedding model to the local cache on first run; afterwards
 * fully offline.
 */
import { indexTranslation, indexPath } from '../server/src/search/indexer.js'

const translationId = process.argv[2] ?? 'kjv'
const started = Date.now()
let lastLogged = -10

console.log(`Indexing '${translationId}' → ${indexPath(translationId)}`)
await indexTranslation(translationId, (pct) => {
  if (pct >= lastLogged + 10 || pct === 100) {
    lastLogged = pct
    const elapsed = ((Date.now() - started) / 1000).toFixed(0)
    console.log(`  ${pct}% (${elapsed}s)`)
  }
})
console.log(`Done in ${((Date.now() - started) / 1000).toFixed(0)}s`)
process.exit(0)
