/**
 * Test script for whisper.cpp STT provider
 */

const { WhisperCppSTTProvider } = require('./whisper-cpp-stt-provider');
const fs = require('fs');
const path = require('path');

async function testWhisperCpp() {
    console.log('=== Testing whisper.cpp STT Provider ===\n');
    
    const provider = new WhisperCppSTTProvider({
        whisperPath: '/opt/whisper.cpp/build/bin/whisper-cli',
        modelPath: '/opt/whisper.cpp/models/ggml-base.en.bin',
        threads: 2,
        language: 'en'
    });

    // Check availability
    console.log('1. Checking availability...');
    const availability = await provider.checkAvailability();
    console.log(`   Available: ${availability.available}`);
    if (!availability.available) {
        console.log(`   Error: ${availability.error}`);
        return;
    }

    // Show info
    console.log('\n2. Provider info:');
    console.log('   ', JSON.stringify(provider.getInfo(), null, 2));

    // Download test audio if needed
    const testAudioPath = '/opt/whisper.cpp/samples/test.wav';
    if (!fs.existsSync(testAudioPath)) {
        console.log('\n3. Downloading test audio...');
        const { execSync } = require('child_process');
        execSync('wget -q -O ' + testAudioPath + ' https://cdn.openai.com/whisper/draft-20220913a/micro-machines.wav');
    }

    // Test transcription
    console.log('\n3. Testing transcription...');
    const audioBuffer = fs.readFileSync(testAudioPath);
    console.log(`   Audio size: ${audioBuffer.length} bytes`);
    
    const startTime = Date.now();
    const result = await provider.transcribe(audioBuffer);
    const elapsed = Date.now() - startTime;
    
    console.log(`\n   Transcription completed in ${elapsed}ms:`);
    console.log(`   Text: "${result.text}"`);
    console.log(`   Confidence: ${result.confidence}`);
    console.log(`   Language: ${result.language}`);
    console.log(`   Words: ${result.words.length}`);

    console.log('\n=== Test completed successfully! ===');
}

testWhisperCpp().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
});
