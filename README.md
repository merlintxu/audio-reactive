# Audio Reactive App (Electron) — WebGL Trails + Worker + Recorder

## Ejecutar
```bash
npm install
npm start
```

## Qué verás
- 2 ventanas: **Controls** (sliders + MP3 + grabación) y **Visualizer** (fullscreen)
- **WebGL2** con **feedback trails** (ping-pong FBO) + **blending aditivo** (glow)
- **Worker**: física + colisiones + polígonos 4–6 lados desprendidos + geometría en buffers transferibles
- **Audio**: Mic o MP3 (se oye) y al grabar el vídeo se graba con el audio (mezcla del bus master)
- **Auto-quality**: DPR dinámico + edge budget + subsampling (stringStep) ajustado por FPS

## Notas
- Si WebGL2 no está disponible, verás `GL: WebGL2 unavailable` en la ventana de Controls.
- El recorder genera WebM (vp8/vp9 + opus) según soporte.

## Troubleshooting
- WebGL2 unavailable: Asegúrate de que tu GPU y drivers soportan WebGL2. En entornos virtualizados/desconocidos puede no estar disponible.
- Mic permissions: Si la app no puede acceder al micrófono, concede permisos al proceso de Electron o usa un MP3 desde Controls.
- MediaElementSource errors: En algunos entornos `createMediaElementSource` puede fallar; el audio aún puede reproducirse en el elemento `<audio>`, pero no siempre será enrutado al AudioContext.
- FBO / GL errors: Si la inicialización GL falla (shader compile, program link, FBO incomplete) la app intentará degradar la visualización y reportará errores en Controls.

## Licencia
Este proyecto se publica bajo la licencia Apache-2.0.
