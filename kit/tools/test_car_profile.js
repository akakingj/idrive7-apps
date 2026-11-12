'use strict';
/**
 * test_car_profile.js - the Car profile (apps/car_profile) and the kit's settings that follow it (mgu.js Settings,
 * app.json "profile"), on the PC.
 *
 *   node kit/tools/test_car_profile.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carprofile-'));
const FILE = path.join(dir, 'car-profile.json');
process.env.MGU_CAR_PROFILE = FILE;
const P = require(path.join(ROOT, 'apps', 'car_profile', 'profile'));

// the real Settings class without the SDK (as hu-stub.js and test_runtime.js cut it)
const src = fs.readFileSync(path.join(ROOT, 'kit', 'runtime', 'mgu.js'), 'utf8').replace(/\r\n/g, '\n');
const cls = src.match(/class Settings[\s\S]*?\n}\n/)[0];
const quiet = { info() {}, warn() {}, error() {} };
let n = 0;
const settingsIn = (schema, saved) => {
    const dd = path.join(dir, 'app' + (n++));
    fs.mkdirSync(dd);
    if (saved) fs.writeFileSync(path.join(dd, 'settings.json'), JSON.stringify(saved));
    const S = new Function('fs', 'path', 'DATA_DIR', 'log', cls + '\nreturn Settings;')(fs, path, dd, quiet);
    return new S(schema);
};
const fakeProfile = (vals) => {
    const s = { v: vals, get(k) { return this.v[k]; } };
    return s;
};
// the file's mtime moves on with each write (the poll looks at it), even within one millisecond
let tick = Date.now() / 1000 - 1000;
const writeProfile = (values) => { P.publish(fakeProfile(values), 'test'); tick += 5; fs.utimesSync(FILE, tick, tick); };
const clear = () => { try { fs.unlinkSync(FILE); } catch (e) { /* none */ } };

const SCHEMA = [
    { key: 'speedUnit', label: 'Speed unit', type: 'choice', default: 'kmh', options: [['kmh', 'km/h'], ['mph', 'mph']], profile: 'speedUnit' },
    { key: 'distUnit', label: 'Distance unit', type: 'choice', default: 'm', options: [['m', 'metres'], ['ft', 'feet']], profile: 'distUnit', profileMap: { km: 'm', mi: 'ft' } },
    { key: 'redline', label: 'Redline', type: 'number', unit: 'rpm', default: 0, labels: { 0: 'Auto' }, steps: [0, 6000, 7000], profile: 'redline' },
    { key: 'torqueUnit', label: 'Torque unit', type: 'choice', default: 'nm', options: [['nm', 'Nm'], ['kgm', 'kgm']], profile: 'torqueUnit' },
    { key: 'maxKgm', label: 'Torque gauge max', type: 'number', default: 100, steps: [40, 100], when: { torqueUnit: 'kgm' } },
    { key: 'theme', label: 'Theme', type: 'choice', default: 'm_tricolour', options: [['m_tricolour', 'M']] },
];

const cases = {
    'publish: only what is set, readable by every app, the same file not rewritten'() {
        clear();
        const vals = P.publish(fakeProfile({ engine: 'app', redline: 6000, rpmScale: -1, speedUnit: 'mph', torqueUnit: 'kgm' }), '1.0.0');
        assert.deepStrictEqual(vals, { redline: 6000, speedUnit: 'mph', torqueUnit: 'kgm' });
        const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        assert.deepStrictEqual(doc, { v: 1, app: 'car_profile', version: '1.0.0', values: vals });
        assert.strictEqual(fs.statSync(FILE).mode & 0o777, 0o644);
        fs.utimesSync(FILE, 1000, 1000);
        P.publish(fakeProfile({ redline: 6000, speedUnit: 'mph', torqueUnit: 'kgm' }), '1.0.0');
        assert.strictEqual(fs.statSync(FILE).mtime.getTime(), 1000 * 1000, 'unchanged: not written again');
        assert(!fs.readdirSync(dir).some((f) => /\.tmp$/.test(f)), 'no temp file left');
    },
    'no profile: each app its own values'() {
        clear();
        const s = settingsIn(SCHEMA, { speedUnit: 'mph', redline: 7000 });
        assert.strictEqual(s.get('speedUnit'), 'mph');
        assert.strictEqual(s.get('redline'), 7000);
        assert.strictEqual(s.held('speedUnit'), false);
    },
    'a profile: its values over the app\'s, kept for what it leaves out'() {
        clear();
        writeProfile({ speedUnit: 'kmh', redline: 6000, torqueUnit: 'kgm', distUnit: 'mi' });
        const s = settingsIn(SCHEMA, { speedUnit: 'mph', redline: 7000, theme: 'm_tricolour' });
        assert.strictEqual(s.get('speedUnit'), 'kmh');
        assert.strictEqual(s.get('redline'), 6000);
        assert.strictEqual(s.get('distUnit'), 'ft', 'profileMap: miles -> feet');
        assert.strictEqual(s.get('theme'), 'm_tricolour', 'a setting without "profile"');
        assert.strictEqual(s.values.speedUnit, 'mph', 'the app\'s own value kept');
        assert.strictEqual(s.display('redline'), '6000 rpm');
        assert.strictEqual(s.display('speedUnit'), 'km/h');
        assert.strictEqual(s.shown(SCHEMA[4]), true, '"when" goes by the profile\'s value (kgm)');
        assert.strictEqual(s.held('redline'), true);
    },
    'a value the setting can\'t take is left to the app'() {
        clear();
        writeProfile({ speedUnit: 'knots', redline: 'high', torqueUnit: 'lbft' });
        const s = settingsIn(SCHEMA, { speedUnit: 'mph', redline: 7000 });
        assert.strictEqual(s.get('speedUnit'), 'mph');
        assert.strictEqual(s.get('redline'), 7000);
        assert.strictEqual(s.get('torqueUnit'), 'nm', 'lb-ft is not among this app\'s options');
        assert.strictEqual(s.held('torqueUnit'), false);
    },
    'Auto (0) passes through as Auto'() {
        clear();
        writeProfile({ redline: 0 });
        const s = settingsIn(SCHEMA, { redline: 7000 });
        assert.strictEqual(s.get('redline'), 0);
        assert.strictEqual(s.display('redline'), 'Auto');
    },
    'held: not changed in the app'() {
        clear();
        writeProfile({ redline: 6000 });
        const s = settingsIn(SCHEMA, { redline: 7000 });
        s.cycle('redline');
        assert.strictEqual(s.values.redline, 7000, 'cycle does nothing while the profile sets it');
        s.cycle('speedUnit');
        assert.strictEqual(s.get('speedUnit'), 'mph', 'a setting the profile leaves out still changes');
    },
    'a change of the profile reaches the listeners; gone, the app\'s own values come back'() {
        clear();
        const s = settingsIn(SCHEMA, { redline: 7000, speedUnit: 'kmh' });
        const seen = [];
        s.onChange((k, v) => seen.push([k, v]));
        writeProfile({ redline: 6000 });
        s._pollProfile();
        assert.deepStrictEqual(seen, [['redline', 6000]]);
        s._pollProfile();
        assert.strictEqual(seen.length, 1, 'no change: no call');
        writeProfile({ redline: 6000, speedUnit: 'mph' });
        s._pollProfile();
        assert.deepStrictEqual(seen.slice(1), [['speedUnit', 'mph']]);
        clear();
        s._pollProfile();
        assert.deepStrictEqual(seen.slice(2), [['speedUnit', 'kmh'], ['redline', 7000]].sort((a, b) => (SCHEMA.findIndex((x) => x.key === a[0]) - SCHEMA.findIndex((x) => x.key === b[0]))));
        assert.strictEqual(s.get('redline'), 7000);
    },
    'a broken file is not taken (and looked at again)'() {
        clear();
        fs.writeFileSync(FILE, '{"v": 1, "values": {"redline": 60');
        const s = settingsIn(SCHEMA, { redline: 7000 });
        assert.strictEqual(s.get('redline'), 7000);
        writeProfile({ redline: 6000 });
        s._pollProfile();
        assert.strictEqual(s.get('redline'), 6000);
        fs.writeFileSync(FILE, JSON.stringify({ v: 2, values: { redline: 5000 } }));
        tick += 5; fs.utimesSync(FILE, tick, tick);
        s._pollProfile();
        assert.strictEqual(s.get('redline'), 7000, 'another format version: not followed');
    },
    'every app.json "profile" is one the Car profile sets, with values it can give'() {
        const cp = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'car_profile', 'app.json'), 'utf8'));
        const byKey = {};
        cp.settings.forEach((s) => { byKey[s.key] = s; });
        assert.deepStrictEqual(Object.keys(byKey).filter((k) => P.KEYS.indexOf(k) >= 0), P.KEYS, 'profile.js KEYS = the app\'s settings, in order');
        assert(cp.settings.every((s) => !s.profile), 'the Car profile follows no profile itself');
        assert(cp.settings.every((s) => (s.type === 'choice' ? s.default === 'app' : s.default === -1)), 'everything starts at Each app');
        let followers = 0;
        fs.readdirSync(path.join(ROOT, 'apps')).forEach((app) => {
            const f = path.join(ROOT, 'apps', app, 'app.json');
            if (!fs.existsSync(f) || app === 'car_profile') return;
            (JSON.parse(fs.readFileSync(f, 'utf8')).settings || []).filter((s) => s.profile).forEach((s) => {
                followers++;
                const p = byKey[s.profile];
                assert(p, app + '.' + s.key + ': no Car profile setting "' + s.profile + '"');
                if (s.type === 'choice') {
                    const own = s.options.map((o) => o[0]);
                    const given = p.options.map((o) => o[0]).filter((v) => v !== 'app').map((v) => (s.profileMap && s.profileMap[v] !== undefined ? s.profileMap[v] : v));
                    const lost = given.filter((v) => own.indexOf(v) < 0);
                    // a value the app can't show is left to the app (fromProfile), but every one should land
                    assert.deepStrictEqual(lost, [], app + '.' + s.key + ': the profile can give ' + lost.join(', ') + ', the app has no such option');
                } else assert.strictEqual(s.type, 'number', app + '.' + s.key);
            });
        });
        assert(followers >= 30, 'the apps follow it: ' + followers);
    },
};

let failed = 0;
for (const name of Object.keys(cases)) {
    try { cases[name](); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
}
fs.rmSync ? fs.rmSync(dir, { recursive: true, force: true }) : null;
console.log(failed ? failed + ' failed' : 'all passed');
process.exit(failed ? 1 : 0);
