'use strict';
/**
 * test_mgu_storage.js - Storage's system readings (apps/mgu_storage/sysinfo.js) on the PC.
 *
 *   node kit/tools/test_mgu_storage.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require(path.join(__dirname, '..', '..', 'apps', 'mgu_storage', 'sysinfo'));

const cases = {
    'df: coreutils -P'() {
        const r = S.parseDf('Filesystem     1024-blocks    Used Available Capacity Mounted on\n' +
            '/dev/sda1         1000000  250000    750000      25% /\n' +
            'tmpfs              204800       0    204800       0% /dev/shm\n');
        assert.deepStrictEqual(r.map((x) => x.mount), ['/', '/dev/shm']);
        assert.strictEqual(r[0].size, 1000000 * 1024);
        assert.strictEqual(r[0].avail, 750000 * 1024);
    },
    'df: busybox wraps a long device name onto its own line; mount points with spaces'() {
        const r = S.parseDf('Filesystem           1K-blocks      Used Available Use% Mounted on\n' +
            '/dev/disk/by-partlabel/very_long_name_of_the_app_partition\n' +
            '                        4096000   1024000   3072000  25% /var/opt\n' +
            '/dev/mmcblk0p3          100     50      50  50% /mnt/my disk\n');
        assert.deepStrictEqual(r.map((x) => [x.dev, x.mount]), [
            ['/dev/disk/by-partlabel/very_long_name_of_the_app_partition', '/var/opt'], ['/dev/mmcblk0p3', '/mnt/my disk']]);
    },
    'df: anything else is not a df table'() {
        assert.strictEqual(S.parseDf(''), null);
        assert.strictEqual(S.parseDf('sh: df: not found\n'), null);
    },
    'fsOf: the longest mount point that holds the path'() {
        const list = [{ mount: '/', alsoAt: [] }, { mount: '/var/opt', alsoAt: [] }, { mount: '/var/optical', alsoAt: [] },
            { mount: '/data', alsoAt: ['/var/opt/public'] }];
        assert.strictEqual(S.fsOf(list, '/var/opt/public/oap').mount, '/data');
        assert.strictEqual(S.fsOf(list, '/var/opt/x').mount, '/var/opt');
        assert.strictEqual(S.fsOf(list, '/usr').mount, '/');
    },
    async 'folders: measured, the app\'s own and the ones it may not open (not 0 KB), biggest first'() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oap-'));
        const mk = (dir, mb) => { fs.mkdirSync(path.join(root, dir, 'data'), { recursive: true }); fs.writeFileSync(path.join(root, dir, 'data', 'blob'), Buffer.alloc(mb * 1048576, 1)); };
        mk('oap_12221', 3); mk('oap_12222', 1);
        fs.writeFileSync(path.join(root, 'oap_12223'), 'not a folder');       // stands in for a folder it can't open
        fs.writeFileSync(path.join(root, 'oap_12222', 'package.json'), JSON.stringify({ name: 'car_vitals' }));
        fs.writeFileSync(path.join(root, 'other'), 'x');
        const seen = [];
        const r = await S.appFolders(root, (d, n) => seen.push(d + '/' + n));
        assert.strictEqual(r.error, '');
        assert.deepStrictEqual(r.list.map((x) => x.folder), ['oap_12221', 'oap_12222', 'oap_12223']);
        assert(r.list[0].bytes >= 3 * 1048576 && r.list[1].bytes >= 1048576);
        assert.strictEqual(r.list[1].name, 'car_vitals');
        assert.strictEqual(r.list[2].noAccess, true);
        assert.strictEqual(r.list[2].bytes, 0);
        assert.strictEqual(r.list[0].noAccess, false);
        assert.deepStrictEqual(seen, ['1/3', '2/3', '3/3']);
        const gone = await S.appFolders(path.join(root, 'nope'));
        assert(gone.error && !gone.list.length);
        fs.rmSync ? fs.rmSync(root, { recursive: true, force: true }) : null;
    },
    async 'this PC: df, memory and up time read'() {
        const r = await S.fileSystems();
        assert(r.list.length > 0, r.error);
        assert(S.fsOf(r.list, '/tmp'), 'the file system /tmp is on');
        assert(S.memory().total > 0);
        assert(S.uptime() > 0);
    },
};

(async () => {
    let failed = 0;
    for (const name of Object.keys(cases)) {
        try { await cases[name](); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
    }
    console.log(failed ? failed + ' failed' : 'all passed');
    process.exit(failed ? 1 : 0);
})();
