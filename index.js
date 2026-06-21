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
const { FishAudioProvider, downmixStereo48kToMono16k } = require('./fish-audio-provider');
const { ElevenLabsIntegration } = require('./elevenlabs-integration');
const { GatewayBridge } = require('./gateway-bridge');
const { AlphaClawdVoiceBot } = require('./bot');
const { PodcastGenerator } = require('./podcast-generator');
const { BigHeartGenerator } = require('./bigheart-generator');
const { InternalThoughtGenerator } = require('./internal-thought-generator');
const { DiscernmentGenerator } = require('./discernment-generator');
const { InternalThoughtManager } = require('./internal-thought-manager');
const { ShowRunnerGenerator } = require('./showrunner-generator');
const { ShowRunnerManager } = require('./showrunner-manager');
const { EpisodePlanStore } = require('./episode-plan-store');
const { EpisodePlanTracker } = require('./episode-plan-tracker');
const { PacketizationBuffer } = require('./packetization-buffer');
const { BigBrainAwarenessSelector } = require('./bigbrain-awareness-selector');
const { DiscordContextInterpreter } = require('./discord-context-interpreter');
const { ParticipantSignalProfile } = require('./participant-signal-profile');
const { AwarenessShelf } = require('./awareness-shelf');
const { RealtimePcmMixer } = require('./realtime-pcm-mixer');
const { GeminiLiveHost, upsampleMono24kToStereo48k } = require('./gemini-live-host');
const { EpisodeTranscriptStore, createEpisodeTranscriptServer } = require('./episode-transcript-viewer');
const { buildTurnIdIntent, normalizeTurnIdIntent } = require('./turn-intent');

module.exports = {
    // Core voice components
    VoiceManager,
    AudioReceiver,
    AudioTransmitter,
    SilenceDetector,
    SpeakerTracker,
    
    // Integrations
    FishAudioProvider,
    downmixStereo48kToMono16k,
    ElevenLabsIntegration,
    GatewayBridge,
    PodcastGenerator,
    BigHeartGenerator,
    InternalThoughtGenerator,
    DiscernmentGenerator,
    InternalThoughtManager,
    ShowRunnerGenerator,
    ShowRunnerManager,
    EpisodePlanStore,
    EpisodePlanTracker,
    PacketizationBuffer,
    BigBrainAwarenessSelector,
    DiscordContextInterpreter,
    ParticipantSignalProfile,
    AwarenessShelf,
    RealtimePcmMixer,
    GeminiLiveHost,
    upsampleMono24kToStereo48k,
    EpisodeTranscriptStore,
    createEpisodeTranscriptServer,
    buildTurnIdIntent,
    normalizeTurnIdIntent,
    
    // Main bot class
    AlphaClawdVoiceBot
};
