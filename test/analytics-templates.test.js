/*
 * Tests for src/analytics-templates.ts against a real baja-apps checkout.
 *
 *   npm run test:analytics-templates
 *   BAJA_APPS=/path/to/baja-apps npm run test:analytics-templates
 *
 * The module is compiled on its own into build-test/ (the script does this), mounted on a bare
 * express app, and driven over HTTP. User folders go to a throwaway temp directory.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const { AnalyticsTemplates, __test } = require('../build-test/analytics-templates');

const APPS = path.resolve(process.env.BAJA_APPS || path.join(__dirname, '..', '..', 'baja-apps'));
const USER = 'Tester@Example.com';
const OTHER = 'someone-else@example.com';

// The client's encoding: pako/zlib bytes, one char each.
const encode = (obj) => zlib.deflateSync(Buffer.from(JSON.stringify(obj), 'utf8')).toString('latin1');
const fakeEncodeEmail = (e) => Buffer.from(e).toString('hex');

let server, base, userData;

test.before(async () => {
    assert.ok(fs.existsSync(path.join(APPS, 'baja', 'analytics-templates', 'index.json')),
        `no index.json under ${APPS}; set BAJA_APPS`);
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'baja-users-'));
    const app = express();
    app.use(express.json({ limit: '100mb' }));
    new AnalyticsTemplates({ appsDir: () => APPS, userData, encodeEmail: fakeEncodeEmail }).updateAPI(app);
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    server && server.close();
    fs.rmSync(userData, { recursive: true, force: true });
});

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
};

test('index lists the built-in library with categories and no payloads', async () => {
    const { status, body } = await get('/analytics-templates/index');
    assert.equal(status, 200);
    assert.ok(body.categories.length >= 5);
    assert.ok(body.templates.length >= 50);
    for (const t of body.templates) {
        assert.equal(t.source, 'builtin');
        assert.equal(t.payload, undefined);
        assert.ok(t.id && t.title && t.kind && t.category);
    }
});

test('every built-in template loads and decodes as the kind it claims', async () => {
    const { body } = await get('/analytics-templates/index');
    for (const t of body.templates) {
        const r = await get(`/analytics-templates/item?id=${t.id}`);
        assert.equal(r.status, 200, t.id);
        assert.equal(r.body.rule_name, t.name, t.id);
        const doc = __test.decodePayload(r.body.rule_value);
        if (t.kind === 'timeline') assert.ok(doc.scatterData, `${t.id} is not a timeline`);
        else if (t.kind === 'table') assert.ok(Array.isArray(doc.wells), `${t.id} is not a table`);
        else assert.ok(doc.root || doc.plateTrack || doc.ptracks, `${t.id} is not a model`);
        // Same bytes /get-script would have served for the same file.
        const onDisk = fs.readFileSync(path.join(APPS, 'baja', 'templates', t.file), 'utf-8');
        assert.equal(r.body.rule_value, onDisk, t.id);
    }
});

test('unknown and malformed ids are refused', async () => {
    assert.equal((await get('/analytics-templates/item?id=nope-not-here')).status, 404);
    assert.equal((await get('/analytics-templates/item?id=../../etc/passwd')).status, 400);
    assert.equal((await get('/analytics-templates/item?id=')).status, 400);
});

test('publish writes to the caller folder, then index and item return it', async () => {
    const table = { name: 'assay_plate', plateType: 'data', grid: { xmax: 2, ymax: 3 },
        wells: [[{ value: 'Well' }, { value: 'A1' }, { value: 'A2' }], [{ value: 'RFU' }, { value: 10 }, { formula: 'x' }]] };
    const payload = encode(table);
    const pub = await post('/analytics-templates/publish', {
        user: USER, title: 'My Assay Plate!', kind: 'table', category: 'lab-analysis',
        description: 'Two wells.', tags: 'assay, plate', payload,
    });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.equal(pub.body.template.id, 'my-assay-plate');
    assert.deepEqual(pub.body.template.tags, ['assay', 'plate']);
    assert.equal(pub.body.template.summary.tables, 1);
    assert.equal(pub.body.template.summary.formulas, 1);
    assert.equal(pub.body.template.payload, undefined);
    assert.equal(pub.body.template.owner, undefined);

    const file = path.join(userData, fakeEncodeEmail(USER), '.analytics-templates', 'my-assay-plate.json');
    assert.ok(fs.existsSync(file));

    const idx = await get(`/analytics-templates/index?user=${encodeURIComponent(USER)}`);
    const mine = idx.body.templates.filter((t) => t.source === 'mine');
    assert.equal(mine.length, 1);
    assert.equal(idx.body.templates[0].source, 'mine', 'own templates come first');

    const item = await get(`/analytics-templates/item?source=mine&id=my-assay-plate&user=${encodeURIComponent(USER)}`);
    assert.equal(item.status, 200);
    assert.equal(item.body.rule_value, payload);
    assert.equal(item.body.rule_name, 'my-assay-plate.ljt');
    assert.deepEqual(__test.decodePayload(item.body.rule_value), table);
});

test('a second publish with the same title gets a new id; replace=true overwrites', async () => {
    const payload = encode({ name: 't', grid: {}, wells: [] });
    const again = await post('/analytics-templates/publish', { user: USER, title: 'My Assay Plate', kind: 'table', payload });
    assert.equal(again.body.template.id, 'my-assay-plate-2');

    const firstCreated = JSON.parse(fs.readFileSync(path.join(userData, fakeEncodeEmail(USER),
        '.analytics-templates', 'my-assay-plate.json'), 'utf-8')).created;
    const rep = await post('/analytics-templates/publish', {
        user: USER, id: 'my-assay-plate', replace: true, title: 'Renamed', kind: 'table', payload,
    });
    assert.equal(rep.body.template.id, 'my-assay-plate');
    assert.equal(rep.body.template.title, 'Renamed');
    assert.equal(rep.body.template.created, firstCreated, 'replace keeps the original created time');
});

test("one user cannot see or delete another user's templates", async () => {
    const idx = await get(`/analytics-templates/index?user=${encodeURIComponent(OTHER)}`);
    assert.equal(idx.body.templates.filter((t) => t.source === 'mine').length, 0);
    const item = await get(`/analytics-templates/item?source=mine&id=my-assay-plate&user=${encodeURIComponent(OTHER)}`);
    assert.equal(item.status, 404);
    const del = await post('/analytics-templates/delete', { user: OTHER, id: 'my-assay-plate' });
    assert.equal(del.status, 404);
});

test('publish rejects bad input', async () => {
    const payload = encode({ wells: [], grid: {} });
    assert.equal((await post('/analytics-templates/publish', { title: 'x', kind: 'table', payload })).status, 400, 'no user');
    assert.equal((await post('/analytics-templates/publish', { user: USER, kind: 'table', payload })).status, 400, 'no title');
    assert.equal((await post('/analytics-templates/publish', { user: USER, title: 'x', kind: 'chart', payload })).status, 400, 'bad kind');
    assert.equal((await post('/analytics-templates/publish', { user: USER, title: 'x', kind: 'table', payload: 'not zlib' })).status, 400, 'junk payload');
    assert.equal((await post('/analytics-templates/publish', { user: USER, title: 'x', kind: 'table', payload, id: '../evil', replace: true })).status, 400, 'path id');
});

test('delete removes the caller own template', async () => {
    const del = await post('/analytics-templates/delete', { user: USER, id: 'my-assay-plate-2' });
    assert.equal(del.status, 200);
    const idx = await get(`/analytics-templates/index?user=${encodeURIComponent(USER)}`);
    assert.deepEqual(idx.body.templates.filter((t) => t.source === 'mine').map((t) => t.id), ['my-assay-plate']);
});

test('slug', () => {
    assert.equal(__test.slug('qPCR ΔΔCt, 2 reps'), 'qpcr-ct-2-reps');
    assert.equal(__test.slug('***'), 'template');
});
