/**
 * VerseCast server — one process, two ports (TDD §2).
 *  :3000 operator console (static SPA + /ws-console + import API)
 *  :3001 live output (static page + /ws-output, read-only by construction)
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import fastifyMultipart from '@fastify/multipart'
import { existsSync } from 'node:fs'
import os from 'node:os'
import type { WebSocket } from 'ws'
import {
  type ConsoleToServer,
  type ServerToConsole,
  type ServerToOutput,
} from '@versecast/shared'
import { PATHS, PORTS } from './config.js'
import { openDb } from './db/index.js'
import { Store } from './state/store.js'
import { AsrPipeline } from './asr/pipeline.js'
import { Detector } from './detect/detector.js'
import { search } from './search/engine.js'
import { getEmbedder } from './search/embedder.js'
import { runImport } from './import/index.js'

function findLanAddress(): string | null {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return null
}

openDb()
const store = new Store()
store.state.outputPort = PORTS.output // never trust a stale snapshot for this
store.state.lanAddress = findLanAddress()

// Never resume hot-mic after a restart (TDD §6.3)
const consoles = new Set<WebSocket>()
const outputs = new Set<WebSocket>()

function sendConsole(ws: WebSocket, msg: ServerToConsole): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

function broadcastConsoles(msg: ServerToConsole): void {
  for (const ws of consoles) sendConsole(ws, msg)
}

function broadcastOutputs(): void {
  const msg: ServerToOutput = { type: 'output.state', output: store.outputState() }
  const data = JSON.stringify(msg)
  for (const ws of outputs) if (ws.readyState === ws.OPEN) ws.send(data)
}

store.on('change', () => {
  broadcastConsoles({ type: 'state.snapshot', state: store.state })
  broadcastOutputs()
})

const detector = new Detector({
  translationId: () => store.state.settings.activeTranslationId,
  threshold: () => store.state.settings.semanticThreshold,
  onDetection: (d) => {
    store.addDetection(d)
    broadcastConsoles({ type: 'detection.new', detection: d })
    // Auto-present explicit spoken references when the operator opts in (PRD §5.2).
    // Only HIGH-confidence references, never semantic guesses.
    if (store.state.settings.autoPresent && d.source === 'reference') {
      store.present(d.ref, d.translationId)
    }
  },
})

const asr = new AsrPipeline({
  modelTier: store.state.settings.modelTier,
  onSegment: (segment) => {
    broadcastConsoles({ type: 'transcript.segment', segment })
    void detector.onSegment(segment)
  },
  onStatus: (status) => broadcastConsoles({ type: 'asr.status', status }),
})

// Warm the embedding model so the first search/detection is fast
void getEmbedder().ready().catch((err) => console.error('embedder failed to load:', err))

// ---------- console app (:3000) ----------

async function buildConsoleApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(fastifyWebsocket, { options: { maxPayload: 1 << 20 } })
  await app.register(fastifyMultipart, { limits: { fileSize: 200 * 1024 * 1024 } })

  app.addHook('onSend', async (_req, reply) => {
    // Offline tripwire (TDD §10): any accidental external request fails loudly
    reply.header(
      'Content-Security-Policy',
      // frame-src: the console embeds the local output page as its live monitor
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ws: http://localhost:* http://127.0.0.1:*; frame-src http://localhost:* http://127.0.0.1:*",
    )
  })

  if (existsSync(PATHS.consoleDist)) {
    await app.register(fastifyStatic, { root: PATHS.consoleDist, prefix: '/' })
  } else {
    app.get('/', async () => 'Console not built yet — run `npm run build` (or `npm run dev`).')
  }
  await app.register(fastifyStatic, { root: PATHS.themes, prefix: '/themes/', decorateReply: false })

  app.get('/ws-console', { websocket: true }, (socket) => {
    consoles.add(socket)
    sendConsole(socket, { type: 'state.snapshot', state: store.state })
    sendConsole(socket, { type: 'asr.status', status: asr.status() })

    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        asr.pushAudio(raw) // audio.chunk — binary frames (TDD §6.2)
        return
      }
      let msg: ConsoleToServer
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      void handleConsoleMessage(socket, msg)
    })

    socket.on('close', () => consoles.delete(socket))
  })

  // Import uses HTTP for the file body; progress streams over the WS
  app.post('/api/import', async (req, reply) => {
    const file = await req.file()
    if (!file) return reply.code(400).send({ error: 'No file uploaded' })
    const xml = (await file.toBuffer()).toString('utf8')
    runImport(xml, file.filename, store, broadcastConsoles)
    return { started: true }
  })

  return app
}

async function handleConsoleMessage(ws: WebSocket, msg: ConsoleToServer): Promise<void> {
  switch (msg.type) {
    case 'asr.start':
      await asr.start()
      detector.reset()
      broadcastConsoles({ type: 'asr.status', status: asr.status() })
      break
    case 'asr.stop':
      asr.stop()
      broadcastConsoles({ type: 'asr.status', status: asr.status() })
      break
    case 'search.query': {
      const { items, reference } = await search(msg.text, store.state.settings.activeTranslationId)
      sendConsole(ws, { type: 'search.results', id: msg.id, query: msg.text, items, reference })
      break
    }
    case 'queue.add':
      store.queueAdd(msg.ref, msg.translationId)
      break
    case 'queue.remove':
      store.queueRemove(msg.id)
      break
    case 'queue.reorder':
      store.queueReorder(msg.id, msg.toIndex)
      break
    case 'queue.clear':
      store.queueClear()
      break
    case 'detections.clear':
      store.clearDetections()
      break
    case 'present.verse':
      store.present(msg.ref, msg.translationId, msg.queueItemId)
      break
    case 'present.blank':
      store.blank(msg.on)
      break
    case 'present.slide':
      store.slide(msg.dir)
      break
    case 'present.step':
      store.step(msg.dir)
      break
    case 'theme.set':
      store.setTheme(msg.themeId)
      break
    case 'settings.update': {
      const prevTier = store.state.settings.modelTier
      store.updateSettings(msg.settings)
      if (msg.settings.modelTier && msg.settings.modelTier !== prevTier) {
        await asr.setTier(msg.settings.modelTier)
        broadcastConsoles({ type: 'asr.status', status: asr.status() })
      }
      if (msg.settings.lanOutput !== undefined) {
        await rebindOutput()
      }
      break
    }
  }
}

// ---------- output app (:3001) ----------

async function buildOutputApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 } })

  app.addHook('onSend', async (_req, reply) => {
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ws:",
    )
  })

  if (existsSync(PATHS.outputDist)) {
    await app.register(fastifyStatic, { root: PATHS.outputDist, prefix: '/' })
  } else {
    app.get('/', async () => 'Output not built yet — run `npm run build` (or `npm run dev`).')
  }
  await app.register(fastifyStatic, { root: PATHS.themes, prefix: '/themes/', decorateReply: false })

  app.get('/ws-output', { websocket: true }, (socket) => {
    outputs.add(socket)
    const msg: ServerToOutput = { type: 'output.state', output: store.outputState() }
    socket.send(JSON.stringify(msg))
    // Read-only by construction: incoming messages are ignored (TDD §10)
    socket.on('message', () => {})
    socket.on('close', () => outputs.delete(socket))
  })

  return app
}

// ---------- boot ----------

const consoleApp = await buildConsoleApp()
let outputApp = await buildOutputApp()
let outputHost = store.state.settings.lanOutput ? '0.0.0.0' : '127.0.0.1'

await consoleApp.listen({ port: PORTS.console, host: '127.0.0.1' })
await outputApp.listen({ port: PORTS.output, host: outputHost })

/**
 * The LAN toggle rebinds ONLY :3001, live (TDD §10). Output pages reconnect
 * on their own; the console is never exposed either way.
 */
let rebinding = false
async function rebindOutput(): Promise<void> {
  if (rebinding) return
  rebinding = true
  try {
    const host = store.state.settings.lanOutput ? '0.0.0.0' : '127.0.0.1'
    if (host === outputHost) return
    await outputApp.close()
    outputApp = await buildOutputApp()
    await outputApp.listen({ port: PORTS.output, host })
    outputHost = host
    console.log(`Live output rebound: ${host === '0.0.0.0' ? 'visible on LAN' : 'localhost only'} (:${PORTS.output})`)
  } catch (err) {
    console.error('output rebind failed:', err)
  } finally {
    rebinding = false
  }
}

console.log(`VerseCast`)
console.log(`  Operator console  http://localhost:${PORTS.console}`)
console.log(`  Live output       http://localhost:${PORTS.output}${outputHost === '0.0.0.0' ? '  (visible on LAN)' : ''}`)

async function shutdown(): Promise<void> {
  asr.stop()
  await Promise.allSettled([consoleApp.close(), outputApp.close(), getEmbedder().terminate()])
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
