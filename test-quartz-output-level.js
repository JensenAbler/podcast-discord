
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
function fullLevel(gain = 4) {
    let now = 0;
    const level = new QuartzOutputLevel(gain, { now: () => now });
    level.setEnvironment('holding_rising');
    now = 5000;
    return level;
}
test('calibrated maximum raises quiet speech by 12 dB without changing silence', () => {
    const l = fullLevel();
    assert.equal(peak(l.process(tone(1000))),4000);
    assert.equal(peak(l.process(Buffer.alloc(640))),0);
});
test('limiter handles full-scale bipolar audio without clipping or wrapping', () => {
    const l = fullLevel();
    const pcm=Buffer.alloc(640);
    for(let i=0;i<640;i+=2) pcm.writeInt16LE(i%4 ? -32768 : 32767,i);
    const out=l.process(pcm);
    assert.ok(peak(out)<=29204);
    assert.ok(out.readInt16LE(0)>0);
    assert.ok(out.readInt16LE(2)<0);
    const after=peak(l.process(tone(1000)));
    assert.ok(after<4000, 'gain recovers smoothly after a loud peak');
    for(let i=0;i<100;i++) l.process(tone(1000));
    assert.equal(peak(l.process(tone(1000))),4000);
});
test('unity and invalid gain values behave predictably', () => {
    assert.deepEqual(fullLevel(1).process(tone(1000)),tone(1000));
    for(const value of [NaN,Infinity,-1,0,100]) assert.equal(peak(fullLevel(value).process(tone(1000))),4000);
});

test('ordinary states attenuate calibrated output by 75%, including limited speech', () => {
    for (const gain of [1, 4, 8]) {
        for (const state of ['listening', 'rare', 'holding', 'holding_longer', 'yielding', 'aside', 'waiting_for_guest']) {
            const level = new QuartzOutputLevel(gain);
            level.setEnvironment(state);
            for (const amplitude of [0, 1000, 32767]) {
                const expected = peak(fullLevel(gain).process(tone(amplitude))) * 0.25;
                assert.ok(Math.abs(peak(level.process(tone(amplitude))) - expected) <= 1);
            }
        }
    }
});
test('rising volume reaches the prior level in five seconds of elapsed time', () => {
    let now = 0;
    const level = new QuartzOutputLevel(4, { now: () => now });
    level.setEnvironment('holding_rising');
    for (const [ms, expected] of [[0, 1000], [1000, 1600], [2500, 2500], [5000, 4000], [60000, 4000]]) {
        now = ms;
        level.setEnvironment('holding_rising'); // repeated updates/reconnects
        assert.equal(peak(level.process(tone(1000))), expected);
    }
});
test('leaving rising resets volume, and the next rise gets a fresh five-second ramp', () => {
    for (const state of ['listening', 'rare', 'holding', 'holding_longer', 'yielding', 'aside', 'waiting_for_guest']) {
        let now = 0;
        const level = new QuartzOutputLevel(4, { now: () => now });
        level.setEnvironment('holding_rising');
        now = 5000;
        assert.equal(peak(level.process(tone(1000))), 4000);
        level.setEnvironment(state);
        assert.equal(peak(level.process(tone(1000))), 1000);
        level.setEnvironment('holding_rising');
        assert.equal(peak(level.process(tone(1000))), 1000);
        now += 2500;
        assert.equal(peak(level.process(tone(1000))), 2500);
    }
});
