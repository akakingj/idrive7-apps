#!/usr/bin/env node
'use strict';
/*
 * Redline (this fork): boost and intake air from the engine unit (apps/redline/intake.js), the HUD's INTAKE readout,
 * and the tyre widget's "Low or warming up" going with the engine's warm-up (hud-tyres.js widgetShows).
 *   node kit/tools/test_redline_intake.js
 */
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'apps', 'redline');
// the app requires the kit as './kit/...' (where the build puts it): mapped to kit/runtime
require('./redline_test_harness').hookKit();
const IntakeWatch = require(path.join(APP, 'intake'));
const Hud = require(path.join(APP, 'hud'));
const HudTyres = require(path.join(APP, 'hud-tyres'));

let n = 0;
const ok = (c, what) => { assert.ok(c, what); n++; console.log('ok   ' + what); };

/** A fake read-only link: replies per DID / OBD PID (a function of the call count, or null: no reply). */
function link(replies) {
    const asked = [];
    return {
        asked,
        woken: 0,
        wake() { this.woken++; },
        async physical(ecu, sid, data) {
            const key = sid === 0x22 ? ((data[0] << 8) | data[1]).toString(16).toUpperCase().padStart(4, '0') : 'OBD ' + data[0].toString(16).toUpperCase().padStart(2, '0');
            asked.push(key);
            const r = replies[key];
            const bytes = typeof r === 'function' ? r(asked.filter((k) => k === key).length) : r;
            if (!bytes) return null;
            return sid === 0x22 ? [0x62, data[0], data[1]].concat(bytes) : [0x41, data[0]].concat(bytes);
        },
    };
}
const log = { info() {}, warn() {} };
const tick = () => new Promise((r) => setImmediate(r));
// k polls, each as if the last of every value were long ago (the outside air pressure once only, as on the car)
async function polls(w, k) {
    for (let i = 0; i < k; i++) {
        const next = i % 2 ? 'iat' : 'boost';
        w.asked.boost = next === 'boost' || !w.want.iat ? 0 : Date.now(); w.asked.iat = next === 'iat' || !w.want.boost ? 0 : Date.now();
        w._poll(); await tick(); await tick(); await tick();
    }
}

(async () => {
    // F470: support byte, commanded A (2), actual A (2): actual 160 kPa absolute = 5120 / 32
    const abs = 160, baro = 98;
    const L = link({ F470: [0x03, 0x00, 0x00, (abs * 32) >> 8, (abs * 32) & 0xFF], F433: [baro], F40F: [40 + 35] });
    const w = new IntakeWatch({ log }, () => L);
    w.start({ boost: true, iat: true });
    await polls(w, 6);
    const v = w.value();
    ok(Math.abs(v.boost - (abs - baro) / 100) < 1e-9, 'boost: F470 absolute less the outside air pressure, bar (' + v.boost + ')');
    ok(v.iat === 35, 'intake air: F40F less 40 (' + v.iat + ' °C)');
    ok(L.asked.indexOf('F433') >= 0 && L.asked.indexOf('F433') < L.asked.indexOf('F470'), 'the outside air pressure asked before the first boost');
    w.stop();
    ok(w.timer === null, 'stopped');

    // only the intake air wanted: no boost (nor the outside air pressure) asked
    const L2 = link({ F470: [0, 0, 0, 0x14, 0], F40F: [60] });
    const w2 = new IntakeWatch({ log }, () => L2);
    w2.start({ boost: false, iat: true });
    await polls(w2, 3);
    ok(L2.asked.every((k) => k === 'F40F'), 'intake air only: only F40F asked (' + L2.asked.join(',') + ')');
    w2.start({ boost: false, iat: false });
    ok(w2.timer === null, 'neither wanted: stopped');
    w2.stop();

    // no boost from the first candidates: the next one (F487), and none at all: given up for a minute after three
    const L3 = link({ F487: [0x00, (130 * 32) >> 8, (130 * 32) & 0xFF] });
    const w3 = new IntakeWatch({ log }, () => L3);
    w3.start({ boost: true, iat: false });
    await polls(w3, 4);
    ok(Math.abs(w3.value().boost - (130 - 101.3) / 100) < 1e-9, 'boost from F487 where F470 gives none; 101.3 kPa without a pressure (' + w3.value().boost + ')');
    w3.stop();
    const L4 = link({});
    const w4 = new IntakeWatch({ log }, () => L4);
    w4.start({ boost: false, iat: true });
    for (let i = 0; i < 3; i++) { w4.asked.iat = 0; w4._poll(); await tick(); await tick(); await tick(); await tick(); }
    const before = L4.asked.length;
    w4.asked.iat = Date.now();
    w4._poll(); await tick();
    ok(w4.fails.iat === 3 && L4.asked.length === before, 'no intake air on this car: not asked again within the minute');
    ok(w4.value().iat === null && w4.value().boost === null, 'nothing read: null');
    w4.stop();

    // stale values: null
    const w5 = new IntakeWatch({ log }, () => link({}));
    w5.v.boost = 0.5; w5.t.boost = Date.now() - 2500; w5.v.iat = 30; w5.t.iat = Date.now() - 5000;
    ok(w5.value().boost === null && w5.value().iat === 30, 'boost stale after 2 s, the intake air after 10 s');

    // the HUD's readout row: INTAKE with the other temperatures, in °F when chosen
    const o = Object.assign({}, Hud.optsFrom({ get: (k) => ({ hudShowIntake: true, hudTempsMode: 'always' })[k] }), { rpm: false, boost: false, oil: false, coolant: false, gearbox: false });
    ok(o.intake === true && !Hud.optsFrom({ get: () => undefined }).intake, 'the Intake readout: off unless switched on');
    let r = Hud.readoutsFor({}, null, null, null, o, { intake: 34.6 });
    ok(r.length === 1 && r[0].label === 'INTAKE' && r[0].value === '35°', 'INTAKE 35° (' + JSON.stringify(r) + ')');
    r = Hud.readoutsFor({}, null, null, null, Object.assign({}, o, { fahrenheit: true }), { intake: 35 });
    ok(r[0].value === '95°', 'in °F');
    ok(Hud.readoutsFor({}, null, null, null, o, {}).length === 0, 'no value: no readout');
    ok(Hud.PROFILE_KEYS.indexOf('hudShowIntake') >= 0 && Hud.calmOpts(o).intake === false, 'per driving mode setup; off in the calm setup');
    // boost from the engine unit shows as the sport display's would
    r = Hud.readoutsFor({}, null, 0.62, null, Object.assign({}, o, { intake: false, boost: true }), {});
    ok(r.length === 1 && r[0].label === 'BOOST' && r[0].value === '0.6', 'BOOST 0.6 from a value of 0.62 bar');

    // the tyre widget: "Low or warming up" with the engine's warm-up
    const W = HudTyres.widgetOf({ get: (k) => ({ hudTyreWidget: 'warm' })[k] });
    const cold = { p: { FL: 2.5, FR: 2.5, RL: 2.7, RR: 2.7 }, tgt: { FL: 2.5, FR: 2.5, RL: 2.7, RR: 2.7 }, t: { FL: 12, FR: 12, RL: 12, RR: 12 } };
    ok(HudTyres.widgetShows(W, cold, true), 'engine warming up: shows');
    ok(!HudTyres.widgetShows(W, cold, false), 'engine warm: goes, though the tyres are still under 40 °C');
    const low = { p: Object.assign({}, cold.p, { RR: 2.0 }), tgt: cold.tgt, t: cold.t };
    ok(HudTyres.widgetShows(W, low, false), 'engine warm and a tyre low: shows');
    ok(HudTyres.widgetShows(W, cold) === true, 'no engine state given: the tyres\' own warm-up as before');
    const Wl = Object.assign({}, W, { show: 'low' });
    ok(!HudTyres.widgetShows(Wl, cold, true), '"When low": not for the engine warming up');

    // main.js: boost from the engine unit only where the sport display sends none
    const main = require('fs').readFileSync(path.join(APP, 'main.js'), 'utf8');
    ok(/boost: \(\) => \(car\.data\(\)\.demo \? null : boost\.moved && Date\.now\(\) - boost\.t < 2000 \? boost\.v : intake\.value\(\)\.boost\)/.test(main), 'the sport display\'s boost first, else the engine unit\'s');
    const hud = require('fs').readFileSync(path.join(APP, 'hud.js'), 'utf8');
    ok(/src\.intake\.start\(\{ boost: run && oNow\.boost && !\(src\.boostCar && src\.boostCar\(\)\), iat: run && oNow\.intake \}\)/.test(hud), 'the engine unit asked for boost only with the engine running, the readout on and no boost from the sport display');
    ok(/\[src\.gearbox, src\.knock, src\.fuel, src\.intake\]\.forEach/.test(hud), 'stopped with the other reads');
    console.log('redline intake: ' + n + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
