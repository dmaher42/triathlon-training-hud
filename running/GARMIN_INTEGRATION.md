# Garmin Forerunner 265 integration contract

The normal Garmin **Run** activity remains the activity recorder and source of truth. The planned Connect IQ component is a data field, not a replacement activity app.

## Responsibilities

The watch data field will:

- read live cadence, heart rate, speed and timer state from `Activity.Info`;
- calculate the watch-side cadence baseline and continuity state so vibration coaching survives a phone disconnect;
- show `STEADY`, `FADING`, `WALKING`, `RESET` and short full-screen alerts;
- send state changes and low-rate telemetry to the Pixel companion app;
- record stable-rhythm percentage, unplanned walk count and longest steady block as FIT developer fields.

The phone will:

- retain hip-pocket motion context;
- prefer fresh Garmin cadence over phone-estimated cadence;
- speak coaching messages and status summaries;
- continue with phone-only cadence if Garmin telemetry becomes stale.

## Version 1 watch-to-phone message

The canonical parser is `src/running/signal-fusion.js`.

```json
{
  "type": "run-telemetry",
  "version": 1,
  "timestampMs": 1000,
  "cadenceSpm": 172,
  "heartRateBpm": 145,
  "speedMps": 3.1,
  "timerState": "running"
}
```

During browser development, the same contract can be exercised from the console with:

```js
window.runCoachGarminSample({
  type: "run-telemetry",
  version: 1,
  timestampMs: performance.now(),
  cadenceSpm: 172,
  heartRateBpm: 145,
  speedMps: 3.1,
  timerState: "running"
});
```

## Toolchain checkpoint

This machine did not have Java, Android SDK/ADB, or Garmin Connect IQ tools at the first implementation checkpoint. Do not claim a compiled watch field or locked-screen Android app until those official toolchains are installed and the result is tested on the Pixel 8 and Forerunner 265.
