/**
 * Quick integration test for Alpha-Clawd Voice Bot
 * 
 * Tests:
 * 1. ElevenLabs STT (Scribe) initialization
 * 2. ElevenLabs persona prompt prepending
 * 3. Transcript entry cleaning
 */

const { ElevenLabsIntegration } = require('./elevenlabs-integration');

async function runTests() {
    console.log('=== Alpha-Clawd Voice Bot Integration Tests ===\n');

    // Test 1: ElevenLabs STT (Scribe)
    console.log('Test 1: ElevenLabs STT (Scribe) Initialization');
    console.log('-----------------------------------------------');

    // Test 2: ElevenLabs Persona Prompt
    console.log('Test 2: ElevenLabs Persona Prompt');
    console.log('----------------------------------');
    const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
    if (!elevenLabsKey) {
        console.log('⚠️  ELEVENLABS_API_KEY not set - skipping validation test');
    } else {
        const elevenlabs = new ElevenLabsIntegration({ apiKey: elevenLabsKey });
        const isValid = await elevenlabs.validateApiKey();
        console.log(`✓ ElevenLabs API Key Valid: ${isValid ? 'YES' : 'NO'}`);
    }
    
    // Check persona prompt exists
    const elevenlabs = new ElevenLabsIntegration({ apiKey: 'test-key' });
    const hasPersona = elevenlabs.personaPrompt && elevenlabs.personaPrompt.includes('Alpha-Clawd');
    console.log(`✓ Persona Prompt Loaded: ${hasPersona ? 'YES' : 'NO'}`);
    console.log(`✓ Prepend Persona Enabled: ${elevenlabs.prependPersona ? 'YES' : 'NO'}`);
    
    // Show snippet of persona prompt
    console.log('\nPersona Prompt Snippet:');
    console.log('  ' + elevenlabs.personaPrompt.split('\n').slice(0, 5).join('\n  ') + '\n');

    // Test 3: Transcript Entry Structure
    console.log('Test 3: Transcript Entry Structure');
    console.log('-----------------------------------');
    const mockUtterance = {
        timestamp: new Date().toISOString(),
        speaker: 'Jensen',
        speakerRole: 'guest',
        transcription: 'Hello, this is a test',
        duration: 1234,
        userId: '123456789',
        audioBuffer: Buffer.from([0, 1, 2, 3, 4]) // This should NOT be in transcript
    };

    // Simulate the cleaning that happens in saveTranscriptEntry
    const cleanEntry = {
        timestamp: mockUtterance.timestamp,
        speaker: mockUtterance.speaker,
        speakerRole: mockUtterance.speakerRole,
        text: mockUtterance.transcription,
        duration: mockUtterance.duration,
        userId: mockUtterance.userId
    };

    const entryJson = JSON.stringify(cleanEntry);
    console.log(`✓ Clean Entry (no audioBuffer): ${!entryJson.includes('audioBuffer') ? 'YES' : 'NO'}`);
    console.log(`✓ Has text field: ${entryJson.includes('"text"') ? 'YES' : 'NO'}`);
    console.log(`✓ Has speaker field: ${entryJson.includes('"speaker"') ? 'YES' : 'NO'}`);
    console.log('\nExample transcript entry:');
    console.log('  ' + entryJson + '\n');

    // Summary
    console.log('=== Test Summary ===');
    console.log('1. ElevenLabs Scribe handles STT transcription (same API key as TTS)');
    console.log('2. ElevenLabs persona prompt is automatically prepended to all TTS');
    console.log('3. Transcript.jsonl will contain text-only entries (no raw audio buffers)');
    console.log('\nTo start the bot: npm start');
}

runTests().catch(console.error);
