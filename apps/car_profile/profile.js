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
const KEYS = ['engine', 'redline', 'shiftBefore', 'rpmScale', 'coldLimit', 'lightMode', 'lightStart', 'coldGuard', 'warmOil',
    'warmCoolant', 'hotOil', 'hotCoolant', 'hotGearbox', 'speedUnit', 'distUnit', 'tempUnit', 'pressUnit', 'fuelUnit', 'torqueUnit', 'powerUnit'];
const FOLLOW = {
    engine: ['M Vitals', 'Redline', 'Warm-Up', 'Virtual Dyno'],
    redline: ['M Vitals', 'Redline', 'Warm-Up', 'AK Cluster'],
    shiftBefore: ['Redline', 'Warm-Up', 'AK Cluster'],
    rpmScale: ['M Vitals', 'Redline', 'Virtual Dyno', 'AK Cluster'],
    coldLimit: ['Redline', 'Warm-Up', 'AK Cluster'],
    lightMode: ['Redline'],
    lightStart: ['Redline', 'AK Cluster Centre'],
    coldGuard: ['Redline', 'Warm-Up', 'AK Cluster'],
    warmOil: ['Redline', 'Warm-Up', 'AK Cluster'],
    warmCoolant: ['Warm-Up'],
    // too hot (red) from: each one at that temperature and above
    hotOil: ['M Vitals', 'Redline', 'Warm-Up', 'AK Cluster'],
    hotCoolant: ['M Vitals', 'Redline', 'AK Cluster'],
    hotGearbox: ['M Vitals', 'Redline', 'Warm-Up', 'AK Cluster'],
    speedUnit: ['M Vitals', 'Redline', 'Drag Timer', 'Brake Test', 'G-Force', 'AK Cluster'],
    distUnit: ['Brake Test', 'eDrive'],
    tempUnit: ['M Vitals', 'Redline HUD', 'Warm-Up', 'eDrive', 'Transmission Config', 'AK Cluster'],
    pressUnit: ['M Vitals', 'Redline HUD', 'Live Data', 'AK Cluster'],
    fuelUnit: ['Redline HUD'],
    torqueUnit: ['M Vitals', 'Redline HUD', 'Virtual Dyno', 'AK Cluster'],
    powerUnit: ['M Vitals', 'Redline HUD', 'Virtual Dyno', 'AK Cluster'],
};
// ('AK Cluster': the cluster apps of akakingj/idrive7-cluster-info, Layouts / Centre / Info, which read this file too)

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
