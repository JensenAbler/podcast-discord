const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { participantTag, recordingTags, writeTags, planChoices } = require('./recording-tags');
const { VoiceManager } = require('./voice-manager');
const { AlphaClawdVoiceBot } = require('./bot');
function fixture(t) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-tags-'));
 t.after(() => fs.rmSync(root, { recursive: true, force: true }));
 return root;
}
test('legacy tags exclude inherited, failed and candidate speakers and group plan versions', t => {
 const root=fixture(t), dir=path.join(root,'episode-a'); fs.mkdirSync(dir);
 fs.writeFileSync(path.join(dir,'episode-complete.json'), JSON.stringify({guildId:'g'}));
 fs.writeFileSync(path.join(dir,'resume-background.json'), JSON.stringify({basename:'retrospective',version:'v002'}));
 fs.writeFileSync(path.join(dir,'resume-history.json'), JSON.stringify([{speaker:'Old Guest'}]));
 fs.writeFileSync(path.join(dir,'transcript.jsonl'), [
  {speaker:'Jensen Abler'}, {speaker:'Alpha-Clawd'}, {speaker:'Ghost',admission:{status:'candidate'}},
  {speaker:'Failed',playbackStatus:'failed'}].map(JSON.stringify).join('\n'));
 assert.deepEqual(recordingTags(dir).tags,['person:alpha','person:jensen','plan:retrospective']);
 assert.equal(planChoices(root,'retro','g')[0].value,'retrospective');
 assert.deepEqual(planChoices(root,'','other'),[]);
 assert.equal(participantTag('Alpha'),participantTag('Alpha-Clawd'));
});
test('current members and later joins add tags once and persist plan without old participants', async t => {
 const dir=fixture(t), vm=Object.create(VoiceManager.prototype);
 const meta={tags:['plan:topic'],planTag:'plan:topic'};
 Object.assign(vm,{recordingMetadata:new Map([['g',meta]]),recordingPaths:new Map([['g',dir]]),
  isRecording:new Map([['g',true]]),connectionChannels:new Map([['g','c']]),
  client:{user:{id:'bot'}},receivers:new Map([['g',{options:{speakerMap:{u:{name:'Jensen'}}},subscribeToUser(){}}]])});
 vm.addParticipantTag('g','Alpha-Clawd');
 vm.addMemberTag('g',{id:'u',displayName:'Different Discord name',user:{}});
 vm.addMemberTag('g',{id:'u',displayName:'Different Discord name',user:{}});
 await vm.handleVoiceStateUpdate({guild:{id:'g'},channelId:null},{id:'v',guild:{id:'g'},channelId:'c',
  member:{id:'v',displayName:'Guest',user:{}}});
 assert.deepEqual(recordingTags(dir).tags,['person:alpha','person:guest','person:jensen','plan:topic']);
});
test('production command passes plan and server without latest recording selection', async () => {
 const bot=Object.create(AlphaClawdVoiceBot.prototype); let args, reply;
 Object.assign(bot,{getProductionEpisodeState:()=>({next:19}),getLatestRecording(){assert.fail('plan must not use latest');},
  runProductionProcess:async a=>{args=a;return {stdout:'{}'};},extractLastJson:()=>({episode:'19',version:'v001',sourceRecordings:['a','b']}),
  ensureProductionVersionedDownload(){}});
 const interaction={guildId:'g',options:{getString:n=>n==='plan'?'topic':null,getInteger:()=>null,getBoolean:()=>null},
  deferReply:async()=>{},editReply:async r=>{reply=r;},reply:async()=>assert.fail('unexpected rejection')};
 await bot.handleProductionCommand(interaction);
 assert(args.includes('--plan')); assert.equal(args[args.indexOf('--plan')+1],'topic');
 assert(!args.includes('--recording')); assert.equal(args[args.indexOf('--guild-id')+1],'g');
 assert.match(reply.content,/2 recordings combined/);
 const cmd=bot.buildSlashCommands().find(c=>c.name==='podcast-production').toJSON();
 assert(cmd.options.find(o=>o.name==='plan').autocomplete);
});
