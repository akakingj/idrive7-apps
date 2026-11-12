'use strict';
/**
 * sysinfo.js - how full the head unit is: file systems (df), memory (/proc/meminfo) and how much
 * each installed app takes (a walk of /var/opt/public/oap).
 *
 * Node 8 on the unit has no statfs, so file system sizes come from the unit's own `df`
 * (busybox / toybox / coreutils all print the same six columns with -k). Everything here only
 * reads; nothing is written or deleted.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/** File system types that hold no files on a disk (left out of the list). */
const VIRTUAL = new Set(['proc', 'sysfs', 'devtmpfs', 'devpts', 'cgroup', 'cgroup2', 'securityfs', 'pstore', 'debugfs',
    'tracefs', 'configfs', 'mqueue', 'hugetlbfs', 'fusectl', 'bpf', 'autofs', 'binfmt_misc', 'rpc_pipefs', 'nsfs', 'efivarfs']);
const RAM = new Set(['tmpfs', 'ramfs']);
const ENV = { PATH: '/bin:/usr/bin:/sbin:/usr/sbin' };

function run(file, args, timeoutMs) {
    return new Promise((resolve) => {
        try {
            execFile(file, args, { timeout: timeoutMs || 5000, env: ENV, maxBuffer: 1 << 20 }, (err, out, errOut) => {
                resolve({ err, out: String(out || ''), errOut: String(errOut || '') });
            });
        } catch (e) { resolve({ err: e, out: '', errOut: '' }); }
    });
}

/** /proc/mounts: mount point -> { dev, type, ro } (the last mount on a path wins, as in the kernel). */
function mounts() {
    const m = {};
    try {
        fs.readFileSync('/proc/mounts', 'utf8').split('\n').forEach((l) => {
            const p = l.split(' ');
            if (p.length < 4) return;
            const mp = p[1].replace(/\\040/g, ' ');
            m[mp] = { dev: p[0], type: p[2], ro: /(^|,)ro(,|$)/.test(p[3]) };
        });
    } catch (e) { /* no /proc */ }
    return m;
}

/** Parse `df -k` output into [{ dev, mount, size, used, avail }] in bytes (wrapped long device names joined). */
function parseDf(out) {
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length || !/^filesystem/i.test(lines[0])) return null;
    const rows = [];
    let carry = '';
    for (const l of lines.slice(1)) {
        const s = carry ? carry + ' ' + l : l;
        const p = s.split(/\s+/);
        if (p.length < 6) { carry = s; continue; }
        carry = '';
        const [dev, blocks, used, avail] = p, mount = p.slice(5).join(' ');
        const n = (x) => (/^\d+$/.test(x) ? Number(x) * 1024 : null);
        if (n(blocks) === null) continue;
        rows.push({ dev, mount, size: n(blocks), used: n(used), avail: n(avail) });
    }
    return rows;
}

/**
 * File systems with their sizes: { list: [{ dev, mount, type, ro, size, used, avail, alsoAt: [] }], how, error }.
 * Bind mounts of the same file system (same device, same numbers) are shown once, at the shortest path.
 */
async function fileSystems() {
    let rows = null, how = '', error = '';
    for (const [file, args] of [['df', ['-kP']], ['df', ['-k']], ['/bin/df', ['-k']], ['busybox', ['df', '-k']], ['toybox', ['df', '-k']]]) {
        const r = await run(file, args);
        rows = parseDf(r.out);
        if (rows && rows.length) { how = file + ' ' + args.join(' '); break; }
        error = (r.err && (r.err.code || r.err.message)) || r.errOut.trim() || 'no output';
    }
    if (!rows || !rows.length) return { list: [], how: '', error: 'df: ' + error };
    const m = mounts(), seen = {}, list = [];
    rows.sort((a, b) => a.mount.length - b.mount.length);
    for (const r of rows) {
        const info = m[r.mount] || {};
        r.type = info.type || '';
        r.ro = !!info.ro;
        r.alsoAt = [];
        if (VIRTUAL.has(r.type) || !r.size) continue;
        const key = r.dev + '|' + r.size + '|' + r.used;
        if (seen[key]) { seen[key].alsoAt.push(r.mount); continue; }
        seen[key] = r;
        list.push(r);
    }
    return { list, how, error: '' };
}
fileSystems.RAM = RAM;

/** The file system a path is on: the entry with the longest mount point that prefixes it. */
function fsOf(list, p) {
    let best = null;
    for (const r of list) {
        for (const mp of [r.mount].concat(r.alsoAt)) {
            const ok = mp === '/' || p === mp || p.indexOf(mp.replace(/\/$/, '') + '/') === 0;
            if (ok && (!best || mp.length > best.len)) best = { r, len: mp.length };
        }
    }
    return best && best.r;
}

/** Memory from /proc/meminfo, bytes: { total, avail, used, swapTotal, swapFree } or null. */
function memory() {
    try {
        const kv = {};
        fs.readFileSync('/proc/meminfo', 'utf8').split('\n').forEach((l) => {
            const m = /^(\w+):\s+(\d+)/.exec(l);
            if (m) kv[m[1]] = Number(m[2]) * 1024;
        });
        if (!kv.MemTotal) return null;
        const avail = kv.MemAvailable != null ? kv.MemAvailable : (kv.MemFree || 0) + (kv.Buffers || 0) + (kv.Cached || 0);
        return { total: kv.MemTotal, avail, used: kv.MemTotal - avail, swapTotal: kv.SwapTotal || 0, swapFree: kv.SwapFree || 0 };
    } catch (e) { return null; }
}

/** Seconds the unit has been up, or null. */
function uptime() {
    try { return Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]); } catch (e) { return null; }
}

const pLstat = (p) => new Promise((res) => fs.lstat(p, (e, s) => res(e ? null : s)));
const pReaddir = (p) => new Promise((res) => fs.readdir(p, (e, l) => res(e ? { err: e } : { list: l })));
const tick = () => new Promise((res) => setImmediate(res));

/**
 * Disk space under a folder (what `du` counts: allocated blocks), walking it without blocking the
 * app: { bytes, files, denied, noAccess } (denied = folders it could not open; noAccess = not even the
 * folder itself: on the car every app runs as a Linux user of its own and its folder is 750, so another
 * app's folder can't be measured from here).
 */
async function folderSize(dir, budget) {
    let bytes = 0, files = 0, denied = 0, n = 0;
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        const r = await pReaddir(d);
        if (r.err) {
            if (d === dir) return { bytes: 0, files: 0, denied: 1, noAccess: true, partial: false, code: String(r.err.code || r.err.message) };
            denied++; continue;
        }
        for (const name of r.list) {
            const p = path.join(d, name), st = await pLstat(p);
            if (++n % 200 === 0) await tick();
            if (!st) continue;
            bytes += st.blocks != null ? st.blocks * 512 : st.size;
            if (st.isDirectory()) stack.push(p);
            else files++;
            if (budget && n > budget) return { bytes, files, denied, noAccess: false, partial: true };
        }
    }
    return { bytes, files, denied, noAccess: false, partial: false };
}

/** App names by uid folder, from the platform's uid list and each app's package.json. */
function appNames(root) {
    const names = {};
    try {
        // oap_12201/security/uids.txt: one app per line with its uid (format varies by firmware: find both)
        fs.readFileSync(path.join(root, 'oap_12201', 'security', 'uids.txt'), 'utf8').split('\n').forEach((l) => {
            const uid = /\b(1[12]\d{3})\b/.exec(l);
            const name = l.replace(/\b1[12]\d{3}\b/, ' ').replace(/[=:,;\t]/g, ' ').trim().split(/\s+/).filter(Boolean)[0];
            if (uid && name) names['oap_' + uid[1]] = name;
        });
    } catch (e) { /* not readable */ }
    return names;
}

/** The name in an app folder's package.json (installed apps keep it at the top or in source/). */
function packageName(dir) {
    for (const f of ['package.json', 'source/package.json']) {
        try {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            return j.displayName || j.name || null;
        } catch (e) { /* next */ }
    }
    return null;
}

/**
 * Every app folder under root (/var/opt/public/oap): [{ folder, name, bytes, files, denied, noAccess }], the
 * measured ones biggest first, the ones that can't be opened after them. onProgress(done, total) after each.
 */
async function appFolders(root, onProgress) {
    const r = await pReaddir(root);
    if (r.err) return { list: [], error: String(r.err.code || r.err.message) };
    const dirs = r.list.filter((f) => /^oap_\d+$/.test(f)).sort();
    const names = appNames(root), list = [];
    for (let i = 0; i < dirs.length; i++) {
        const dir = path.join(root, dirs[i]);
        const s = await folderSize(dir, 300000);
        list.push(Object.assign({ folder: dirs[i], name: packageName(dir) || names[dirs[i]] || null }, s));
        if (onProgress) onProgress(i + 1, dirs.length);
    }
    list.sort((a, b) => (a.noAccess - b.noAccess) || (b.bytes - a.bytes) || (a.folder < b.folder ? -1 : 1));
    return { list, error: '' };
}

module.exports = { fileSystems, fsOf, memory, uptime, folderSize, appFolders, parseDf, RAM, VIRTUAL };
