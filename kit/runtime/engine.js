'use strict';
/**
 * engine.js - diesel / petrol profile: rpm scale top and default redline.
 *
 *   const engine = new Engine({ settings, dataDir: ctx.dataDir, log });
 *   // merge into the app's Vehicle2 watch (one proxy per interface):
 *   watches[Engine.SIGNAL[0]] = Object.assign({}, watches[Engine.SIGNAL[0]], engine.handlers());
 *   engine.scaleMax()  -> setting "rpmScale" (0 = Auto: follows the redline, redline + 800 rounded up
 *                         to 1000, as before the profiles: 7000 -> 8000, 6000 -> 7000, 5000 -> 6000)
 *   engine.redline()   -> setting "redline" (0 = Auto: the profile's), never above scaleMax()
 *   engine.value('coldLimit', { diesel: 3000, petrol: 4500 })  -> the setting, or per profile when 0
 *   engine.coldLimit()  -> setting "coldLimit" (0 = Auto: diesel 3000, petrol 4500): the shift point with the oil at 30 °C
 *   Engine.coldShift(normal, cold, oil, warm, guard) -> { rpm, cold }: the shift point now, lowered while the oil is cold
 *                       (Redline's; Warm-Up's rev limit while cold and the AK Cluster apps' the same)
 *
 * The profile comes from setting "engine" (auto / diesel / petrol). Auto reads typeEngine from
 * Vehicle2.statusVehiclePartType; the last valid type is kept in data/engine.json so the first
 * frames after a start already use it. Nothing known = petrol. "No value" never clears it.
 */
const fs = require('fs');
const path = require('path');

/** Write a file whole or not at all: a temp file renamed over it (a reader or a power cut never sees half). */
function writeWhole(file, text) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

// scaleMax = the Auto scale for the profile's own redline (see scaleMax()); coldLimit: the shift point with the oil at
// 30 °C (Redline's, and Warm-Up's rev limit then: one value for every app, the Car profile's Cold rev limit on Auto)
const PROFILES = { diesel: { scaleMax: 6000, redline: 5000, coldLimit: 3000 }, petrol: { scaleMax: 8000, redline: 7000, coldLimit: 4500 } };
// VehicleTypes.TypeEngine, by name or wire number; 0 (no information) / 15 (invalid) = unknown
const TYPES = {
    4: 'petrol', 5: 'petrol', 6: 'diesel', 7: 'diesel', 8: 'petrol', 9: 'petrol',
    BENZIN_DIREKTEINSPRITZUNG: 'petrol', BENZIN_KONVENTIONELL: 'petrol', DIESEL_DIREKTEINSPRITZUNG: 'diesel',
    DIESEL_KONVENTIONELL: 'diesel', ELEKTROMOTOR: 'petrol', HYBRIDMOTOR: 'petrol',
};
const typeOf = (raw) => (raw !== undefined && raw !== null && Object.prototype.hasOwnProperty.call(TYPES, raw) ? TYPES[raw] : null);

class Engine {
    constructor(opts) {
        this.settings = opts.settings; this.log = opts.log;
        this.file = path.join(opts.dataDir, 'engine.json');
        this.listeners = []; this.logged = false;
        this.type = null;
        try { const t = JSON.parse(fs.readFileSync(this.file, 'utf8')).type; this.type = t === 'diesel' || t === 'petrol' ? t : null; } catch (e) { /* not yet */ }
        this.last = this.profile();
        if (this.settings.onChange) this.settings.onChange((key) => { if (key === 'engine' || key === 'redline' || key === 'rpmScale') this._changed(true); });
    }
    /** statusVehiclePartType value. */
    feed(v) {
        const raw = v ? v.typeEngine : undefined, t = typeOf(raw);
        if (!this.logged) { this.logged = true; if (this.log) this.log.info('engine type: ' + JSON.stringify(raw) + ' -> ' + (t || 'unknown')); }
        if (!t || t === this.type) return;
        this.type = t;
        try { writeWhole(this.file, JSON.stringify({ type: t })); } catch (e) { if (this.log) this.log.warn('engine save: ' + e); }
        this._changed(false);
    }
    handlers() { return { statusVehiclePartType: (v) => this.feed(v) }; }
    detected() { return this.type; }
    profile() {
        const s = this.settings.get('engine');
        return s === 'diesel' || s === 'petrol' ? s : this.type || 'petrol';
    }
    /** Rev scale top: the "rpmScale" setting, or on Auto the redline + 800 rpm of red zone, rounded up to 1000. */
    scaleMax() {
        const s = this.settings.get('rpmScale');
        if (typeof s === 'number' && s > 0) return s;
        return Math.ceil((this._redline() + 800) / 1000) * 1000;
    }
    value(key, perProfile) {
        const v = this.settings.get(key);
        return typeof v === 'number' && v !== 0 ? v : perProfile[this.profile()];
    }
    _redline() { return this.value('redline', { diesel: PROFILES.diesel.redline, petrol: PROFILES.petrol.redline }); }
    /** The shift point with the oil at 30 °C: setting "coldLimit", on Auto the profile's (diesel 3000, petrol 4500). */
    coldLimit() { return this.value('coldLimit', { diesel: PROFILES.diesel.coldLimit, petrol: PROFILES.petrol.coldLimit }); }
    redline() { return Math.min(this._redline(), this.scaleMax()); }
    onChange(fn) { this.listeners.push(fn); }
    _changed(always) {
        const p = this.profile();
        if (!always && p === this.last) return;
        this.last = p;
        this.listeners.forEach((fn) => { try { fn(); } catch (e) { if (this.log) this.log.error(e); } });
    }
}
/**
 * The shift point now: `normal` (the warm one), with the guard on pulled down while the oil is under `warm`, from `cold`
 * (never above normal) with the oil at 30 °C rising in a straight line to normal at `warm`, to 50 rpm. Redline's shift
 * point (setting "coldGuard"); Warm-Up shows it as its rev limit while cold; the AK Cluster apps (idrive7-cluster-info)
 * work it the same way. -> { rpm, cold } (cold: lowered now).
 */
Engine.coldShift = (normal, cold, oil, warm, guard) => {
    const ok = (v) => typeof v === 'number' && isFinite(v);
    if (!guard || !ok(oil) || !ok(warm) || oil >= warm) return { rpm: normal, cold: false };
    const c = Math.min(ok(cold) ? cold : normal, normal), f = Math.max(0, Math.min(1, (oil - 30) / Math.max(1, warm - 30)));
    return { rpm: Math.round((c + (normal - c) * f) / 50) * 50, cold: true };
};
Engine.SIGNAL = ['de.bmw.infotainment.vehicle.Vehicle2', 'statusVehiclePartType'];
Engine.PROFILES = PROFILES;
Engine.typeOf = typeOf;

module.exports = Engine;
