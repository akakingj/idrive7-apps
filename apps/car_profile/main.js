'use strict';
/**
 * Car profile - one place for the car's engine values and units, followed by the other apps.
 *
 * Settings: the engine (Auto / Diesel / Petrol), redline, rev scale, cold rev limit, the shift lights (shift point
 * or rev bar, and where the rev bar starts), when oil and coolant count as warm, when oil, coolant and gearbox count
 * as too hot (red), and the speed, distance,
 * temperature, pressure, fuel use, torque and power units. Each one starts at "Each app": until it is set here, every
 * app keeps its own setting, so installing this app changes nothing.
 * What is set is written for the other apps (profile.js: /dev/shm/car-profile.json). Their kit follows it for the
 * settings that name it (app.json "profile") and shows those settings with the profile's value, not changeable there.
 * Uninstalled (or everything back on "Each app"), every app has its own settings again: from the next start of the
 * head unit, or at once with "Each app".
 * It runs from the platform's start (app.json "autostart"): the profile is there for the other apps without opening it.
 * Page: the groups with each value and the apps that follow it; in the header, whether anything is set for them.
 * Each row is a place for the iDrive controller and a tap: pressed, its values' list (kit/sheet.js) over the page.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const P = require('./profile');
const { listSheet } = require('./kit/sheet');

const W = 1600, H = 520;

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

        /**
         * A row pressed (the iDrive controller or a tap): its values' list over the page, the one set marked; a
         * value chosen, or Back, and the page is back. Where the kit can't draw it (another renderer): the HMI's
         * settings.
         */
        function edit(s) {
            const sh = listSheet(settings, null, { version: ctx.spec.version });
            const own = settings.schema.find((x) => x.key === s.key) || s;
            const vals = own.type === 'choice' ? (own.options || []).map((o) => o[0]) : own.steps || [];
            sh.settings = true;
            sh.group = own.group || null;
            sh.focus = Math.max(0, settings.schema.filter((x) => (x.group || null) === sh.group && (!settings.shown || settings.shown(x))).findIndex((x) => x.key === own.key));
            sh.open = own;
            sh.sub = Math.max(0, vals.indexOf(settings.get(own.key)));
            sh.controller = true;
            let direct = true;      // opened from the page: done with this one value
            const choose = sh.choose, back = sh.back;
            sh.choose = function () { const was = direct && !!this.open; const r = choose.call(this); return was ? 'close' : r; };
            sh.back = function () { if (direct && this.open && !this.child) return 'close'; direct = false; return back.call(this); };
            sh.onClose = () => render();
            if (ctx.sheet && ctx.sheet(sh)) return null;
            return ui.open('SETTINGS');
        }

        function row(cv, t, x, y, w, s, pitch) {
            const v = settings.get(s.key), on = P.isSet(v);
            // the whole row: the controller's place (in order down the columns) and a tap
            cv.target(x - 12, y - 2, w + 24, Math.min(50, pitch - 4), () => edit(s), 'row_' + s.key, 8);
            cv.text(s.label, x, y + 20, 21, t.text);
            cv.text(settings.display(s.key), x + w, y + 20, 23, on ? (t.sel || t.accent) : t.dim, { align: 'right', font: 'bold' });
            const who = (P.FOLLOW[s.key] || []).join(', ');
            if (who) cv.text(who, x, y + 42, 15, on ? t.dim : withAlpha(t.dim, 0.55));
            cv.fillRect(x, y + 51, w, 1, withAlpha(t.tick || t.dim, 0.25));
        }

        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const gap = 16, pw = Math.floor((W - gap * 4) / 3), top = G.TOP + 4, bottom = G.pageBottom(cv) - 8;
            const group = (g) => items.filter((s) => s.group === g);
            const column = (i, panels) => {
                // each panel's rows 56 apart, 52 where two share a column; the last panel down to the page's bottom
                const x = gap + i * (pw + gap), pitch = panels.length > 1 ? 52 : 56;
                let y = top;
                panels.forEach(([g, title], k) => {
                    // (a panel of more than one group: their rows one after the other)
                    const rows = [].concat.apply([], [].concat(g).map(group)), last = k === panels.length - 1;
                    const p = G.panel(cv, t, x, y, pw, last ? bottom - y : 64 + rows.length * pitch, title);
                    rows.forEach((s, j) => row(cv, t, p.x + 22, p.y + 58 + j * pitch, p.w - 44, s, pitch));
                    y = p.y + p.h + gap;
                });
            };
            column(0, [['Engine', 'Engine']]);
            // warm-up and too hot in one panel: seven rows as the other columns (with the gearbox oil's warm-up, two panels
            // of four and three no longer fit the page)
            column(1, [[['Warm-up', 'Too hot'], 'Warm-up and too hot']]);
            column(2, [['Units', 'Units']]);
            // whether the other apps have it, in the header (each text translated whole)
            const n = Object.keys(P.valuesOf(settings)).length;
            const badge = state.error ? { text: 'Not written for the apps', color: 'crit' }
                : n ? { text: 'Set for the apps', color: t.sel || t.accent } : { text: 'Nothing set: each app as it is', color: t.dim };
            G.frame(cv, t, ['Car profile'], 0, [badge]);
            return ui.image('MAIN_GFX', cv);
        }

        settings.onChange(() => render());
        ctx.loop('MAIN', 2, render);
        render().then(() => ctx.log.info('first frame done')).catch((e) => ctx.log.warn('first render: ' + e));
    },
});
