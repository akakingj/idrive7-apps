'use strict';

// Car profile's page with a stubbed head unit: every row is a place for the iDrive controller and a tap, and pressed
// it opens that setting's values (kit/sheet.js) on the one set; a value chosen or Back brings the page back.
//   node kit/tools/test_car_profile_page.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const MAIN = path.join(ROOT, 'apps', 'car_profile', 'main.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'car_profile', 'app.json'), 'utf8'));
process.env.MGU_CAR_PROFILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-page-')), 'car-profile.json');
const { Recorder } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));
// the real Settings class without the SDK (as test_car_profile.js cuts it)
const src = fs.readFileSync(path.join(KIT, 'mgu.js'), 'utf8').replace(/\r\n/g, '\n');
const DD = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-page-data-'));
const Settings = new Function('fs', 'path', 'DATA_DIR', 'log', src.match(/class Settings[\s\S]*?\n}\n/)[0] + '\nreturn Settings;')(fs, path, DD, { info() {}, warn() {}, error() {} });

let app = null;
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run(a) { app = a; } };
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};

let n = 0;
const check = (name, fn) => fn().then(() => { n++; console.log('ok   ' + name); });

(async () => {
    require(MAIN);
    const settings = new Settings(SPEC.settings);
    let frame = null, last = null, sheet = null, opened = null;
    const log = { info() {}, warn(m) { throw new Error('warned: ' + m); }, error(m) { throw new Error('error: ' + m); } };
    settings.onChange = settings.onChange || (() => {});
    const ctx = {
        spec: SPEC, settings, log,
        ui: { image: async () => {}, open: async (s) => { opened = s; } },
        theme: () => themes.theme('m_tricolour'), loop: (name, fps, fn) => { frame = fn; },
        canvas: (w, h) => (last = new Recorder(w, h)),
        sheet: (sh) => { sheet = sh; return true; },
    };
    ctx.background = await app.background(ctx);
    await app.start(ctx);
    await frame();
    const targets = () => last.targets.filter((q) => /^row_/.test(q.key));

    await check('a place on the page for every setting, none overlapping', async () => {
        const t = targets();
        assert.deepStrictEqual(t.map((q) => q.key.slice(4)).sort(), SPEC.settings.map((s) => s.key).sort());
        t.forEach((a) => t.forEach((b) => {
            if (a === b) return;
            const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
            assert(apart, a.key + ' over ' + b.key);
        }));
        t.forEach((q) => assert(q.y >= 46 && q.y + q.h <= 520, q.key + ' on the page'));
    });
    await check('pressed: its values, on the one set; the knob and a press set the next and close', async () => {
        targets().find((q) => q.key === 'row_redline').run();
        assert(sheet && sheet.open && sheet.open.key === 'redline', 'the redline\'s values open');
        assert.strictEqual(sheet.sub, 0, 'on Each app');
        sheet.move(1); sheet.move(1);
        assert.strictEqual(await sheet.press(), 'close');
        assert.strictEqual(settings.get('redline'), 4000, 'Auto, then 4000');
        sheet.draw(new Recorder(1600, 520), themes.theme('m_tricolour'));
    });
    await check('Back: the page again, nothing changed', async () => {
        sheet = null;
        targets().find((q) => q.key === 'row_pressUnit').run();
        assert.strictEqual(sheet.open.key, 'pressUnit');
        sheet.move(-5);
        assert.strictEqual(await sheet.press(), 'close', 'Back (above the list) closes');
        assert.strictEqual(settings.get('pressUnit'), 'app');
        sheet = null;
        targets().find((q) => q.key === 'row_hotGearbox').run();
        assert.strictEqual(sheet.back(), 'close');
    });
    await check('a tap on a value: set, the page back', async () => {
        sheet = null;
        targets().find((q) => q.key === 'row_hotOil').run();
        const rows = sheet.draw(new Recorder(1600, 520), themes.theme('m_tricolour'));
        const row130 = rows.filter((q) => q.i !== undefined).find((q) => q.i === SPEC.settings.find((s) => s.key === 'hotOil').steps.indexOf(130));
        assert(row130, 'the 130 row on the sheet');
        assert.strictEqual(await row130.act(), 'close');
        assert.strictEqual(settings.get('hotOil'), 130);
        await frame();
    });
    await check('no sheet (another renderer): the HMI\'s settings', async () => {
        ctx.sheet = () => false;
        await targets().find((q) => q.key === 'row_engine').run();
        assert.strictEqual(opened, 'SETTINGS');
    });
    console.log(n + ' passed');
})().catch((e) => { console.error('FAIL ' + (e && e.stack || e)); process.exit(1); });
