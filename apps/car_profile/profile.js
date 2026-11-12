'use strict';
/**
 * profile.js - the Car profile as the other apps read it: /dev/shm/car-profile.json
 *
 *   { "v": 1, "app": "car_profile", "version": "1.0.0", "values": { "redline": 6000, "speedUnit": "kmh", ... } }
 *
 * Only what is set is in it: a value left to each app ("app", -1) is not. The kit's settings (mgu.js Settings)
 * follow it for a setting with "profile": name in an app's app.json, over the app's own value, which they keep for
 * whatever the profile leaves out. Written whole (a temp file renamed over it) and readable by every app (0644): the
 * apps run as users of their own and can't read each other's data folders. /dev/shm is emptied at each start of the
 * head unit, so the app (app.json "autostart") writes it again from its own settings at each start.
 */
const fs = require('fs');

// what the profile sets, in Settings order; FOLLOW: the apps that follow each (their app.json "profile")
const KEYS = ['engine', 'redline', 'rpmScale', 'coldLimit', 'lightMode', 'lightStart', 'warmOil', 'warmCoolant',
    'speedUnit', 'distUnit', 'tempUnit', 'pressUnit', 'fuelUnit', 'torqueUnit', 'powerUnit'];
const FOLLOW = {
    engine: ['M Vitals', 'Redline', 'Warm-Up', 'Virtual Dyno'],
    redline: ['M Vitals', 'Redline', 'Warm-Up'],
    rpmScale: ['M Vitals', 'Redline', 'Virtual Dyno'],
    coldLimit: ['Redline', 'Warm-Up'],
    lightMode: ['Redline'],
    lightStart: ['Redline'],
    warmOil: ['Redline', 'Warm-Up'],
    warmCoolant: ['Warm-Up'],
    speedUnit: ['M Vitals', 'Redline', 'Drag Timer', 'Brake Test', 'G-Force'],
    distUnit: ['Brake Test', 'eDrive'],
    tempUnit: ['M Vitals', 'Redline HUD', 'Warm-Up', 'eDrive', 'Transmission Config'],
    pressUnit: ['M Vitals', 'Redline HUD'],
    fuelUnit: ['Redline HUD'],
    torqueUnit: ['M Vitals', 'Redline HUD', 'Virtual Dyno'],
    powerUnit: ['M Vitals', 'Redline HUD', 'Virtual Dyno'],
};

const file = () => process.env.MGU_CAR_PROFILE || '/dev/shm/car-profile.json';
const isSet = (v) => v !== undefined && v !== null && v !== 'app' && v !== -1;

/** The values the profile sets now: { key: value } for each one not left to each app. */
function valuesOf(settings) {
    const o = {};
    KEYS.forEach((k) => { const v = settings.get(k); if (isSet(v)) o[k] = v; });
    return o;
}

/** Write the profile from settings when it differs from the file (or there is none). Returns the values. */
function publish(settings, version, log) {
    const f = file(), values = valuesOf(settings);
    const text = JSON.stringify({ v: 1, app: 'car_profile', version: version || '', values }, null, 1);
    try { if (fs.readFileSync(f, 'utf8') === text) return values; } catch (e) { /* none yet */ }
    const tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text, { mode: 0o644 });
    try { fs.chmodSync(tmp, 0o644); } catch (e) { /* the mode given above */ }
    fs.renameSync(tmp, f);
    if (log) log.info('car profile written: ' + JSON.stringify(values));
    return values;
}

module.exports = { KEYS, FOLLOW, file, isSet, valuesOf, publish };
