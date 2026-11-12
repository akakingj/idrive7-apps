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
    async 'Storage helper: every app measured, BMW / custom / platform apart, names, tools; Storage reads it'() {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'msh-')), oap = path.join(base, 'oap'), vo = path.join(base, 'opt');
        const mk = (p, mb) => { fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, 'b'), Buffer.alloc(mb * 1048576, 1)); };
        mk(path.join(oap, 'oap_12201', 'security'), 1); fs.mkdirSync(path.join(oap, 'oap_12201', 'data'));
        fs.writeFileSync(path.join(oap, 'oap_12201', 'security', 'uids.txt'), '12203=com.bmw.weather\n12450=redline\n12449=robertn_waze_cluster');
        fs.writeFileSync(path.join(oap, 'oap_12201', 'data', 'custom_apps.json'), JSON.stringify({ redline: {}, robertn_waze_cluster: {} }));
        mk(path.join(oap, 'oap_12203'), 2); fs.writeFileSync(path.join(oap, 'oap_12203', 'package.json'), JSON.stringify({ name: 'weather', displayName: 'Weather' }));
        mk(path.join(oap, 'oap_12450', 'source', 'javascript', 'kit'), 3);
        fs.writeFileSync(path.join(oap, 'oap_12450', 'source', 'javascript', 'kit', 'app-spec.json'), JSON.stringify({ id: 'redline', title: 'Redline' }));
        mk(path.join(oap, 'oap_12449'), 1);
        mk(path.join(vo, 'mgu-store'), 2); mk(path.join(vo, 'idrive7-renderd'), 1); mk(path.join(vo, 'bmw_own'), 1);
        Object.assign(process.env, { MSH_OAP: oap, MSH_VAR_OPT: vo, MSH_OUT: path.join(base, 'run', 'apps.json'), MSH_REQUEST: path.join(base, 'req') });
        delete require.cache[require.resolve('../storage-helper/mgu-storage-helper')];
        const H = require('../storage-helper/mgu-storage-helper');
        fs.writeFileSync(path.join(base, 'req'), '1');
        const r = await H.once();
        const by = {}; r.apps.forEach((a) => { by[a.folder] = a; });
        assert.deepStrictEqual(Object.keys(by).sort(), ['oap_12201', 'oap_12203', 'oap_12449', 'oap_12450']);
        assert.strictEqual(by.oap_12201.kind, 'platform');
        assert.strictEqual(by.oap_12203.kind, 'stock'); assert.strictEqual(by.oap_12203.title, 'Weather');
        assert.strictEqual(by.oap_12450.kind, 'custom'); assert.strictEqual(by.oap_12450.title, 'Redline');
        assert.strictEqual(by.oap_12449.kind, 'custom'); assert.strictEqual(by.oap_12449.id, 'robertn_waze_cluster'); assert.strictEqual(by.oap_12449.title, null);
        assert(by.oap_12450.kb >= 3 * 1024 && by.oap_12203.kb >= 2 * 1024, 'du sizes in KB');
        assert.deepStrictEqual(r.tools.map((x) => path.basename(x.path)), ['idrive7-renderd', 'mgu-store'], 'BMW\'s own /var/opt folders left out');
        assert(!fs.existsSync(path.join(base, 'req')), 'the request is answered');
        assert.strictEqual(fs.statSync(process.env.MSH_OUT).mode & 0o777, 0o644);
        // the Storage app's side
        process.env.STORAGE_HELPER_OUT = process.env.MSH_OUT; process.env.STORAGE_HELPER_REQUEST = path.join(base, 'req2');
        delete require.cache[require.resolve(path.join(__dirname, '..', '..', 'apps', 'mgu_storage', 'sysinfo'))];
        const S2 = require(path.join(__dirname, '..', '..', 'apps', 'mgu_storage', 'sysinfo'));
        assert.strictEqual(S2.helper().apps.length, 4);
        assert(S2.askHelper() && fs.existsSync(path.join(base, 'req2')));
        fs.writeFileSync(process.env.MSH_OUT, '{"v": 2}'); fs.utimesSync(process.env.MSH_OUT, Date.now() / 1000 + 5, Date.now() / 1000 + 5);
        assert.strictEqual(S2.helper(), null, 'another format: not taken');
        process.env.STORAGE_HELPER_OUT = path.join(base, 'none.json');
        delete require.cache[require.resolve(path.join(__dirname, '..', '..', 'apps', 'mgu_storage', 'sysinfo'))];
        assert.strictEqual(require(path.join(__dirname, '..', '..', 'apps', 'mgu_storage', 'sysinfo')).helper(), null, 'no helper');
        fs.rmSync ? fs.rmSync(base, { recursive: true, force: true }) : null;
    },
    'Storage helper: the Store gets a tool with its unit and files'() {
        const dir = path.join(__dirname, '..', 'storage-helper');
        const c = JSON.parse(fs.readFileSync(path.join(dir, 'component.json'), 'utf8'));
        assert.strictEqual(c.id, 'mgu-storage-helper'); assert.strictEqual(c.kind, 'tool');
        c.files.forEach((f) => assert(fs.existsSync(path.join(dir, f.path)), f.path));
        c.units.forEach((u) => assert(fs.existsSync(path.join(dir, u.name)), u.name));
        const unit = fs.readFileSync(path.join(dir, 'mgu-storage-helper.service'), 'utf8');
        assert(/ExecStart=\/usr\/bin\/node \/var\/opt\/mgu-storage-helper\/current\/mgu-storage-helper\.js/.test(unit));
        const repo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'mgu-repo.json'), 'utf8'));
        assert(repo.tools.some((x) => x.id === c.id && x.path === 'kit/storage-helper'));
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
