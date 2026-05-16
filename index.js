/**
 * Alpha-Clawd Voice Host - Main Entry Point
 * 
 * Exports all modules for the Discord voice AI host system.
 * 
 * Architecture:
 * Discord → Bot → STT → Gateway (Clawdbot) → Response → TTS → Discord
 * 
 * The bot is a thin voice I/O pipe. The AI brain is the external
 * Clawdbot Gateway session with full context.
 */

const { VoiceManager } = require('./voice-manager');
const { AudioReceiver } = require('./audio-receiver');
const { AudioTransmitter } = require('./audio-transmitter');
const { SilenceDetector } = require('./silence-detector');
const { SpeakerTracker } = require('./speaker-tracker');
const { FishAudioProvider } = require('./fish-audio-provider');
const { ElevenLabsIntegration } = require('./elevenlabs-integration');
const { GatewayBridge } = require('./gateway-bridge');
const { AlphaClawdVoiceBot } = require('./bot');
const { PodcastGenerator } = require('./podcast-generator');
const { InternalThoughtGenerator } = require('./internal-thought-generator');
const { DiscernmentGenerator } = require('./discernment-generator');
const { InternalThoughtManager } = require('./internal-thought-manager');
const { ShowRunnerGenerator } = require('./showrunner-generator');
const { ShowRunnerManager } = require('./showrunner-manager');
const { PacketizationBuffer } = require('./packetization-buffer');
const { BigBrainAwarenessSelector } = require('./bigbrain-awareness-selector');
const { EpisodeTranscriptStore, createEpisodeTranscriptServer } = require('./episode-transcript-viewer');

module.exports = {
    // Core voice components
    VoiceManager,
    AudioReceiver,
    AudioTransmitter,
    SilenceDetector,
    SpeakerTracker,
    
    // Integrations
    FishAudioProvider,
    ElevenLabsIntegration,
    GatewayBridge,
    PodcastGenerator,
    InternalThoughtGenerator,
    DiscernmentGenerator,
    InternalThoughtManager,
    ShowRunnerGenerator,
    ShowRunnerManager,
    PacketizationBuffer,
    BigBrainAwarenessSelector,
    EpisodeTranscriptStore,
    createEpisodeTranscriptServer,
    
    // Main bot class
    AlphaClawdVoiceBot
};
