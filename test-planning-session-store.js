'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'), os=require('os'), path=require('path');
const {PlanningSessionStore}=require('./planning-session-store');
const {AlphaClawdVoiceBot}=require('./bot');
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'planning-restore-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return new PlanningSessionStore(root);
}
test('draftless planning messages survive restart without replaying an in-flight request',async t=>{
 const store=fixture(t);
 const bot=Object.create(AlphaClawdVoiceBot.prototype);
 bot.planningSessionStore=store;
 const session={channelId:'c',guildId:'g',messages:[{text:'My background',sequence:1}],basename:'',messageSequence:1,processing:Promise.resolve(),processingActive:true};
 bot.planningSessions=new Map([['c',session]]);
 bot.persistPlanningSessionMessages(session);
 const restored=store.load().get('c');
 assert.equal(restored.messages[0].text,'My background');
 assert.equal(restored.messageSequence,1);
 assert.equal(restored.processingActive,false);
 await restored.processing;
 assert(!fs.readFileSync(store.filename,'utf8').includes('processing'));
});
test('latest plan and message journal cursor survive; explicitly closed sessions stay closed',t=>{
 const store=fixture(t);
 const session={channelId:'c',guildId:'g',messages:[{text:'Background'}],latestPlan:{basename:'draft',version:'v002'},loggedMessageCount:1};
 const sessions=new Map([['c',session]]);
 store.save(sessions);
 assert.deepEqual(store.load().get('c').latestPlan,session.latestPlan);
 assert.equal(store.load().get('c').loggedMessageCount,1);
 sessions.delete('c');store.save(sessions);
 assert.equal(store.load().size,0);
});
test('closing through the bot persists removal',async t=>{
 const store=fixture(t),bot=Object.create(AlphaClawdVoiceBot.prototype);
 const session={channelId:'c',guildId:'g',messages:[],basename:''};
 bot.planningSessionStore=store;bot.planningSessions=new Map([['c',session]]);
 store.save(bot.planningSessions);
 await bot.closePlanningSession(session,null,{send:async()=>{}});
 assert.equal(store.load().size,0);
});
