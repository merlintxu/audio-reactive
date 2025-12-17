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

## Licencia
Este proyecto se publica bajo la licencia Apache-2.0.
