'use strict';
/**
 * test_parked_diag.js - nothing asked of the car's units while it is parked (kit/runtime/diag.js): once the car says
 * parked or standby with nobody in it (VehicleCondition 1-3) and a 20 s grace has passed, a request is not sent and
 * goes as one no unit answers; someone in the car, ignition on, driving, or a state not told yet: sent as before. The
 * read-only link doesn't count held requests as a unit gone silent, and asks every unit again once the car is in use.
 * Engine Config's Hold sends again only while the engine runs. Every app with a diagnostic link declares the state.
 *   node kit/tools/test_parked_diag.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const D = require(path.join(ROOT, 'kit', 'runtime', 'diag'));
const { ReadOnlyDiag } = require(path.join(ROOT, 'kit', 'runtime', 'readonly-diag'));
const { AutoFlap } = require(path.join(ROOT, 'apps', 'live_adjustments', 'auto'));

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log('ok   ' + name); };
const log = { info() {}, warn() {}, error() {} };

// a fake head unit: the car's state handler, and every TASU request counted (answered at once by the DME, 0x12)
let condition = null, calls = 0;
let now = 1e9;
D.carState.now = () => now;
function fakeSignals() {
    const listeners = {};
    return {
        watch: (iface, inst, h) => { if (/VehicleCondition/.test(iface)) condition = h.VehicleCondition; return Promise.resolve({ available: true }); },
        proxy: () => Promise.resolve({}),
        on: (p, ev, fn) => { listeners[ev] = fn; return Promise.resolve(); },
        onAvailable: (p, fn) => { fn(true); return Promise.resolve(); },
        call: (p, m, req) => {
            calls++;
            setImmediate(() => listeners.sendTasuResponse && listeners.sendTasuResponse({ errorCode: 'NO_ERROR',
                udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, req.targetAddress, 0, 0, 0x62, req.udsData[0], req.udsData[1], 0x2A]) }));
            return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
        },
    };
}

(async () => {
    const sig = fakeSignals();
    const diag = await new D.Diag(sig, log).init();
    await new Promise((r) => setImmediate(r));
    const ask = () => diag.physical(0x12, 0x22, [0xF4, 0x0F], 300);

    await check('the car\'s state by name and by number', () => {
        assert.strictEqual(D.conditionOf('PARKEN_BN_IO'), 2);
        assert.strictEqual(D.conditionOf({ statusConditionVehicle: 'WOHNEN' }), 5);
        assert.strictEqual(D.conditionOf(10), 10);
        assert.strictEqual(D.conditionOf('NONSENSE'), undefined);
    });
    await check('not told yet: sent', async () => {
        assert(typeof condition === 'function', 'the Diag watches the car\'s state');
        calls = 0; assert((await ask())[0] === 0x62); assert.strictEqual(calls, 1);
    });
    await check('locked: sent for the grace (a light given back), then nothing goes out', async () => {
        condition({ statusConditionVehicle: 'PARKEN_BN_IO' });
        calls = 0; now += 5000; assert((await ask())[0] === 0x62); assert.strictEqual(calls, 1, 'in the grace');
        now += D.PARKED_GRACE_MS;
        calls = 0; const t0 = Date.now();
        assert.strictEqual(await ask(), null, 'as a unit that doesn\'t answer');
        assert.strictEqual(calls, 0, 'nothing sent');
        assert(Date.now() - t0 >= 250, 'after its timeout, so a loop asking again is held back too');
        const m = await diag.functional(0x22, [0xF1, 0x50], { idleMs: 50, maxMs: 300 });
        assert.strictEqual(m.size, 0); assert.strictEqual(calls, 0, 'nor a request to all units');
    });
    await check('standby with nobody in it: held too; someone in the car: sent', async () => {
        condition(3); now += D.PARKED_GRACE_MS + 1;
        calls = 0; assert.strictEqual(await ask(), null); assert.strictEqual(calls, 0);
        condition('WOHNEN');
        calls = 0; assert((await ask())[0] === 0x62); assert.strictEqual(calls, 1);
    });
    await check('the read-only link: held requests are not a unit gone silent; in use again, every unit asked', async () => {
        const link = new ReadOnlyDiag(sig, log, { gapMs: 0, silentAfter: 2 });
        await link.init();
        condition(1); now += D.PARKED_GRACE_MS + 1;
        for (let i = 0; i < 4; i++) assert.strictEqual(await link.read(0x12, 0xF40F, 100), null);
        assert.strictEqual(link.silent(0x12), false, 'not taken for silent');
        link.misses[0x12] = 9;                 // (one that went silent before)
        condition('FAHREN');
        assert.strictEqual(link.silent(0x12), false, 'woken as the car came back');
        calls = 0; assert((await link.read(0x12, 0xF40F, 300))[0] === 0x62); assert.strictEqual(calls, 1);
    });
    await check('Engine Config: Hold sends again only while the engine runs', async () => {
        let sent = 0, rpm = null;
        const auto = new AutoFlap({ controller: { armedSetting: true, setMode: () => { sent++; return Promise.resolve(); } },
            get: (k) => ({ hold: 'on', driveLink: 'off', closeLimit: 0 })[k], rpm: () => rpm, log, holdMs: 30 });
        rpm = 2000;
        await auto.press('OPEN'); assert.strictEqual(sent, 1, 'the press');
        await new Promise((r) => setTimeout(r, 45)); await auto._q;
        assert.strictEqual(sent, 2, 'held, engine running');
        rpm = 0;
        await new Promise((r) => setTimeout(r, 100)); await auto._q;
        assert.strictEqual(sent, 2, 'engine off: not sent again');
        rpm = null;
        await new Promise((r) => setTimeout(r, 70)); await auto._q;
        assert.strictEqual(sent, 2, 'no engine speed: not sent again');
        rpm = 1800;
        await new Promise((r) => setTimeout(r, 45)); await auto._q;
        assert(sent >= 3, 'running again: held again');
        auto._stop();
    });
    await check('every app with a diagnostic link declares the car\'s state (else nothing would be held)', () => {
        fs.readdirSync(path.join(ROOT, 'apps')).forEach((a) => {
            const dir = path.join(ROOT, 'apps', a);
            if (!fs.existsSync(path.join(dir, 'app.json'))) return;
            const src = fs.readdirSync(dir).filter((f) => /\.js$/.test(f)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
            if (!/kit\/diag'|kit\/readonly-diag'|new Diag\(|new ReadOnlyDiag\(|DiagLink/.test(src)) return;
            const spec = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
            const s = (spec.signals || {})['de.bmw.infrastructure.VehicleCondition'];
            assert(s && s.VehicleCondition, a + ': VehicleCondition');
        });
    });
    console.log(n + ' passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
