'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JevSpeechJudge, AudioCushion, splitCandidates, opportunisticSpeech } = require('./jev-speech-batcher');
const { FishAudioProvider } = require('./fish-audio-provider');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const collect = async source => { const out = []; for await (const x of source) out.push(x); return out; };
const passage = 'We were talking about Martin Luther King and the way his words stayed with us, even when the room went quiet. ' +
    'I wanted to understand the entire story before we moved on, because it mattered to everyone who had been there. ' +
    'That gave us enough time to reflect on what had happened and decide what to do next.';
const judge = split => ({ available: true, split });
function channel() {
    const queue = []; let wake, done = false;
    return {
        push: value => { queue.push(value); wake?.(); },
        end: () => { done = true; wake?.(); },
        async *[Symbol.asyncIterator]() {
            while (true) {
                while (queue.length) yield queue.shift();
                if (done) return;
                await new Promise(r => { wake = r; });
            }
        }
    };
}

test('first chunk is immediate and unchanged even with plentiful audio and text', async () => {
    let calls = 0;
    const stream = opportunisticSpeech([passage], { audioAheadMs: () => 10000,
        judge: judge(async () => { calls++; return []; }) });
    assert.deepEqual(await collect(stream), [{ text: passage, flush: false }]);
    assert.equal(calls, 0);
});

test('no audio surplus preserves every original chunk and makes no requests', async () => {
    let calls = 0;
    const input = ['Yes!',' Dr. Smith ',passage,'🙂'];
    const result = await collect(opportunisticSpeech(input, { audioAheadMs: () => 0,
        judge: judge(async () => { calls++; return []; }) }));
    assert.deepEqual(result, input.map(text => ({ text, flush: false })));
    assert.equal(calls, 0);
});

test('ready backlog is split only with audio cushion; all characters survive', async () => {
    let seen;
    const pieces = [passage.slice(0,90),passage.slice(90,180),passage.slice(180)];
    const out = await collect(opportunisticSpeech(['Start. ',...pieces], {
        audioAheadMs: () => 3000, judge: judge(async text => { seen = text; return splitCandidates(text); })
    }));
    assert.equal(seen, passage);
    assert.equal(out.map(x => x.text).join(''), 'Start. ' + passage);
    assert.ok(out.some(x => x.flush));
});

test('plentiful audio does not wait for future words to build a text surplus', async () => {
    const input = channel(); let calls = 0;
    const stream = opportunisticSpeech(input, { audioAheadMs: () => 3000,
        judge: judge(async () => { calls++; return []; }) });
    input.push('First '); assert.equal((await stream.next()).value.text, 'First ');
    input.push('tiny ');
    const out = await Promise.race([stream.next(), delay(100).then(() => { throw Error('waited for future text'); })]);
    assert.equal(out.value.text, 'tiny ');
    assert.equal(calls, 0);
    input.push('later'); input.end();
    assert.equal((await collect(stream)).map(x => x.text).join(''), 'later');
});

test('a rejected request restores original boundaries and disables repeats this response', async () => {
    let calls = 0;
    const input = channel(); const out = collect(opportunisticSpeech(input, {
        audioAheadMs: () => 3000, judge: judge(async () => { calls++; throw Error('offline'); })
    }));
    input.push('Start'); await delay(5); input.push(passage); await delay(20);
    input.push(passage); input.end();
    const result = await out;
    assert.deepEqual(result.map(x => x.text), ['Start',passage,passage]);
    assert.ok(result.every(x => !x.flush)); assert.equal(calls, 1);
});

test('hung judgment is abandoned within budget and its signal is aborted', async () => {
    let signal;
    const start = Date.now();
    const out = await collect(opportunisticSpeech(['Start',passage], {
        audioAheadMs: () => 3000, judge: judge((_,__,s) => { signal = s; return new Promise(() => {}); })
    }));
    assert.ok(Date.now() - start < 800);
    assert.equal(signal.aborted, true);
    assert.deepEqual(out.map(x => x.text), ['Start',passage]);
});

test('stale result after cushion loss cannot introduce new flushes', async () => {
    let slack = 3000;
    const out = await collect(opportunisticSpeech(['Start',passage], {
        audioAheadMs: () => slack, judge: judge(async text => { slack = 0; return splitCandidates(text); })
    }));
    assert.deepEqual(out, ['Start',passage].map(text => ({ text, flush:false })));
});

test('invalid offsets fall back without changing text', async () => {
    const out = await collect(opportunisticSpeech(['Start',passage], {
        audioAheadMs: () => 3000, judge: judge(async () => [3,999999])
    }));
    assert.deepEqual(out.map(x => x.text), ['Start',passage]);
    assert.ok(out.every(x => !x.flush));
});

test('abort stops a pending judgment promptly and discards its result', async () => {
    const controller = new AbortController(); let s;
    const stream = opportunisticSpeech(['Start',passage], { signal:controller.signal,
        audioAheadMs: () => 3000, judge: judge((_,__,signal) => { s=signal; return new Promise(() => {}); }) });
    await stream.next(); const pending = stream.next(); await delay(10); controller.abort();
    assert.equal((await pending).done, true); assert.equal(s.aborted,true);
});

test('upstream failure remains a failure', async () => {
    const source = (async function* () { yield 'Start'; throw Error('source failed'); })();
    await assert.rejects(collect(opportunisticSpeech(source, {
        audioAheadMs: () => 0, judge: judge(async () => [])
    })), /source failed/);
});

test('candidate sampling avoids tags and preserves unicode', () => {
    const text = 'Words '.repeat(10) + '[a very very long inline control with spaces] café 🙂 ' + 'words '.repeat(40);
    const start = text.indexOf('['), end = text.indexOf(']');
    assert.ok(splitCandidates(text).every(n => !(n > start && n <= end)));
    assert.ok(splitCandidates('x'.repeat(2000)).length === 0);
});

function mp3Frame(index = 9) {
    const bitrate = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320][index];
    const frame = Buffer.alloc(Math.floor(144000 * bitrate / 48000));
    frame.set([255,251,(index<<4)|4,0]); return frame;
}
test('audio cushion counts fragmented VBR frames and subtracts elapsed wall time', () => {
    let now = 0; const tracker = new AudioCushion('mp3', () => now);
    const id3 = Buffer.from([73,68,51,4,0,0,0,0,0,0]);
    const frames = Buffer.concat([id3,...Array.from({length:100},(_,i)=>mp3Frame(i%2?9:11))]);
    for (let i=0;i<frames.length;i+=79) tracker.push(frames.subarray(i,i+79));
    assert.ok(Math.abs(tracker.aheadMs()-2400)<1);
    now = 1700; assert.ok(Math.abs(tracker.aheadMs()-700)<1);
    now = 3000; assert.equal(tracker.aheadMs(),0);
    tracker.push(Buffer.from('invalid audio bytes')); assert.equal(tracker.aheadMs(),0);
    const unknown = new AudioCushion('wav'); unknown.push(frames); assert.equal(unknown.aheadMs(),0);
});

test('TypeSafe groups boundary questions, validates responses, and cools down after errors', async () => {
    let body;
    const client = new JevSpeechJudge({ apiKey:'test-only', fetch:async (url,options) => {
        assert.equal(url,'https://api.typesafe.ai/v1/systemone');
        body=JSON.parse(options.body);
        return {ok:true,json:async()=>({answers:Object.fromEntries(Object.keys(body.questions).map(k=>[k,{type:'noul',noul:0.9}]))})};
    }});
    assert.deepEqual(await client.split(passage),splitCandidates(passage));
    assert.ok(Object.keys(body.questions).length>1);
    assert.equal(body.state.text,passage);
    client.fetch=async()=>({ok:true,json:async()=>({answers:{}})});
    await assert.rejects(client.split(passage),/Invalid Jev answer/);
    assert.equal(client.available,false);
});

test('Fish fast path retains original text/flush sequence and configured chunk length', async () => {
    const p = new FishAudioProvider({ apiKey:'test-only', chunkLength:100,
        jevJudge:{apiKey:'test-only', available:true, split:async()=>{ throw Error('must not call'); }} });
    const events=[]; p.sendWebSocketEvent=(_,event)=>events.push(event);
    await p.sendStreamingText({}, {}, ['One. ','Two.'], {
        surplus:{audioAheadMs:()=>0,judge:p.jevJudge}
    });
    assert.deepEqual(events.map(e=>e.event),['start','text','text','flush','stop']);
    const { EventEmitter } = require('events');
    const ws=new EventEmitter(); ws.close=()=>{};
    p.createWebSocketAudioConnection=()=>({ws});
    p.streamWebSocketAudio=async function* (r,stream) {
        assert.equal(r.chunk_length,100); for await (const _ of stream) {} yield Buffer.from('audio');
    };
    await collect(p.createStreamingAudio(['Hello. ']));
});

test('Fish inserts flushes only at Jev-approved surplus cuts', async () => {
    const p = new FishAudioProvider({apiKey:'test-only',semanticBatching:false});
    const events=[]; p.sendWebSocketEvent=(_,event)=>events.push(event);
    await p.sendStreamingText({}, {}, ['Start',passage], {
        surplus:{audioAheadMs:()=>3000,judge:judge(async text=>splitCandidates(text))}
    });
    assert.equal(events.filter(e=>e.event==='text').map(e=>e.text).join(''),'Start'+passage);
    assert.ok(events.filter(e=>e.event==='flush').length>1);
    assert.equal(events.at(-1).event,'stop');
});

function oggPage(payload, granule, bos = false, serial = 1) {
    const b=Buffer.alloc(28+payload.length);
    b.write('OggS'); b[5]=bos?2:0; b.writeBigUInt64LE(BigInt(granule),6);
    b.writeUInt32LE(serial,14); b[26]=1; b[27]=payload.length; payload.copy(b,28);
    return b;
}
test('Opus granules account for preskip, fragmented pages, and chained streams', () => {
    let now=0; const tracker=new AudioCushion('opus',()=>now);
    const head=Buffer.alloc(19);head.write('OpusHead');head.writeUInt16LE(312,10);
    const bytes=Buffer.concat([oggPage(head,0,true),oggPage(Buffer.from([1,2]),144312)]);
    for(let i=0;i<bytes.length;i+=7)tracker.push(bytes.subarray(i,i+7));
    assert.equal(tracker.aheadMs(),3000);
    now=500;assert.equal(tracker.aheadMs(),2500);
    tracker.push(oggPage(head,0,true,2));tracker.push(oggPage(Buffer.from([1]),48312,false,2));
    assert.equal(tracker.aheadMs(),3500);
    tracker.push(oggPage(Buffer.from([1]),999999,false,3));assert.equal(tracker.aheadMs(),0);
});
test('no approved cuts preserve original backlog boundaries', async () => {
    const input=['Start',passage.slice(0,150),passage.slice(150)];
    const telemetry=[];
    const out=await collect(opportunisticSpeech(input,{audioAheadMs:()=>3000,judge:judge(async()=>[]),
        onEvent:event=>telemetry.push(event)}));
    assert.deepEqual(out,input.map(text=>({text,flush:false})));
    assert.ok(telemetry.some(e=>e.reason==='surplus-gate' && e.stage==='audio' && e.audioReady));
    assert.ok(telemetry.some(e=>e.reason==='surplus-gate' && e.stage==='text' &&
        e.immediateChars>=240 && e.immediateChunks>=1 && e.textReady));
});

test('Jev telemetry records a blocked audio gate without invoking the judge', async () => {
    let calls=0; const telemetry=[];
    const input=['Start',passage];
    const out=await collect(opportunisticSpeech(input,{audioAheadMs:()=>900,
        judge:judge(async()=>{calls++; return [];}),onEvent:event=>telemetry.push(event)}));
    assert.deepEqual(out,input.map(text=>({text,flush:false})));
    assert.equal(calls,0);
    assert.ok(telemetry.some(e=>e.reason==='surplus-gate' && e.stage==='audio' &&
        e.audioAheadMs===900 && e.audioReady===false));
    assert.equal(telemetry.some(e=>e.stage==='text'),false);
});
test('Fish close before first text cancels promptly', async () => {
    const p=new FishAudioProvider({apiKey:'test-only',semanticBatching:false});
    const {EventEmitter}=require('events');
    const ws=new EventEmitter();ws.close=()=>{};
    p.createWebSocketAudioConnection=()=>({ws});
    const stream=p.createStreamingAudio(channel());const pending=stream.next();
    setTimeout(()=>ws.emit('close'),5);
    await assert.rejects(pending,/cancelled/);
});
