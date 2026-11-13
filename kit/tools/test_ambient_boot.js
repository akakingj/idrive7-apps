'use strict';
/**
 * test_ambient_boot.js - Ambient config's background at a head-unit start with the car locked and its state not told
 * (the head unit woke for a remote service): the car's own light, nothing shown or written, until someone is there (a
 * door opening here); locked again: the car's own. Builds the app's offline preview first (no SDK).
 *   node kit/tools/test_ambient_boot.js
 */
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..', '..');
require('child_process').execFileSync('python3', [path.join(ROOT, 'kit', 'tools', 'build.py'), '--preview-only', 'ambient_config'], { cwd: ROOT, stdio: 'pipe' });
const APP = path.join(ROOT, 'dist', 'ambient_config', 'source', 'javascript');
const Module = require('module'); const load = Module._load;
const calls = [];
const fakeLights = class { constructor() { this.lights = []; this.scene = null; } on() {} find() { return Promise.resolve([]); } show(s) { calls.push(['show', s.kind]); this.scene = s; } carColour() { calls.push(['car']); this.scene = null; } overlay() {} dim() {} flash() {} hold() {} };
Module._load = function (req, parent, isMain) {
    if (req === 'oap-sdk') { const l = { info() {}, warn() {}, error() {}, debug() {} }; return { OnlineApp: class {}, logging: { getSDKLogger: () => l, getLogger: () => l } }; }
    if (/\/lights$/.test(req) || req === './lights') return { Lights: fakeLights };
    if (/kit\/diag$/.test(req)) return { Diag: class { constructor() {} init() { return Promise.resolve(this); } } };
    if (/\/ambient$/.test(req) || req === './ambient') return { Ambient: class { constructor() {} start() { return Promise.resolve(); } mode() { return null; } on() {} } };
    if (/\/others$/.test(req) || req === './others') return { Others: class { constructor() {} start() { return this; } on() {} } };
    return load.apply(this, arguments);
};
process.env.MGU_KIT_DIR = '';
const handlers = {};
const S = { on: true, look: undefined, follow: true, welcome: false };
const bg = { settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; }, onChange() {} }, log: { info() {}, warn() {}, error() {} },
    signals: { watch: (i, inst, h) => { Object.assign(handlers, h); return Promise.resolve({ available: true }); } }, dataDir: null };
let background;
const mgu = require(path.join(APP, 'kit', 'mgu'));
mgu.run = (o) => { background = o.background; };
require(path.join(APP, 'app.js'));
(async () => {
    const r = await background(bg);
    assert(calls.every((c) => c[0] !== 'show'), 'nothing shown at a start without the car state: ' + JSON.stringify(calls));
    handlers.CentralLockingSystemAndPanelStatus({ statusDoorSwitchDRD: 1 });
    assert(calls.some((c) => c[0] === 'show'), 'a door opened: shown');
    calls.length = 0;
    handlers.VehicleCondition({ statusConditionVehicle: 'PARKEN_BN_IO' });
    assert(calls.length && calls[calls.length - 1][0] === 'car', 'locked: the car\'s own');
    console.log('ok: ambient at a locked start');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
