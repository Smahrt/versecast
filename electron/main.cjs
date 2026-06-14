/**
 * Electron shell (TDD §3): the server is Node, and Electron IS Node —
 * the Fastify server runs in this main process, no sidecar.
 */
const { app, BrowserWindow, session, dialog, shell } = require('electron')
const path = require('node:path')
const os = require('node:os')

const CONSOLE_PORT = Number(process.env.VERSECAST_CONSOLE_PORT ?? 3000)
const CONSOLE_URL = `http://127.0.0.1:${CONSOLE_PORT}`

// In a packaged build, bundled data lives under resources/root (see electron-builder.yml)
if (app.isPackaged) {
  process.env.VERSECAST_ROOT = path.join(process.resourcesPath, 'root')
} else {
  process.env.VERSECAST_ROOT = path.resolve(__dirname, '..')
}

function hardwareWarning() {
  // PRD §3: warn below 4 cores / 8 GB
  const cores = os.cpus().length
  const gb = os.totalmem() / 1024 ** 3
  if (cores < 4 || gb < 7.5) {
    dialog.showMessageBoxSync({
      type: 'warning',
      title: 'VerseCast — hardware check',
      message: `This machine (${cores} cores, ${Math.round(gb)} GB RAM) is below the recommended minimum (4 cores, 8 GB).\n\nVerseCast will still run, but speech recognition may lag. The smallest speech model will be used.`,
    })
  }
}

async function createWindow() {
  // The console needs the microphone; grant media requests from our own origin only
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media' && wc.getURL().startsWith(CONSOLE_URL))
  })

  const win = new BrowserWindow({
    width: 1512,
    height: 945,
    minWidth: 1360,
    minHeight: 800,
    backgroundColor: '#0D0D0C',
    title: 'VerseCast',
    webPreferences: { contextIsolation: true },
  })

  // External links (none expected — offline app) open nowhere by policy
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  await win.loadURL(CONSOLE_URL)
}

app.whenReady().then(async () => {
  hardwareWarning()
  try {
    // Boot the server in-process; it binds 127.0.0.1 on the console/output ports
    await import(path.join(__dirname, 'dist/server.mjs'))
  } catch (err) {
    const busy = String(err).includes('EADDRINUSE')
    dialog.showErrorBox(
      'VerseCast could not start',
      busy
        ? `Port ${CONSOLE_PORT} is already in use — VerseCast may already be running. Close the other instance and try again.`
        : `The local server failed to start:\n\n${err}`,
    )
    app.quit()
    return
  }
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit() // single-window booth app — closing the console closes everything
})
