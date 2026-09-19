
const test = require('node:test');
const assert = require('node:assert/strict');
const { QuartzOutputLevel } = require('./quartz-output-level');
function tone(amplitude) {
    const b = Buffer.alloc(640);
    for (let i=0; i<320; i++) b.writeInt16LE(Math.round(amplitude * Math.sin(i * Math.PI / 16)), i*2);
    return b;
}
function peak(b) {
    let p=0; for(let i=0;i<b.length;i+=2) p=Math.max(p,Math.abs(b.readInt16LE(i))); return p;
}
test('calibrated boost raises quiet speech by 18 dB without changing silence', () => {
    const l = new QuartzOutputLevel();
    assert.equal(peak(l.process(tone(1000))),8000);
    assert.equal(peak(l.process(Buffer.alloc(640))),0);
});
test('limiter handles full-scale bipolar audio without clipping or wrapping', () => {
    const l = new QuartzOutputLevel();
    const pcm=Buffer.alloc(640);
    for(let i=0;i<640;i+=2) pcm.writeInt16LE(i%4 ? -32768 : 32767,i);
    const out=l.process(pcm);
    assert.ok(peak(out)<=29204);
    assert.ok(out.readInt16LE(0)>0);
    assert.ok(out.readInt16LE(2)<0);
    const after=peak(l.process(tone(1000)));
    assert.ok(after<8000, 'gain recovers smoothly after a loud peak');
    for(let i=0;i<100;i++) l.process(tone(1000));
    assert.equal(peak(l.process(tone(1000))),8000);
});
test('unity and invalid gain values behave predictably', () => {
    assert.deepEqual(new QuartzOutputLevel(1).process(tone(1000)),tone(1000));
    for(const value of [NaN,Infinity,-1,0,100]) assert.equal(peak(new QuartzOutputLevel(value).process(tone(1000))),8000);
});
