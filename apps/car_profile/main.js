'use strict';
/**
 * Car profile - one place for the car's engine values and units, followed by the other apps.
 *
 * Settings: the engine (Auto / Diesel / Petrol), redline, rev scale, cold rev limit, the shift lights (shift point
 * or rev bar, and where the rev bar starts), when oil and coolant count as warm, and the speed, distance,
 * temperature, pressure, fuel use, torque and power units. Each one starts at "Each app": until it is set here, every
 * app keeps its own setting, so installing this app changes nothing.
 * What is set is written for the other apps (profile.js: /dev/shm/car-profile.json). Their kit follows it for the
 * settings that name it (app.json "profile") and shows those settings with the profile's value, not changeable there.
 * Uninstalled (or everything back on "Each app"), every app has its own settings again: from the next start of the
 * head unit, or at once with "Each app".
 * It runs from the platform's start (app.json "autostart"): the profile is there for the other apps without opening it.
 * Page: the three groups with each value and the apps that follow it.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const P = require('./profile');

const W = 1600, H = 520;
const GROUPS = [['Engine', 'Engine'], ['Warm-up', 'Warm-up'], ['Units', 'Units']];

async function background(bg) {
    const { settings, log, spec } = bg;
    const state = { at: 0, error: '' };
    const write = () => {
        try { P.publish(settings, spec.version, log); state.at = Date.now(); state.error = ''; } catch (e) { state.error = String(e && e.message || e); log.warn('car profile: ' + state.error); }
    };
    write();
    settings.onChange((key) => { if (P.KEYS.indexOf(key) >= 0) write(); });
    // written again should it be gone (another start of the head unit's tmpfs, a hand cleaning /dev/shm)
    const timer = setInterval(write, 30000);
    if (timer.unref) timer.unref();
    return { state, write };
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings } = ctx;
        const { state } = ctx.background || await background(ctx);
        const items = (ctx.spec.settings || []).filter((s) => P.KEYS.indexOf(s.key) >= 0);

        function row(cv, t, x, y, w, s) {
            const v = settings.get(s.key), on = P.isSet(v);
            cv.text(s.label, x, y + 20, 21, t.text);
            cv.text(settings.display(s.key), x + w, y + 20, 23, on ? (t.sel || t.accent) : t.dim, { align: 'right', font: 'bold' });
            const who = (P.FOLLOW[s.key] || []).join(', ');
            if (who) cv.text(who, x, y + 42, 15, on ? t.dim : withAlpha(t.dim, 0.55));
            cv.fillRect(x, y + 51, w, 1, withAlpha(t.tick || t.dim, 0.25));
        }

        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const gap = 16, pw = Math.floor((W - gap * 4) / 3), top = G.TOP + 4;
            GROUPS.forEach(([group, title], i) => {
                const x = gap + i * (pw + gap), rows = items.filter((s) => s.group === group);
                const h = group === 'Warm-up' ? 66 + rows.length * 56 : G.pageBottom(cv) - top - 8;
                const p = G.panel(cv, t, x, top, pw, h, title);
                rows.forEach((s, j) => row(cv, t, p.x + 22, p.y + 58 + j * 56, p.w - 44, s));
                if (group === 'Warm-up') {
                    // how it works, and whether the other apps have it
                    const y0 = p.y + p.h + 16, q = G.panel(cv, t, x, y0, pw, G.pageBottom(cv) - y0 - 8, 'Profile');
                    const lines = ['Set here: the apps listed follow it', 'Each app: the app keeps its own setting'];
                    lines.forEach((l, k) => cv.text(l, q.x + 22, q.y + 76 + k * 32, 19, t.text));
                    // (each text drawn on its own: translated whole, the number and the error beside it)
                    const n = Object.keys(P.valuesOf(settings)).length, ys = q.y + 76 + lines.length * 32 + 12;
                    const st = state.error ? 'Not written for the apps' : n ? 'Set for the apps' : 'Nothing set: each app as it is';
                    const sw = cv.text(st, q.x + 22, ys, 21, state.error ? t.crit : n ? (t.sel || t.accent) : t.dim, { font: 'bold' });
                    if (state.error) cv.text(state.error.slice(0, 60), q.x + 22, ys + 30, 16, t.dim);
                    else if (n) cv.text(String(n), q.x + 36 + sw, ys, 21, t.sel || t.accent, { font: 'bold' });
                }
            });
            G.frame(cv, t, ['Car profile'], 0, []);
            return ui.image('MAIN_GFX', cv);
        }

        settings.onChange(() => render());
        ctx.loop('MAIN', 2, render);
        render().then(() => ctx.log.info('first frame done')).catch((e) => ctx.log.warn('first render: ' + e));
    },
});
