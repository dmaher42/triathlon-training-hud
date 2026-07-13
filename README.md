# Triathlon Training HUD

A low-distraction browser HUD for long indoor triathlon rides. It supports Aero interval progression, hydration and fueling reminders, mobility prompts, ride review, and optional on-device camera posture detection.

## Open the app

**[Launch Triathlon Training HUD](https://dmaher42.github.io/triathlon-training-hud/)**

The hosted version runs entirely in the browser. Camera analysis stays on the device, no video is uploaded or saved, and ride history is stored only in that browser. History does not automatically sync between devices and can be removed if browser data is cleared.

## Local use

On Windows, double-click `Start Triathlon HUD.bat`.

For development:

```powershell
npm install
npm run dev
```

Run the checks with:

```powershell
npm test
npm run build
```

## Deployment

Pushes to `main` are built and published automatically through GitHub Pages.
