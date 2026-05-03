/**
 * Test whisper.cpp with simulated Discord PCM audio
 * Discord sends: 48kHz, 16-bit, stereo PCM (no WAV header)
 */

const { WhisperCppSTTProvider } = require('./whisper-cpp-stt-provider');
const fs = require('fs');

async function testWithSimulatedDiscordAudio() {
    console.log('=== Testing whisper.cpp with Simulated Discord PCM Audio ===\n');
    
    const provider = new WhisperCppSTTProvider({
        whisperPath: '/opt/whisper.cpp/build/bin/whisper-cli',
        modelPath: '/opt/whisper.cpp/models/ggml-base.en.bin',
        threads: 2,
        language: 'en'
    });

    // Load a test WAV file
    const testWavPath = '/opt/whisper.cpp/samples/test.wav';
    if (!fs.existsSync(testWavPath)) {
        console.log('Downloading test audio...');
        const { execSync } = require('child_process');
        execSync('wget -q -O ' + testWavPath + ' https://cdn.openai.com/whisper/draft-20220913a/micro-machines.wav');
    }

    // Read the WAV file and strip the header to simulate Discord PCM audio
    const wavBuffer = fs.readFileSync(testWavPath);
    
    // WAV header is typically 44 bytes
    const pcmData = wavBuffer.slice(44);
    
    console.log(`Original WAV size: ${wavBuffer.length} bytes`);
    console.log(`PCM data size (simulating Discord): ${pcmData.length} bytes`);
    console.log('\nThis simulates Discord audio: raw PCM 48kHz, 16-bit, stereo\n');

    // Test transcription - the provider should now add WAV header
    console.log('Testing transcription with PCM data...');
    const startTime = Date.now();
    const result = await provider.transcribe(pcmData);
    const elapsed = Date.now() - startTime;
    
    console.log(`\n   Transcription completed in ${elapsed}ms:`);
    console.log(`   Text: "${result.text}"`);
    console.log(`   Confidence: ${result.confidence}`);
    console.log(`   Language: ${result.language}`);
    console.log(`   Words: ${result.words.length}`);

    if (result.text && result.text.length > 0) {
        console.log('\n=== SUCCESS! whisper.cpp now works with raw PCM audio ===');
    } else {
        console.log('\n=== FAILED! Still getting blank output ===');
    }
}

testWithSimulatedDiscordAudio().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
});
