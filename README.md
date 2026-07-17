# Triathlon Training Tools

Low-distraction coaching tools for specific triathlon execution habits.

## Cycling HUD

The cycling HUD supports Aero interval progression, hydration and fueling reminders, mobility prompts, ride review, smart-trainer stop tracking, and optional on-device camera posture detection.

## Open the app

**[Launch Triathlon Training HUD](https://dmaher42.github.io/triathlon-training-hud/)**

The hosted version runs entirely in the browser. Camera analysis stays on the device, no video is uploaded or saved, and ride history is stored only in that browser. History does not automatically sync between devices and can be removed if browser data is cleared.

## Run Durability Coach prototype

The first running prototype learns a personal cadence baseline from a phone carried in a consistent hip pocket, detects sustained rhythm drift and run/walk/stop transitions, and provides low-frequency spoken coaching. It is intentionally not a pace or distance tracker.

**[Launch Run Durability Coach](https://dmaher42.github.io/triathlon-training-hud/running/)**

Local path: `http://127.0.0.1:5173/running/`

The start-up preflight confirms that phone motion samples are arriving and that the screen wake lock is active before coaching begins. Locked-screen Android service and compiled Garmin Forerunner 265 integration are later platform milestones; the versioned live Garmin telemetry seam is already represented by `src/running/signal-fusion.js`.

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
