const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { VoiceReceiveDiagnostics } = require('./voice-receive-diagnostics');
test('counts receive stages, excludes payloads, rebinds and removes listeners', () => {
 const c = new EventEmitter(), client = new EventEmitter(), network = new EventEmitter();
 const udp = new EventEmitter(), ws = new EventEmitter(), speaking = new EventEmitter();
 const records = [];
 c.joinConfig = { channelId: 'c', selfDeaf: false, selfMute: false };
 c.receiver = { ssrcMap: new Map(), speaking, subscriptions: new Map([['u', {}]]),
   onUdpMessage() {}, onWsPacket() {} };
 udp.on('message', c.receiver.onUdpMessage); ws.on('packet', c.receiver.onWsPacket);
 network.state = { code: 4, udp, ws, secretKey: 'SECRET' };
 c.state = { status: 'ready', networking: network };
 client.guilds = { cache: new Map([['g', { voiceStates: { cache: new Map([['u',
  { id: 'u', channelId: 'c', selfMute: true, serverMute: false, selfDeaf: false }]]) }}]]) };
 const d = new VoiceReceiveDiagnostics(c, { client, guildId: 'g',
 log: s => records.push(JSON.parse(s.slice(s.indexOf('{')))) });
 try {
  assert.equal(records[0].counts.udp, 0);
  udp.emit('message', Buffer.alloc(8));
  const p = Buffer.alloc(32); p[0]=0x80; p.writeUInt32BE(123,8); p.write('PRIVATE_AUDIO',12);
  udp.emit('message', p);
  c.receiver.ssrcMap.set(123,{ userId:'u' }); udp.emit('message',p);
  speaking.emit('start','u'); d.pcm('u',3840); d.report('test');
  const r=records.at(-1);
  assert.deepEqual(r.counts,{udp:3,short:1,unknownSender:1,knownSender:1,speakingStarts:1,pcmChunks:1,pcmBytes:3840});
  assert.equal(r.members[0].selfMute,true);
  assert.equal(r.receiverUdpHandlerAttached,true);
  assert.equal(r.receiverWsHandlerAttached,true);
  assert.equal(JSON.stringify(records).includes('SECRET'),false);
  assert.equal(JSON.stringify(records).includes('PRIVATE_AUDIO'),false);
  const next = new EventEmitter(); network.state={code:4,udp:next,ws};
  network.emit('stateChange',{},network.state);
  assert.equal(udp.listenerCount('message'),1);
  next.emit('message',p); assert.equal(d.counts.udp,4);
  const replacement = new EventEmitter(); replacement.state={code:4,udp:new EventEmitter(),ws};
  c.state={status:'ready',networking:replacement};c.emit('stateChange');
  assert.equal(next.listenerCount('message'),0);
  assert.equal(network.listenerCount('stateChange'),0);
  d.destroy();d.destroy();
  assert.equal(replacement.state.udp.listenerCount('message'),0);
  assert.equal(c.listenerCount('stateChange'),0);
  assert.equal(client.listenerCount('voiceStateUpdate'),0);
  assert.equal(speaking.listenerCount('start'),0);
  assert.equal(records.at(-1).event,'detached');
 } finally { d.destroy(); }
});
