'use strict';
/**
 * Storage - how full the head unit is.
 *
 *   Disks  each file system the unit has (from its own `df`): free / used / size, a bar coloured
 *          by how full it is; the one the apps are installed on is marked APPS. On the right:
 *          free space for apps and the memory (RAM) in use.
 *   Apps   with the Storage helper (kit/storage-helper, a root service from the MGU Store): BMW's own apps and
 *          the custom apps side by side, each with the space it takes and the total, and the custom tools' folders
 *          in /var/opt; "Refresh" asks the helper to measure again. Without it: this app's own folder (every app
 *          runs as its own user and can't open the others'), and where to get the helper.
 *
 * Read-only: the app deletes and changes nothing.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const S = require('./sysinfo');

const W = 1600, H = 520;
const PAGES = ['disks', 'apps'];
const TABS = ['Disks', 'Apps'];
const DISK_MS = 10000;               // df again this often while the screen is shown

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;

        // the folder every app is installed in (/var/opt/public/oap/oap_<uid>/data is our dataDir);
        // STORAGE_OAP_ROOT points it elsewhere for a test on a PC
        const m = /^(.*\/oap)\/(oap_\d+)(\/|$)/.exec(ctx.dataDir || '');
        const ROOT = process.env.STORAGE_OAP_ROOT || (m ? m[1] : '/var/opt/public/oap');
        const OWN = m ? m[2] : null;

        /* ---------- data ---------- */
        let disks = { list: [], how: '', error: '', t: 0 }, mem = null, up = null, diskBusy = false;
        async function readDisks() {
            if (diskBusy) return;
            diskBusy = true;
            try {
                const r = await S.fileSystems();
                if (r.error && !disks.t) log.warn(r.error);
                if (!disks.t && r.list.length) log.info('file systems (' + r.how + '): ' + r.list.map((x) => x.mount + ' ' + x.type + ' ' + Math.round(x.size / 1048576) + 'M').join(', '));
                disks = Object.assign(r, { t: Date.now() });
            } catch (e) { log.warn('df: ' + e); }
            mem = S.memory(); up = S.uptime();
            diskBusy = false;
        }
        readDisks();

        let apps = { list: [], error: '', scanning: false, done: 0, total: 0, t: 0 };
        async function scanApps() {
            if (apps.scanning) return;
            apps = Object.assign({}, apps, { scanning: true, done: 0, total: 0 });
            const t0 = Date.now();
            try {
                const r = await S.appFolders(ROOT, (done, total) => { apps.done = done; apps.total = total; });
                apps = { list: r.list, error: r.error, scanning: false, done: apps.total, total: apps.total, t: Date.now() };
                log.info('app folders: ' + r.list.length + ' in ' + (Date.now() - t0) + ' ms' + (r.error ? ' (' + r.error + ')' : ''));
            } catch (e) {
                apps = Object.assign({}, apps, { scanning: false, error: String(e) });
                log.warn('app scan: ' + e);
            }
        }

        /* ---------- formatting ---------- */
        const base = () => (settings.get('units') === 'dec' ? 1000 : 1024);
        /** [number text, unit] for a size in bytes. */
        function size(b) {
            if (!G.isNum(b)) return ['--', ''];
            if (b === 0) return ['0', 'KB'];
            const k = base(), u = [['GB', k * k * k], ['MB', k * k], ['KB', k]];
            for (const [name, f] of u) {
                if (b >= f * 0.95 || name === 'KB') {
                    const v = b / f;
                    return [v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2), name];
                }
            }
            return [String(b), 'B'];
        }
        const sz = (b) => size(b).join(' ');
        const pct = (a, b) => (b ? a / b * 100 : 0);
        const fullCol = (t, p, ro) => (ro ? t.dim : p >= 90 ? t.crit : p >= 75 ? t.warn : t.accent);
        const fit = (cv, s, px, w, font) => {
            if (cv.textWidth(s, px, { font }) <= w) return s;
            while (s.length > 4 && cv.textWidth(s + '...', px, { font }) > w) s = s.slice(0, -1);
            return s + '...';
        };

        /** File systems to show: the apps' one first, then writable ones by size, read-only ones last. */
        function shown() {
            const appFs = S.fsOf(disks.list, ROOT);
            const list = disks.list.filter((r) => r === appFs || ((settings.get('showRam') || !S.RAM.has(r.type)) && (settings.get('showRo') || !r.ro)));
            list.sort((a, b) => (b === appFs) - (a === appFs) || a.ro - b.ro || b.size - a.size);
            return { list, appFs };
        }

        /* ---------- drawing ---------- */
        let page = Math.max(0, PAGES.indexOf(settings.get('page')));
        let lastDraw = 0;

        function bar(cv, t, x, y, w, h, frac, color) {
            cv.roundRect(x, y, w, h, Math.min(4, h / 2), t.track);
            const f = Math.max(0, Math.min(1, frac));
            if (f * w > 2) cv.roundRect(x, y, Math.max(h, f * w), h, Math.min(4, h / 2), color);
        }

        function drawDisks(cv, t) {
            const bottom = G.BOTTOM, { list, appFs } = shown();
            const L = G.panel(cv, t, 24, G.TOP, 1060, bottom - G.TOP, 'File systems');
            const rowH = 74, top = G.TOP + 62, fitRows = Math.max(1, Math.floor((L.h - 70) / rowH));
            if (!list.length) {
                cv.text(disks.t ? (disks.error || 'No file systems found') : 'Reading...', 48, top + 40, 24, disks.error ? t.warn : t.dim);
            }
            const rows = list.length > fitRows ? list.slice(0, fitRows - 1) : list;
            rows.forEach((r, i) => {
                const y = top + i * rowH, p = pct(r.used, r.size), c = fullCol(t, p, r.ro);
                let nx = 48;
                const name = r.mount === '/' ? '/  (system)' : r.mount;
                nx += cv.text(fit(cv, name, 24, 470, 'bold'), nx, y + 24, 24, t.text, { font: 'bold' }) + 14;
                if (r === appFs) nx += G.pill(cv, t, nx, y + 2, 78, 28, 'APPS', { size: 16 }) + 10;
                if (r.ro) G.pill(cv, t, nx, y + 2, 120, 28, 'READ-ONLY', { size: 16, color: 'dim' });
                // free on the right, used / size under it
                cv.text(sz(r.avail) + ' free', 1060, y + 24, 24, r.ro ? t.dim : t.text, { align: 'right', font: 'bold' });
                cv.text(sz(r.used) + ' of ' + sz(r.size) + '  ·  ' + p.toFixed(0) + '%', 1060, y + 52, 18, t.dim, { align: 'right' });
                const extra = [r.type, r.dev.length < 40 ? r.dev : '', r.alsoAt.length ? 'also at ' + r.alsoAt.length + ' other path' + (r.alsoAt.length > 1 ? 's' : '') : ''].filter(Boolean).join('  ·  ');
                cv.text(fit(cv, extra, 18, 560, 'label'), 48, y + 52, 18, t.dim);
                bar(cv, t, 48, y + 62, 1012, 6, p / 100, c);
            });
            if (list.length > rows.length) {
                const rest = list.slice(rows.length);
                cv.text('+ ' + rest.length + ' more: ' + rest.map((r) => r.mount).join(', '), 48, top + rows.length * rowH + 28, 20, t.dim);
            }

            // right: free for apps, memory
            const x = 1108, w = 468, gap = 16, th = (bottom - G.TOP - gap) / 2;
            G.panel(cv, t, x, G.TOP, w, th, 'Free for apps');
            if (appFs) {
                const [n, u] = size(appFs.avail), p = pct(appFs.used, appFs.size);
                const vw = cv.text(n, x + 24, G.TOP + 150, 96, p >= 90 ? t.crit : t.text, { font: 'num' });
                cv.text(u, x + 34 + vw, G.TOP + 150, 30, t.dim);
                bar(cv, t, x + 24, G.TOP + 170, w - 48, 10, p / 100, fullCol(t, p, false));
                cv.text('of ' + sz(appFs.size) + '  ·  ' + p.toFixed(0) + '% used  ·  ' + appFs.mount, x + 24, G.TOP + th - 16, 20, t.dim);
            } else cv.text(disks.t ? 'not found (' + ROOT + ')' : 'Reading...', x + 24, G.TOP + 120, 22, t.dim);

            const my = G.TOP + th + gap;
            G.panel(cv, t, x, my, w, th, 'Memory (RAM)');
            if (mem) {
                const [n, u] = size(mem.avail), p = pct(mem.used, mem.total);
                const vw = cv.text(n, x + 24, my + 150, 96, p >= 90 ? t.crit : t.text, { font: 'num' });
                cv.text(u + ' free', x + 34 + vw, my + 150, 30, t.dim);
                bar(cv, t, x + 24, my + 170, w - 48, 10, p / 100, fullCol(t, p, false));
                const upTxt = G.isNum(up) ? '  ·  up ' + (up >= 86400 ? Math.floor(up / 86400) + 'd ' : '') + Math.floor(up % 86400 / 3600) + 'h ' + Math.floor(up % 3600 / 60) + 'm' : '';
                cv.text('used ' + sz(mem.used) + ' of ' + sz(mem.total) + upTxt, x + 24, my + th - 16, 20, t.dim);
            } else cv.text('not available', x + 24, my + 120, 22, t.dim);
        }

        /* ---------- apps from the Storage helper ---------- */
        let asked = 0;          // when Refresh asked the helper (its answer is newer than this)
        const KB = 1024;
        const appName = (a) => a.kind === 'platform' ? 'App platform (MainApp)' : a.title || a.id || a.folder;
        const ago = (ms) => (ms < 90000 ? 'just now' : ms < 5400000 ? Math.round(ms / 60000) + ' min ago' : Math.round(ms / 3600000) + ' h ago');

        /** One list panel: rows of name, uid, bar and size; what doesn't fit summed in a last row. */
        function listPanel(cv, t, x, y, w, h, title, rows, extra) {
            G.panel(cv, t, x, y, w, h, title);
            const total = rows.reduce((a, r) => a + r.kb, 0);
            cv.text(rows.length + (rows.length === 1 ? ' app' : ' apps') + '  ·  ' + sz(total * KB), x + w - 24, y + 36, 20, t.dim, { align: 'right', font: 'bold' });
            const rowH = 34, top = y + 56, n = Math.max(1, Math.floor((h - 64) / rowH));
            const lines = rows.map((r) => ({ name: appName(r), sub: r.uid, kb: r.kb, own: r.folder === OWN }));
            if (extra && extra.rows.length) {
                lines.push({ head: extra.title + '  ·  ' + sz(extra.rows.reduce((a, r) => a + r.kb, 0) * KB) });
                extra.rows.forEach((r) => lines.push({ name: String(r.path).split('/').pop(), sub: '', kb: r.kb }));
            }
            const shownLines = lines.length > n ? lines.slice(0, n - 1) : lines;
            const max = Math.max(1, rows.concat(extra ? extra.rows : []).reduce((a, r) => Math.max(a, r.kb), 0));
            shownLines.forEach((l, i) => {
                const ly = top + i * rowH;
                if (l.head) { cv.text(l.head, x + 24, ly + 26, 18, t.dim, { font: 'bold', spacing: 1.5 }); return; }
                if (i % 2 === 1) cv.fillRect(x + 16, ly, w - 32, rowH, t.track);
                cv.text(fit(cv, l.name + (l.own ? '  (this app)' : ''), 20, w - 330, 'label'), x + 24, ly + 24, 20, t.text);
                if (l.sub) cv.text(l.sub, x + w - 268, ly + 24, 16, t.dim, { align: 'right' });
                bar(cv, t, x + w - 254, ly + 14, 100, 7, l.kb / max, t.accent);
                cv.text(sz(l.kb * KB), x + w - 24, ly + 24, 20, t.text, { align: 'right', font: 'bold' });
            });
            if (lines.length > shownLines.length) {
                const rest = lines.slice(shownLines.length).filter((l) => !l.head);
                cv.text('+ ' + rest.length + ' more  ·  ' + sz(rest.reduce((a, l) => a + l.kb, 0) * KB), x + 24, top + shownLines.length * rowH + 24, 20, t.dim);
            }
        }

        function drawHelperApps(cv, t, d) {
            const bottom = G.BOTTOM - 26, h = bottom - G.TOP, gap = 16, w = (1552 - gap) / 2;
            const by = (k) => d.apps.filter((a) => k.indexOf(a.kind) >= 0).sort((a, b) => b.kb - a.kb);
            listPanel(cv, t, 24, G.TOP, w, h, 'BMW apps', by(['stock', 'platform']));
            listPanel(cv, t, 24 + w + gap, G.TOP, w, h, 'Custom apps', by(['custom']),
                { title: 'TOOLS IN /var/opt', rows: (d.tools || []).slice().sort((a, b) => b.kb - a.kb) });
            const waiting = asked && d.t < asked;
            const line = waiting ? 'Measuring ...' : 'Measured ' + ago(Date.now() - d.t) + ' by the Storage helper  ·  Refresh measures again';
            cv.text(line, 1552, G.BOTTOM - 4, 18, waiting ? t.warn : t.dim, { align: 'right' });
        }

        function drawApps(cv, t) {
            const d = S.helper();
            if (d) return drawHelperApps(cv, t, d);
            const bottom = G.BOTTOM;
            const L = G.panel(cv, t, 24, G.TOP, 1552, bottom - G.TOP, 'Installed apps');
            const list = apps.list, total = list.reduce((a, r) => a + r.bytes, 0);
            const closed = list.filter((r) => r.noAccess).length;
            // summary on the panel's title line (apps whose folder can't be opened counted apart: not 0 KB)
            const status = apps.scanning ? 'Scanning ' + apps.done + ' / ' + (apps.total || '?') + ' ...'
                : apps.error ? 'Cannot open ' + ROOT + ' (' + apps.error + ')'
                    : apps.t ? (list.length - closed) + ' measured  ·  ' + sz(total) + (closed ? '  ·  ' + closed + ' no access' : '') : 'Press Refresh to measure';
            cv.text(status, 1552, G.TOP + 36, 22, apps.error ? t.warn : t.dim, { align: 'right', font: 'bold' });
            if (!list.length) return;
            const rowH = 40, top = G.TOP + 66, per = Math.max(1, Math.floor((L.h - 80) / rowH)), cols = 2, colW = 740;
            const fitN = per * cols;
            const rows = list.length > fitN ? list.slice(0, fitN - 1) : list;
            const max = Math.max(1, list.reduce((a, r) => Math.max(a, r.bytes), 0));
            rows.forEach((r, i) => {
                const c = Math.floor(i / per), k = i % per;
                const x = 48 + c * (colW + 24), y = top + k * rowH;
                if (k % 2 === 1) cv.fillRect(x - 8, y, colW + 16, rowH, t.track);
                const own = r.folder === OWN;
                // oap_12201 is the app platform itself (MainApp: registry, app list)
                const label = r.name || (r.folder === 'oap_12201' ? 'App platform (MainApp)' : r.folder);
                const name = label + (own ? '  (this app)' : '');
                cv.text(fit(cv, name, 22, 390, 'label'), x, y + 28, 22, r.name || r.folder === 'oap_12201' ? t.text : t.dim);
                cv.text(r.folder.replace('oap_', ''), x + 470, y + 28, 18, t.dim, { align: 'right' });
                if (r.noAccess) { cv.text('no access', x + colW, y + 28, 20, t.dim, { align: 'right' }); return; }
                bar(cv, t, x + 490, y + 17, 110, 8, r.bytes / max, t.accent);
                cv.text(sz(r.bytes) + (r.denied ? ' *' : ''), x + colW, y + 28, 22, r.denied ? t.dim : t.text, { align: 'right', font: 'bold' });
            });
            if (list.length > rows.length) {
                const rest = list.slice(rows.length), i = rows.length, c = Math.floor(i / per), k = i % per;
                cv.text('+ ' + rest.length + ' more: ' + sz(rest.reduce((a, r) => a + r.bytes, 0)), 48 + c * (colW + 24), top + k * rowH + 28, 22, t.dim);
            }
            // each app runs as a Linux user of its own, its folder 750: another app's folder can't be opened from here
            const note = closed ? 'No access: apps can\'t open each other\'s folders. Install the Storage helper from the MGU Store to measure every app'
                : list.some((r) => r.denied && !r.noAccess) ? '* some folders could not be opened: at least this much' : '';
            if (note) cv.text(note, 1552, bottom - 14, 18, t.dim, { align: 'right' });
        }

        async function render() {
            const now = Date.now();
            // the screen came back or has been open a while: read again
            if (now - lastDraw > 2000 || now - disks.t > DISK_MS) readDisks();
            if (PAGES[page] === 'apps' && !apps.t && !apps.scanning && !S.helper()) scanApps();
            lastDraw = now;
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            (PAGES[page] === 'apps' ? drawApps : drawDisks)(cv, t);
            G.frame(cv, t, TABS, page, []);
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_ACTION', () => {
            readDisks();
            if (PAGES[page] === 'apps') {
                if (S.helper() && S.askHelper()) asked = Date.now();
                else { apps.t = 0; scanApps(); }
            }
            return render();
        });
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; return render(); });
        ctx.onTab((i) => { page = i; return render(); });
        settings.onChange((k) => { if (k === 'page') page = Math.max(0, PAGES.indexOf(settings.get('page'))); });
        ctx.loop('MAIN', 5, render);
        log.info('app root ' + ROOT + (OWN ? ', this app ' + OWN : ''));
        render().catch((e) => log.warn('first render: ' + e));
    },
});
