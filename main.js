const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("path");

app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("ignore-gpu-blacklist");
app.commandLine.appendSwitch("disable-frame-rate-limit");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

let controlWindow=null, visualizerWindow=null;

function createWindows(){
  const displays = screen.getAllDisplays();
  const externalDisplay = displays.find(d => d.bounds.x !== 0) || displays[0];

  visualizerWindow = new BrowserWindow({
    x: externalDisplay.bounds.x, y: externalDisplay.bounds.y,
    width: externalDisplay.bounds.width, height: externalDisplay.bounds.height,
    frame:false, fullscreen:true, backgroundColor:"#000000", show:true,
    webPreferences:{ nodeIntegration:true, contextIsolation:false, backgroundThrottling:false }
  });
  visualizerWindow.loadFile(path.join(__dirname,"src/visualizer.html"));

  controlWindow = new BrowserWindow({
    width:520, height:880, backgroundColor:"#0b0b0b", show:true,
    webPreferences:{ nodeIntegration:true, contextIsolation:false }
  });
  controlWindow.loadFile(path.join(__dirname,"src/controls.html"));

  const relay = ch => (_evt,payload)=>{
    if(visualizerWindow && !visualizerWindow.isDestroyed()){
      visualizerWindow.webContents.send(ch,payload);
    }
  };
  ipcMain.on("update-param", relay("update-param"));
  ipcMain.on("audio-cmd", relay("audio-cmd"));
  ipcMain.on("rec-cmd", relay("rec-cmd"));

  ipcMain.on("viz-status", (_evt,payload)=>{
    if(controlWindow && !controlWindow.isDestroyed()){
      controlWindow.webContents.send("viz-status", payload);
    }
  });
}
app.whenReady().then(createWindows);

app.on("window-all-closed", ()=>{ if(process.platform!=="darwin") app.quit(); });
app.on("activate", ()=>{ if(BrowserWindow.getAllWindows().length===0) createWindows(); });
