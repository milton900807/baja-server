// ---------------------------------------------------------------------------------------
//  BAJA ANALYTICS TEMPLATES
//
//  One place for the workbook templates the baja-analytics app offers: the curated built-in
//  library that ships with baja-apps, and each user's own published templates.
//
//    GET  /analytics-templates/index?user=<email>
//         -> { categories, templates: [ ...built-in, ...the caller's own ] }   (no payloads)
//    GET  /analytics-templates/item?user=<email>&id=<id>&source=builtin|mine
//         -> { rule_name, rule_type, rule_value, template }   (the shape /get-script returns,
//            so the existing place-table / place-timeline / model loaders take it unchanged)
//    POST /analytics-templates/publish  { user, title, kind, category, description, tags,
//                                         payload, id?, replace? }
//         -> { ok, template }
//    POST /analytics-templates/delete   { user, id }  -> { ok }
//
//  Built-ins are described by baja-apps/baja/analytics-templates/index.json (generated from
//  catalog.json by tools/analytics-templates/build-index.js) and their payloads stay under
//  baja-apps/baja/templates/. This module only reads that tree -- in production it is mounted
//  read-only.
//
//  Published templates are written to the caller's own folder,
//  <userData>/<encodeEmail(user)>/.analytics-templates/<id>.json, never into the apps tree.
//  (The older "Publish" menus write into baja/templates via /save-script, which fails on the
//  read-only mount and accepts any path.)
//
//  Identity is the claimed address, as everywhere else on this server (see the note on access
//  control in index.ts): it scopes reads and writes to one folder, it does not authenticate.
// ---------------------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';

export interface AnalyticsTemplateDeps {
    appsDir: () => string;                    // the baja-apps root (index.ts `wd`)
    userData: string;                         // the per-user folder root
    encodeEmail: (email: string) => string;   // the same folder naming every other route uses
}

const KINDS = new Set(['table', 'model', 'timeline']);
const EXT: { [k: string]: string } = { table: 'ljt', model: 'bjb', timeline: 'ljp' };
const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const USER_DIR = '.analytics-templates';
const MAX_PAYLOAD_CHARS = 64 * 1024 * 1024;   // payload text, one char per compressed byte
const MAX_TEXT = 4000;                        // description and other free text
const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:/i;

// ------------------------------------------------------------------ helpers

function bad(res: any, status: number, msg: string) {
    return res.status(status).json({ ok: false, msg });
}

function userOf(req: any): string {
    const q = req.query || {};
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const u = String(q.user || b.user || '').trim();
    return u.indexOf('@') > 0 ? u : '';
}

function text(v: any, max = 200): string {
    return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

function slug(s: string): string {
    const v = s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
        .replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    return v || 'template';
}

// The payload as the client stores it: zlib bytes, one char each. Returns the decoded JSON, or
// throws if it is not a payload this platform could load.
function decodePayload(s: string): any {
    return JSON.parse(zlib.inflateSync(Buffer.from(s, 'latin1')).toString('utf8'));
}

// A small structural summary of a decoded payload, so the browser can describe a user's
// template the same way it describes a built-in one. Deliberately shallow on nesting: packages
// are counted, not opened.
function summarize(kind: string, doc: any): any {
    if (kind === 'timeline') {
        const pts = doc && doc.scatterData && Array.isArray(doc.scatterData.points) ? doc.scatterData.points : [];
        const named = pts.map((p: any) => (p && p.name ? String(p.name) : '')).filter(Boolean);
        return {
            milestones: Math.max(0, named.length - 2),
            range: named.length >= 2 ? [named[0], named[1]] : null,
            preview: named.slice(2, 8),
        };
    }
    const tables: any[] = [];
    const packages: string[] = [];
    const seen = new Set<string>();
    const walk = (o: any, depth: number) => {
        if (!o || typeof o !== 'object' || depth > 40) return;
        if (Array.isArray(o.wells) && o.grid && typeof o.grid === 'object') {
            const key = String(o.uid || o.name);
            if (!seen.has(key)) {
                seen.add(key);
                if (o.plateType === 'package') packages.push(String(o.name || ''));
                else {
                    const cols = o.wells.length;
                    const rows = cols && Array.isArray(o.wells[0]) ? o.wells[0].length : 0;
                    let formulas = 0;
                    for (const col of o.wells) for (const c of (col || [])) if (c && c.formula) formulas++;
                    const header: string[] = [];
                    for (const col of o.wells.slice(0, 6)) {
                        const c = col && col[0];
                        if (c && c.value !== undefined && c.value !== null && String(c.value).trim()) header.push(String(c.value).trim().slice(0, 40));
                    }
                    tables.push({ name: String(o.name || ''), rows: Math.max(0, rows - 1), cols, formulas, header });
                }
            }
        }
        for (const v of (Array.isArray(o) ? o : Object.values(o))) {
            if (v && typeof v === 'object') walk(v, depth + 1);
        }
    };
    walk(doc, 0);
    return {
        tables: tables.length,
        formulas: tables.reduce((n, t) => n + t.formulas, 0),
        embeddedModels: packages.filter(Boolean),
        preview: tables.slice(0, 8).map(t => ({ name: t.name, rows: t.rows, cols: t.cols, header: t.header })),
    };
}

// ------------------------------------------------------------------ the routes

export class AnalyticsTemplates {
    private builtinCache: { mtimeMs: number, file: string, index: any } | null = null;

    constructor(private deps: AnalyticsTemplateDeps) { }

    private templatesRoot(): string {
        return path.resolve(this.deps.appsDir(), 'baja', 'templates');
    }

    private builtinIndex(): any {
        const file = path.resolve(this.deps.appsDir(), 'baja', 'analytics-templates', 'index.json');
        let st: fs.Stats;
        try { st = fs.statSync(file); } catch (e) { return { categories: [], templates: [] }; }
        const c = this.builtinCache;
        if (c && c.file === file && c.mtimeMs === st.mtimeMs) return c.index;
        const index = JSON.parse(fs.readFileSync(file, 'utf-8'));
        this.builtinCache = { mtimeMs: st.mtimeMs, file, index };
        return index;
    }

    private userDir(user: string): string {
        const base = path.resolve(this.deps.userData, this.deps.encodeEmail(user));
        return path.join(base, USER_DIR);
    }

    private userFile(user: string, id: string): string | null {
        if (!ID_RE.test(id)) return null;
        const dir = this.userDir(user);
        const file = path.resolve(dir, id + '.json');
        return file.startsWith(dir + path.sep) ? file : null;
    }

    private readUserTemplate(file: string): any | null {
        try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return null; }
    }

    private listMine(user: string): any[] {
        const dir = this.userDir(user);
        let names: string[] = [];
        try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch (e) { return []; }
        const out: any[] = [];
        for (const n of names) {
            const t = this.readUserTemplate(path.join(dir, n));
            if (!t || !t.id) continue;
            const { payload, owner, ...meta } = t;
            out.push({ ...meta, source: 'mine' });
        }
        out.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
        return out;
    }

    updateAPI(app: any) {

        app.get('/analytics-templates/index', (req: any, res: any) => {
            try {
                const index = this.builtinIndex();
                const builtin = (index.templates || []).map((t: any) => ({ ...t, source: 'builtin' }));
                const user = userOf(req);
                const mine = user ? this.listMine(user) : [];
                res.setHeader('Cache-Control', 'no-store');
                return res.json({ ok: true, categories: index.categories || [], templates: [...mine, ...builtin] });
            } catch (e: any) {
                console.error('analytics-templates/index', e);
                return bad(res, 500, 'Could not read the template library.');
            }
        });

        app.get('/analytics-templates/item', (req: any, res: any) => {
            try {
                const id = text(req.query.id, 80);
                const source = text(req.query.source, 16) || 'builtin';
                if (!ID_RE.test(id)) return bad(res, 400, 'Missing or invalid template id.');

                if (source === 'mine') {
                    const user = userOf(req);
                    if (!user) return bad(res, 400, 'Missing user.');
                    const file = this.userFile(user, id);
                    const t = file && this.readUserTemplate(file);
                    if (!t || typeof t.payload !== 'string') return bad(res, 404, 'Template not found.');
                    const { payload, owner, ...meta } = t;
                    return res.json({
                        ok: true, rule_name: id + '.' + (EXT[t.kind] || 'ljt'), rule_type: EXT[t.kind] || 'ljt',
                        rule_value: payload, template: { ...meta, source: 'mine' },
                    });
                }

                const entry = (this.builtinIndex().templates || []).find((t: any) => t.id === id);
                if (!entry) return bad(res, 404, 'Template not found.');
                const root = this.templatesRoot();
                const file = path.resolve(root, String(entry.file || ''));
                if (!file.startsWith(root + path.sep)) return bad(res, 403, 'Access denied.');
                const value = fs.readFileSync(file, 'utf-8');
                return res.json({
                    ok: true, rule_name: entry.name, rule_type: path.extname(entry.name).slice(1),
                    rule_value: value, template: { ...entry, source: 'builtin' },
                });
            } catch (e: any) {
                if (e && e.code === 'ENOENT') return bad(res, 404, 'Template file not found.');
                console.error('analytics-templates/item', e);
                return bad(res, 500, 'Could not read the template.');
            }
        });

        app.post('/analytics-templates/publish', (req: any, res: any) => {
            try {
                const user = userOf(req);
                if (!user) return bad(res, 400, 'Missing user.');
                const b = req.body || {};
                const title = text(b.title, 120);
                const kind = text(b.kind, 16);
                const payload = typeof b.payload === 'string' ? b.payload : '';
                if (!title) return bad(res, 400, 'A template needs a title.');
                if (!KINDS.has(kind)) return bad(res, 400, 'kind must be table, model or timeline.');
                if (!payload) return bad(res, 400, 'Missing payload.');
                if (payload.length > MAX_PAYLOAD_CHARS) return bad(res, 413, 'Template is too large to publish.');

                let doc: any;
                try { doc = decodePayload(payload); } catch (e) { return bad(res, 400, 'Payload is not a saved table, model or timeline.'); }

                const dir = this.userDir(user);
                fs.mkdirSync(dir, { recursive: true });

                // An explicit id with replace=true overwrites that template; otherwise the title
                // picks the id and a clash gets a numeric suffix, so publishing never silently
                // replaces an earlier template.
                let id = text(b.id, 80);
                const replace = b.replace === true || b.replace === 'true';
                let previous: any = null;
                if (id && replace) {
                    if (!ID_RE.test(id)) return bad(res, 400, 'Invalid template id.');
                    previous = this.readUserTemplate(this.userFile(user, id) as string);
                } else {
                    const base = slug(id || title);
                    id = base;
                    for (let n = 2; fs.existsSync(path.join(dir, id + '.json')); n++) id = base + '-' + n;
                }
                const file = this.userFile(user, id);
                if (!file) return bad(res, 400, 'Invalid template id.');

                const now = new Date().toISOString();
                const tags = Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',');
                const template = {
                    schema: 'baja.analytics-templates.user/1',
                    id,
                    title,
                    kind,
                    category: text(b.category, 60) || 'mine',
                    description: text(b.description, MAX_TEXT),
                    tags: tags.map((t: any) => text(t, 40)).filter(Boolean).slice(0, 20),
                    status: 'ready',
                    created: (previous && previous.created) || now,
                    updated: now,
                    size: payload.length,
                    sha256: crypto.createHash('sha256').update(payload, 'latin1').digest('hex'),
                    summary: summarize(kind, doc),
                    owner: user,
                    payload,
                };
                // Write-then-rename so a crash mid-write cannot leave a half template behind.
                const tmp = file + '.' + process.pid + '.tmp';
                fs.writeFileSync(tmp, JSON.stringify(template));
                fs.renameSync(tmp, file);

                const { payload: _p, owner: _o, ...meta } = template;
                return res.json({ ok: true, template: { ...meta, source: 'mine' } });
            } catch (e: any) {
                console.error('analytics-templates/publish', e);
                return bad(res, 500, 'Could not publish the template.');
            }
        });

        app.post('/analytics-templates/delete', (req: any, res: any) => {
            try {
                const user = userOf(req);
                if (!user) return bad(res, 400, 'Missing user.');
                const id = text((req.body || {}).id, 80);
                const file = this.userFile(user, id);
                if (!file) return bad(res, 400, 'Invalid template id.');
                if (!fs.existsSync(file)) return bad(res, 404, 'Template not found.');
                fs.unlinkSync(file);
                return res.json({ ok: true });
            } catch (e: any) {
                console.error('analytics-templates/delete', e);
                return bad(res, 500, 'Could not delete the template.');
            }
        });
    }
}

// Exposed for tests.
export const __test = { decodePayload, summarize, slug, UUID_PREFIX };
