// Renders build/icon.html to build/icon-1024.png (run: npx electron build/render-icon.js)
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('fs')
const { join } = require('path')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true }
  })
  await win.loadFile(join(__dirname, 'icon.html'))
  await new Promise((r) => setTimeout(r, 800))
  let img = await win.webContents.capturePage()
  const size = img.getSize()
  if (size.width !== 1024) {
    img = img.resize({ width: 1024, height: 1024 })
  }
  writeFileSync(join(__dirname, 'icon-1024.png'), img.toPNG())
  console.log('icon rendered', size)
  app.exit(0)
})
