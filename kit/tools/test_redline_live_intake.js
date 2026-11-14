'use strict';

// Redline (this fork): the HUD's boost and intake air running end to end, against a stand-in cluster-render and a
// stand-in engine unit read through the real IntakeWatch (apps/redline/intake.js):
//   node kit/tools/test_redline_live_intake.js
// - boost: the sport display's while it sends a moving value; where it sends none, the engine unit's (read only
//   while the Boost readout is on and the engine runs, stopped with the engine and with the HUD);
// - the Intake readout from the engine unit;
// - the tyre widget "Low or warming up": with the engine warming up, gone once the oil and coolant are warm.
// src.boost / boostCar are main.js's own expressions (checked there by test_redline_intake.js).

const fs = require('fs');
const path = require('path');
const TH = require('./redline_test_harness');
const { TMP, SHM } = TH.claimsDir('redline-live-intake-');
const ROOT = TH.ROOT;

let cr = null;
TH.hookKit({ clusterRender: TH.fakeClusterRender({ set: 'merge', onCreate: (c) => { cr = c; } }) });
const Hud = require(path.join(ROOT, 'apps', 'redline', 'hud'));
const IntakeWatch = require(path.join(ROOT, 'apps', 'redline', 'intake'));
const def = TH.redlineDefaults().def;
const tally = TH.counter(), ok = tally.ok, sleep = TH.sleep;
const log = { info() {}, warn() {}, error() {} };

/** The engine unit: F470 (boost, absolute kPa x 32 in bytes D-E), F433 (outside air kPa), F40F (intake air + 40). */
const engine = { absKpa: 180, baro: 100, iatC: 38, asked: [] };
const link = {
    wake() {},
    async physical(ecu, sid, data) {
        const key = ((data[0] << 8) | data[1]).toString(16).toUpperCase().padStart(4, '0');
        engine.asked.push(key);
        let bytes = null;
        if (key === 'F470') { const raw = Math.round(engine.absKpa * 32); bytes = [0x1f, 0, 0, raw >> 8, raw & 0xff, 0, 0, 0, 0, 0]; }
        if (key === 'F433') bytes = [engine.baro];
        if (key === 'F40F') bytes = [engine.iatC + 40];
        return bytes ? [0x62, data[0], data[1]].concat(bytes) : null;
    },
};

(async () => {
    fs.mkdirSync(SHM);
    fs.writeFileSync(path.join(SHM, 'redline'), JSON.stringify({ held: false, at: Date.now() }) + '\n');
    const v = Object.assign({}, def, { hud: 'on', hudStyle: 'standard', hudComfortMode: 'same', hudBoost: true, hudShowIntake: true,
        hudShowOil: false, hudShowWater: false, hudShowGearbox: false, hudShowOutside: false, hudShowRpm: false, hudShowSpeed: false,
        hudShowLimit: false, hudShowTorque: false, hudShowPower: false, hudShowG: false, hudShowKnock: false, hudShowFuel: false,
        hudTyreWidget: 'warm', warmOil: 80 }), fns = [];
    const settings = { get: (k) => v[k], set: (k, x) => { v[k] = x; fns.forEach((f) => f(k, x)); }, onChange: (f) => fns.push(f) };
    let rpm = 3000, oil = 95, coolant = 90;
    // the sport display's boost (main.js's "boost" watch): moved once a changing value came
    const boost = { v: 0, t: 0, moved: false };
    const intake = new IntakeWatch({ log }, () => link);
    const src = {
        data: () => ({ rpm: rpm, gear: 3, stage: 'D', speed: 80, oil: oil, coolant: coolant }),
        shiftPoint: () => ({ rpm: 6200, cold: false }), redline: () => 6550, maxRpm: () => 8000, driveMode: () => 'sport',
        intake: intake,
        tyres: { val: null, value() { return this.val; } },
        nav: { m: null, view() { return { show: this.m, giveWay: false }; } },
        // main.js 2.0.53's
        boostCar: () => boost.moved && Date.now() - boost.t < 2000,
        boost: () => (src.data().demo ? null : boost.moved && Date.now() - boost.t < 2000 ? boost.v : intake.value().boost),
        extras: () => ({ intake: intake.value().iat }),
    };
    const h = Hud.start({ settings: settings, log: log, dataDir: TMP, backWaitMs: 600 }, src);
    const row = () => (h.frame().readouts || []).map((r) => r.label + '=' + r.value).join(' ');
    await sleep(1300);

    // the sport display silent: boost and intake air from the engine unit
    ok(intake.timer !== null && intake.want.boost && intake.want.iat, 'engine running, Boost and Intake on, the sport display silent: the engine unit read');
    ok(/BOOST=0\.8/.test(row()) && /INTAKE=38°/.test(row()), 'BOOST 0.8 (180 kPa less 100) and INTAKE 38° from the engine unit (' + row() + ')');
    engine.absKpa = 230; await sleep(900);
    ok(/BOOST=1\.3/.test(row()), 'the boost follows the engine unit (' + row() + ')');
    ok(engine.asked.filter((k) => k === 'F433').length === 1, 'the outside air pressure read once (not every boost read)');

    // the sport display sends a moving value: its boost, the engine unit's boost no longer asked
    const feed = setInterval(() => { boost.v = 0.5 + Math.random() * 0.01; boost.t = Date.now(); boost.moved = true; }, 100);
    await sleep(600);
    const n0 = engine.asked.filter((k) => k === 'F470').length;
    await sleep(1200);
    ok(/BOOST=0\.5/.test(row()) && !intake.want.boost, 'the sport display sending: its boost, the engine unit\'s not wanted (' + row() + ')');
    ok(engine.asked.filter((k) => k === 'F470').length === n0, 'no boost asked of the engine unit while the sport display sends');
    ok(/INTAKE=38°/.test(row()) && intake.timer !== null, 'the intake air still read');
    clearInterval(feed);
    await sleep(2600);
    ok(intake.want.boost && /BOOST=1\.3/.test(row()), 'the sport display quiet again: back to the engine unit (' + row() + ')');

    // the engine off: nothing read
    rpm = 0; await sleep(400);
    ok(intake.timer === null, 'the engine off (0 rpm): the engine unit not read');
    const nOff = engine.asked.length; await sleep(800);
    ok(engine.asked.length === nOff, '... and nothing asked while it is off');
    rpm = 2500; await sleep(400);
    ok(intake.timer !== null, 'the engine on again: read again');

    // both readouts off: nothing read
    settings.set('hudBoost', false); settings.set('hudShowIntake', false); await sleep(400);
    ok(intake.timer === null, 'Boost and Intake off: the engine unit not read');
    settings.set('hudShowIntake', true); await sleep(400);
    ok(intake.timer !== null && !intake.want.boost && intake.want.iat, 'Intake alone on: only the intake air');

    // the tyre widget "Low or warming up": with the engine's warm-up, the tyres still cold
    const T = (rr) => ({ p: { FL: 2.5, FR: 2.5, RL: 2.7, RR: rr }, tgt: { FL: 2.5, FR: 2.5, RL: 2.7, RR: 2.7 }, t: { FL: 15, FR: 15, RL: 15, RR: 15 } });
    src.tyres.val = T(2.7);
    oil = 60; coolant = 50; await sleep(300);
    ok(h.corner() === 'tyres', 'engine cold, tyres cold: the widget (' + h.corner() + ')');
    oil = 85; coolant = 50; await sleep(300);
    ok(h.corner() === 'tyres', 'oil warm, coolant still cold: the widget');
    coolant = 75; await sleep(300);
    ok(h.corner() === '', 'oil and coolant warm, tyres still at 15 °C: the widget gone (' + h.corner() + ')');
    src.tyres.val = T(2.0); await sleep(300);
    ok(h.corner() === 'tyres', 'warm, but a tyre low: the widget');

    // the HUD off: the engine unit's reads stop
    settings.set('hud', 'off'); await sleep(400);
    ok(intake.timer === null, 'the HUD off: the engine unit not read');
    h.stop();
    intake.stop();
    TH.rmTree(TMP);
    console.log('redline live intake: ' + tally.checks + ' checks, ' + tally.fails + ' failed');
    process.exit(tally.fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
