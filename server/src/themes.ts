/**
 * Theme catalog — a theme is a folder under themes/ with theme.json + theme.css.
 * Adding a theme later is adding a folder (PRD §5.3, TDD §9).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import type { ThemeInfo } from '@versecast/shared'
import { PATHS } from './config.js'

export function listThemes(): ThemeInfo[] {
  if (!existsSync(PATHS.themes)) return []
  const out: ThemeInfo[] = []
  for (const dir of readdirSync(PATHS.themes, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const jsonPath = path.join(PATHS.themes, dir.name, 'theme.json')
    if (!existsSync(jsonPath)) continue
    try {
      const config = JSON.parse(readFileSync(jsonPath, 'utf8'))
      out.push({
        id: config.id ?? dir.name,
        name: config.name ?? dir.name,
        transitionMs: config.transition?.ms ?? 450,
      })
    } catch {
      // malformed theme folder — skip rather than break the catalog
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
