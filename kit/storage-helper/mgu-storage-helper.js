'use strict';
/**
 * mgu-storage-helper.js - measures every app on the head unit for the Storage app, as root.
 *
 * Each app runs as a Linux user of its own and its folder (/var/opt/public/oap/oap_<uid>) is 750, so an app can
 * measure only its own folder. This runs as root (mgu-storage-helper.service, installed from the MGU Store with
 * this folder's component.json) and writes what it measures where every app can read it:
 *
 *   /run/mgu-storage/apps.json  { "v": 1, "t": ms, "took": ms, "apps": [{ "uid", "folder", "id", "title", "kind", "kb" }],
 *                                 "tools": [{ "path", "kb" }], "error": "" }
 *
 * kind: "platform" (oap_12201, MainApp), "custom" (listed in oap_12201/data/custom_apps.json: apps installed by
 * the kit's installer or the MGU Store), "stock" (BMW's own). tools: the custom tools' folders in /var/opt (renderers,
 * the Store, cluster-render ...). Sizes are what du counts (allocated KB).
 * It measures at start, then every 30 minutes, and within 5 s of a request: the Storage app's Refresh creates
 * /dev/shm/mgu-storage-request (any user may), which is removed when the new measurement is written.
 * Reading only: it changes nothing but its own two files. Run at the lowest CPU and disk priority (the unit).
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const env = process.env;
const P = {
    oap: env.MSH_OAP || '/var/opt/public/oap',
    varOpt: env.MSH_VAR_OPT || '/var/opt',
    out: env.MSH_OUT || '/run/mgu-storage/apps.json',
    request: env.MSH_REQUEST || '/dev/shm/mgu-storage-request',
};
const EVERY_MS = 30 * 60 * 1000, POLL_MS = 5000;
// custom tools in /var/opt by folder name (BMW's own folders there are left out)
const TOOL = /^(mgu[-_]|idrive7|cluster[-_]?render|waze|robertn|iterio|car[-_]apps)/i;

const log = (s) => process.stdout.write(new Date().toISOString() + ' ' + s + '\n');

/** uids.txt: "<uid>=<app id>" per line -> { uid: id }. */
function readUids(file) {
    const out = {};
    try {
        fs.readFileSync(file, 'utf8').split('\n').forEach((l) => {
            const m = /^\s*(\d+)\s*=\s*(\S+)\s*$/.exec(l);
            if (m) out[m[1]] = m[2];
        });
    } catch (e) { /* none */ }
    return out;
}

/** custom_apps.json: { "<app id>": {...} } -> the ids. */
function readCustom(file) {
    try { return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')) || {}); } catch (e) { return []; }
}

/** The name an app shows: the kit's app-spec.json title, else package.json's displayName / name, else null. */
function titleOf(dir) {
    for (const f of ['source/javascript/kit/app-spec.json', 'package.json', 'source/package.json']) {
        try {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const t = j.title || j.displayName || j.name;
            if (t && typeof t === 'string') return t.slice(0, 60);
        } catch (e) { /* next */ }
    }
    return null;
}

/** KB a folder takes (du -sk, else a walk adding allocated blocks), or null. */
function sizeKb(dir) {
    return new Promise((resolve) => {
        execFile('du', ['-sk', dir], { timeout: 120000, maxBuffer: 1 << 20, env: { PATH: '/bin:/usr/bin:/sbin:/usr/sbin' } }, (err, out) => {
            const m = /^(\d+)\s/.exec(String(out || ''));
            if (m) return resolve(Number(m[1]));
            resolve(walkKb(dir));
        });
    });
}
function walkKb(dir) {
    let kb = 0;
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        let list;
        try { list = fs.readdirSync(d); } catch (e) { continue; }
        for (const n of list) {
            let st;
            try { st = fs.lstatSync(path.join(d, n)); } catch (e) { continue; }
            kb += st.blocks != null ? st.blocks / 2 : Math.ceil(st.size / 1024);
            if (st.isDirectory()) stack.push(path.join(d, n));
        }
    }
    return Math.round(kb);
}

async function measure() {
    const t0 = Date.now();
    const uids = readUids(path.join(P.oap, 'oap_12201', 'security', 'uids.txt'));
    const custom = readCustom(path.join(P.oap, 'oap_12201', 'data', 'custom_apps.json'));
    const res = { v: 1, t: 0, took: 0, apps: [], tools: [], error: '' };
    let dirs = [];
    try { dirs = fs.readdirSync(P.oap).filter((f) => /^oap_\d+$/.test(f)).sort(); } catch (e) { res.error = 'oap: ' + (e.code || e.message); }
    for (const folder of dirs) {
        const uid = folder.slice(4), id = uids[uid] || null;
        const kind = uid === '12201' ? 'platform' : id && custom.indexOf(id) >= 0 ? 'custom' : 'stock';
        const dir = path.join(P.oap, folder);
        res.apps.push({ uid, folder, id, title: titleOf(dir), kind, kb: await sizeKb(dir) });
    }
    let tops = [];
    try { tops = fs.readdirSync(P.varOpt).filter((f) => TOOL.test(f)).sort(); } catch (e) { /* none */ }
    for (const name of tops) {
        const p = path.join(P.varOpt, name);
        let st;
        try { st = fs.lstatSync(p); } catch (e) { continue; }
        if (st.isDirectory()) res.tools.push({ path: p, kb: await sizeKb(p) });
    }
    res.t = Date.now(); res.took = res.t - t0;
    return res;
}

/** Write the file whole (a temp file renamed over it), readable by every app. */
function write(res) {
    // (the unit's RuntimeDirectory makes it; Node 8 has no recursive mkdir)
    try { fs.mkdirSync(path.dirname(P.out), 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const tmp = P.out + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(res), { mode: 0o644 });
    try { fs.chmodSync(tmp, 0o644); } catch (e) { /* the mode given above */ }
    fs.renameSync(tmp, P.out);
}

async function once() {
    const res = await measure();
    write(res);
    try { fs.unlinkSync(P.request); } catch (e) { /* none asked */ }
    log('measured ' + res.apps.length + ' app folders and ' + res.tools.length + ' tool folders in ' + res.took + ' ms' + (res.error ? ' (' + res.error + ')' : ''));
    return res;
}

function main() {
    let busy = false, last = 0;
    const tick = () => {
        if (busy) return;
        let asked = false;
        try { asked = fs.existsSync(P.request); } catch (e) { /* no */ }
        if (!asked && Date.now() - last < EVERY_MS) return;
        busy = true;
        once().catch((e) => log('error: ' + (e && e.stack || e))).then(() => { last = Date.now(); busy = false; });
    };
    tick();
    setInterval(tick, POLL_MS);
}

module.exports = { readUids, readCustom, titleOf, measure, write, once, walkKb, P, TOOL };
if (require.main === module) main();
