const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { VoiceManager } = require('./voice-manager');
const { AlphaClawdVoiceBot } = require('./bot');
const { AudioJournal } = require('./audio-journal');
const { recoverEpisodeCompletions, writeJsonAtomic } = require('./recording-completion');
const { loadResumeSource, handleResumeCommand } = require('./podcast-resume');
const { EpisodePlanTracker } = require('./episode-plan-tracker');
const { savePlanProgress } = require('./episode-plan-progress');

function root(t) {
    const p = fs.mkdtempSync(path.join(os.tmpdir(), 'hangup-resume-'));
    t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p;
}
function voice(members) {
    const vm = Object.create(VoiceManager.prototype), calls = [];
    Object.assign(vm, {
        client: { user: { id: 'bot' }, channels: { cache: new Map([['c', { members: new Map(members.map(m => [m.id, m])) }]]) } },
        connectionChannels: new Map([['g','c']]),
        receivers: new Map([['g', { flushUser: async () => calls.push('flush'), cleanupUser: () => calls.push('cleanup') }]]),
        onChannelEmpty: async () => calls.push('empty')
    });
    return { vm, calls };
}
const oldState = { id: 'u', guild: { id: 'g' }, channelId: 'c' };
const newState = { ...oldState, channelId: null };
test('last human hangup finalizes, while another human or a mute event does not', async () => {
    const f = voice([{id:'bot',user:{bot:true}}, {id:'otherbot',user:{bot:true}}]);
    await f.vm.handleVoiceStateUpdate(oldState,newState);
    assert.deepEqual(f.calls,['cleanup','empty']);
    const g = voice([{id:'v',user:{bot:false}}]);
    await g.vm.handleVoiceStateUpdate(oldState,newState);
    assert.deepEqual(g.calls,['flush','cleanup']);
    g.calls.length=0;
    await g.vm.handleVoiceStateUpdate(oldState,{...oldState,selfMute:true});
    assert.deepEqual(g.calls,[]);
});
test('concurrent hangup, command and shutdown share one finalization', async () => {
    const bot = Object.create(AlphaClawdVoiceBot.prototype); let finish, count=0;
    bot.finalizePodcastSession = async () => { count++; await new Promise(r=>finish=r); return 'saved'; };
    const a=bot.leavePodcastSession('g'), b=bot.leavePodcastSession('g');
    assert.equal(a,b); await Promise.resolve(); assert.equal(count,1);
    finish(); assert.equal(await a,'saved');
});
test('hangup stops generation and saves plan before slow recording finalization', async () => {
    const bot=Object.create(AlphaClawdVoiceBot.prototype), events=[]; let finish;
    Object.assign(bot,{
        recordingState:new Map([['g','RECORDING']]),RecordingState:{RECORDING:'RECORDING',STOPPING:'STOPPING'},
        recordingTextChannels:new Map(),consentWaiters:new Map(),sessionHostModes:new Map(),discordContextProcessing:new Map(),
        disabledCronJobs:[],voiceManager:{
            isConnected:()=>true,stopTranscriptSaving:()=>events.push('transcript-stop'),
            transmitters:new Map([['g',{stop:()=>events.push('audio-stop')}]]),
            stopRecording:async()=>{events.push('finalize');await new Promise(r=>finish=r);return {recordingPath:'saved'};},
            leaveChannel:async()=>events.push('disconnect')
        },
        conversationBuffer:{clear(){}},stopIdleDecisionLoop:()=>events.push('idle-stop'),
        stopGeminiLiveSession:async()=>{},podcastGenerator:{endSession:()=>events.push('generator-stop')},
        saveEpisodePlanProgress:()=>events.push('checkpoint'),endEpisodePlanTracker(){},endInternalThoughtSession:async()=>{}
    });
    const pending=bot.leavePodcastSession('g',{reason:'last_participant_left'});
    for(let i=0;i<8;i++) await Promise.resolve();
    assert.equal(bot.recordingState.get('g'),'STOPPING');
    assert(events.indexOf('checkpoint') < events.indexOf('finalize'));
    assert(events.indexOf('idle-stop') < events.indexOf('finalize'));
    finish();await pending;assert.equal(events.at(-1),'disconnect');
});
async function recoveredFixture(t) {
    const r=root(t), dir=path.join(r,'episode-2026-09-21T22-56-32-775Z');
    const journal=new AudioJournal(dir,{outputFormat:'wav'});
    journal.start({startedAt:1000,consentGiven:true,consentTimestamp:new Date(1000).toISOString()});
    journal.appendPcm('participant','u',Buffer.alloc(48000*4),{capturedAt:1000,timelineOffsetMs:0}); journal.close();
    writeJsonAtomic(path.join(dir,'resume-identity.json'),{ownerId:'u',guildId:'g'});
    const tracker=new EpisodePlanTracker({basename:'la-no-car-no-job',version:'v002',phases:{developing:{angles:['Van']}}},
        {currentPhase:'developing',lastChosenAngle:'van',activeAngles:['van'],openingHostSpoken:true,openingGuestSpeakers:['jensen']});
    writeJsonAtomic(path.join(dir,'episode-plan.json'),tracker.plan);
    savePlanProgress(tracker,dir);
    fs.writeFileSync(path.join(dir,'transcript.jsonl'),JSON.stringify({speaker:'Jensen',text:'Continue this discussion'})+'\n');
    await AudioJournal.recoverIncompleteRecordings(r);
    return {r,dir,tracker};
}
test('real interrupted audio recovery creates resumable metadata and retains exact plan state',async t=>{
    const f=await recoveredFixture(t);
    assert(!fs.existsSync(path.join(f.dir,'episode-complete.json')));
    const result=recoverEpisodeCompletions(f.r);assert.equal(result.length,1);
    const s=loadResumeSource(f.r,null,'u','g');
    assert.equal(s.plan.basename,'la-no-car-no-job');assert.equal(s.planProgress.state.currentPhase,'developing');
    assert.deepEqual(s.planProgress.state.activeAngles,['van']);
    const bytes=fs.readFileSync(path.join(f.dir,'episode-complete.json'));
    assert.deepEqual(recoverEpisodeCompletions(f.r),[]);
    assert.deepEqual(fs.readFileSync(path.join(f.dir,'episode-complete.json')),bytes);
});
test('incomplete newest owned recording blocks fallback; other owners do not',async t=>{
    const f=await recoveredFixture(t);recoverEpisodeCompletions(f.r);
    const latest=path.join(f.r,'episode-2026-09-22T00-00-00-000Z');fs.mkdirSync(latest);
    writeJsonAtomic(path.join(latest,'resume-identity.json'),{ownerId:'u',guildId:'g'});
    assert.throws(()=>loadResumeSource(f.r,null,'u','g'),/older episode was not selected/);
    assert.equal(loadResumeSource(f.r,path.basename(f.dir),'u','g').recording,path.basename(f.dir));
    writeJsonAtomic(path.join(latest,'resume-identity.json'),{ownerId:'other',guildId:'g'});
    assert.equal(loadResumeSource(f.r,null,'u','g').recording,path.basename(f.dir));
});
test('unfinished render is never marked complete and recorder errors propagate',async t=>{
    const r=root(t),d=path.join(r,'episode-broken');fs.mkdirSync(d);fs.mkdirSync(path.join(d,'audio-journal'));
    writeJsonAtomic(path.join(d,'audio-journal/manifest.json'),{status:'finalizing',consentGiven:true});
    assert.deepEqual(recoverEpisodeCompletions(r),[]);
    const vm=Object.create(VoiceManager.prototype);
    Object.assign(vm,{stopQuartzBackchannel:async()=>{},isRecording:new Map([['g',true]]),recordingPaths:new Map([['g',d]]),
        recorders:new Map([['g',{stopRecording:async()=>{throw new Error('render failed');}}]]),receivers:new Map(),recordingMetadata:new Map()});
    await assert.rejects(vm.stopRecording('g'),/render failed/);
    assert(!fs.existsSync(path.join(d,'episode-complete.json')));
});
test('resume waits for startup recovery before selecting a source',async()=>{
    let release,joined=false,reply;
    const recoveryPromise=new Promise(r=>release=r);
    const bot={useGatewayGenerator:()=>false,recordingState:new Map(),RecordingState:{IDLE:'IDLE'},
        voiceManager:{isConnected:()=>false,recoveryPromise,options:{recordingDir:'/does-not-exist'}},
        handleJoinCommand:async()=>{joined=true;}};
    const interaction={memberPermissions:{has:()=>true},member:{voice:{channel:{}}},options:{getString:()=>null},
        user:{id:'u'},guildId:'g',reply:async p=>reply=p, editReply:async p=>reply=p,
        async deferReply(){this.deferred=true;} };
    const task=handleResumeCommand(bot,interaction);await Promise.resolve();
    assert.equal(interaction.deferred,true);assert.equal(reply,undefined);assert.equal(joined,false);
    release();await task;assert.match(reply.content,/Cannot resume/);
});
