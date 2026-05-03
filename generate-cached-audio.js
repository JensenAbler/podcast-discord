const fs = require('fs');
const path = require('path');
const { VoiceProvider } = require('./voice-provider');

const voiceProvider = new VoiceProvider({
    mode: process.env.VOICE_MODE || 'fish',
    fishApiKey: process.env.FISH_AUDIO_API_KEY || process.env.FISH_API_KEY,
    fishVoiceId: process.env.FISH_AUDIO_VOICE_ID || process.env.FISH_AUDIO_MODEL_ID,
    apiKey: process.env.ELEVENLABS_API_KEY,
    defaultVoice: process.env.ELEVENLABS_VOICE_ID
});

const audioFiles = {
    'consent-disclosure': "I'll be recording this conversation for the podcast. Do all participants consent to being recorded? Please type YES to proceed or NO to cancel.",
    'recording-started': "Recording started. The podcast is now live!",
    'recording-cancelled': "Recording cancelled. No audio was saved.",
    'consent-timeout': "Consent timed out. Please try again when everyone is ready to proceed."
};

const cacheDir = path.join(__dirname, 'cached-audio');

async function synthesize(text, filename) {
    console.log(`Generating: ${filename}...`);

    try {
        const audioBuffer = await voiceProvider.synthesize(text);
        const filePath = path.join(cacheDir, `${filename}.mp3`);
        fs.writeFileSync(filePath, audioBuffer);

        console.log(`Saved: ${filePath} (${audioBuffer.length} bytes)`);
        return true;
    } catch (error) {
        console.error(`Failed to generate ${filename}:`, error.message);
        return false;
    }
}

async function main() {
    fs.mkdirSync(cacheDir, { recursive: true });
    console.log(`Regenerating cached audio with ${voiceProvider.getMode()} mode...\n`);

    let success = 0;
    let failed = 0;

    for (const [filename, text] of Object.entries(audioFiles)) {
        const result = await synthesize(text, filename);
        if (result) success++;
        else failed++;
    }

    console.log(`\nDone. ${success} files generated, ${failed} failed.`);
}

main();
