/**
 * Generate short filler clips with the configured voice provider.
 */

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

const fillerClips = [
    { filename: 'filler-one-moment', text: 'One moment.' },
    { filename: 'filler-one-sec', text: 'One sec.' },
    { filename: 'filler-moment', text: 'Moment.' },
    { filename: 'filler-hold-tight', text: 'Hang on.' },
    { filename: 'filler-just-a-sec', text: 'Just a sec.' },
    { filename: 'filler-hmm', text: 'Hmm...' },
    { filename: 'filler-thinking', text: 'Thinking...' },
    { filename: 'filler-working', text: 'Working...' },
    { filename: 'filler-processing', text: 'Processing.' },
    { filename: 'filler-let-me-see', text: 'Let me see...' }
];

const outputDir = path.join(__dirname, 'cached-audio');

async function synthesize(text, filename) {
    console.log(`Generating: ${filename}.mp3 - "${text}"`);

    try {
        const audioBuffer = await voiceProvider.synthesize(text);
        const filePath = path.join(outputDir, `${filename}.mp3`);
        fs.writeFileSync(filePath, audioBuffer);

        console.log(`  Saved: ${filePath} (${audioBuffer.length} bytes)`);
        return true;
    } catch (error) {
        console.error(`  Failed: ${error.message}`);
        return false;
    }
}

async function main() {
    console.log(`Regenerating filler clips with ${voiceProvider.getMode()} mode...\n`);
    console.log(`Output: ${outputDir}\n`);

    fs.mkdirSync(outputDir, { recursive: true });

    let success = 0;
    let failed = 0;

    for (const clip of fillerClips) {
        const result = await synthesize(clip.text, clip.filename);
        if (result) success++;
        else failed++;
    }

    console.log(`\nDone. ${success} generated, ${failed} failed.`);
}

main();
