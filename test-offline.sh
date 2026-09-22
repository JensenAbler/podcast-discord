#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export NODE_OPTIONS="--require=$PWD/test-offline-guard.cjs"
node --test test-hangup-resume.js test-podcast-resume.js test-shutdown.js test-recording-startup.js test-journal-recovery.js test-quartz-output-level.js test-live-turn-controller.js test-prepared-clip.js test-speech-delivery.js
npm test
