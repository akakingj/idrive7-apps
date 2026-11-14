'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * Boost and intake air from the engine unit (DME, 0x12), for the HUD: read on the gearbox reader's link, only
 * while a readout wants them and the engine runs (hud.js starts and stops it). The same candidates as M Vitals'
 * (car_vitals app.json config.dme), the first that answers wins (DidReader remembers it):
 *   boost: absolute pressure, kPa - 22 F470 (PID 0x70 actual, sensor A), 22 F487 (PID 0x87 manifold),
 *          22 F40B / OBD 01 0B (manifold, to 255 kPa); the outside air pressure taken off (22 F433 / OBD 01 33,
 *          read once a minute, 101.3 kPa until then): bar over atmosphere, as the sport display's boost
 *   iat:   intake air, deg C - 22 F40F, 22 F477 (charge air cooler), OBD 01 0F
 * Boost is read every 0.5 s, the intake air every 3 s. A value no candidate gives three times in a row is asked
 * again only once a minute. Never throws; value() is { boost (bar, null when not read in the last 2 s), iat
 * (deg C, null when not read in the last 10 s) }.
 */
const { DidReader } = require('./kit/dids');

const TICK_MS = 250, BOOST_MS = 500, IAT_MS = 3000, BARO_MS = 60000, FAIL_RETRY_MS = 60000;
const STALE = { boost: 2000, iat: 10000 };
const BARO_DEFAULT = 101.3;

const CANDS = {
    boost: [
        { ecu: 0x12, did: 'F470', bytes: 2, at: 3, factor: 0.03125, offset: 0, min: 20, max: 600 },
        { ecu: 0x12, did: 'F487', bytes: 2, at: 1, factor: 0.03125, offset: 0, min: 20, max: 600 },
        { ecu: 0x12, did: 'F40B', bytes: 1, at: 0, factor: 1, offset: 0, min: 20, max: 255 },
        { ecu: 0x12, obd: '0B', bytes: 1, at: 0, factor: 1, offset: 0, min: 20, max: 255 },
    ],
    baro: [
        { ecu: 0x12, did: 'F433', bytes: 1, at: 0, factor: 1, offset: 0, min: 50, max: 115 },
        { ecu: 0x12, obd: '33', bytes: 1, at: 0, factor: 1, offset: 0, min: 50, max: 115 },
    ],
    iat: [
        { ecu: 0x12, did: 'F40F', bytes: 1, at: 0, factor: 1, offset: -40, min: -40, max: 150 },
        { ecu: 0x12, did: 'F477', bytes: 1, at: 1, factor: 1, offset: -40, min: -40, max: 150 },
        { ecu: 0x12, obd: '0F', bytes: 1, at: 0, factor: 1, offset: -40, min: -40, max: 150 },
    ],
};
const EVERY = { boost: BOOST_MS, iat: IAT_MS, baro: BARO_MS };

class IntakeWatch {
    /** linkOf: () => a ReadOnlyDiag (the gearbox reader's, shared). */
    constructor(ctx, linkOf) {
        this.ctx = ctx; this.log = ctx.log; this.linkOf = linkOf;
        this.rd = null; this.timer = null; this.busy = false;
        this.want = { boost: false, iat: false };
        this.baro = BARO_DEFAULT;
        this.v = { boost: null, iat: null };
        this.t = { boost: 0, iat: 0 };
        this.asked = { boost: 0, iat: 0, baro: 0 };
        this.fails = { boost: 0, iat: 0, baro: 0 };
        this.logged = {};
    }

    /** want: { boost, iat } - what to read; neither stops it. */
    start(want) {
        const w = { boost: !!(want && want.boost), iat: !!(want && want.iat) };
        this.want = w;
        if (!w.boost && !w.iat) { this.stop(); return; }
        if (this.timer) return;
        try {
            if (!this.rd) this.rd = new DidReader(this.linkOf(), { ecu: 0x12 });
            this._wake();             // a new start (the engine on again): asked even if the link gave up on it
            this.timer = setInterval(() => this._poll(), TICK_MS);
            this._poll();
        } catch (e) { this.log.warn('intake: ' + (e && e.message || e)); }
    }

    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

    /** The link stops asking a unit after 5 misses in a row (other readers count too) until it is woken. */
    _wake() { const l = this.rd && this.rd.diag; if (l && typeof l.wake === 'function') { try { l.wake(0x12); } catch (e) { /* never */ } } }

    /** The value read next, or null: the boost first (fast), the outside air pressure once a minute with it, the intake air. */
    _next(now) {
        const due = (k) => {
            if (this.fails[k] >= 3) return now - this.asked[k] >= FAIL_RETRY_MS;
            return now - this.asked[k] >= EVERY[k];
        };
        if (this.want.boost && due('baro') && this.fails.boost < 3) return 'baro';
        if (this.want.boost && due('boost')) return 'boost';
        if (this.want.iat && due('iat')) return 'iat';
        return null;
    }

    _poll() {
        if (this.busy || !this.rd) return;
        // the shared link not up yet: not a failed read
        const link = this.rd.diag;
        if (link && (link.ready === false || link.available === false)) return;
        const now = Date.now(), k = this._next(now);
        if (!k) return;
        if (this.fails[k] >= 3) this._wake();      // the once-a-minute try really asks it
        this.asked[k] = now;
        this.busy = true;
        Promise.resolve().then(() => this.rd.value(k, CANDS[k])).then((v) => {
            if (v === null) {
                if (++this.fails[k] === 3) this.log.info('intake: the engine unit gives no ' + k + ' (' + CANDS[k].map(DidReader.label).join(', ') + ')');
                return;
            }
            this.fails[k] = 0;
            if (!this.logged[k]) { this.logged[k] = true; this.log.info('intake: ' + k + ' read from the engine unit (' + DidReader.label(CANDS[k][this.rd.pick[k] || 0]) + '), ' + v.toFixed(1)); }
            if (k === 'baro') { this.baro = v; return; }
            // boost: bar over the outside air (under it, on a closed throttle: below 0)
            this.v[k] = k === 'boost' ? (v - this.baro) / 100 : v;
            this.t[k] = Date.now();
        }).catch((e) => { this.fails[k]++; this.log.warn('intake: ' + (e && e.message || e)); })
            .then(() => { this.busy = false; });
    }

    /** { boost (bar over atmosphere), iat (deg C) }: null when stale or never read. */
    value() {
        const now = Date.now(), f = (k) => (this.v[k] !== null && this.t[k] > 0 && now - this.t[k] <= STALE[k] ? this.v[k] : null);
        return { boost: f('boost'), iat: f('iat') };
    }
}

module.exports = IntakeWatch;
module.exports.IntakeWatch = IntakeWatch;
module.exports.CANDS = CANDS;
