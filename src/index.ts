
const { TextEncoder, TextDecoder } = require('util');
import { ClientCertificateCredential } from '@azure/identity';
import { createHash } from 'crypto';
import Papa, { Parser } from 'papaparse';
import { promisify } from 'util';
import zlib from 'zlib';
import express from "express";
import path, { normalize } from "path";
import cors from "cors";
import simpleGit, { PullResult, ResetMode, SimpleGit } from "simple-git"
import fs from 'fs'
import dirTree from 'directory-tree'
import { Pool, Client } from 'pg'
import { DocTracker } from "./doctrac/doctrac-manager";
import { ELNDocTracker } from "./eln/elndocs";
import { DataIndex } from "./d-index";
import { TemplateServer } from "./usertemplates/template-server";
import { PyCompute } from "./pycompute/py-comp";
import { spawn, exec } from "child_process";
import Stripe from "stripe";
import { EnvConfig, environment } from "./environment";
import xlsx from 'node-xlsx';
import fetch from 'node-fetch';
import { Buffer } from 'buffer';
import { LJIO } from './index-io'
import { JsonDatabase } from './db/json-store';
import { gitcmd } from './git-cmd'
import * as readline from 'readline';
import tempfile from 'tempfile';
import multer from 'multer';
import bodyParser from "body-parser";
import dotenv from "dotenv";
import routes from "./routes";
import https from "https";

import 'isomorphic-fetch';
import { ClientSecretCredential } from '@azure/identity';
import { Client as GraphClient } from '@microsoft/microsoft-graph-client';
import type { InvocationContext } from '@azure/functions';
import 'isomorphic-fetch';
require('isomorphic-fetch'); // Required for Graph SDK
import sharp from "sharp";
import { pipeline } from "stream";
import type { IncomingMessage } from "http";
import type { ClientRequest } from "http";

const streamPipeline = (src: NodeJS.ReadableStream, dst: NodeJS.WritableStream) =>
    new Promise<void>((resolve, reject) => {
        pipeline(src, dst, (err) => (err ? reject(err) : resolve()));
    });

const REMOTE_BASE = "https://data.lajollalabs.com/ljdata/";

// Setup PostgreSQL connection (optional)
const pgPool = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: parseInt(process.env.PGPORT || '5432'),
});

dotenv.config();
const pako = require("pako");
const formData = require('form-data');
const fsPromises = require('fs').promises;
let cache: { [key: string]: any } = {}
const app = express();
const port = 8080; // default port to listen

// Increase the JSON payload size limit to 8GB
app.use(express.json({ limit: '8gb' })); // Note: Be cautious with such large limits
app.use(express.urlencoded({ limit: '8gb', extended: true })); // For URL-encoded payloads
app.use(bodyParser.json());
app.use("/api", routes);

import milestoneQueriesRouter from './models/mileston-db';
app.use('/ms', milestoneQueriesRouter);

const allowedOrigins = [
    '*',
];

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id'],
    credentials: true, // only if you use cookies; fine to keep true otherwise
    optionsSuccessStatus: 204,
}));

// app.use((req, _res, next) => {
//     // console.log('> ORIGIN:', req.headers.origin);
//     // console.log('> AUTH:', req.headers.authorization);
//     // console.log('> X-USER-ID:', req.headers['x-user-id']);
//     next();
// });























interface TranscriptPayload {
    transcriptId: string;
    sequence: string;
    annotations: Annotation[];
    strand: string | null;
    reversedForNegativeStrand: boolean;
    species?: string;
    // True while this species' local reference is still downloading/indexing,
    // so the client can tell the user the data came from the remote service.
    referencesLoading?: boolean;
    sequenceSource?: "cache" | "local" | "ensembl" | "none";
    annotationSource?: "local" | "ensembl" | "none";
}

app.get(['/transcript/:transcriptId', '/api/ensembl/transcript/:transcriptId'], async (req, res) => {
    try {
        const { transcriptId } = req.params;
        const prefix = (req.query.prefix as string) || ENSEMBL_REST_BASE;
        // Prefer an explicit species query param; otherwise infer it from the
        // transcript id prefix (ENST=human, ENSMUST=mouse, ENSRNOT=rat).
        const requestedSpecies = String(req.query.species || '').trim();
        const species = normalizeSpecies(
            requestedSpecies || speciesFromTranscriptId(transcriptId) || 'human'
        );
        const useReverseComplement = req.query.reverseComplement === 'true';

        if (!transcriptId) {
            return res.status(400).json({ error: 'transcriptId is required' });
        }

        if (!speciesRegistry[species]) {
            return res.status(400).json({
                error: `Species '${species}' is not configured`,
                availableSpecies: Object.keys(speciesRegistry),
            });
        }

        const result = await getTranscriptSequenceAndAnnotations(
            transcriptId,
            species,
            useReverseComplement,
            prefix
        );

        return res.json(result);
    } catch (error: any) {
        console.error('Error loading transcript sequence/annotations:', error);
        return res.status(500).json({
            error: 'Failed to load transcript sequence and annotations',
            details: error?.message || String(error)
        });
    }
});

// Server-side Ensembl proxies so the browser never calls rest.ensembl.org
// directly (which is CORS-blocked). They reuse the same retry/failsafe fetch
// helpers as the transcript endpoint.
app.get(['/api/ensembl/lookup/:id', '/ensembl/lookup/:id'], async (req: any, res: any) => {
    try {
        const id = String(req.params.id || '');
        const prefix = (req.query.prefix as string) || ENSEMBL_REST_BASE;
        const lookup = await fetchTranscriptLookup(id, prefix);
        return res.json(lookup);
    } catch (error: any) {
        return res.status(502).json({ error: error?.message || String(error) });
    }
});

app.get(['/api/ensembl/sequence/:id', '/ensembl/sequence/:id'], async (req: any, res: any) => {
    try {
        const id = String(req.params.id || '');
        const prefix = (req.query.prefix as string) || ENSEMBL_REST_BASE;
        const seq = await fetchEnsemblSequence(id, prefix);
        return res.type('text/plain').send(seq);
    } catch (error: any) {
        return res.status(502).json({ error: error?.message || String(error) });
    }
});

// Flanking genomic sequence for a chromosome region — display-only context showing where
// a track sits in the genome. Proxies Ensembl REST /sequence/region. Failsafe: any error
// returns an empty body (200) so the client never breaks on a missing flank.
app.get(['/api/ensembl/region', '/ensembl/region'], async (req: any, res: any) => {
    try {
        const species = String(req.query.species || 'human').trim() || 'human';
        const region = String(req.query.region || '').trim();   // e.g. "17:7668000..7669000:1"
        if (!region) return res.type('text/plain').send('');
        const prefix = (req.query.prefix as string) || ENSEMBL_REST_BASE;
        const url = `${prefix}/sequence/region/${species}/${region}?content-type=text/plain`;
        const r = await fetch(url, { headers: { Accept: 'text/plain' } });
        if (!r.ok) return res.type('text/plain').send('');
        const seq = (await r.text()).trim();
        return res.type('text/plain').send(seq);
    } catch (error: any) {
        return res.type('text/plain').send('');
    }
});

// Region variants from the major variant databases (ClinVar / dbSNP / gnomAD /
// COSMIC) for a genomic region. Proxies Ensembl overlap (variation / somatic_
// variation) and the gnomAD GraphQL API so the browser never calls them directly.
//   /variants/region?species=human&region=17:7676100-7676300&db=clinvar&limit=500
// Databases whose full data can be downloaded into the local reference store as a
// bgzipped + tabix-indexed VCF and queried by region locally (no live API call).
// NCBI ships ClinVar already bgzipped with a .tbi. dbSNP (~25 GB), gnomAD (per-chrom,
// huge) and COSMIC (license-gated) are NOT bulk-downloadable and stay on the live API.
const VARIANT_DB_SOURCES: Record<string, { vcf: string; tbi: string; local: string }> = {
    clinvar: {
        vcf: 'https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh38/clinvar.vcf.gz',
        tbi: 'https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh38/clinvar.vcf.gz.tbi',
        local: 'reference_data/variants/clinvar.vcf.gz',
    },
};

function variantDbLocalPath(db: string): string | null {
    const s = VARIANT_DB_SOURCES[db];
    return s ? path.resolve(s.local) : null;
}

function variantDbReady(db: string): boolean {
    const lp = variantDbLocalPath(db);
    return !!lp && fs.existsSync(lp) && fs.existsSync(lp + '.tbi');
}

// Is the `tabix` binary available? Cached after the first probe. When it isn't,
// local VCF queries can't run, so we fall back to the live API instead of silently
// returning nothing.
let _tabixOk: boolean | null = null;
function hasTabix(): Promise<boolean> {
    if (_tabixOk != null) return Promise.resolve(_tabixOk);
    return new Promise((resolve) => {
        try {
            const p = spawn('tabix', ['--version']);
            p.on('error', () => { _tabixOk = false; resolve(false); });
            p.on('close', (code) => { _tabixOk = (code === 0); resolve(_tabixOk); });
        } catch { _tabixOk = false; resolve(false); }
    });
}

const _variantDlInFlight: Record<string, boolean> = {};

// Download a database's VCF (+ .tbi index) into the reference location, once.
async function ensureVariantDb(db: string): Promise<boolean> {
    const s = VARIANT_DB_SOURCES[db];
    if (!s) return false;
    const lp = path.resolve(s.local);
    if (fs.existsSync(lp) && fs.existsSync(lp + '.tbi')) return true;
    if (_variantDlInFlight[db]) return false;
    _variantDlInFlight[db] = true;
    try {
        fs.mkdirSync(path.dirname(lp), { recursive: true });
        console.log(`[variants] ${db}: downloading ${s.vcf} -> ${lp}`);
        await downloadToFileProgress(s.vcf, lp, {
            onProgress: (w, t) => { if (t && Math.floor(w / t * 10) !== Math.floor((w - 1) / t * 10)) console.log(`[variants] ${db}: ${Math.floor(w / t * 100)}%`); },
        });
        await downloadToFileProgress(s.tbi, lp + '.tbi', {});
        const ok = fs.existsSync(lp) && fs.existsSync(lp + '.tbi');
        console.log(`[variants] ${db}: download ${ok ? 'complete' : 'FAILED'}`);
        return ok;
    } catch (e: any) {
        console.error(`[variants] ${db}: download failed:`, e?.message || e);
        return false;
    } finally {
        _variantDlInFlight[db] = false;
    }
}

function parseVcfInfo(info: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const kv of String(info || '').split(';')) {
        const i = kv.indexOf('=');
        if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
        else if (kv) out[kv] = '';
    }
    return out;
}

// Skip structural variants: alleles longer than this (bp) aren't point variants and
// would render as giant deletions/insertions.
const MAX_VARIANT_ALLELE = 50;

// Parse tabix/pysam VCF output lines into normalized variants.
function parseVcfLines(buf: string, db: string, limit: number): any[] {
    const out: any[] = [];
    for (const line of buf.split('\n')) {
        if (!line || line[0] === '#') continue;
        const f = line.split('\t');
        if (f.length < 8) continue;
        const pos = parseInt(f[1], 10);
        const ref = f[3];
        if (ref.length > MAX_VARIANT_ALLELE) continue;   // skip structural variants
        const info = parseVcfInfo(f[7]);
        let clinsig: string[] = [];
        if (info.CLNSIG) clinsig = info.CLNSIG.replace(/_/g, ' ').split(/[|,/]/).map((s) => s.trim()).filter(Boolean);
        const gene = (info.GENEINFO || '').split(':')[0] || null;
        const rid = info.RS ? 'rs' + info.RS : (f[2] && f[2] !== '.' ? f[2] : (db || 'variant'));
        for (const alt of String(f[4] || '').split(',')) {
            if (alt.length > MAX_VARIANT_ALLELE) continue;   // structural alt allele
            out.push({
                id: rid, chr: String(f[0]).replace(/^chr/, ''), start: pos, end: pos + Math.max(0, ref.length - 1),
                strand: 1, ref, alt, alleles: [ref, alt], clinsig,
                consequence: info.MC ? String(info.MC).split('|').pop() : null,
                source: db === 'clinvar' ? 'ClinVar' : db, af: null, gene,
            });
            if (out.length >= limit) return out;
        }
    }
    return out;
}

// Is Python's pysam importable? (Used to query indexed VCFs when the `tabix` CLI is
// absent — e.g. local dev.) Cached after first probe.
let _pysamOk: boolean | null = null;
function hasPysam(): Promise<boolean> {
    if (_pysamOk != null) return Promise.resolve(_pysamOk);
    return new Promise((resolve) => {
        try {
            const p = spawn('python3', ['-c', 'import pysam']);
            p.on('error', () => { _pysamOk = false; resolve(false); });
            p.on('close', (code) => { _pysamOk = (code === 0); resolve(_pysamOk); });
        } catch { _pysamOk = false; resolve(false); }
    });
}

const PYSAM_FETCH = 'import sys,pysam\n' +
    'vcf=sys.argv[1]; region=sys.argv[2]\n' +
    'chrom,rest=region.split(":",1); s,e=rest.split("-",1)\n' +
    'tb=pysam.TabixFile(vcf)\n' +
    'for row in tb.fetch(chrom, max(0,int(s)-1), int(e)):\n' +
    '    sys.stdout.write(row+"\\n")\n';

// Query a locally-downloaded, tabix-indexed VCF by region — via the `tabix` binary
// when present, otherwise via pysam (same bgzip/tbi files).
function queryLocalVcf(file: string, chr: string, start: number, end: number, db: string, limit: number): Promise<any[]> {
    return new Promise(async (resolve) => {
        const region = `${chr}:${start}-${end}`;
        const useTabix = await hasTabix();
        const p = useTabix
            ? spawn('tabix', [file, region])
            : spawn('python3', ['-c', PYSAM_FETCH, file, region]);
        let buf = '';
        p.stdout.on('data', (d) => { buf += d.toString(); });
        p.on('error', () => resolve([]));
        p.on('close', () => resolve(parseVcfLines(buf, db, limit)));
    });
}

async function fetchGnomadRegion(chr: string, start: number, end: number, limit: number): Promise<any[]> {
    try {
        const query = `query($chrom:String!,$start:Int!,$stop:Int!){region(chrom:$chrom,start:$start,stop:$stop,reference_genome:GRCh38){variants(dataset:gnomad_r4){variant_id pos ref alt genome{af}exome{af}}}}`;
        const r = await fetch('https://gnomad.broadinstitute.org/api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ query, variables: { chrom: String(chr).replace(/^chr/, ''), start, stop: end } }),
        });
        if (!r.ok) return [];
        const j: any = await r.json();
        const vs: any[] = j?.data?.region?.variants || [];
        return vs.slice(0, limit).map((v: any) => {
            const af = (v.genome && v.genome.af != null) ? v.genome.af : (v.exome && v.exome.af != null ? v.exome.af : null);
            return {
                id: v.variant_id, chr: String(chr).replace(/^chr/, ''), start: v.pos, end: v.pos,
                strand: 1, ref: v.ref, alt: v.alt, alleles: [v.ref, v.alt],
                clinsig: [], consequence: null, source: 'gnomAD', af,
            };
        });
    } catch { return []; }
}

// One Ensembl overlap call (variation / somatic_variation) -> normalized variants.
async function fetchEnsemblOverlapVariants(species: string, chr: string, start: number, end: number, feature: string): Promise<any[]> {
    const url = `${ENSEMBL_REST_BASE}/overlap/region/${species}/${chr}:${start}-${end}?feature=${feature}`;
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`ensembl ${r.status}`);
    const arr: any[] = await r.json();
    const out: any[] = [];
    for (const v of arr) {
        const alleles = Array.isArray(v.alleles) ? v.alleles : [];
        const clin = Array.isArray(v.clinical_significance) ? v.clinical_significance : [];
        out.push({
            id: v.id, chr: String(v.seq_region_name || chr).replace(/^chr/, ''),
            start: v.start, end: v.end, strand: v.strand,
            ref: alleles[0] || '', alt: alleles[1] || '', alleles,
            clinsig: clin, consequence: v.consequence_type,
            source: v.source || (feature === 'somatic_variation' ? 'COSMIC' : 'dbSNP'), af: null,
        });
    }
    return out;
}

// Region-scoped dbSNP cache: dbSNP is far too large to download whole, so we cache
// just the queried genomic windows into the reference store as fixed 10 kb tiles
// (reference_data/variants/dbsnp_cache/<chr>_<bin>.json). Overlapping queries reuse
// the tiles; only never-seen windows hit Ensembl.
const DBSNP_BIN = 10000;      // 10 kb tiles
const DBSNP_MAX_BINS = 16;    // cap coverage per request (160 kb) to bound work
const _dbsnpBinInFlight: Record<string, Promise<any[]>> = {};

function dbsnpCacheDir(): string { return path.resolve('reference_data/variants/dbsnp_cache'); }

async function dbsnpTile(species: string, chr: string, bin: number): Promise<any[]> {
    const file = path.join(dbsnpCacheDir(), `${chr}_${bin}.json`);
    try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* refetch */ }
    const key = `${species}:${chr}:${bin}`;
    if (_dbsnpBinInFlight[key]) return _dbsnpBinInFlight[key];
    const p = (async () => {
        const s = bin * DBSNP_BIN + 1, e = (bin + 1) * DBSNP_BIN;
        let vs: any[] = [];
        try { vs = await fetchEnsemblOverlapVariants(species, chr, s, e, 'variation'); } catch { vs = []; }
        try { fs.mkdirSync(dbsnpCacheDir(), { recursive: true }); fs.writeFileSync(file, JSON.stringify(vs)); } catch { }
        return vs;
    })();
    _dbsnpBinInFlight[key] = p;
    try { return await p; } finally { delete _dbsnpBinInFlight[key]; }
}

async function ensureDbsnpRegionCache(species: string, chr: string, start: number, end: number, limit: number): Promise<{ variants: any[]; source: string; binsCapped: boolean }> {
    const firstBin = Math.floor(start / DBSNP_BIN), lastBin = Math.floor(end / DBSNP_BIN);
    const bins: number[] = [];
    for (let b = firstBin; b <= lastBin && bins.length < DBSNP_MAX_BINS; b++) bins.push(b);
    const binsCapped = (lastBin - firstBin + 1) > bins.length;
    let anyCached = false, anyFetched = false;
    const seen = new Set<string>();
    const out: any[] = [];
    for (const b of bins) {
        const wasCached = fs.existsSync(path.join(dbsnpCacheDir(), `${chr}_${b}.json`));
        const vs = await dbsnpTile(species, chr, b);
        if (wasCached) anyCached = true; else anyFetched = true;
        for (const v of vs) {
            if (v.start < start || v.start > end) continue;
            const k = (v.id || '') + ':' + v.start + ':' + (v.alt || '');
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(v);
            if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
    }
    const source = (anyCached && anyFetched) ? 'local-cache+live' : (anyCached ? 'local-cache' : 'live-cached');
    return { variants: out, source, binsCapped };
}

app.get(['/api/variants/region', '/variants/region'], async (req: any, res: any) => {
    const db = String(req.query.db || 'clinvar').trim().toLowerCase();
    try {
        const species = String(req.query.species || 'human').trim() || 'human';
        const region = String(req.query.region || '').trim();   // "17:7676100-7676300"
        const limit = Math.max(1, Math.min(2000, parseInt(String(req.query.limit || '500'), 10) || 500));
        if (!region) return res.json({ db, variants: [], error: 'no region' });
        const m = region.match(/^(\w+):(\d+)-(\d+)$/);
        if (!m) return res.json({ db, variants: [], error: 'bad region' });
        const chr = m[1].replace(/^chr/, ''), start = parseInt(m[2], 10), end = parseInt(m[3], 10);

        // Prefer a locally-downloaded copy in the reference store (fast, no live call) —
        // when a local query engine (tabix CLI or pysam) is available; otherwise fall
        // through to the live API rather than silently returning nothing.
        if (variantDbReady(db) && (await hasTabix() || await hasPysam())) {
            const variants = await queryLocalVcf(variantDbLocalPath(db)!, chr, start, end, db, limit);
            const total = variants.length;
            return res.json({ db, region, source: 'local', total, count: variants.length, truncated: false, variants });
        }
        // Downloadable DB not present yet -> fetch it into the reference store for next time,
        // and serve this request from the live API meanwhile.
        if (VARIANT_DB_SOURCES[db]) { ensureVariantDb(db).catch(() => { }); }

        // dbSNP is too large to download whole -> serve from a region-scoped tile cache
        // in the reference store (only queried windows are fetched + persisted).
        if (db === 'dbsnp') {
            const cached = await ensureDbsnpRegionCache(species, chr, start, end, limit);
            return res.json({
                db, region, source: cached.source, count: cached.variants.length,
                truncated: cached.variants.length >= limit, binsCapped: cached.binsCapped,
                variants: cached.variants,
            });
        }

        let variants: any[] = [];
        if (db === 'gnomad') {
            variants = await fetchGnomadRegion(chr, start, end, limit);
        } else {
            const feature = (db === 'cosmic') ? 'somatic_variation' : 'variation';
            try {
                variants = await fetchEnsemblOverlapVariants(species, chr, start, end, feature);
            } catch (e: any) {
                return res.json({ db, variants: [], error: e?.message || String(e) });
            }
            // ClinVar = the clinically-annotated subset of the variation set.
            if (db === 'clinvar') variants = variants.filter((x) => (x.clinsig || []).length > 0);
        }
        const total = variants.length;
        const truncated = total > limit;
        if (truncated) variants = variants.slice(0, limit);
        return res.json({ db, region, source: 'live', total, count: variants.length, truncated, variants });
    } catch (error: any) {
        return res.json({ db, variants: [], error: error?.message || String(error) });
    }
});

// Download a variant database into the reference store (only the bulk-downloadable
// ones — currently ClinVar). dbSNP/gnomAD/COSMIC are not bulk-downloadable and are
// served from the live API instead.
app.get(['/api/variants/install/:db', '/variants/install/:db'], async (req: any, res: any) => {
    const db = String(req.params.db || '').trim().toLowerCase();
    if (!VARIANT_DB_SOURCES[db]) {
        return res.json({ db, ok: false, error: 'no bulk-downloadable source (dbsnp/gnomad/cosmic use the live API); downloadable: ' + Object.keys(VARIANT_DB_SOURCES).join(', ') });
    }
    try {
        const ok = await ensureVariantDb(db);
        return res.json({ db, ok, ready: variantDbReady(db), path: variantDbLocalPath(db) });
    } catch (e: any) {
        return res.json({ db, ok: false, error: e?.message || String(e) });
    }
});

// Proactively install (download + index) local reference data for a species, or
// "all" for human/mouse/rat. Lets an operator warm the references so the first
// transcript request doesn't pay the (potentially large) download cost.
app.get('/reference/install/:species', async (req: any, res: any) => {
    try {
        const raw = String(req.params.species || 'all').trim().toLowerCase();
        const targets = raw === 'all'
            ? ['human', 'mouse', 'rat']
            : [normalizeSpecies(raw)];

        const report: any[] = [];
        for (const sp of targets) {
            if (!speciesRegistry[sp]) {
                report.push({ species: sp, ok: false, error: 'not configured' });
                continue;
            }
            try {
                await loadSpeciesAnnotations(sp);
                await loadSpeciesCdna(sp);
                report.push({
                    species: sp,
                    ok: true,
                    annotations: Object.keys(annotationsCache[sp] || {}).length,
                    transcripts: Object.keys(cdnaCache[sp] || {}).length,
                });
            } catch (e: any) {
                report.push({ species: sp, ok: false, error: e?.message || String(e) });
            }
        }
        return res.json({ installed: report });
    } catch (error: any) {
        return res.status(500).json({ error: error?.message || String(error) });
    }
});

// Which local references are currently downloaded + indexed in memory.
app.get('/reference/status', (_req: any, res: any) => {
    const status: Record<string, any> = {};
    for (const sp of Object.keys(speciesRegistry)) {
        status[sp] = {
            annotationsLoaded: loadedSpecies.has(sp),
            annotations: Object.keys(annotationsCache[sp] || {}).length,
            cdnaLoaded: loadedCdna.has(sp),
            transcripts: Object.keys(cdnaCache[sp] || {}).length,
            hasCdnaConfig: !!speciesRegistry[sp].cdnaUrl,
        };
    }
    res.json(status);
});












LJIO.init();
const ljio = new LJIO();
let wd = environment.wd;
const devPath = environment.devPath;
const htsFilesPath = environment.htsFilesPath;
const bigDataFilesPath = environment.bigDataFilesPath;
const configPath = environment.configPath;
const userData = environment.userData;
const ott_root = environment.ott_root;
const offtarget_index_root = path.resolve(
    (environment as any).offtarget_index_root || 'reference_data/offtarget_index');


let git: SimpleGit | null = null;

try {
    git = simpleGit(wd)
} catch (exception) {
    console.log(" Failed to find the path " + wd)
}
const dbconfig = {
    host: '',
    user: 'blust',
    password: 'test!!',
    database: 'test',
    port: 5432,
    ssl: true
}
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");
const docTrack = new DocTracker();
docTrack.updateAPI(app);
const dataindex = new DataIndex();
dataindex.updateAPI(app);
const templateServer = new TemplateServer();
templateServer.updateAPI(app);
const pyComp = new PyCompute();
pyComp.updateAPI(app);
const cachd = new Map();








// src/types/milestones.ts

export interface Scope {
    minPxPerMonth?: number | null;
    maxPxPerMonth?: number | null;
    minPxPerDay?: number | null;
    maxPxPerDay?: number | null;
    minPxPerHour?: number | null;
    maxPxPerHour?: number | null;
}

export interface Milestone {
    x: number;
    y: number;
    type: 'milestone' | string;
    name: string;
    color?: string;
    date: string;        // ISO string coming from client
    url?: string | null;
    scope?: Scope;
}

export interface WindowRange {
    start: string;       // ISO string
    end: string;         // ISO string
}

export interface SaveMilestoneQueryBody {
    queryString: string;
    date?: string;       // optional, default to now if missing
    window: WindowRange;
    milestones: Milestone[];
}




/**
 * Load a GFF3 file into memory.
 * @param {string} filePath - Path to the GFF3 file.
 * @returns {Promise<string[]>} - A promise that resolves to an array of lines from the GFF3 file.
 */
async function loadGFF3_from_file(filePath: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const fileStream = fs.createReadStream(filePath);
        const decompressedStream = filePath.endsWith('.gz') ? fileStream.pipe(zlib.createGunzip()) : fileStream;

        const lines: string[] = [];
        const rl = readline.createInterface({
            input: decompressedStream,
            crlfDelay: Infinity
        });

        rl.on('line', (line: string) => {
            lines.push(line);
        });

        rl.on('close', () => {
            resolve(lines);
        });

        rl.on('error', (err: Error) => {
            reject(err);
        });
    });
}

const annotationsCache: AnnotationCache = {};



const scriptPath = '/ljconfig/util/set_env_vars.sh';
fs.access(scriptPath, fs.constants.F_OK, (err: any) => {
    if (err) {
        // Optional deployment env-setup script; skip quietly when it's absent.
        return;
    }
    console.log(' Setting the environment variables ')
    console.log('' + scriptPath)
    exec(`sh ${scriptPath}`, (error: any, stdout: any, stderr: any) => {
        if (error) {
            console.error(`Execution error: ${error}`);
            return;
        }
        if (stderr) {
            console.error(`Error output: ${stderr}`);
        }
        console.log(`Standard output: ${stdout}`);
    });
});



function ensureDirectoryExists(folderPath: string): void {
    // Use the path module to resolve the full path
    const resolvedPath = path.resolve(folderPath);

    // Check if the folder exists
    if (!fs.existsSync(resolvedPath)) {
        // If it doesn't exist, create the folder
        fs.mkdirSync(resolvedPath, { recursive: true });
        console.log(`Directory created: ${resolvedPath}`);
    } else {
        console.log(`Directory already exists: ${resolvedPath}`);
    }
}


/**
 * Parse the attributes column of the GFF3 file into a dictionary.
 * @param {string} attributesStr - The attributes string from a GFF3 file.
 * @returns {Record<string, string>} - A dictionary of attributes.
 */
function parseAttributes(attributesStr: string): Record<string, string> {
    const attributes: Record<string, string> = {};
    for (const attr of attributesStr.split(';')) {
        if (attr.trim()) {
            const [key, value] = attr.trim().split('=');
            attributes[key] = value;
        }
    }
    return attributes;
}

// Load the entire GFF3 file into memory.
async function loadGFF3(filePath: string): Promise<Record<string, Annotation[]>> {
    const annotations: Record<string, Annotation[]> = {};

    const resolvedPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(process.cwd(), filePath);

    try {
        await fs.promises.access(resolvedPath, fs.constants.R_OK);
    } catch {
        throw new Error(`[loadGFF3] File missing or unreadable: ${resolvedPath}`);
    }

    return new Promise((resolve, reject) => {
        let settled = false;

        const finishResolve = () => {
            if (!settled) {
                settled = true;
                resolve(annotations);
            }
        };

        const finishReject = (err: unknown) => {
            if (!settled) {
                settled = true;
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        };

        const fileStream = fs.createReadStream(resolvedPath);

        fileStream.on("error", (err: NodeJS.ErrnoException) => {
            finishReject(
                new Error(`[loadGFF3] ReadStream error for ${resolvedPath}: ${err.code ?? err.message}`)
            );
        });

        const inputStream = resolvedPath.endsWith(".gz")
            ? fileStream.pipe(zlib.createGunzip())
            : fileStream;

        inputStream.on("error", (err: NodeJS.ErrnoException) => {
            finishReject(
                new Error(`[loadGFF3] Decompression/stream error for ${resolvedPath}: ${err.code ?? err.message}`)
            );
        });

        const rl = readline.createInterface({
            input: inputStream,
            crlfDelay: Infinity,
        });

        rl.on("line", (line: string) => {
            if (!line || line.startsWith("#")) return;

            const fields = line.split("\t");
            if (fields.length < 9) return;

            const attributes = parseAttributes(fields[8]);

            // Prefer transcript_id when present, but fall back for GFF3 sources
            // that use ID/Parent/transcript_name/etc.
            const rawTranscriptId =
                attributes.transcript_id ||
                attributes.transcriptId ||
                (fields[2] === "transcript" ? attributes.ID : undefined) ||
                attributes.Parent;

            if (!rawTranscriptId) return;

            // Parent can be comma-separated in some files
            const transcriptIds = rawTranscriptId
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);

            if (transcriptIds.length === 0) return;

            const annotation: Annotation = {
                seqname: fields[0],
                source: fields[1],
                feature: fields[2],
                start: fields[3],
                end: fields[4],
                score: fields[5],
                strand: fields[6],
                frame: fields[7],
                attributes,
            };

            for (const transcriptId of transcriptIds) {
                // Ensembl GFF3 ids look like "transcript:ENSMUST00000..."; strip
                // the "<type>:" prefix so keys match the bare stable id the client
                // requests. GENCODE (human) ids have no colon and are unaffected.
                const bare = transcriptId.includes(":")
                    ? transcriptId.slice(transcriptId.lastIndexOf(":") + 1)
                    : transcriptId;
                const strippedId = stripDecimal(bare);
                (annotations[strippedId] ??= []).push(annotation);
            }
        });

        rl.on("close", finishResolve);

        rl.on("error", (err: NodeJS.ErrnoException) => {
            finishReject(
                new Error(`[loadGFF3] readline error for ${resolvedPath}: ${err.code ?? err.message}`)
            );
        });
    });
}
// -----------------------------------------------------------------------------------------
// -----------------------------------------------------------------------------------------
// -----------------------------------------------------------------------------------------


interface Annotation {
    seqname: string;
    source: string;
    feature: string;
    start: string;
    end: string;
    score: string;
    strand: string;
    frame: string;
    attributes: Record<string, string>;
}

interface TranscriptPayload {
    transcriptId: string;
    sequence: string;
    annotations: Annotation[];
    strand: string | null;
    reversedForNegativeStrand: boolean;
    species?: string;
    // True while this species' local reference is still downloading/indexing,
    // so the client can tell the user the data came from the remote service.
    referencesLoading?: boolean;
    sequenceSource?: "cache" | "local" | "ensembl" | "none";
    annotationSource?: "local" | "ensembl" | "none";
}

const ENSEMBL_REST_BASE = "https://rest.ensembl.org";

type SpeciesConfig = {
    filePath: string;        // GFF3 annotations (local path)
    remoteUrl: string;       // GFF3 download url
    cdnaPath?: string;       // transcript cDNA FASTA (local path)
    cdnaUrl?: string;        // cDNA FASTA download url
    ncrnaPath?: string;      // non-coding RNA FASTA (local path)
    ncrnaUrl?: string;       // ncRNA FASTA download url
    aliases?: string[];      // alternative names (Ensembl species name, assembly, ...)
};

type SpeciesRegistry = Record<string, SpeciesConfig>;
type AnnotationCache = Record<string, Record<string, Annotation[]>>;

const ENSEMBL_FTP = "https://ftp.ensembl.org/pub/release-110";

const speciesRegistry: SpeciesRegistry = {
    human: {
        // GENCODE COMPREHENSIVE (all isoforms, every biotype) — the basic set
        // and Ensembl cdna.all/ncrna omit minor isoforms (retained_intron,
        // processed_transcript, NMD, …), which forced Ensembl REST fallbacks.
        filePath: "./reference_data/human.gencode.annotation.gff3.gz",
        remoteUrl: "https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_human/release_46/gencode.v46.annotation.gff3.gz",
        cdnaPath: "./reference_data/human.gencode.transcripts.fa.gz",
        cdnaUrl: "https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_human/release_46/gencode.v46.transcripts.fa.gz",
        aliases: ["homo_sapiens", "hsapiens", "grch38", "hg38"],
    },
    mouse: {
        filePath: "./reference_data/mouse.annotation.gff3.gz",
        remoteUrl: `${ENSEMBL_FTP}/gff3/mus_musculus/Mus_musculus.GRCm39.110.gff3.gz`,
        cdnaPath: "./reference_data/mouse.cdna.all.fa.gz",
        cdnaUrl: `${ENSEMBL_FTP}/fasta/mus_musculus/cdna/Mus_musculus.GRCm39.cdna.all.fa.gz`,
        ncrnaPath: "./reference_data/mouse.ncrna.fa.gz",
        ncrnaUrl: `${ENSEMBL_FTP}/fasta/mus_musculus/ncrna/Mus_musculus.GRCm39.ncrna.fa.gz`,
        aliases: ["mus_musculus", "mmusculus", "grcm39", "mm39", "mm10"],
    },
    rat: {
        filePath: "./reference_data/rat.annotation.gff3.gz",
        remoteUrl: `${ENSEMBL_FTP}/gff3/rattus_norvegicus/Rattus_norvegicus.mRatBN7.2.110.gff3.gz`,
        cdnaPath: "./reference_data/rat.cdna.all.fa.gz",
        cdnaUrl: `${ENSEMBL_FTP}/fasta/rattus_norvegicus/cdna/Rattus_norvegicus.mRatBN7.2.cdna.all.fa.gz`,
        ncrnaPath: "./reference_data/rat.ncrna.fa.gz",
        ncrnaUrl: `${ENSEMBL_FTP}/fasta/rattus_norvegicus/ncrna/Rattus_norvegicus.mRatBN7.2.ncrna.fa.gz`,
        aliases: ["rattus_norvegicus", "rnorvegicus", "mratbn7", "rn7"],
    },
    yeast: {
        filePath: "./reference_data/yeast.annotation.gff3.gz",
        remoteUrl: "https://ftp.ensembl.org/pub/release-110/gff3/saccharomyces_cerevisiae/Saccharomyces_cerevisiae.R64-1-1.110.gff3.gz",
        aliases: ["saccharomyces_cerevisiae", "s_cerevisiae", "scerevisiae"],
    },
    dog: {
        filePath: "./reference_data/dog.annotation.gff3.gz",
        remoteUrl: "https://ftp.ensembl.org/pub/release-110/gff3/canis_lupus_familiaris/Canis_lupus_familiaris.ROS_Cfam_1.0.110.gff3.gz",
        aliases: ["canis_lupus_familiaris"],
    },
};

// Lazily-loaded per-species transcript cDNA index (stripped transcript id -> sequence).
const cdnaCache: Record<string, Record<string, string>> = {};
const loadedCdna = new Set<string>();
const loadingCdna = new Map<string, Promise<void>>();
// const annotationsCache: AnnotationCache = {};
const sequenceCache: Record<string, string> = {};
const loadedSpecies = new Set<string>();
const loadingSpecies = new Map<string, Promise<void>>();

function cacheKey(species: string, transcriptId: string): string {
    return `${species}:${stripDecimal(transcriptId)}`;
}

function fileReadable(filePath: string): boolean {
    try {
        fs.accessSync(filePath, fs.constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

function ensureParentDirectory(filePath: string): void {
    const dir = path.dirname(path.resolve(filePath));
    fs.mkdirSync(dir, { recursive: true });
}

function stripDecimal(transcriptId: string): string {
    return transcriptId.split(".")[0];
}

function reverseSequence(seq: string): string {
    return seq.split("").reverse().join("");
}

function reverseComplement(seq: string): string {
    const complement: Record<string, string> = {
        A: "T", T: "A", C: "G", G: "C",
        a: "t", t: "a", c: "g", g: "c",
        N: "N", n: "n"
    };

    return seq
        .split("")
        .reverse()
        .map(base => complement[base] ?? base)
        .join("");
}

// Map an incoming species label (common name, Ensembl name, assembly, ...) to a
// registry key. Unknown values are returned as-is for the caller to validate.
function normalizeSpecies(species: string | null | undefined): string {
    if (!species) return "human";
    const s = String(species).trim().toLowerCase();
    if (speciesRegistry[s]) return s;
    for (const key of Object.keys(speciesRegistry)) {
        if ((speciesRegistry[key].aliases || []).includes(s)) return key;
    }
    return s;
}

// Infer species from an Ensembl transcript stable id prefix.
//   ENST… = human, ENSMUST… = mouse, ENSRNOT… = rat.
function speciesFromTranscriptId(transcriptId: string): string | null {
    const id = String(transcriptId || "").toUpperCase();
    if (id.startsWith("ENSMUST")) return "mouse";
    if (id.startsWith("ENSRNOT")) return "rat";
    if (id.startsWith("ENST")) return "human";
    return null;
}

// Stream a (optionally gzipped) transcriptome cDNA FASTA into a
// { strippedTranscriptId -> sequence } map without buffering the whole file.
function loadCdnaFastaToMap(filePath: string): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
        const map: Record<string, string> = {};
        const fileStream = fs.createReadStream(filePath);
        const input = filePath.endsWith(".gz")
            ? fileStream.pipe(zlib.createGunzip())
            : fileStream;
        const rl = readline.createInterface({ input, crlfDelay: Infinity });

        let currentId: string | null = null;
        let chunks: string[] = [];

        const flush = () => {
            if (currentId && chunks.length) {
                map[currentId] = chunks.join("");
            }
            chunks = [];
        };

        rl.on("line", (line: string) => {
            if (line.startsWith(">")) {
                flush();
                // Ensembl header: ">ENST00000371953.8 cdna chromosome:..."
                // GENCODE header: ">ENST00000371953.8|ENSG...|...|GENE|..."
                const firstTok = line.slice(1).trim().split(/\s+/)[0] || "";
                const idTok = firstTok.split("|")[0];   // GENCODE is pipe-delimited
                currentId = stripDecimal(idTok);
            } else if (currentId) {
                chunks.push(line.trim());
            }
        });
        rl.on("close", () => { flush(); resolve(map); });
        rl.on("error", (err: Error) => reject(err));
        fileStream.on("error", (err: Error) => reject(err));
    });
}

// Ensure a species reference FASTA (cDNA or ncRNA) is present locally,
// downloading it on demand. Returns the local path, or null if not configured.
async function ensureFastaFile(
    species: string,
    localPath: string | undefined,
    url: string | undefined,
    label: string
): Promise<string | null> {
    if (!localPath || !url) return null;

    const resolvedPath = path.resolve(localPath);
    if (fileReadable(resolvedPath)) {
        console.log(`[${label}] ${species}: file already present -> ${resolvedPath}`);
        ensureOffTargetIndex(resolvedPath, deriveIndexName(species, label));
        return resolvedPath;
    }

    ensureParentDirectory(resolvedPath);
    console.log(`[${label}] ${species}: file missing, downloading from ${url}`);

    let lastPct = -1;
    await downloadToFileProgress(url, resolvedPath, {
        onStart: (total) => {
            console.log(
                `[${label}] ${species}: download started` +
                (total ? ` (${(total / 1024 / 1024).toFixed(2)} MB)` : "")
            );
        },
        onProgress: (written, total) => {
            if (!total) return;
            const pct = Math.floor((written / total) * 100);
            if (pct >= lastPct + 10 || pct === 100) {
                lastPct = pct;
                console.log(`[${label}] ${species}: ${pct}%`);
            }
        },
        onDone: () => console.log(`[${label}] ${species}: download complete`),
        onInfo: (msg) => console.log(`[${label}] ${species}: ${msg}`),
    });

    if (!fileReadable(resolvedPath)) {
        throw new Error(`${label} for '${species}' downloaded but is unreadable`);
    }
    ensureOffTargetIndex(resolvedPath, deriveIndexName(species, label));
    return resolvedPath;
}

// ---------------------------------------------------------------------------
// Local off-target index management (2-bit + seed index) — see
// baja-apps/py/sequence/offtarget/{build-index,search}.py.
// ---------------------------------------------------------------------------

// Legacy / UI-default genome names -> on-disk index directory names.
// Keep in sync with _ALIASES in search.py.
const OFFTARGET_ALIASES: Record<string, string> = {
    "Homo_sapiens.GRCh38.88.3utr": "human_all_transcripts",
    "3UTR_human": "human_3utr",
    "3UTR_mouse": "mouse_3utr",
};

function deriveIndexName(species: string, label: string): string {
    return `${species}_${label}`.replace(/[^A-Za-z0-9._-]/g, "_");
}

function hasLocalIndex(name: string): boolean {
    try {
        return !!offtarget_index_root &&
            fs.existsSync(path.join(offtarget_index_root, name, "meta.json"));
    } catch { return false; }
}

// Map a requested genome name to a locally-built index dir name (or null).
function resolveLocalIndexName(name: string): string | null {
    const n = (name || "").trim();
    if (hasLocalIndex(n)) return n;
    const a = OFFTARGET_ALIASES[n];
    if (a && hasLocalIndex(a)) return a;
    return null;
}

// Fire-and-forget: build a 2-bit/seed index for a freshly-available FASTA.
// No-op if an index (meta.json) already exists or a build is already running.
function ensureOffTargetIndex(fastaPath: string, name: string): void {
    try {
        if (!offtarget_index_root) return;
        const dir = path.join(offtarget_index_root, name);
        if (fs.existsSync(path.join(dir, "meta.json"))) return;      // already built
        const lock = dir + ".building";
        if (fs.existsSync(lock)) return;                             // build in progress
        fs.mkdirSync(offtarget_index_root, { recursive: true });
        try { fs.writeFileSync(lock, String(Date.now())); } catch { }
        const script = path.join(wd, "py/sequence/offtarget/build-index.py");
        const env = buildPythonEnv({ protocol: "http", get: () => "" } as any);
        console.log(`[offtarget] building index '${name}' from ${fastaPath}`);
        const p = spawn("python3", ["-u", script, fastaPath, offtarget_index_root, name],
            { env, detached: true, stdio: "ignore" });
        const clearLock = () => { try { fs.unlinkSync(lock); } catch { } };
        p.on("close", (code) => {
            clearLock();
            console.log(`[offtarget] index '${name}' build exited (${code})`);
        });
        p.on("error", (e) => { clearLock(); console.error("[offtarget] build spawn:", e); });
        p.unref();
    } catch (e) {
        console.error("ensureOffTargetIndex:", e);
    }
}

// Run the local off-target search (spawn search.py, parse its single
// IONWORKS:RESOLUTION line synchronously) and resolve the oligoQuery result.
async function runSearchLocal(
    req: any, names: string[], oligos: any, k: number, strand: string, runMode: string
): Promise<any> {
    const argfile = path.join(os.tmpdir(),
        `ott-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
    fs.writeFileSync(argfile, JSON.stringify(
        { "1": names, "2": oligos, "3": k, "4": strand, "5": runMode }));
    const script = path.join(wd, "py/sequence/offtarget/search.py");
    const env = buildPythonEnv(req);
    return await new Promise((resolve) => {
        const p = spawn("python3", ["-u", script, "jfile:" + argfile], { env });
        let out = "";
        p.stdout.on("data", (d) => { out += d.toString(); });
        p.stderr.on("data", (d) => console.error("search.py: " + d));
        p.on("close", () => {
            try { fs.unlinkSync(argfile); } catch { }
            const line = out.split("\n").find((l) => l.startsWith("IONWORKS:RESOLUTION:"));
            try { resolve(line ? JSON.parse(line.split("\t")[1]) : { oligoQuery: [] }); }
            catch { resolve({ oligoQuery: [] }); }
        });
        p.on("error", (e) => { console.error("search.py spawn:", e); resolve({ oligoQuery: [] }); });
    });
}

// Startup diagnostic: confirm the python3 that runs the off-target search has
// numpy (its only hard dependency), and report how many local indexes exist.
function checkOffTargetPython(): void {
    try {
        let count = 0;
        try {
            if (offtarget_index_root && fs.existsSync(offtarget_index_root)) {
                count = fs.readdirSync(offtarget_index_root).filter(
                    (n) => fs.existsSync(path.join(offtarget_index_root, n, "meta.json"))).length;
            }
        } catch { }
        console.log(`[offtarget] index dir: ${offtarget_index_root} (${count} local index${count === 1 ? "" : "es"})`);
        const env = buildPythonEnv({ protocol: "http", get: () => "" } as any);
        const p = spawn("python3",
            ["-c", "import numpy,sys; sys.stdout.write(numpy.__version__)"], { env });
        let out = "", err = "";
        p.stdout.on("data", (d) => { out += d.toString(); });
        p.stderr.on("data", (d) => { err += d.toString(); });
        p.on("close", (code) => {
            if (code === 0 && out.trim()) {
                console.log(`[offtarget] python3 OK — numpy ${out.trim()}; local off-target search enabled`);
            } else {
                console.warn(
                    "[offtarget] WARNING: the python3 used for off-target search is missing numpy — " +
                    "local off-target search will fail and requests will fall back to the external worker. " +
                    "Install it in that interpreter (e.g. `pip install numpy`)." +
                    (err.trim() ? " Detail: " + err.trim() : ""));
            }
        });
        p.on("error", (e: any) => {
            console.warn("[offtarget] WARNING: could not run python3 for off-target search: " +
                (e?.message || e) + " — local off-target search disabled (external-worker fallback).");
        });
    } catch (e) {
        console.error("[offtarget] python check error:", e);
    }
}

// Ensure + index a species' transcript sequences into memory (once), combining
// the coding cDNA and non-coding RNA FASTAs so both coding and ncRNA transcripts
// resolve locally. Species without configured FASTAs are marked loaded (empty)
// so callers fall back to Ensembl gracefully.
async function loadSpeciesCdna(species: string): Promise<void> {
    if (loadedCdna.has(species)) return;

    const inFlight = loadingCdna.get(species);
    if (inFlight) { await inFlight; return; }

    const p = (async () => {
        const cfg = speciesRegistry[species];
        const map: Record<string, string> = cdnaCache[species] || {};

        const sources: [string | undefined, string | undefined, string][] = [
            [cfg?.cdnaPath, cfg?.cdnaUrl, "cdna"],
            [cfg?.ncrnaPath, cfg?.ncrnaUrl, "ncrna"],
        ];

        for (const [localPath, url, label] of sources) {
            const filePath = await ensureFastaFile(species, localPath, url, label);
            if (!filePath) continue;
            console.log(`[${label}] ${species}: indexing transcript sequences into memory`);
            const partial = await loadCdnaFastaToMap(filePath);
            let added = 0;
            for (const k in partial) {
                if (!(k in map)) added++;
                map[k] = partial[k];
            }
            console.log(
                `[${label}] ${species}: indexed ${Object.keys(partial).length} sequences (+${added} new)`
            );
        }

        cdnaCache[species] = map;
        loadedCdna.add(species);
        console.log(
            `[transcripts] ${species}: ${Object.keys(map).length} total transcript sequences indexed`
        );
    })();

    loadingCdna.set(species, p);
    try {
        await p;
    } finally {
        loadingCdna.delete(species);
    }
}

async function ensureSpeciesFile(species: string): Promise<string> {
    const cfg = speciesRegistry[species];
    if (!cfg) {
        throw new Error(`Species '${species}' is not configured`);
    }

    const resolvedPath = path.resolve(cfg.filePath);

    if (fileReadable(resolvedPath)) {
        console.log(`[annotations] ${species}: file already present -> ${resolvedPath}`);
        return resolvedPath;
    }

    ensureParentDirectory(resolvedPath);

    console.log(`[annotations] ${species}: file missing, starting download`);
    console.log(`[annotations] ${species}: source=${cfg.remoteUrl}`);
    console.log(`[annotations] ${species}: dest=${resolvedPath}`);

    let lastPct = -1;

    await downloadToFileProgress(cfg.remoteUrl, resolvedPath, {
        onStart: (total) => {
            console.log(
                `[annotations] ${species}: download started` +
                (total ? ` (${(total / 1024 / 1024).toFixed(2)} MB)` : "")
            );
        },
        onProgress: (written, total) => {
            if (!total) {
                console.log(
                    `[annotations] ${species}: downloaded ${(written / 1024 / 1024).toFixed(2)} MB`
                );
                return;
            }

            const pct = Math.floor((written / total) * 100);
            if (pct >= lastPct + 5 || pct === 100) {
                lastPct = pct;
                console.log(
                    `[annotations] ${species}: ${pct}% ` +
                    `(${(written / 1024 / 1024).toFixed(2)} / ${(total / 1024 / 1024).toFixed(2)} MB)`
                );
            }
        },
        onDone: (written, total) => {
            console.log(
                `[annotations] ${species}: download complete ` +
                `(${(written / 1024 / 1024).toFixed(2)} MB` +
                (total ? ` of ${(total / 1024 / 1024).toFixed(2)} MB` : "") +
                `)`
            );
        },
        onInfo: (msg) => {
            console.log(`[annotations] ${species}: ${msg}`);
        },
    });

    if (!fileReadable(resolvedPath)) {
        throw new Error(`Species '${species}' download completed but file is unreadable`);
    }

    return resolvedPath;
}

async function loadSpeciesAnnotations(species: string): Promise<void> {
    if (loadedSpecies.has(species)) return;

    const inFlight = loadingSpecies.get(species);
    if (inFlight) {
        await inFlight;
        return;
    }

    const p = (async () => {
        const filePath = await ensureSpeciesFile(species);

        console.log(`[annotations] ${species}: loading annotations into memory`);
        const loaded = await loadGFF3(filePath);

        annotationsCache[species] = loaded;
        loadedSpecies.add(species);

        console.log(
            `[annotations] ${species}: loaded ${Object.keys(loaded).length} transcript entries`
        );
    })();

    loadingSpecies.set(species, p);

    try {
        await p;
    } finally {
        loadingSpecies.delete(species);
    }
}

async function initializeAnnotationCache(speciesToLoad?: string[]): Promise<void> {
    const targets =
        speciesToLoad && speciesToLoad.length > 0
            ? speciesToLoad
            : Object.keys(speciesRegistry);

    console.log(`[annotations] startup init beginning for: ${targets.join(", ")}`);

    for (const species of targets) {
        await loadSpeciesAnnotations(species);
    }

    console.log(`[annotations] startup init complete`);
}

// Transient Ensembl statuses worth retrying (rate limit / overload / gateway).
// 400 / 404 etc. are permanent (bad or retired id) and are NOT retried.
const TRANSIENT_HTTP = new Set([429, 500, 502, 503, 504]);

// Shared Ensembl fetch with retry + backoff on transient errors and network
// blips. Returns the successful Response; throws with the last status once
// retries are exhausted or the failure is permanent.
async function ensemblFetch(
    url: string,
    headers: Record<string, string>,
    maxAttempts = 3
): Promise<any> {
    let lastStatus = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let response: any;
        try {
            response = await fetch(url, { headers });
        } catch (netErr: any) {
            lastStatus = `network error: ${netErr?.message || netErr}`;
            if (attempt < maxAttempts) {
                await new Promise((r) => setTimeout(r, attempt * 1000));
                continue;
            }
            break;
        }

        if (response.ok) return response;

        lastStatus = `${response.status} ${response.statusText}`;
        if (TRANSIENT_HTTP.has(response.status) && attempt < maxAttempts) {
            const retryAfter = Number(response.headers.get("Retry-After")) || attempt;
            await new Promise((r) => setTimeout(r, Math.min(retryAfter, 5) * 1000));
            continue;
        }
        break;
    }
    throw new Error(`${lastStatus} (${url})`);
}

async function fetchEnsemblSequence(
    transcriptId: string,
    baseUrl: string = ENSEMBL_REST_BASE
): Promise<string> {
    const strippedId = stripDecimal(transcriptId);
    const url = `${baseUrl}/sequence/id/${encodeURIComponent(strippedId)}?type=cdna`;
    const response = await ensemblFetch(url, { Accept: "text/plain" });
    return (await response.text()).trim();
}


type TranscriptResultCache = Record<string, TranscriptPayload>;

const transcriptResultCache: TranscriptResultCache = {};

function annotationKey(species: string, transcriptId: string): string {
    return `${species}:${stripDecimal(transcriptId)}`;
}

function mapStrand(strand: number | string | null | undefined): string {
    if (strand === -1 || strand === "-1" || strand === "-") return "-";
    if (strand === 1 || strand === "1" || strand === "+") return "+";
    return ".";
}

async function fetchTranscriptLookup(
    transcriptId: string,
    baseUrl: string = ENSEMBL_REST_BASE
): Promise<any> {
    const strippedId = stripDecimal(transcriptId);
    const url = `${baseUrl}/lookup/id/${encodeURIComponent(strippedId)}?expand=1`;
    // GET with only Accept — a Content-Type header on a GET can trigger a 400.
    const response = await ensemblFetch(url, { Accept: "application/json" });
    return await response.json();
}

function buildAnnotationsFromLookup(lookup: any): Annotation[] {
    const annotations: Annotation[] = [];

    const transcriptAttrs: Record<string, string> = {
        ID: lookup.id ?? "",
        Name: lookup.display_name ?? "",
        biotype: lookup.biotype ?? "",
        Parent: lookup.Parent ?? lookup.parent ?? "",
    };

    annotations.push({
        seqname: lookup.seq_region_name ?? "",
        source: "Ensembl_REST",
        feature: lookup.object_type ?? "transcript",
        start: String(lookup.start ?? ""),
        end: String(lookup.end ?? ""),
        score: ".",
        strand: mapStrand(lookup.strand),
        frame: ".",
        attributes: transcriptAttrs,
    });

    if (Array.isArray(lookup.Exon)) {
        for (const exon of lookup.Exon) {
            annotations.push({
                seqname: exon.seq_region_name ?? lookup.seq_region_name ?? "",
                source: "Ensembl_REST",
                feature: "exon",
                start: String(exon.start ?? ""),
                end: String(exon.end ?? ""),
                score: ".",
                strand: mapStrand(exon.strand ?? lookup.strand),
                frame: ".",
                attributes: {
                    ID: exon.id ?? "",
                    Parent: lookup.id ?? "",
                    constitutive: String(exon.constitutive ?? ""),
                },
            });
        }
    }

    if (lookup.Translation) {
        const tr = lookup.Translation;
        annotations.push({
            seqname: lookup.seq_region_name ?? "",
            source: "Ensembl_REST",
            feature: "CDS",
            start: String(tr.start ?? lookup.start ?? ""),
            end: String(tr.end ?? lookup.end ?? ""),
            score: ".",
            strand: mapStrand(lookup.strand),
            frame: "0",
            attributes: {
                ID: tr.id ?? "",
                Parent: lookup.id ?? "",
            },
        });
    }

    return annotations;
}

async function getTranscriptAnnotationsWithFallback(
    transcriptId: string,
    species: string,
    baseUrl: string = ENSEMBL_REST_BASE
): Promise<Annotation[]> {
    const strippedId = stripDecimal(transcriptId);

    // Step 2: local annotations — but only if they are already downloaded and
    // indexed in memory. If not, kick the download/index off in the background
    // (idempotent) and fall back to Ensembl REST for THIS request instead of
    // blocking on a potentially large / incomplete download+install.
    if (loadedSpecies.has(species)) {
        const localAnnotations = annotationsCache[species]?.[strippedId];
        if (localAnnotations && localAnnotations.length > 0) {
            return localAnnotations;
        }
    } else {
        void loadSpeciesAnnotations(species).catch((e: any) =>
            console.warn(`[annotations] ${species}: background load failed:`, e?.message || e)
        );
        console.log(`[annotations] ${species}: not ready yet, using Ensembl REST fallback`);
    }

    // Step 3: Ensembl REST fallback
    try {
        const lookup = await fetchTranscriptLookup(transcriptId, baseUrl);
        const restAnnotations = buildAnnotationsFromLookup(lookup);

        // write-through cache into local in-memory species map
        if (!annotationsCache[species]) {
            annotationsCache[species] = {};
        }
        annotationsCache[species][strippedId] = restAnnotations;

        return restAnnotations;
    } catch (exception: any) {
        // Local miss + Ensembl REST unavailable (transient 5xx, or a
        // retired/invalid id returning 400/404). Fail soft with no annotations;
        // the caller still returns a well-formed (possibly empty) payload.
        console.warn(
            `[annotations] REST lookup unavailable for ${transcriptId}: ${exception?.message || exception}`
        );
        return null;
    }
}
// Directory of bundled per-transcript sequence files (checked before Ensembl).
// Files may be plain sequence or FASTA; layout is <dir>/<species>/<ENST>.<ext>
// or <dir>/<ENST>.<ext>. Convention: the sequence is the transcript cDNA in the
// same orientation Ensembl `type=cdna` returns (downstream strand handling is
// applied uniformly).
const LOCAL_SEQUENCE_DIR =
    process.env.TRANSCRIPT_SEQ_DIR || "./reference_data/sequences";

function readSequenceFile(filePath: string): string | null {
    try {
        if (!fileReadable(filePath)) return null;
        const raw = fs.readFileSync(filePath, "utf-8");
        const seq = raw
            .split(/\r?\n/)
            .filter((line) => !line.startsWith(">"))   // drop FASTA headers
            .join("")
            .replace(/\s+/g, "")
            .trim();
        return seq.length > 0 ? seq : null;
    } catch {
        return null;
    }
}

async function getLocalTranscriptSequence(
    transcriptId: string,
    species: string
): Promise<string | null> {
    const strippedId = stripDecimal(transcriptId);

    // 1. Bundled transcriptome cDNA — only if already downloaded and indexed.
    //    If not ready, trigger the download/index in the background (idempotent)
    //    and fall through (per-file, then Ensembl REST) rather than blocking on
    //    an incomplete download+install.
    if (loadedCdna.has(species)) {
        const fromCdna = cdnaCache[species]?.[strippedId];
        if (fromCdna && fromCdna.length > 0) return fromCdna;
    } else {
        void loadSpeciesCdna(species).catch((e: any) =>
            console.warn(`[cdna] ${species}: background load failed:`, e?.message || e)
        );
        console.log(`[cdna] ${species}: not ready yet, using Ensembl REST fallback`);
    }

    // 2. Per-transcript sequence file convention.
    const base = path.isAbsolute(LOCAL_SEQUENCE_DIR)
        ? LOCAL_SEQUENCE_DIR
        : path.resolve(process.cwd(), LOCAL_SEQUENCE_DIR);

    const exts = ["txt", "seq", "fa", "fasta"];
    for (const ext of exts) {
        const scoped = readSequenceFile(path.join(base, species, `${strippedId}.${ext}`));
        if (scoped) return scoped;
        const flat = readSequenceFile(path.join(base, `${strippedId}.${ext}`));
        if (flat) return flat;
    }
    return null;
}

async function getTranscriptSequenceAndAnnotations(
    transcriptId: string,
    species = "human",
    useReverseComplement = false,
    baseUrl: string = ENSEMBL_REST_BASE
): Promise<TranscriptPayload> {
    const strippedId = stripDecimal(transcriptId);
    const resultKey = annotationKey(species, transcriptId);

    // Is this species' local reference still downloading / indexing?
    const referencesLoading =
        !loadedSpecies.has(species) || !loadedCdna.has(species);

    // Step 1: full transcript result cache
    const cachedResult = transcriptResultCache[resultKey];
    if (cachedResult) {
        // Recompute the transient loading flag so it reflects current state.
        return { ...cachedResult, species, referencesLoading };
    }

    // Was the annotation already available locally (before the fallback runs)?
    const hadLocalAnnotations =
        loadedSpecies.has(species) &&
        !!(annotationsCache[species]?.[strippedId]?.length);

    // Step 2 and 3: local annotations, then REST fallback
    const annotations =
        (await getTranscriptAnnotationsWithFallback(
            transcriptId,
            species,
            baseUrl
        )) ?? [];

    // Sequence: local first, then Ensembl. A failed Ensembl fetch (e.g. a
    // persistent 503) must NOT abort the whole response — return the annotations
    // so the client can still build the track; the sequence can be filled in
    // on a later attempt.
    let rawSequence = "";
    let sequenceSource: "cache" | "local" | "ensembl" | "none" = "none";
    if (sequenceCache[resultKey]) {
        rawSequence = sequenceCache[resultKey];
        sequenceSource = "cache";
    } else {
        // 1. Local: bundled cDNA index / per-transcript file, if present.
        const localSequence = await getLocalTranscriptSequence(transcriptId, species);
        if (localSequence) {
            rawSequence = localSequence;
            sequenceCache[resultKey] = rawSequence;
            sequenceSource = "local";
        } else {
            // 2. Fall back to Ensembl REST (retries transient errors internally).
            try {
                rawSequence = await fetchEnsemblSequence(transcriptId, baseUrl);
                sequenceCache[resultKey] = rawSequence;
                sequenceSource = rawSequence ? "ensembl" : "none";
            } catch (seqErr: any) {
                console.warn(
                    `Sequence fetch failed for ${transcriptId} (returning annotations only):`,
                    seqErr?.message || seqErr
                );
                rawSequence = "";
                sequenceSource = "none";
            }
        }
    }

    let strand: string | null = null;
    if (annotations.length > 0) {
        strand = annotations[0]?.strand ?? null;
    }

    let sequence = rawSequence;
    const negativeStrand = strand === "-" || strand === "-1";

    if (negativeStrand) {
        sequence = useReverseComplement
            ? reverseComplement(sequence)
            : reverseSequence(sequence);
    }

    const payload: TranscriptPayload = {
        transcriptId,
        sequence,
        annotations,
        strand,
        reversedForNegativeStrand: negativeStrand,
        species,
        referencesLoading,
        sequenceSource,
        annotationSource: hadLocalAnnotations
            ? "local"
            : (annotations.length > 0 ? "ensembl" : "none"),
    };

    // Only cache a complete payload; if the sequence was unavailable, leave it
    // uncached so a later request can retry the Ensembl sequence fetch.
    if (sequence && sequence.length > 0) {
        transcriptResultCache[resultKey] = payload;
    }
    return payload;
}

// -----------------------------------------------------------------------------------------
// -----------------------------------------------------------------------------------------
// -----------------------------------------------------------------------------------------
// -----------------------------------------------------------------------------------------
// -----------------------------------------------------------------------------------------
// -----------------------------------------------------------------------------------------
// In-memory store
// -----------------------------------------------------------------------------------------
// -----------------------------------------------------------------------------------------
const { Server } = require('socket.io');
const http = require('http');
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // your frontend URL
        methods: ["GET", "POST"],
        allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id'],
        exposedHeaders: ['Content-Type', 'Authorization', 'x-user-id'],
        // Access-Control-Allow-Headers: Content-Type, Authorization, x-user-id
        credentials: true,
    },
});

interface FolderAccessMap {
    [folderId: string]: Set<string>;
}
interface FolderMap {
    [folderId: string]: {};
}

interface ObjectStateMap {
    [folderId: string]: {
        [objectId: string]: any; // You can replace `any` with a proper object state type
    };
}



function __decompressLjlString(compressed: string): string {
    const chunkSize = 0x8000;
    const binaryData: number[] = [];

    for (let i = 0; i < compressed.length; i += chunkSize) {
        const chunk = compressed.substring(i, i + chunkSize);
        for (let j = 0; j < chunk.length; j++) {
            binaryData.push(chunk.charCodeAt(j));
        }
    }

    const uint8 = Uint8Array.from(binaryData);
    const decompressed = pako.inflate(uint8, { to: 'string' });
    return decompressed;
}

function __decompress(compressedString: string) {
    const chunkSize = 0x8000;
    const binaryData = [];
    for (let i = 0; i < compressedString.length; i += chunkSize) {
        const chunk = compressedString.substring(i, i + chunkSize);
        const chunkArray = Array.from(chunk, char => char.charCodeAt(0));
        binaryData.push(...chunkArray);
    }
    const jsonString = decompressJson(Uint8Array.from(binaryData));
    return jsonString;
}
const folderAccess: FolderAccessMap = {};
const objectStates: ObjectStateMap = {};
const sharedFolders: FolderMap = {}

// Represents the structure of each folder's details
interface FolderDetail {
    name: string;
    owner: string;
    path: string;
}

// Maps folderId to its detail
interface FolderDetailMap {
    [folderId: string]: FolderDetail;
}

// Example usage
const folderDetails: FolderDetailMap = {
};


const lastEmittedUpdates: any = {}; // 🔄 Store last emitted update per folder

// 🔁 Periodic emitter: runs every 10 seconds
setInterval(async () => {
    for (const folderId in lastEmittedUpdates) {
        const update = lastEmittedUpdates[folderId];
        if (update) {
            console.log(`[Periodic Emit] folder ${folderId}`);
            io.to(folderId).emit('objectUpdated', update);
        }
    }
}, 10000); // every 10 seconds
// Recursively get all .ljl files in a directory
function _deprecated_getLjlFilesRecursively(dir: string, files: string[] = []): string[] {
    const items: string[] = fs.readdirSync(dir);

    for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            getLjlFilesRecursively(fullPath, files);
        } else if (fullPath.endsWith('.ljl')) {
            files.push(fullPath);
        }
    }

    return files;
}

const removeMyFilesFromPath = (path: string): string => {
    const parts = path.split('/').filter(part => part !== 'myfiles');
    return parts.join('/');
};



const removeEmail = (path: string, encoded: string): string => {
    const parts = path.split('/').filter(part => part !== encoded);
    return parts.join('/');
};


// minimal filename sanitizer: allow only plain filenames (no slashes)
function sanitizeFilename(input: string): string | null {
    const name = (input || "").trim();
    if (!name) return null;

    // Reject any path separators or traversal
    if (name.includes("/") || name.includes("\\") || name.includes("..")) return null;

    // Optional: tighten allowed chars
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;

    return name;
}
function downloadToFile(url: string, destPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let req: ClientRequest | undefined;

        try {
            req = https.get(url, (resp: IncomingMessage) => {
                const status = resp.statusCode ?? 0;

                // Follow redirects (handle relative Location too)
                if (status >= 300 && status < 400 && resp.headers.location) {
                    const location = resp.headers.location;
                    resp.resume();
                    const nextUrl = new URL(location, url).toString();
                    resolve(downloadToFile(nextUrl, destPath));
                    return;
                }

                if (status !== 200) {
                    const chunks: Buffer[] = [];

                    resp.on("data", (d: Buffer | string) => {
                        chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
                    });

                    resp.on("end", () => {
                        const body = Buffer.concat(chunks).toString("utf8").slice(0, 500);
                        reject(new Error(`Download failed (${status}). ${body}`));
                    });

                    resp.on("error", reject);
                    resp.resume(); // ensure socket is drained
                    return;
                }

                const fileStream = fs.createWriteStream(destPath);

                fileStream.on("error", (e: any) => {
                    resp.destroy(); // stop download if we can't write
                    reject(e);
                });

                streamPipeline(resp, fileStream).then(resolve).catch(reject);
            });

            req.on("error", reject);
            req.setTimeout(60_000, () => {
                req?.destroy(new Error("Download timed out"));
            });
        } catch (e) {
            reject(e);
        }
    });
}

type DownloadTelemetry = {
    bytes: number;
    total: number | null;
    pct: number | null;
    mb: string;
    mbTotal: string | null;
    speedMBps: string;
    etaSec: string | null;
};

const makeReporter = (res: any, stream: boolean) => {
    const t0 = Date.now();
    let lastBytes = 0;
    let lastTs = t0;

    const emit = (type: string, data: any = {}) => {
        const dt = ((Date.now() - t0) / 1000).toFixed(2);
        const payload = { t: dt, type, ...data };

        // Console: readable
        console.log(
            `[${payload.t}s] ${type}`,
            data && Object.keys(data).length ? data : ""
        );

        // Client: structured JSON lines (easy for Python)
        if (stream) {
            try {
                res.write(JSON.stringify(payload) + "\n");
            } catch {
                /* client gone */
            }
        }
    };

    const progress = (written: number, total: number | null) => {
        const now = Date.now();
        const dt = (now - lastTs) / 1000 || 0.001;
        const dBytes = written - lastBytes;

        const speed = dBytes / dt; // bytes/sec
        const pct = total ? (written / total) * 100 : null;
        const eta =
            total && speed > 0 ? ((total - written) / speed) : null;

        const telemetry: DownloadTelemetry = {
            bytes: written,
            total,
            pct: pct ? Number(pct.toFixed(2)) : null,
            mb: (written / 1024 / 1024).toFixed(2),
            mbTotal: total ? (total / 1024 / 1024).toFixed(2) : null,
            speedMBps: (speed / 1024 / 1024).toFixed(2),
            etaSec: eta ? eta.toFixed(1) : null,
        };

        emit("DOWNLOAD_PROGRESS", telemetry);

        lastBytes = written;
        lastTs = now;
    };

    return { emit, progress };
};



const PRIVATE_CA_HOSTS = new Set(
    (process.env.REMOTE_PRIVATE_CA_HOSTS || "my-internal.hts.bio")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
);

// Passphrase used to encrypt genomic-analysis
const GENOMIC_ANALYSIS_PO = "ljl-data";
const GENOMIC_ANALYSIS_FILE = path.join(__dirname, "genomic-analysis");
let cachedDecryptedCA: string | null = null;
function decryptGenomicAnalysisFile(onInfo?: (m: string) => void): string {
    if (cachedDecryptedCA) return cachedDecryptedCA;
    if (!GENOMIC_ANALYSIS_PO) {
        throw new Error(
            "GENOMIC_ANALYSIS_PO is not set (required to decrypt genomic-analysis)"
        );
    }
    const payload = `v1.iOpuMVpicda1wZwTKrBilQ==.PX8VT2yr1/0bgYZz.bI5O6u18Gvn3NJpC4WMKhw==.ysbpGnd+1+89GhlhaG/pJS52DxtlVn7Jg7A6IPBYPDWXjMRA7BxPV5F1AjLUwFG2V3XpYvK2hrZJhKcGG0olzkV3L+0tdzdNtaaIDKIl46p4Ir8tMMD/EJPryQekyteTc0CEfq1uKpEgMqgC0U5J37zpjD2aQyw1llRG6o6qzWwwn2PAmxjblN1UY8wOjy7pAdkRWmkFi+IJeX3F8DbdJhnUCuvasKw/KlN0mcFTYOzIOEhkb03NyPtISrAw1txBUvydkcD2gITUN10Ud+QlcqnqyfjH/JnAUUVdS+RBHTwZd7A9p3RuaaUlpPJfEwp+G3kqOx8OV/MS3KvLEumIvBR6R/ylsVOGTqzw/TtCgopgM2hEiaTK7gERbAW4wN87ukW9YyP/AiWnoJNjfn0N21dpMJAKBxVXpaxdzKxOwK/NYFXNHmzoVpNJi+JSRB6CX2bKFzRScmB6awd69LZz6wSWrDp0fV1Xs7CUGVuWXo8zPXkDxtAiphJ79IQMGrOF8hpSEyGSKVBtWriCaF+fXlCoLgxpeYKSAFYA7lNqdbZDZGrmmgs3CBDisl1ooTBrqrObaXOR3pgU3WGO8UR/gmGf7I3SPuO/kxrBQoeNJvNOJ+ULvdriDIH5NwHGmqyP+8UY16aohj3gzDO7UqvO1rcUR6F+IlBULPTh1IFyvaukIJkNKybaGZZYWdeJzMkiOqtj7lYjjLsGszkiJY4urnE91GLu1JYPhy4BjJqjzGhMTfMiD/HiLswJUbN7lDlA0GPxQiugGVgv4BhD0wzu3MhKvFp9Qfwdl0VUOjdYIGR7E7G7UoLn8sLSuKEY3oR9hHNFto19/xg27ZBnODmI/GgoEeiGuLFjj9eSD/rQrQDlA9AqEeOBHUNFL7LJLf3Dxaqs6ADig7b4rkBgS8GoMAHB3t6TU1VI1NOQBbwMvstpmFhyfBmBhlZDAseyJJmz6zQ9XKr/XbTXAfD/7jnXJk859Ix5O2qonOVmDKuO6ipSc5Dwwd4jj8GSjpjoddh7fDjUHkdKSwpUlb10lQXDdFU1Wnn7X1bl/zRQZymJJUhLUjoa1+7PS+P97uOSZGENj3uBT9fVk8O5CdcSZzWZ9ezIISWPbw/le9NxKCy8//ZBUKT5R9kym3NQ4xZRGOfPE+LSQnpxDjet7CCc19s3wIJnVEhcfLewrSux6oxXNpXIFhs8qLW/j1G2e/9HRCFJxqJasw6MERmcBqCLdEexwAr1165Aippn/JCE7zk0OHpWdAGie0LpI67Fvmw+l/YVpxKq680DGoVbA3UfPKmVhFXDz6YmlO2x4nD9O5hLw0vawKFEMombj4j0U/Ai/IHr46AFin+5Ok8GzwLVfHgUj3P+xhJLK3S6bnJr9jYb7/vaMMNaQCnwDbjoLw6jsZnT1GXaNtIaGe+sw4YOpN89EIQkF232aCjFV/jzuIvIJlMt+8vbOWw2ZsfmMbJUYgY5yykxiz0H8CMOWjrX7dRRIvy4uuOE0nQOMN1fgUQURH38YDAZX79IG4xiXSnWRMsZpmRxM1kMsB5B/Lm7rtLsYUy4vibUNmvQPDBEg2uyrTIZSGm3d9tVyLWOL+z0+rmNcqFvauhH2/uMQgrbJgSXIBSu7CsH1gVlMnQ4j/Oq60U6OY6eBb5gKTQSKVlAlXGE9Fl+4RCMAOSHPgu1/Z5tSjakMwc8YlXfmD7ilcVZgg4NS2lOXi/JE5JnB+HISbK92o2DMDDMgccE36zL2j7TSvZlyPgj7/2IALM3IPzrkL+Oh7J/FX85KuKsrixeNwtozJiHGi87kUz7+IjbLP9drwqlZd6dIofWNsg8+y8TD12SqZrhDb+wq7xztmaTfDNB1fBg5sC3J1q3uBP9YhDihlU2Xwqq583WNfOLh0kBBXyqm66Z+KpyOHzL+X7XU3PvCqpgIRWPpFtepcgtOT2X9lz+u4TaovULjVdGNy4w4Fux2dgVvavjBp9dJsAvbKow8rq4aNXEtwSYs7T3XX3LoqeIZVOX66tR85xEQrSiLojeFsBdWlRYxVl667t7LmOMl1/6BJJWgK8At1ByQLGIHXCRudP+QihjuZMWnsKoeVkOBWEQibFR41HZFBGYbhBgYlSfbb4NKGGmwknWQ2ZfHFI6FLJ2eeFg1ZoFQWy10xhdPVoL+dv42000rOZgz0B7EyN2gjc30dCmwS5Y9A3G+JWUr8XKYEwJe9y5Eo5Ef9lboWvxEKsJMkwBjDV32IU9ZX4nVszTqircOck3Hr5WBLk2N2LvgPLfdzB3yzCaawHVNIbyccB4/5OaJlZTDvsP630/9yeQgWiEZ1ZFgyPQ+BCcqmtYkQrqUjEUqD47kxIub/csXuQNS0mk6ZWZNOFOpG364ntNRPzLkWBK7kaukQ9VQpq+3XC2mUMgvZeGM4VZKsiHcPqcjQKr8qyxCLumBiaT5G9iDus36sux2KX42d69BMra2ISdCY6qC7sqjTgfvAjdPgZXt3StYQdOooEdJV8IfwZAsjm1PukDynu9hJXNTuRmUoINtH+tRJRnA6SiD15Ld6aRLaCWbpxKutabY99CJzGEjAwS6go+Iz4xFRbZakAE4l7caWBd59wOfoUULLRZd0Xh0/oZ9nAchF43N56fcrh3MU9BmOHw915q/qyQE0jyQwMIKoc8XD/bV9LsG7izqhqK2T+c/bekKVwz2/hyF9NDCLiK4Qp2C7rZ6dBBlSr/x50Ehz7c4yAkQid8QkfGDltdq+qpfvSKKCJp8ztTTjhtLLkoMk1t+7FF/vmuHRH8zxl2b3BVOSvYCjSe36znzRf5WIFjAPFq6Z7/IgNZoVj/IPtU13F0Q1KeTJAdj1PMeyY/nWjlSUTkKMkTpYugfCMeK4P2wAlslSfc0DyytkngUVIyx+NGXv5ljcxNFMHgcxSzUrI8kBlKmYy9rNqEItYdsMJPkcf7zzSBpyOpN0p0knpeYvZeJmGVtZUIsNHl6C73BMOGzT/CmCApt0+RxcMFGpLlKyicOxG8I6PTdrnUUV8QjcvMJQDkA67hEkyYwmwwLcH+tAa2XZUWsw1MGa0gj4X9yytg+qo6rWgloqko3uUVorWMH11xh4Bnsft1WtcXmisqjQoSkeqDKK/MNzkgnyavNd5SjFlTrSHthT66TodU4ETJ98iKJeFQxPGx+qhLkycsCpmL8moFVOsglfHYL+yXRksbJ7LXaWTLqRDJP3CLjEmy8tkBHg9m5hczct8ScZ2D5CYUCeZdwC50RxLcqFyHpGOw5SWMNX74xLlfFavUpCUwLNH0XmppcOMIpunKOP+1x0/0pBQWi76QuIdPgHmhFWvgR+ydvyZ2h425kGhLxbccq1f5zqi3G8mvcDnd/aPWZCFzWD9ae8wjyi5eoTzcyPTygd3eVfIT8Tgixm3vj5nMKec508QvrGDHX3CgDxws3uY3DHFs4CWyzJSlgxkoTkxAzwGK+ZVIedbX235yGPizCh0xoEmiMWHtxZyi9TymDyD1dEBL9/5QYykXLBgP8nUZcS1a78EaQ0txs7VRzYPeF3uNm5ujVECwwic9X4L3J4m5wFVzVyxrkNQjwI+QA6eRLjGv2XuSQh25+CAPbtbsvBrRnP38YQgMJmpYyX1jD7sgS2+jaaYtURXqBzFrD2YS67hZlxuVv5KH3SGnoZkQM6rBbkGXau5In9UWQxG6tD/9oxm4M8QLs9H3eXxeev6wxd7vOnW6r0cuFRqhRL15acVITN27GPRxICzJkpITM9YcYQUDhkmcaqSdcEORCl+XDz658pakl2DAvhXEx+/Fgy5P7najQmemx1pu3HMGfE/O1kNWdk7nvAmtByCwG2TbsVs4JGxv4L8ztEAsrlcDmjc0CtAa6IxiJtYXZQvpjQ8ll5B/2uJYO0xEIywSv1oVJei9/5rFkGMFDNuGIoPynl239G6m3kcK8fSnVuDuAbnvpn1apDGoRCE3BiISuhKqZ8BqllH+6Yzxf9It9+Y/nMdPsJ0t+pFdl7htSDuxD/9xsfS9hPP3xwCpOZnRICXGEBZLzdbry/94KsSzSUK7NAxhCXIAX4OlcfDse0nlENmYeDz6BC+t//7gBNjeqwOQHJ2wE+YepGy8gP8H7SHm14cVunH7CtG0315nSdGQTDAABrKre5hucijwXyTrc3Gfuz17zVZa9svDA2QyvUDmdCG7an36EckNmuZeyXr50EceqQn1h+D4ke8SBCN/rgaJlWkd82201JGXbrS7QboO5Uq1Wu7JZldcUUhXYrpe8rcSWJLrZ+cgJrSy5jFVz9afEha/8cOrRJ6lvPicuwQF52L0NI6S+LJk5AEIulZaTF+is4pYc/n+OVDjuNhY3JxgaTlDtH4C9UviZVFYIgvxz90YTPhx6oBrtYqmYJxqBnqHBYu8aVqNqNzZBbcvqHhKg9Bm2C9sDLcgLpHAbBCmRAYxnv76bOwIsk/ts7jCAm1h9y+NpK/C8Uv+TKkBIL032nngzEPYQ2WzdS5KUpwp0HgmnovjVV834rsrbJOBSH7HT9YIxcoMF6Ks7MZn2uLkvez4bY7cEVCaVihnBrmWaVKuzEya9WCuOIp01pPU9AdfJc9bMnmWA+J545p8+WgmSJQTRS2z04lBs8qwzdBh8DtBMzvSQK2vetOYzwW5pqtb0wVZsQW5Rw7N+vTkj5tsmgImRvtVTgY7EA6gDOVfuSyIpLFdVKJHWKhtIjeOR6TzIKxLmiDBVCZZGZhpc3NS0sruMt/wY/vooyxwQT6HjEClWz19I2MPjPWx21tCHcDj7m2w5/Jq5PFQEiDe+HvTTPDplSQxNCxPuptvHCjzHSP1W8NkN4E2L0XsjReLWbblSZ/YEqolLSPYuL5ZfuGnFSbD5LdGu6e7crK6+1bMDSDuriJ/Cp4NG2EkOwdbVP/XekgvvHIb3IO4NnaHuWabMPOES0xSnD3GxPTd4Yrzkib3Ea1UWvXwwNkEhXi1cNtli+O+wEif2KgmCOa1tCtBXZbIff6NwGczWMbgD9VhDsv0sDDgXXeBkPbtb5tq7R0VDDkKSgQJ+/F9gnkzMPs5u/Yad8nHkA5vEYKWs5ICRWWIx8Ce5zcDIHH9E6yx8PPwQ9EwS/s8viGqE73PCX6gCKuYT2YnbWWkz7qh2DqlJKAIPShw5WGyRu9wLZXzkSXS76wIVqUXYVcmO1BRaPLDbQsC7ad4GYPvt+Tqa3vH124WyhDz1pDUp+mzCGE8zqaSJ/ISJbDEXSkA1J1qe+rKAFUEbJE6BMDpK8Y5jhEgmYQW1CEz0EVsisF6DXl9D0aM6G1OfjOJ1OK/CoEt3xWNZXYY9NrrkD9P5ti6XtQkC8RkdykopIm5mpPmcn5u0HOZwC7pv56I12uQq9LXUjhB936EVpezDEljHCNAUA4ldwBjzSEHHXaZbUfzEIcIvARfI/FlDOgBYRELyBXqBP+5EOIUGmaZ2pdsSx9RtRT6ZEvbJg0Cc8Tqe14LOJot046RKzhZYCmIFDKV7yjYTG9FhPYhciR7ll0jSPcZMTF6KJxgPMZ/Z3XAvuH5uOkwvtGOReKTKBvxF1oc74P0Emhpz5k9IrFbQmb92MQSRnHBYVAlV5VQ/Pdy1H0glSBAw1zxoZ+THRgkpx+ES/aGvQtulA4Dy8iVq4zbhW0YDbVXY4ukpnmSeeZp3/T1AfKOnQhX1FvyZwMkOF3vTabKxWnKiGRQ8bkGxSwH+Wf/ake95IFGd1DpnwGIA9e9ZiRyJMHKTqqKU/C96oNR0VaYm0XoU+Ypz65YcxDiWVMV26CLvQqeII23GV7Itl3US7WQ+iAnFHWoU2ztx5zL1qOcD0Gq4ELm7UbR/AAZEIkYLe35JHBq2PPM/W7PrDbj79e3G6tVfQ5xmjA95GWXNxV49HoO6GZyMVnjNOkfSNjfYqiR/7y7ng+LQ8meeBlBqdE1HRV3H1dtzmFHGTFXsKN2UcHlQ2WrEobaOlc9yeiJHkEvWHy8VVctVcNWRoEV1NnWKjpnPXco0F9DSQGg/eT1Q9QQbQFHVvkxwU6n4tds57KclHr2VEQfmMdlGe5t2GQcuWjz3nCZq7YvqnCAKW3H2U7u9MzWdrQooHGZToVvlE++BkvVFj3NZKm5zevFJxP9qk4dGxMtt3jny5ZOoeINPW0Ag5zTBe5yaRMZ2+5U1fNBK7O1MeAFnVSJpPvZa1aN6n/ojqq833I8tKBBpc/hp1m616urax8bFNduZ8YghxNVEHlWy6jpz9M51MCEz8lRRtXRKFIIUWIcAdosBrYcqqfeUNoXwdIIEePIKaNbzOtLGCFg+qTb/5MdjaDwQ9KbaAW0eQ0SbCW5XtH2E3GDsGp5odwZMiZJ/u/CvCoYUxoiEE9qXi3ooe0vXEZgb/NrT2+C0d3U19T83J4NvB7i9JTpbOGR7oku3zwsWy5F2iNcoE1oi49WJdO9QklsC005BWH6eB5fGE0n2KBiG34DKy1Ib8/eAsGm1BI5g4Ryxi6LHmtrhKai3DZJohbHszJW0jEdkoHw/5IA2hhV2ppsPujtv3E6dzbi8mnTsXJV9f5MVGiGgtTX5HdqiewSJgexoiLlTLBNHS6JlQDI10MrpU8WMW1g8nTCTDkolmLDM6dSB2/6DX+uos/bVgFMavnL3eYkf4RxZdsey/TTyproLsElkLF3inTRrJJ17qXx+nPreYKn/f7YoTgrsZKw5+7UmRpQ0B8+SpLZCz6h0xheLN296jEx601YXfBqjSqMD9XDX+XzR4PxAZOpUC7n3XfGMRVtPsIjN9fU65EILHX5clVDHREjDicj7AX8BHwfFV1QyZq50oU2BIzJ3Ut3aiady+WnJqLGgtsVUKuWuw586zhNdYIlMhnT/S5BlzulX7lZBPLXBcbn0Wh84CpMpggXS0Qu3pESO6ovqq86vjWEBcm5ePeR4VNC4baPd4wNTZVU/ZYh8Yo/qwMd+HTa3c/gI7IJpaVfYfWd75D3Dq3RVu6aVj0SUHv0rV+ixbHuqGgAJbM92GYo6t4RRZ8M32aKQDQrC7g9S/fV4AX979s9TeIvCiIT1/zNEhmBYxttnL0r10E5f2boB+WWy0MJ7z887lvvIB1VH9p6/85km49R0/LG0BfssnI3uSV8tll0+e8dOWS9pUlcv5j/swTZ1jkby8C/mcfYXYW5nPynPobmTUatt58IJjn+Xcn4/KejxteDHJNhW/WGqi/AAPTBRJGLsbuvZpL4ZrMeppI8wUPq4QtWpL2nkSjBIAS6bIACM7nlhUUkIdqm11tzgdGQWI1kAHrcDbye4qHQTUmSBIOmSXygzwvvBglcrGCtThlHTEP6No4EpCAk6mzSs6D2OG3Il2ps6eur5xWEJr3dq50elOALLewlMNAl+zQj/Ks2coYOvpIJecctaJkGWP3ehTuUyVhyuPCQ/WdnTZOBPwArOFBQbMKY5fCbCOSyLspPNydcQqCy2/sJHXWdQL+Krzm5Wl6ixmttEThNlVykyvDb967sy11wusuNKg64FIOS2o1ijkA0BKh286/Maqktvk0bRh/BwotPXEKj8sSHNnX8HAXbnwSIrVqp1ErdoQaan58HNYGF4W8Yf3iGzJCmksddWkCogrxx352QhBPG7266cFrc8P17+9ggHCVd8DJ+S8W9E0qTHtdQW1a3fN31W5qW6/y+2+LHyWI5eHiZUMx9nHY4QBsn/oqAQ7A4AAkMcZDgwWL1bUyc/HceDqrQBTYDH3AcivWgPL4tJIwbvd90wwtI2+wB4QoTHilaqx0h1eMV1AuX8xY1TtEkAw5HWDJ3xwO/1Wk5CIcANH46fX7V8qj5ECNmZJ86QwJFQvKkvW/jJ7ROQR83tICThVyb0eWFD59ApEmgpiKozV9cZejJBhFsmQh1J0vC6Vbz9VgMteDQrXSUdOPb4P7JwX+aAu2//S+8Ml9Cckj/S4BrPwzBdT6xjmu8YyG1Xt8ZVdFVHOLeSEB9HXaCLhew0L65ykdRRaRfhsW371e59RqskAzQv3angMo+cgdJBA3hVDtsx+rOr07L0fBQcVZ8FH1O4O/PCWzz2e1+yFXGYvMVCcKbQimBy6RWpIQcOINbH3Uzpft9Kg3IOxkBS5jzBSMSSCWgfl76cTz5HJSpjTQzDGnOIH9FbmFK1JRwxfUU0SP6UnMPPkBn5DRcp7Ix/qxkelehDcVcYSMc2dG+DWehnvJTID0n8IfDxjsx9kD09fwjsBRwVZZakyx93qbQVhQNKyVKFP0Mk2AIsyiLmtJ/wMwrjtQsOlewb2Td7Aob7YM7mznrgqB8SCKsKeoXiU/wBhPCRZ8AHMUYkC1gAJpn27lcWBxWmDYZwEigRKBNMLbNIfmXkEcHRp6bxGWAeCzLzb9nrIbZKTrh6NYqoGld/YmPJiyIB+/wlK/3ThvXevujNCo67avxvylazYTMXuzK25eMUJNef1hoUtADzztq8KM1db5jatyH2aM1QjVYUaKHfu59UVCsyunOcn4R3h+TnAiGutkQetuMy3pRCnsXzU+R/Lci6+BLpKG0KCex1iBAmUV9OW4ddl2UgumtwfhTptgNBmdPpVHP35+3f9qVY1oU77S5ztl2y9KKbC/rVNtC95rf/TcrCGPXRUT+q5Hvz9HKY5JLekLnJ/MDzkC+1bFPp0Fx6IzE43OfR9ICfwB2Npf1OMkllTn/roQbbEfQVH4I2TRAEIS43xg/C3C/EqCHkBbLVI1UdLPTDpS5jQ5E6WJxzFkcpIubuGqpDdd6wQnn8oTWKb2XVRkePecewP6Y7J3McbHPJXQ1vXiUgNS3cKy7iU2YkJg2OFNMdNi8l9twcjLPkLNaZml4XQuc/ZMKmdhBoEcAKWpAPdrSgXhat6LhjuC9s0VmmQOwLJop+0Xa9Sek5shLLiqhTiJShMBuWP05DChtjpdIqQhoSwSwK824SLWyBVI8D5qJfGgSp0YpZCtVjU5Q747u9TK8HlqztGlGPNtnjfUd6aqZFVW8CKmCgOSvNqGckCXo6/FTMkzEeF4Mz0MBVz9Hai82DhseWROiiTHjTfYnlEyiS+Y/euWyL55Z/LZ0mQVE2b3aAFINSpg0XfAxq9q3q9+Al9teQOU78wyRRtW+85PaYuyTj9J7N8CEttK2y0iobftmJEarMaElDmmBjNK+wqlmcscn/+nwh8V8Kqcktfd/RWHCWc13arsf4xRhF7CKciGtDVtG6/EIUZaJ2tLeO38RW6Qa/dDTUwWsVlYwEQe/How29TfzY4yCD1AA61yXfeAnUZPVI4Mx1AOielYfuyU/QV3hV6eAZRpKmjcE45PsXArKT6WhcYn0ScRVKiLP27g6yGee7Ai5PM/6Lg6uTX+N4R4hR3gJKskXz5kKCXjj6PUub7m0wkcOYOS6ofqTDsbGhybUITKHq8weKrcIolSi+NFSAe908vNqVszvb+MP7q026FDoBVqdIDC/jz6QilzHIXxnsMgQeeHCkjwgw0k9m5rcLO1V4BZ61PuCAbrPxNosSBkzMS2PviT+aUM6MTauvQQPJ4mvf67NDQmO10mnXLVsDvuYtE1zz93RgPkp7rcQWdjK8oJsX6kMpKd6i4CxIvF5nqDWRWYamrZ+elZ5Yse0JCxlGeXbbnTNfwZocRXxCYFdJi/vlx2oMbnQrW2shE0nyXKmD0os3hCkx51+fvgxRbBIY01FoAfssNvcZy1GLrWwiTO2RB7MIPrj5zxhuG/kuDIYLpy5CGqteYpxgsjzPC1NDGsbjXtqX8rzao0ZYF60PyGDXXC4WvlnGeIqmgxrpnyRsGEdoxThwGSuvVnLjfzregRukWh9EOJkVIpruzWecch+aJiRX4lC2Y6/LDdK13KoqmQocx9Y3w==`;
    const parts = payload.split(".");
    if (parts.length !== 5 || parts[0] !== "v1") {
        throw new Error("genomic-analysis: invalid payload");
    }
    const salt = Buffer.from(parts[1], "base64");
    const iv = Buffer.from(parts[2], "base64");
    const tag = Buffer.from(parts[3], "base64");
    const ciphertext = Buffer.from(parts[4], "base64");

    // Keep these in sync with your encrypt tool:
    const ITERATIONS = 310000;
    const KEY_LEN = 32;

    const key = crypto.pbkdf2Sync(
        GENOMIC_ANALYSIS_PO,
        salt,
        ITERATIONS,
        KEY_LEN,
        "sha256"
    );

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");

    // Optional sanity check: looks like PEM
    if (!plaintext.includes("-----BEGIN CERTIFICATE-----")) {
        onInfo?.("Warning: decrypted genomic-analysis does not look like PEM cert(s).");
    }

    cachedDecryptedCA = plaintext;
    onInfo?.("Decrypted genomic-analysis CA bundle loaded and cached.");
    return plaintext;
}

export function makeRemoteHttpsAgent(urlStr: string, onInfo?: (m: string) => void) {
    const host = new URL(urlStr).hostname;

    // Public HTTPS → default trust store
    if (!PRIVATE_CA_HOSTS.has(host)) {
        onInfo?.(`HTTPS agent: default trust store (host=${host})`);
        return new https.Agent({ keepAlive: true });
    }

    onInfo?.(`HTTPS agent: using decrypted private CA for host=${host}`);

    const caPem = decryptGenomicAnalysisFile(onInfo);

    return new https.Agent({
        keepAlive: true,
        ca: caPem,
    });


}
type ProgressCallbacks = {
    onStart?: (totalBytes: number | null) => void;
    onProgress?: (written: number, totalBytes: number | null) => void;
    onDone?: (written: number, totalBytes: number | null) => void;
    onInfo?: (msg: string) => void;
};

export async function downloadToFileProgress(
    remoteUrl: string,
    destPath: string,
    cb: ProgressCallbacks = {}
): Promise<void> {
    const tmpPath = destPath + ".part";

    fs.mkdirSync(path.posix.dirname(destPath), { recursive: true });

    const cleanup = () => {
        try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch { }
    };

    const safeMove = (from: string, to: string) => {
        try {
            fs.renameSync(from, to);
            return;
        } catch (e: any) {
            if (e?.code === "EXDEV") {
                fs.copyFileSync(from, to);
                fs.unlinkSync(from);
                return;
            }
            throw e;
        }
    };

    const fetchOnce = (urlStr: string, depth: number): Promise<void> =>
        new Promise<void>((resolve, reject) => {
            if (depth > 5) return reject(new Error("Too many redirects"));

            const u = new URL(urlStr);
            const isHttps = u.protocol === "https:";
            const lib = isHttps ? https : http;

            const agent = isHttps ? makeRemoteHttpsAgent(urlStr, cb.onInfo) : undefined;

            const req = lib.get(
                urlStr,
                {
                    headers: { "User-Agent": "download-bigdata/1.0" },
                    agent,
                } as any,
                (resp: any) => {
                    // Redirects
                    if (
                        resp.statusCode &&
                        resp.statusCode >= 300 &&
                        resp.statusCode < 400 &&
                        resp.headers.location
                    ) {
                        const nextUrl = new URL(resp.headers.location, u).toString();
                        cb.onInfo?.(`redirect ${resp.statusCode} -> ${nextUrl}`);
                        resp.resume();
                        return fetchOnce(nextUrl, depth + 1).then(resolve).catch(reject);
                    }

                    if (resp.statusCode !== 200) {
                        const code = resp.statusCode ?? 0;
                        resp.resume();
                        return reject(new Error(`HTTP ${code} downloading ${urlStr}`));
                    }

                    const totalHeader = resp.headers["content-length"];
                    const total =
                        typeof totalHeader === "string" && totalHeader.trim() !== ""
                            ? Number(totalHeader)
                            : null;

                    cb.onStart?.(Number.isFinite(total as any) ? (total as number) : null);

                    const out = fs.createWriteStream(tmpPath);

                    let written = 0;
                    let lastEmit = Date.now();

                    const fail = (e: any) => {
                        try {
                            out.close();
                        } catch { }
                        try {
                            resp.destroy();
                        } catch { }
                        cleanup();
                        reject(e instanceof Error ? e : new Error(String(e)));
                    };

                    resp.on("data", (chunk: Buffer) => {
                        written += chunk.length;
                        const now = Date.now();
                        if (now - lastEmit >= 500) {
                            cb.onProgress?.(written, total);
                            lastEmit = now;
                        }
                    });

                    resp.on("error", fail);
                    out.on("error", fail);

                    out.on("finish", () => {
                        cb.onProgress?.(written, total);
                        cb.onDone?.(written, total);

                        try {
                            safeMove(tmpPath, destPath);
                            resolve();
                        } catch (e) {
                            cleanup();
                            reject(e);
                        }
                    });

                    resp.pipe(out);
                }
            );

            req.on("error", (e: any) => {
                cleanup();
                reject(e);
            });
        });

    try {
        await fetchOnce(remoteUrl, 0);
    } catch (e) {
        cleanup();
        throw e;
    }
}

function sanitizeSubPath(p: string): string | null {
    if (!p) return "";
    // normalize to posix, remove leading/trailing slashes
    const clean = path.posix.normalize(p).replace(/^\/+|\/+$/g, "");

    // reject traversal or absolute paths
    if (
        clean === "." ||
        clean === ".." ||
        clean.includes("..") ||
        clean.startsWith("/") ||
        clean.includes("\\")
    ) {
        return null;
    }

    return clean;
}

app.get("/download-bigdata", async (req, res) => {
    const stream = String(req.query.stream || "") === "1";
    const { emit, progress } = makeReporter(res, stream);

    try {
        emit("START", { route: "download-bigdata" });

        const filenameRaw = String(req.query.filename || "");
        const pathRaw = String(req.query.path || "");

        emit("INPUT", { filenameRaw, pathRaw });

        const filename = sanitizeFilename(filenameRaw);
        if (!filename) {
            emit("ERROR", { msg: "Invalid filename" });
            return res.status(400).json({ msg: "Invalid filename" });
        }

        const subPath = sanitizeSubPath(pathRaw);
        if (subPath === null) {
            emit("ERROR", { msg: "Invalid path" });
            return res.status(400).json({ msg: "Invalid path" });
        }

        emit("VALIDATED", { filename, subPath });

        const bigdataRoot = getKey("bigdata");
        if (!bigdataRoot) {
            emit("ERROR", { msg: "Bigdata path not configured" });
            return res.status(500).json({ msg: "Bigdata path not configured" });
        }

        const destPath = subPath
            ? path.posix.join(bigdataRoot, subPath, filename)
            : path.posix.join(bigdataRoot, filename);

        const remoteUrl = REMOTE_BASE + encodeURIComponent(filename);

        emit("DOWNLOAD_PREP", {
            remoteUrl,
            destPath,
        });

        if (!stream) {
            emit("MODE", { type: "json" });
            await downloadToFileProgress(remoteUrl, destPath);
            emit("DONE");
            return res.json({ ok: true });
        }

        emit("MODE", { type: "stream" });

        res.status(200);
        res.setHeader("Content-Type", "application/x-ndjson");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Accel-Buffering", "no");

        let clientGone = false;
        req.on("close", () => {
            clientGone = true;
            emit("CLIENT_DISCONNECT");
        });

        await downloadToFileProgress(remoteUrl, destPath, {
            onStart: (total) => {
                if (clientGone) return;
                emit("DOWNLOAD_START", {
                    totalBytes: total,
                    totalMB: total ? (total / 1024 / 1024).toFixed(2) : null,
                });
            },
            onProgress: (written, total) => {
                if (clientGone) return;
                progress(written, total);
            },
            onDone: (written, total) => {
                if (clientGone) return;
                emit("DOWNLOAD_DONE", {
                    bytes: written,
                    mb: (written / 1024 / 1024).toFixed(2),
                });
            },
            onInfo: (m) => {
                if (clientGone) return;
                emit("INFO", { msg: m });
            },
        });

        emit("OK");
        res.end();
    } catch (err: any) {
        emit("ERROR", { msg: err?.message || "Unknown error" });
        res.end();
    }
});



// GET /bigdata-exists?filename=somefile.bin&path=/optional/subfolder
app.get("/bigdata-exists", async (req, res) => {
    try {
        // const userId =
        //     (req.headers["x-user-id"] as string) || (req.headers.user as string) || "";
        // if (!userId) return res.status(401).json({ msg: "Missing user" });

        const filenameRaw = String(req.query.filename || "");
        const filename = sanitizeFilename(filenameRaw);
        if (!filename) return res.status(400).json({ msg: "Invalid filename" });

        const bigdataRoot = getKey("bigdata");
        if (!bigdataRoot) return res.status(500).json({ msg: "Bigdata path not configured" });

        const root = bigdataRoot.endsWith("/") ? bigdataRoot.slice(0, -1) : bigdataRoot;
        const encodedUser = encodeEmail(String(userId));

        const baseDir = path.posix.join(root, encodedUser);

        // Optional sub-path
        const optionalPathRaw = String(req.query.path ?? "").trim();
        let targetDir = baseDir;

        if (optionalPathRaw) {
            const rel = optionalPathRaw.replace(/^\/+/, "");

            if (rel.includes("..") || rel.includes("\\") || rel.startsWith("~")) {
                return res.status(400).json({ msg: "Invalid path" });
            }

            const candidate = path.posix.normalize(path.posix.join(baseDir, rel));
            if (!(candidate === baseDir || candidate.startsWith(baseDir + "/"))) {
                return res.status(400).json({ msg: "Invalid path" });
            }

            targetDir = candidate;
        }

        const filePath = path.posix.join(targetDir, filename);

        // Check existence
        let exists = false;
        let isFile = false;
        let size: number | null = null;

        if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            exists = true;
            isFile = stats.isFile();
            size = stats.size;
        }

        return res.json({
            exists,
            isFile,
            filename,
            path: targetDir,
            fullPath: exists ? filePath : null,
            size,
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.log("bigdata-exists failed:", err);
        return res.status(500).json({ msg });
    }
});


// ---------------------------------------------------------------------------------------
// OAuth2 / OIDC token-exchange proxy.
//
// The browser login (src/app/auth) runs Authorization Code + PKCE. Providers whose token
// endpoint needs a client secret and/or blocks browser CORS (Google web clients, Facebook,
// GitHub, Apple) POST their authorization code here; this endpoint adds the secret and
// exchanges it server-side, then returns the token JSON. Secrets come from server env vars
// and never touch the browser.
//
// Env vars (set the ones you use):
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//   FACEBOOK_APP_ID (or FACEBOOK_CLIENT_ID) / FACEBOOK_APP_SECRET (or FACEBOOK_CLIENT_SECRET)
//   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
//   APPLE_CLIENT_ID  / APPLE_CLIENT_SECRET  (Apple's secret is a signed JWT)
const OIDC_TOKEN_PROVIDERS: { [k: string]: any } = {
    google: {
        tokenUrl: 'https://oauth2.googleapis.com/token',
        clientId: () => process.env.GOOGLE_CLIENT_ID,
        clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
        acceptJson: false,
    },
    facebook: {
        tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
        clientId: () => process.env.FACEBOOK_APP_ID || process.env.FACEBOOK_CLIENT_ID,
        clientSecret: () => process.env.FACEBOOK_APP_SECRET || process.env.FACEBOOK_CLIENT_SECRET,
        acceptJson: false,
    },
    github: {
        tokenUrl: 'https://github.com/login/oauth/access_token',
        clientId: () => process.env.GITHUB_CLIENT_ID,
        clientSecret: () => process.env.GITHUB_CLIENT_SECRET,
        acceptJson: true,   // GitHub returns urlencoded unless you ask for JSON
    },
    apple: {
        tokenUrl: 'https://appleid.apple.com/auth/token',
        clientId: () => process.env.APPLE_CLIENT_ID,
        clientSecret: () => process.env.APPLE_CLIENT_SECRET,
        acceptJson: false,
    },
};

app.post(['/oidc/token', '/api/oidc/token'], async (req: any, res: any) => {
    try {
        const { provider, code, code_verifier, redirect_uri } = req.body || {};
        const p = OIDC_TOKEN_PROVIDERS[String(provider || '').toLowerCase()];
        if (!p) return res.status(400).json({ error: 'unsupported_provider', provider });

        const clientId = p.clientId() || req.body.client_id;
        const clientSecret = p.clientSecret();
        if (!clientId || !clientSecret) {
            return res.status(500).json({
                error: 'server_not_configured',
                error_description: `Set the ${String(provider).toUpperCase()} client id/secret env vars on the server.`,
            });
        }
        if (!code || !redirect_uri) {
            return res.status(400).json({ error: 'missing_params', error_description: 'code and redirect_uri are required.' });
        }

        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code: String(code),
            client_id: String(clientId),
            client_secret: String(clientSecret),
            redirect_uri: String(redirect_uri),
        });
        if (code_verifier) body.set('code_verifier', String(code_verifier));

        const headers: any = { 'Content-Type': 'application/x-www-form-urlencoded' };
        if (p.acceptJson) headers.Accept = 'application/json';

        const r = await fetch(p.tokenUrl, { method: 'POST', headers, body: body.toString() });
        const text = await r.text();
        let json: any;
        try {
            json = JSON.parse(text);
        } catch {
            // Some providers (older Facebook/GitHub) return application/x-www-form-urlencoded.
            const params = new URLSearchParams(text);
            json = {};
            params.forEach((v: string, k: string) => { json[k] = v; });
        }
        if (!r.ok || json.error) return res.status(r.ok ? 400 : r.status).json(json);
        return res.json(json);
    } catch (e: any) {
        return res.status(500).json({ error: 'proxy_error', error_description: e?.message || String(e) });
    }
});


// ---------------------------------------------------------------------------------------
// Stripe subscriptions.
//
// Hosted Stripe Checkout is used so cards, Apple Pay, Google Pay and Link are all supported
// with no PCI burden. The frontend (SubscriptionService) calls these; access is gated by a
// live subscription-status check against Stripe (keyed on the signed-in user's email).
//
// Env vars: STRIPE_SECRET_KEY, STRIPE_PRICE_ID (the subscription price), and optionally
// STRIPE_WEBHOOK_SECRET.
// Use a standard account secret key (sk_live_.../sk_test_...). Organization keys
// (sk_org_...) are NOT supported by this SDK version — they require a Stripe-Context
// header the SDK can't send.
const stripeClient: Stripe | null = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null;

function stripeReady(res: any): boolean {
    if (!stripeClient) {
        res.status(500).json({ error: 'stripe_not_configured', error_description: 'Set STRIPE_SECRET_KEY on the server.' });
        return false;
    }
    return true;
}

async function stripeCustomerFor(email: string, name?: string): Promise<Stripe.Customer> {
    const found = await stripeClient!.customers.list({ email, limit: 1 });
    if (found.data.length) return found.data[0];
    return stripeClient!.customers.create({ email, name });
}

// Accept either a price id (price_...) or a product id (prod_...). Passing an explicit
// price id is always unambiguous. For a product we resolve deterministically:
//   1. the product's configured DEFAULT price (set this in the dashboard), else
//   2. the single active recurring price if there's exactly one, else
//   3. the most recently created active recurring price (and warn — ambiguous).
// Cached so we don't hit Stripe on every checkout.
const priceCache: { [k: string]: string } = {};
async function resolvePriceId(idOrProduct: string): Promise<string> {
    if (!idOrProduct.startsWith('prod_')) return idOrProduct; // already a price id
    if (priceCache[idOrProduct]) return priceCache[idOrProduct];

    // 1. Honor the product's default price (deterministic — this is "the" price).
    const product = await stripeClient!.products.retrieve(idOrProduct);
    let priceId: string | undefined =
        typeof product.default_price === 'string' ? product.default_price
        : (product.default_price && typeof product.default_price === 'object') ? product.default_price.id
        : undefined;

    // 2/3. No default set → fall back to active recurring prices.
    if (!priceId) {
        const prices = await stripeClient!.prices.list({ product: idOrProduct, active: true, limit: 100 });
        const recurring = prices.data.filter(p => p.recurring);
        if (!recurring.length && !prices.data.length) {
            throw new Error(`Product ${idOrProduct} has no active price. Add a recurring price to it in Stripe.`);
        }
        const pick = recurring[0] || prices.data[0]; // Stripe lists newest-first
        if (recurring.length > 1) {
            console.warn(`[stripe] Product ${idOrProduct} has ${recurring.length} active recurring prices and no default_price set; ` +
                `using ${pick.id} (newest). Set a default price on the product, or put the exact price_... in STRIPE_PRICE_ID.`);
        }
        priceId = pick.id;
    }

    priceCache[idOrProduct] = priceId;
    return priceId;
}

// Is there an active/trialing subscription for this email?
app.get(['/stripe/subscription-status', '/api/stripe/subscription-status'], async (req: any, res: any) => {
    if (!stripeReady(res)) return;
    try {
        const email = String(req.query.email || '').trim();
        if (!email) return res.status(400).json({ error: 'missing_email' });
        const customers = await stripeClient!.customers.list({ email, limit: 1 });
        if (!customers.data.length) return res.json({ active: false, status: 'none' });
        const subs = await stripeClient!.subscriptions.list({ customer: customers.data[0].id, status: 'all', limit: 10 });
        const active = subs.data.find(s => s.status === 'active' || s.status === 'trialing');
        return res.json({
            active: !!active,
            status: active ? active.status : (subs.data[0]?.status || 'none'),
            currentPeriodEnd: active ? active.current_period_end : null,
            customerId: customers.data[0].id,
        });
    } catch (e: any) {
        return res.status(500).json({ error: 'stripe_error', error_description: e?.message || String(e) });
    }
});

// The configured plan price, for display on the paywall (so the UI matches what Stripe
// actually charges instead of hardcoded copy). { display: '$1', period: '/year', ... }.
app.get(['/stripe/price-info', '/api/stripe/price-info'], async (req: any, res: any) => {
    if (!stripeReady(res)) return;
    try {
        const idOrProduct = String(req.query.priceId || process.env.STRIPE_PRICE_ID || '');
        if (!idOrProduct) return res.status(500).json({ error: 'no_price', error_description: 'Set STRIPE_PRICE_ID on the server.' });
        const priceId = await resolvePriceId(idOrProduct);
        const price = await stripeClient!.prices.retrieve(priceId);

        const currency = (price.currency || 'usd').toUpperCase();
        const symbol = currency === 'USD' ? '$' : '';
        const amount = (price.unit_amount ?? 0) / 100;
        const amountStr = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
        const display = symbol ? symbol + amountStr : amountStr + ' ' + currency;

        let period = '';
        if (price.recurring) {
            const n = price.recurring.interval_count || 1;
            period = '/' + (n > 1 ? n + ' ' : '') + price.recurring.interval + (n > 1 ? 's' : '');
        }
        return res.json({
            priceId, display, period,
            amount, currency,
            interval: price.recurring?.interval || null,
            intervalCount: price.recurring?.interval_count || null,
        });
    } catch (e: any) {
        return res.status(500).json({ error: 'stripe_error', error_description: e?.message || String(e) });
    }
});

// Start a hosted Checkout for a subscription; returns { url } to redirect to.
app.post(['/stripe/create-checkout-session', '/api/stripe/create-checkout-session'], async (req: any, res: any) => {
    if (!stripeReady(res)) return;
    try {
        const { email, name, priceId, appBase, returnPath } = req.body || {};
        if (!email) return res.status(400).json({ error: 'missing_email' });
        const priceOrProduct = priceId || process.env.STRIPE_PRICE_ID;
        if (!priceOrProduct) return res.status(500).json({ error: 'no_price', error_description: 'Set STRIPE_PRICE_ID on the server (or pass priceId).' });
        const price = await resolvePriceId(String(priceOrProduct));

        const base = String(appBase || req.headers.origin || '').replace(/\/$/, '');
        const back = returnPath || '/subscribe';
        const customer = await stripeCustomerFor(email, name);

        const session = await stripeClient!.checkout.sessions.create({
            mode: 'subscription',
            customer: customer.id,
            line_items: [{ price, quantity: 1 }],
            allow_promotion_codes: true,
            client_reference_id: email,
            success_url: `${base}${back}?status=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${base}${back}?status=cancel`,
        });
        return res.json({ url: session.url, id: session.id });
    } catch (e: any) {
        return res.status(500).json({ error: 'stripe_error', error_description: e?.message || String(e) });
    }
});

// Open the Stripe billing portal (manage / cancel subscription); returns { url }.
app.post(['/stripe/portal', '/api/stripe/portal'], async (req: any, res: any) => {
    if (!stripeReady(res)) return;
    try {
        const { email, appBase } = req.body || {};
        if (!email) return res.status(400).json({ error: 'missing_email' });
        const customers = await stripeClient!.customers.list({ email, limit: 1 });
        if (!customers.data.length) return res.status(404).json({ error: 'no_customer' });
        const base = String(appBase || req.headers.origin || '').replace(/\/$/, '');
        const portal = await stripeClient!.billingPortal.sessions.create({
            customer: customers.data[0].id,
            return_url: base + '/',
        });
        return res.json({ url: portal.url });
    } catch (e: any) {
        return res.status(500).json({ error: 'stripe_error', error_description: e?.message || String(e) });
    }
});


// Share folder with a user
app.post('/share', (req, res) => {
    const { ljlfile, ownerId, userIdToShare } = req.body;
    let fname = ljlfile.file;
    const owner = ljlfile.owner;
    const encodedOwner = encodeEmail(owner);
    const key = getKey('user');
    fname = removeEmail(fname, encodedOwner.toString())
    let baseDir = path.join(key, encodedOwner); // Adjust base path as needed
    let shared_file = path.join(baseDir, fname);
    shared_file = removeMyFilesFromPath(shared_file)
    let spath = path.join(encodedOwner + '', fname);
    if (!spath.startsWith('/')) {
        spath = '/' + spath;
    }
    fname = removeMyFilesFromPath(fname);
    // console.log(" shared file " + shared_file)
    const data = fs.readFileSync(shared_file);
    const udata = stringToBinary(data.toString());
    const decompressedData = pako.inflate(udata, { to: 'string' });
    const gfolder = JSON.parse(decompressedData);
    let folderId = gfolder.uid;
    if (!folderId && gfolder.plateTrack) {
        folderId = gfolder.plateTrack.uid
    }
    // console.log(" folder " + folderId + ' guest ' + userIdToShare);
    if (!folderAccess[folderId]) folderAccess[folderId] = new Set();
    folderAccess[folderId].add(ownerId);
    sharedFolders[folderId] = gfolder;
    folderDetails[folderId] = {
        name: fname,
        owner: ownerId,
        path: spath
    }
    if (userIdToShare) {
        folderAccess[folderId].add(userIdToShare);
        const encodedUser = encodeEmail(userIdToShare);
        console.log(" Sharing with " + encodedUser)
        baseDir = path.join(key, encodedUser); // Adjust base path as needed
        const sharedDir = path.join(baseDir, 'Shared_With_Me');
        console.log(" Sharing with " + sharedDir)
        // Ensure Shared_With_Me directory exists
        ensureDirectoryExists(sharedDir);
        const filename = `${ownerId}-${folderId}.ljl-share`;
        const filePath = path.join(sharedDir, filename);
        console.log(' file path ' + filePath)
        fs.writeFileSync(filePath, JSON.stringify({
            name: fname,
            uid: folderId,
            owner,
            path: spath,
        }, null, 2));

    }
    res.send({ message: 'Folder shared' });
});






// Share folder with a user
app.post('/push', (req, res) => {
    let { folder } = req.body;
    if (typeof folder === 'string') {
        folder = JSON.parse(folder)
    }
    // console.log ( 'jpushing ' + JSON.stringify(folder))
    const folderId = folder.uid;
    if (!sharedFolders[folderId]) {
    } else {
        const original = sharedFolders[folderId]
        sharedFolders[folderId] = reconstituteObject(original, folder)
    }
    console.log(' pucsh complewtel ' + folderId + ' gfller ' + folder.uid)
    res.send({ message: 'Folder push complete' });
});
// Share folder with a user
app.post('/share-update', (req, res) => {
    const { folderId, ownerId, userIdToShare } = req.body;
    console.log("folder " + folderId + ' | guest: ' + userIdToShare + ' | owner: ' + ownerId);

    if (!folderId || (!ownerId && !userIdToShare)) {
        return res.status(400).send({ error: 'Missing folderId or userIds' });
    }

    if (!folderAccess[folderId]) folderAccess[folderId] = new Set();

    // Add only non-null/defined values
    if (ownerId) folderAccess[folderId].add(ownerId);
    if (userIdToShare) folderAccess[folderId].add(userIdToShare);

    // Clean up: remove any null or undefined values (just in case)
    folderAccess[folderId] = new Set(
        Array.from(folderAccess[folderId]).filter((id) => id !== null && id !== undefined)
    );

    // Print the current access list for this folder
    console.log(`Access list for folder ${folderId}:`, Array.from(folderAccess[folderId]));

    res.send({ message: 'Folder shared' });
});

app.post('/pull', (req, res) => {
    const { user, folderId } = req.body;
    if (folderAccess[folderId] && folderAccess[folderId].has(user)) {
        const folder = sharedFolders[folderId];
        if (folder) {
            console.log(" folder found and sending ..... ")
            return res.send({ folder });
        } else {
            console.log(' foldersd ' + Object.keys(sharedFolders))
            return res.status(404).send({ error: 'Folder not found' });
        }
    }
    return res.status(403).send({ error: 'User does not have access to this folder' });
});

app.get('/shared-folders/:userId', (req, res) => {
    const userId = req.params.userId;
    const sharedFolders = Object.keys(folderAccess).filter(folderId =>
        folderAccess[folderId].has(userId)
    );
    res.send({ sharedFolders });
});

type JSONValue = string | number | boolean | null | JSONObject | JSONArray;

interface JSONObject {
    [key: string]: JSONValue;
}
interface JSONArray extends Array<JSONValue> { }

interface WellJSON {
    name: string;
    value: any;
    obj?: any;
    group?: any;
    [key: string]: any;
}

class GenericWell {
    constructor(
        public name: string,
        public value: any,
        public obj?: any,
        public group?: any
    ) { }
}

class MGrid {
    [key: string]: any;
}

type OriginalObject = {
    grid?: MGrid;
    wells?: GenericWell[][];
    [key: string]: any;
};

type JSONObjectInput = {
    [key: string]: any;
};

const reconstituteObject = (
    originalObject: OriginalObject,
    jsonObject: JSONObjectInput
): OriginalObject => {
    for (const key in jsonObject) {
        if (Object.prototype.hasOwnProperty.call(jsonObject, key)) {
            const originalValue = originalObject[key];
            const jsonValue = jsonObject[key];

            if (jsonValue === null || typeof jsonValue !== 'object') {
                if (originalValue !== jsonValue) {
                    originalObject[key] = jsonValue;
                }
            } else if (typeof jsonValue === 'object' && originalValue && typeof originalValue === 'object') {
                if (key === 'grid' && originalValue instanceof MGrid) {
                    Object.assign(originalValue, jsonValue);
                } else if (key === 'wells' && Array.isArray(jsonValue)) {
                    for (let col = 0; col < jsonValue.length; col++) {
                        if (!originalValue[col]) {
                            originalValue[col] = [];
                        }

                        for (let row = 0; row < jsonValue[col].length; row++) {
                            const jsonWell: WellJSON = jsonValue[col][row];
                            if (originalValue[col][row] instanceof GenericWell) {
                                Object.assign(originalValue[col][row], jsonWell);
                            } else {
                                originalValue[col][row] = new GenericWell(
                                    jsonWell.name,
                                    jsonWell.value,
                                    jsonWell.obj,
                                    jsonWell.group
                                );
                                Object.assign(originalValue[col][row], jsonWell);
                            }
                        }

                        if (originalValue[col].length > jsonValue[col].length) {
                            originalValue[col].length = jsonValue[col].length;
                        }
                    }

                    if (originalValue.length > jsonValue.length) {
                        originalValue.length = jsonValue.length;
                    }
                } else {
                    reconstituteObject(originalValue, jsonValue);
                }
            }
        }
    }

    return originalObject;
};



app.post('/update-object', async (req, res) => {
    const { folderId, state, userId, socketId } = req.body;
    // console.log(`${userId} Users with access to folder ${folderId}:`);
    // for (const fi of Object.keys(folderAccess)) {
    //     console.log(fi + ' ===> ' + JSON.stringify(folderAccess[fi]));
    // }
    const folder = sharedFolders[folderId];

    if (!folderAccess[folderId] || !folderAccess[folderId].has(userId)) {
        console.log("update-object::::: User does not have access to this folder");
        console.log(" User  " + userId);
        console.log(" folder  " + folderId);
    }

    if (folder && typeof folder === 'object' && 'owner' in folder) {
        const typedFolder = folder as { owner: string };
        if (typedFolder.owner === userId) {
            folderAccess[folderId].add(userId);
        }
    }

    // const puser = encodeEmail(userId);
    // const key = getKey('user');
    // const sharedFilesPath = path.join(key, puser, 'Shared_With_Me');
    if (!folderAccess[folderId] || !folderAccess[folderId].has(userId)) {
        console.warn("update-object::::: User does not have access to this folder");
        console.warn("User:", userId);
        console.warn("Folder:", folderId);
        const puser = encodeEmail(userId);
        const key = getKey('user');
        const sharedFilesPath = path.join(key, puser);
        // Recursively search for files ending with .ljl-share
        function searchSharedFiles(dir: string) {
            const files = fs.readdirSync(dir, { withFileTypes: true });

            for (const file of files) {
                const fullPath = path.join(dir, file.name);

                if (file.isDirectory()) {
                    const found = searchSharedFiles(fullPath);
                    if (found) return true;
                } else if (file.name.endsWith('.ljl-share')) {
                    try {
                        const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
                        if (data.uid === folderId) {
                            console.log("Found shared access file:", fullPath);
                            // Optional: You could grant access or return from here
                            return true;
                        }
                    } catch (err) {
                        console.error("Error reading/parsing file:", fullPath, err.message);
                        return res.send({ error: err.message });

                    }
                }
            }

            return false;
        }

        const hasSharedAccess = searchSharedFiles(sharedFilesPath);
        if (!hasSharedAccess) {
            console.log("No matching shared file found for folder:", folderId);
        } else {
            folderAccess[folderId] = userId
        }
    }
    if (!folderAccess[folderId] || !folderAccess[folderId].has(userId)) {
        return res.send({ error: 'User does not have access to this folder' });
    }
    const objectId = state.uid;
    if (!objectStates[folderId]) objectStates[folderId] = {};
    objectStates[folderId][objectId] = state;


    if (!folderDetails[folderId]) {

    }






    const room = io.sockets.adapter.rooms.get(folderId);
    const numConnected = room ? room.size : 0;
    console.log(`${socketId} =========== Number of connected clients in folder ${folderId}: ${numConnected}`);

    // Send to everyone *except* the sender
    if (socketId && io.sockets.sockets.get(socketId)) {
        io.sockets.sockets.get(socketId).to(folderId).emit('objectUpdated', { folderId, objectId, state });
    } else {
        // Fallback if socketId missing or invalid
        console.log('No valid socketId, sending to all clients in folder');
        const room = io.sockets.adapter.rooms.get(folderId);
        if (!room) {
            console.log(`Folder ${folderId} - no connected clients`);
            res.send({ message: 'No socket room for folder' });

        }

        try {
            const connectedSocketIds = Array.from(room);
            const userList = Array.from(folderAccess[folderId]);
            console.log(`Folder ID: ${folderId}`);
            console.log(`  Users with access: ${userList.join(', ')}`);
            console.log(`  Connected socket IDs that will receive emit:`);
            for (const socketId of connectedSocketIds) {
                console.log(`    - ${socketId}`);
            }
            io.to(folderId).emit('objectUpdated', { folderId, objectId, state });
        } catch (exception) {
            console.log(" array from failed ")
            res.send({ message: exception.message });

        }
    }

    res.send({ message: 'Object updated' });
});






function logFolderEmitTargets() {
    console.log("===== Emit Targets Per Folder =====");
    for (const folderId of Object.keys(folderAccess)) {
        const room = io.sockets.adapter.rooms.get(folderId);
        if (!room) {
            console.log(`Folder ${folderId} - no connected clients`);
            continue;
        }
        const connectedSocketIds = Array.from(room);
        const userList = Array.from(folderAccess[folderId]);
        console.log(`Folder ID: ${folderId}`);
        console.log(`  Users with access: ${userList.join(', ')}`);
        console.log(`  Connected socket IDs that will receive emit:`);
        for (const socketId of connectedSocketIds) {
            console.log(`    - ${socketId}`);
        }
    }

    console.log("=====================================");
}
// setInterval(() => {
//     // logFolderEmitTargets();
// }, 14000);
interface JoinFolderPayload {
    folderId: string;
    userId: string;
}

io.on('connection', (socket: any) => {
    console.log('User connected:', socket.id);

    socket.on('joinFolder', ({ folderId, userId }: JoinFolderPayload) => {

        if (!userId) {
            return;
        }

        const hasAccess = folderAccess[folderId]?.has(userId);




        if (hasAccess) {
            socket.join(folderId);
            console.log(`User ${userId} joined folder ${folderId}`);
            return;
        }

        console.log(`Initial access denied for user ${userId} to folder ${folderId}`);


        const puser = encodeEmail(userId);
        const key = getKey('user');




        const sharedFilesPath = path.join(key, puser);

        try {
            const files = fs.readdirSync(sharedFilesPath);

            const matchingFile = files.find((file: string) => {
                return (
                    file.endsWith(folderId + '.ljl-share')
                    // !file.startsWith(userId) // Assuming the file name starts with owner's email
                );
            });

            if (matchingFile) {
                // Grant access since shared file found
                if (!folderAccess[folderId]) {
                    folderAccess[folderId] = new Set();
                }
                folderAccess[folderId].add(userId);
                socket.join(folderId);
                console.log(`User ${userId} granted access to folder ${folderId} via shared file: ${matchingFile}`);
            } else {
                console.log(`No matching shared file found for user ${userId} in folder ${folderId}`);
            }
        } catch (err) {
            console.error(`Error reading shared files for user ${userId}:`, err);
        }

        // Debug: show current folderAccess structure
        for (const f of Object.keys(folderAccess)) {
            console.log(`Access list for folder ${f}:`, Array.from(folderAccess[f]));
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});


app.get('/deprecated_transcript/:id', (req, res) => {
    const transcriptId = req.params.id;
    const strippedId = stripDecimal(transcriptId);

    if (annotationsCache[strippedId]) {
        res.json(annotationsCache[strippedId]);
    } else {
        res.status(404).json({ message: `Transcript ID ${transcriptId} not found.` });
    }
});




function ensureNotADirectory(filePath: string): void {
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isDirectory()) {
        throw new Error(`${filePath} is a directory, expected a file.`);
    }
}


function ensureDirectoryPathExists(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

app.post('/save-train', (req, res) => {
    const data = req.body;

    if (!data) {
        return res.status(400).json({ error: 'Missing JSON body' });
    }

    const filePath = path.join(htsFilesPath, 'TDW.json');

    try {
        ensureDirectoryPathExists(filePath);
        ensureNotADirectory(filePath);

        console.log('writing to :', filePath);


    } catch (err: any) {
        console.error('Path error:', err);
        return res.status(500).json({ error: err.message });
    }

    const jsonString = JSON.stringify(data) + '\n'; // NDJSON format

    fs.appendFile(filePath, jsonString, 'utf8', (err: any) => {
        if (err) {
            console.error('Error writing to file:', err);
            return res.status(500).json({ error: 'Failed to write to file' });
        }

        res.status(200).json({ message: 'Data successfully appended' });
    });
});





app.get("/", (req, res) => {
    try {
        const configv = fs.readFileSync('~/trails.json', 'utf-8')
        if (configv) {
            const cconfigv = JSON.parse(configv)
            wd = cconfigv.trails
        }
    } catch (exception) {
        console.log(" no config file so scripping ")
    }
    res.render("index");
});
type EncryptionResult = {
    encryptedData: ArrayBuffer;
    iv: Uint8Array;
};
async function generateKey(): Promise<CryptoKey> {
    return window.crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
}
async function encryptData(key: CryptoKey, data: object): Promise<EncryptionResult> {
    const encoder = new TextEncoder();
    const encoded = encoder.encode(JSON.stringify(data));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));

    const encrypted = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
    return { encryptedData: encrypted, iv };
}

async function decryptData(key: CryptoKey, encryptedData: ArrayBuffer, iv: Uint8Array): Promise<object> {
    const decrypted = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encryptedData);
    const decoder = new TextDecoder();
    const decoded = decoder.decode(decrypted);
    return JSON.parse(decoded);
} 1
app.post('/enc', async (req, res) => {
    try {
        const key = await generateKey();
        const { encryptedData, iv } = await encryptData(key, req.body);
        res.json({ encryptedData: Buffer.from(encryptedData).toString('base64'), iv: Buffer.from(iv).toString('base64') });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.post('/dec', async (req, res) => {
    try {
        const key = await generateKey(); // In a real scenario, use the same key from encryption
        const encryptedData = Buffer.from(req.body.encryptedData, 'base64');
        const iv = Buffer.from(req.body.iv, 'base64');
        const decryptedData = await decryptData(key, encryptedData, iv);
        res.json(decryptedData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
function createSha256Hash(data: string): string {
    const hash = createHash('sha256');
    hash.update(data);
    return hash.digest('base64'); // Output as base64 to make it URL-safe and slightly shorter
}

// Route to hash a string
app.post('/hash', async (req, res) => {
    if (!req.body || !req.body.data) {
        return res.status(400).send({ error: 'No data provided' });
    }
    try {
        const hashedData = createSha256Hash(req.body.data);
        res.send({ hashedData });
    } catch (error) {
        res.status(500).json({ error: 'Error hashing data' });
    }
});


// Promisify zlib methods for use with async/await
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Function to compress a string
async function compressString(data: string): Promise<Buffer> {
    return gzip(Buffer.from(data, 'utf-8'));
}

// Function to decompress a string
async function decompressString(data: Buffer): Promise<string> {
    const buffer = await gunzip(data);
    return buffer.toString('utf-8');
}

// Route to compress a string
app.post('/comp', async (req, res) => {
    if (!req.body || !req.body.data) {
        return res.status(400).send({ error: 'No data provided' });
    }
    try {
        const compressedData = await compressString(req.body.data);
        res.send({ compressedData: compressedData.toString('base64') }); // Send as base64 to ensure safe transmission
    } catch (error) {
        res.status(500).json({ error: 'Error compressing data' });
    }
});
app.post('/decomp', async (req, res) => {
    if (!req.body || !req.body.data) {
        return res.status(400).send({ error: 'No data provided' });
    }
    try {
        const compressedData = Buffer.from(req.body.data, 'base64');
        const decompressedData = await decompressString(compressedData);
        res.send({ decompressedData });
    } catch (error) {
        res.status(500).json({ error: 'Error decompressing data' });
    }
});















export class ExpressionObject {
    name: string;
    values: { [key: string]: any } = {};
    constructor(name: string) {
        this.name = name;
    }
    public set(key: string, value: any) {
        this.values[key] = value;
    }
}
app.get('/load-cache', async (req, res) => {
    // Or var xlsx = require('node-xlsx').default;
    // Parse a buffer
    let data;
    const workbook = xlsx.parse(fs.readFileSync(`./data/gene-expression/gtex-expression.xlsx`));
    for (const w of workbook) {
        console.log(w.name)
        data = w.data;
        cache.add(w.name, data);
    }
    console.log(" Cache loaded ")
    return res.json(data)
})


const crypto = require('crypto');
const secretKeyHex = "A4BA8B43795566F988FF8FCBC3016E70";
console.log(' key length ' + secretKeyHex.length)
const byteArray = Buffer.from(secretKeyHex, 'hex');
const iv = createIVFromString('powers'); // 128 bits
function createIVFromString(inputString: any) {
    const iv = crypto.createHash('md5').update(inputString).digest();
    return iv;
}
function encodeEmail(email: string) {
    if (!email) {
        return email;
    }
    const cipher = crypto.createCipheriv('aes-256-cbc', byteArray.toString('hex'), iv);
    let encrypted = cipher.update(email, 'utf-8', 'hex');
    encrypted += cipher.final('hex');
    return '' + encrypted;
}
function decodeEmail(encodedEmail: string) {
    const decipher = crypto.createDecipheriv('aes-256-cbc', byteArray.toString('hex'), iv);
    let decrypted = decipher.update(encodedEmail, 'hex', 'utf-8');
    decrypted += decipher.final('utf-8');
    return decrypted;
}
const email = 'installer@lajollalabs.com';
const encoded = encodeEmail(email);
console.log('Encoded:', encoded);
const decoded = decodeEmail(encoded);
console.log('Decoded:', decoded);
const databases: { [key: string]: JsonDatabase } = {};




// const compressed = pako.deflate(typedArray);
// const decompressed = pako.inflate(compressedData);








function findFileRecursively(startDir: string, targetFileName: string): string {
    try {
        // Read the contents of the current directory
        const files = fs.readdirSync(startDir);

        // Loop through each file or directory in the current directory
        for (const file of files) {
            const filePath = path.join(startDir, file);

            // Check if the current item is a directory
            if (fs.statSync(filePath).isDirectory()) {
                // If it's a directory, recursively search within it
                const foundInSubDirectory = findFileRecursively(filePath, targetFileName);
                if (foundInSubDirectory) {
                    return foundInSubDirectory; // File found in a subdirectory
                }
            } else if (file === targetFileName) {
                // If it's a file and matches the target file name, return the file path
                return filePath; // File found in the current directory
            }
        }

        // File not found in the current directory or its subdirectories
        return null;
    } catch (err) {
        // Handle any errors, such as permission issues
        console.error('Error while searching for the file:', err);
        return null;
    }
}




app.get('/jdbc/:chrom/:key', (req, res) => {
    const key = req.params.key;
    const chrom = req.params.key;

    const obj = databases[chrom + '/' + key]?.getObject(key);
    if (obj) {
        res.json(obj);
    } else {
        res.status(404).json({ error: 'Object not found' });
    }
});

app.post('/jdbc/:chrom/:key/:crange/:idvalue', (req, res) => {
    const key = req.params.key;
    const chrom = req.params.chrom;
    const crange = req.params.crange;
    const idvalue = req.params.idvalue;
    const { key: dbKey, value } = req.body;



    if (!key || !dbKey || !value) {
        res.status(400).json({ error: 'Both key, dbKey, and value are required in the request body' });
    } else {
        let db = databases[chrom + '/' + dbKey];
        if (!db) {
            db = new JsonDatabase(chrom + '/' + dbKey);
            databases[chrom + '/' + dbKey] = db;
        }
        db.addObject(key + '/' + crange + "/" + idvalue, req.body);
        res.status(201).json({ message: 'Object added successfully' });
    }
});




app.get('/get-cached-expression', async (req, res) => {
    const sheet = '' + req.query.sheet;
    const gene = '' + req.query.ensembl;
    const tissue_list = '' + req.query.cell_types;


    let t = []
    let g = []
    if (gene.indexOf(',') > 0) {
        g = gene.split(',')
    }
    else {
        g = [gene]
    }
    if (tissue_list.indexOf(',') > 0) {
        t = tissue_list.split(',')
    }
    else {
        t = [tissue_list]
    }


    const cache_item = cache.get(`${sheet}`)
    console.log(` sheet not found: ${sheet} `)
    if (cache_item != null) {
        const table = cache_item.obj;
        const row1 = table[0]
        let index = 0;
        const t_index = [];
        for (const col of row1) {
            for (const tissue of t) {
                if (col === `${tissue}`) {
                    t_index.push(index);
                }
            }
            index++;
        }
        const resjson: { [key: string]: any } = {};
        if (index >= 0) {
            for (const r of table) {
                for (const ensembl of g) {
                    if (r[0].trim() == ensembl.trim()) {
                        for (const tissue of t_index) {
                            resjson[row1[tissue] + '_-_' + ensembl] = r[tissue]
                        }
                    }
                }
            }
            return res.json(resjson);
        } else {
            return res.json({ tissue: 'Not Found' })

        }
    }
    res.json({ 'status': 'Not Found' })
})

/**
 *  deprecated
 */
app.get('/get-cached-tissues', async (req, res) => {
    const sheet = '' + req.query.sheet;
    const cache_item = cache.get(`${sheet}`)
    if (cache_item != null) {
        const table = cache_item.obj;
        const row1 = table[0]
        return res.json(row1)
    }
    return res.json({ 'status': 'Not Found' })
})




/*********************************************************************************************/
/*********************************************************************************************/
/*********************************************************************************************/
/*********************************************************************************************/






const Folder = (folderPath: string, l: {}[], parent: any) => {
    try {
        const files = fs.readdirSync(folderPath);
        files.forEach((file: any) => {
            const filePath = path.join(folderPath, file);
            const stats = fs.statSync(filePath);

            let name = filePath;
            if (name.indexOf('/') >= 0) {
                name = name.substring(name.lastIndexOf('/') + 1)
            }
            if (stats.isDirectory()) {
                const p = {
                    'parent': parent.id, 'name': name,
                    path: filePath, 'id': stats.ino, 'size': stats.size, 'isFolder': stats.isDirectory()
                }
                Folder(filePath, l, p);
                l.push(p);

            } else {
                l.push({
                    'parent': parent.id, 'name': name,
                    path: filePath, 'id': stats.ino, 'size': stats.size, 'isFolder': stats.isDirectory()
                });
            }
        });
    } catch (error) {
        console.error('Error:', error);
    }
}




const browseFolder = (folderPath: string, l: string[]) => {
    try {
        const files = fs.readdirSync(folderPath);
        files.forEach((file: any) => {
            const filePath = path.join(folderPath, file);
            const stats = fs.statSync(filePath);


            if (stats.isDirectory()) {
                console.log('Directory:', filePath);
                browseFolder(filePath, l);
            } else {
                console.log('File:', filePath);
                l.push(filePath)
            }
        });
    } catch (error) {
        console.error('Error:', error);
    }
}




app.get('/ls-folder', async (req, res) => {
    let c = req.query.path;
    let key = req.query.key;
    if (key != null) {
        key = getKey(key + '')
    } else {
        key = htsFilesPath;
    }

    if (!c) {
        c = '/tmp'
    } else {
        c = key + '/' + c;
    }
    const l: string[] = []
    browseFolder(c, l);
    res.json(l)
})


const getKey = (root: string) => {
    let key = htsFilesPath;
    if (root === "htsFiles") {
        key = htsFilesPath;
    } else if (root.toLowerCase() === 'bigdata') {
        return bigDataFilesPath;
    }
    else if (root.toLowerCase() === 'config') {
        return configPath;
    } else if (root.toLowerCase() === 'user') {
        return userData;
    }
    else if (root.toLowerCase() === 'wd') {
        return wd;
    }
    else {
        return htsFilesPath;
    }
    return key;
}
function reduceContiguousNodes(filePath: string, node: string) {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const segments = normalizedPath.split('/');
    const reducedSegments = [];
    let prevSegment = null;
    for (const segment of segments) {
        if (segment === node && prevSegment === node) {
            continue; // Skip this segment as it's a duplicate
        }
        reducedSegments.push(segment);
        prevSegment = segment;
    }
    const reducedPath = reducedSegments.join('/');
    return reducedPath;
}



// Set up multer storage with a dynamic destination and filename
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        let uploadPath = path.join(__dirname, '../tmp'); // Default path

        if (req.body.type === 'model') {
            const user = req.body.user;
            const puser = encodeEmail(user);
            const key = getKey('user');
            uploadPath = path.join(key, puser, '.models');

            // Ensure the directory exists
            ensureDirectoryExists(uploadPath);
        }

        cb(null, uploadPath); // Set the destination folder dynamically
    },
    filename: (req, file, cb) => {
        // Use the filename provided in the request body or generate a timestamped filename
        const fileName = req.body.filename || `${Date.now()}-${file.originalname}`;
        cb(null, fileName);
    }
});

const upload = multer({ storage });


app.post("/upload", (req, res) => {
    const form = new formidable.IncomingForm({
        multiples: false,
        keepExtensions: true,
    });

    form.parse(req, async (err: any, fields: { user: any; type: any; uploadId: any; filename: any; chunkIndex: any; totalChunks: any; fileSize: any; path: any; }, files: { file: any[]; }) => {
        try {
            if (err) {
                console.error("form parse error:", err);
                return res.status(400).json({ failed: "error parsing form" });
            }

            const uploaded = Array.isArray(files.file) ? files.file[0] : files.file;
            if (!uploaded) {
                return res.status(400).json({ failed: "not a proper file" });
            }

            const user = String(fields.user || "");
            const type = String(fields.type || "");
            const uploadId = String(fields.uploadId || "");
            const filename = String(fields.filename || uploaded.originalFilename || "");
            const chunkIndex = Number(fields.chunkIndex);
            const totalChunks = Number(fields.totalChunks);
            const fileSize = Number(fields.fileSize || 0);

            const pathr = fields.path ? String(fields.path) : "";
            const puser = encodeEmail(user);

            if (!user || !type || !filename || !uploadId) {
                return res.status(400).json({ failed: "missing upload metadata" });
            }

            if (
                !Number.isInteger(chunkIndex) ||
                !Number.isInteger(totalChunks) ||
                chunkIndex < 0 ||
                totalChunks <= 0 ||
                chunkIndex >= totalChunks
            ) {
                return res.status(400).json({ failed: "invalid chunk metadata" });
            }

            let uploadPath = path.join(__dirname, "../tmp");

            if (type === "model") {
                const key = getKey("user");
                uploadPath = path.join(key, puser, ".models");
            } else if (type === "data") {
                const key = getKey("user");
                uploadPath = pathr ? path.join(key, puser, pathr) : path.join(key, puser);
            }

            ensureDirectoryExists(uploadPath);

            // sanitize file name
            const safeFilename = path.basename(filename);

            // temp file per upload
            const tempFilePath = path.join(uploadPath, `${safeFilename}.${uploadId}.part`);
            const finalFilePath = path.join(uploadPath, safeFilename);
            const metaFilePath = path.join(uploadPath, `${safeFilename}.${uploadId}.json`);

            const chunkBuffer = await fs.promises.readFile(uploaded.filepath);

            let meta = {
                uploadId,
                filename: safeFilename,
                expectedNextChunk: 0,
                totalChunks,
                fileSize,
            };

            if (await exists(metaFilePath)) {
                const raw = await fs.promises.readFile(metaFilePath, "utf8");
                meta = JSON.parse(raw);
            }

            if (meta.expectedNextChunk !== chunkIndex) {
                return res.status(409).json({
                    failed: `out of order chunk: expected ${meta.expectedNextChunk}, got ${chunkIndex}`,
                });
            }

            if (chunkIndex === 0) {
                await fs.promises.writeFile(tempFilePath, chunkBuffer);
            } else {
                await fs.promises.appendFile(tempFilePath, chunkBuffer);
            }

            meta.expectedNextChunk = chunkIndex + 1;
            await fs.promises.writeFile(metaFilePath, JSON.stringify(meta), "utf8");

            const isLastChunk = chunkIndex === totalChunks - 1;

            if (isLastChunk) {
                const stat = await fs.promises.stat(tempFilePath);

                if (fileSize > 0 && stat.size !== fileSize) {
                    return res.status(400).json({
                        failed: `final size mismatch: expected ${fileSize}, got ${stat.size}`,
                    });
                }

                await fs.promises.rename(tempFilePath, finalFilePath);
                await fs.promises.unlink(metaFilePath).catch(() => { });

                return res.json({
                    success: [safeFilename],
                    folder: puser,
                    completed: true,
                });
            }

            return res.json({
                success: [safeFilename],
                folder: puser,
                completed: false,
                nextChunk: meta.expectedNextChunk,
            });
        } catch (error) {
            console.error("Error saving chunk:", error);
            return res.status(500).json({ failed: "Error saving file" });
        }
    });
});

async function exists(filePath: any) {
    try {
        await fs.promises.access(filePath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}












app.get('/get-folder', async (req, res) => {
    try {
        // Resolve user
        const userId = (req.headers['x-user-id'] as string) || (req.headers.user as string) || '';
        if (!userId) {
            return res.json({ msg: '' });
        }
        console.log('User-ID:', userId);
        const key = getKey(String(req.query.key || ''));
        if (!key) {
            return res.json({ msg: 'Missing key' });
        }
        const incoming = String(req.query.path ?? '/').trim() || '/';
        console.log('****  ' + incoming);

        let pub = false;
        if (incoming.indexOf('public/myfile') > 0 || incoming.startsWith('public') && userId) {
            pub = true;
        }
        // Base root under which all access must stay
        const root = key.endsWith('/') ? key.slice(0, -1) : key;

        // If root request, route to user's own folder: <key>/<encodeEmail(userId)>
        const userEncoded = encodeEmail(String(userId));
        let c = incoming === '/'
            ? path.posix.join(root, userEncoded)
            : path.posix.join(root, incoming);

        // Normalize and ensure we're still under root
        c = path.posix.normalize(c);
        if (!c.startsWith(root + '/')) {
            return res.json({ msg: 'Security Error Logged.' });
        }

        // Determine "name" for response
        const name = incoming === '/' ? '/' : path.posix.basename(c) || '/';

        // If path has an email, enforce that it matches the caller
        let pathEmail: string | null = null;
        if (hasEmailInPath(c)) {
            pathEmail = extractEmailFromPath(c);
            if (!pathEmail) {
                return res.json({ msg: 'Invalid email in path.' });
            }
            if (String(pathEmail).toLowerCase() !== String(userId).toLowerCase()) {
                return res.json({ msg: 'Security Error Logged.' });
            }
        }

        // Use email from path if present, otherwise userId
        const effectiveEmail = pathEmail || String(userId);
        const encoded = encodeEmail(effectiveEmail);

        // Replace raw emails with encoded placeholder and reduce nodes, if desired
        c = replaceEmailsWithPlaceholder(c, encoded);
        c = reduceContiguousNodes(c, encoded);

        // Ensure directory exists
        if (!fs.existsSync(c)) {
            fs.mkdirSync(c, { recursive: true });
        }

        const stats = fs.statSync(c);

        // ----- SPECIAL CASE: incoming is exactly "/<useremail>" and matches userId -----
        // If true, displayPath must be key + '/' + encodedEmail (no scrub/mask).
        const isExactUserRoot =
            incoming.startsWith('/') &&
            incoming.split('/').filter(Boolean).length === 1 &&
            incoming.split('/').filter(Boolean)[0].toLowerCase() === String(userId).toLowerCase();

        let displayPath: string;

        if (isExactUserRoot) {
            displayPath = encoded; // required behavior
            console.log(' displayPath (exact user root) ', displayPath);
        } else {
            // Optional "scrub"
            displayPath = c;
            if (key) {
                displayPath = scrub(displayPath, key);
            }
            console.log(' scrubbed c ' + displayPath);

            // If the scrubbed path ends with the encoded email, mask it in the display (not on disk)
            if (displayPath.endsWith(encoded)) {
                displayPath = displayPath.slice(0, -encoded.length) + 'myfile';
            }
        }
        // ------------------------------------------------------------------------------

        const children: any[] = [];
        const rf: any = {
            name,
            path: displayPath,
            id: stats.ino,
            size: stats.size,
            isFolder: stats.isDirectory(),
            children,
        };



        // console.log(" display Path " + displayPath)
        let temp = path.posix.join(key, encoded); // required behavior


        if (pub || displayPath.startsWith('/public') || displayPath.startsWith('public')) {
            console.log(" pub ")
            temp = path.posix.join(key, 'public/' + encoded);
        }



        Folder(temp, children, rf);
        rf.children = children;

        // console.log(" temp " + JSON.stringify(rf))



        return res.json(rf);
    } catch (exception: any) {
        console.log(' ?Failed to create the folder ', exception);
        return res.json({ msg: exception?.message || 'Unknown error' });
    }
});



function extractEmailFromPath(filePath: string) {
    const emailPattern = /[\w\.-]+@[\w\.-]+/;
    const match = filePath.match(emailPattern);
    if (match) {
        return match[0]; // Return the matched email address
    } else {
        return null; // No email address found in the file path
    }
}
function hasEmailInPath(filePath: string) {
    // Define a regular expression pattern for matching email addresses
    const emailPattern = /[\w\.-]+@[\w\.-]+/;

    // Test if the pattern matches in the file path
    return emailPattern.test(filePath);
}


function scrub(path: string, key: string) {
    return replaceSubpath(path, key, '');
}


function replaceSubpath(path: string, subpathToReplace: string, replacement: string) {
    return path.replace(subpathToReplace, replacement)
}

function canAccess(key: string, path: string) {
    // Normalize paths to remove any trailing slashes for consistency
    const normalizedKey = key.replace(/\/$/, '');
    const normalizedPath = path.replace(/\/$/, '');

    // Check if the key starts with the path (and is not above the specified level)
    if (
        normalizedKey === normalizedPath ||
        normalizedKey.startsWith(normalizedPath + '/')
    ) {
        return false;
    }

    return true;
}


import type { NextFunction, Request, Response } from "express";
import pLimit from "p-limit";


type NodeItem = {
    parent: number;
    name: string;
    path: string;
    id: number;
    size: number;
    isFolder: boolean;
    lastEdited: Date;
};

const DEFAULT_CACHE_TTL = 0; // 24 hours
const CACHE_TTL_FILE = path.join(wd, "cache-ttl.txt");

const nodeCache = new Map<string, { values: NodeItem[]; timestamp: number; pub: boolean }>();
function parseTTL(value: string): number | null {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return null;

    // plain number = milliseconds
    if (/^\d+$/.test(raw)) {
        const ms = Number(raw);
        return Number.isFinite(ms) && ms > 0 ? ms : null;
    }

    // supports: 10s, 5m, 6h, 2d
    const match = raw.match(/^(\d+)\s*(ms|s|m|h|d)$/);
    if (!match) return null;

    const amount = Number(match[1]);
    const unit = match[2];

    if (!Number.isFinite(amount) || amount <= 0) return null;

    switch (unit) {
        case "ms":
            return amount;
        case "s":
            return amount * 1000;
        case "m":
            return amount * 60 * 1000;
        case "h":
            return amount * 60 * 60 * 1000;
        case "d":
            return amount * 24 * 60 * 60 * 1000;
        default:
            return null;
    }
}

async function getDynamicCacheTTL(): Promise<number> {
    try {
        const raw = await fs.promises.readFile(CACHE_TTL_FILE, "utf-8");
        return parseTTL(raw) ?? DEFAULT_CACHE_TTL;
    } catch {
        return DEFAULT_CACHE_TTL;
    }
}




app.get("/get-nodes", async (req: Request, res: Response) => {
    try {
        const userId = (req.headers["x-user-id"] as string) || (req.headers.user as string);
        const authHeader = (req.headers.authorization as string) || "";

        console.log("[get-nodes] userId:", userId, "auth:", authHeader ? "(present)" : "(none)");

        if (!userId) {
            return res.json({ values: [], msg: "Missing user id" });
        }

        const rawKey = String(req.query.key || "");
        let incoming: string = String(req.query.path ?? "/").trim() || "/";

        const isLibrary =
            rawKey === "library" ||
            incoming === "/library" ||
            incoming.startsWith("/library/");

        let key: string = getKey(rawKey);

        if (!key) {
            return res.json({ values: [], msg: "Missing key" });
        }

        if (key.endsWith("/")) key = key.slice(0, -1);

        let c: string;
        let baseRoot: string;

        if (isLibrary) {
            baseRoot = path.posix.join(key, "library");

            const libraryPath = incoming.replace(/^\/library\/?/, "");

            if (!libraryPath || libraryPath === "." || libraryPath === "/") {
                c = baseRoot;
            } else {
                c = path.posix.join(baseRoot, libraryPath);
            }
        } else {
            const userEncoded = encodeEmail(userId);
            const userRoot = path.posix.join(key, userEncoded);

            console.log("[get-nodes] incoming:", incoming, "key:", key, "userRoot:", userRoot);

            if (incoming === "/" || incoming === "./" || incoming === "/." || incoming === "./.") {
                c = userRoot;
            } else {
                if (incoming.startsWith("/")) incoming = incoming.slice(1);
                c = path.posix.join(key, incoming);
            }

            c = path.posix.normalize(c);

            const isBDPath = c.startsWith("/bd");
            baseRoot = isBDPath ? "/bd" : userRoot;
        }

        c = path.posix.normalize(c);
        baseRoot = path.posix.normalize(baseRoot);

        console.log("[get-nodes] resolved:", { incoming, key, baseRoot, c, isLibrary });

        const insideBaseRoot = c === baseRoot || c.startsWith(baseRoot + "/");
        if (!insideBaseRoot) c = baseRoot;

        if (!isLibrary && hasEmailInPath(c)) {
            const pathEmail = extractEmailFromPath(c);

            if (!pathEmail) {
                return res.json({ values: [], msg: "Invalid email in path." });
            }

            if (pathEmail.toLowerCase() !== userId.toLowerCase()) {
                return res.json({ values: [], msg: "Security Error Logged." });
            }
        }

        let pub = false;

        if (!isLibrary && incoming.includes("public/myfile")) {
            pub = true;
            const cc = "/public/" + encodeEmail(String(userId));
            c = path.posix.join(key, cc);
        }

        const cacheKey = `${userId}:${rawKey}:${c}:${pub}:${isLibrary}`;
        const cached = nodeCache.get(cacheKey);
        const cacheTTL = await getDynamicCacheTTL();

        if (cached && Date.now() - cached.timestamp < cacheTTL) {
            return res.json({
                userId,
                values: cached.values,
                pub: cached.pub,
                cached: true,
                cacheTTL,
                library: isLibrary,
            });
        }

        await fs.promises.mkdir(baseRoot, { recursive: true });
        await fs.promises.mkdir(c, { recursive: true });

        const [dirents, parentStats] = await Promise.all([
            fs.promises.readdir(c, { withFileTypes: true }),
            fs.promises.stat(c),
        ]);

        const limit = pLimit(32);

        const items = await Promise.all(
            dirents
                .filter((d: { name: string }) => !d.name.startsWith("."))
                .map((d: { name: string; isDirectory: () => boolean }) =>
                    limit(async () => {
                        const filePath = path.posix.join(c, d.name);
                        const stats = await fs.promises.stat(filePath);

                        const node: NodeItem = {
                            parent: parentStats.ino,
                            name: d.name,
                            path: isLibrary
                                ? path.posix.join("/library", path.posix.relative(baseRoot, filePath))
                                : scrub(filePath, key),
                            id: stats.ino,
                            size: stats.size,
                            isFolder: d.isDirectory(),
                            lastEdited: stats.mtime,
                        };

                        return { node, mtimeMs: stats.mtimeMs };
                    })
                )
        );

        items.sort((a, b) => b.mtimeMs - a.mtimeMs);

        const values: NodeItem[] = items.map((x) => x.node);

        nodeCache.set(cacheKey, {
            values,
            timestamp: Date.now(),
            pub,
        });

        return res.json({
            userId,
            values,
            pub,
            cached: false,
            library: isLibrary,
        });
    } catch (error) {
        console.error("Error:", error);
        return res.json({ values: [], msg: (error as Error).message });
    }
});

const input_directoryPath = '/query';
const output_directoryPath = '/results';

const inputtemplate = input_directoryPath + '/';
const resultstemplate = output_directoryPath + '/';


// Genome list for the off-target UI. Returns an object whose keys are the
// locally-available index names (the UI reads Object.keys() only), including
// alias display names that resolve to a present index.
app.get('/genomes', (_req: any, res: any) => {
    const out: Record<string, any> = {};
    try {
        if (offtarget_index_root && fs.existsSync(offtarget_index_root)) {
            for (const name of fs.readdirSync(offtarget_index_root)) {
                if (fs.existsSync(path.join(offtarget_index_root, name, "meta.json"))) {
                    out[name] = { name };
                }
            }
        }
    } catch (e) { console.error("/genomes:", e); }
    for (const alias in OFFTARGET_ALIASES) {
        if (out[OFFTARGET_ALIASES[alias]]) out[alias] = { name: OFFTARGET_ALIASES[alias], alias: true };
    }
    return res.json(out);
});

app.post('/off-targets-file', async (req, res) => {
    const uuid = Math.floor(Date.now() / 1000);
    const inputfile = inputtemplate + uuid + '.json';
    const resultsfile = resultstemplate + uuid + '.out.json';
    const tm = req.body;
    let editDistance = tm.editDistance;
    let strand = tm.strand;
    let genomes = '' + tm.genomes;
    let runMode = '' + tm.runMode;
    const sequence = tm.sequences;
    // let editDistance = req.query.editDistance;
    // let strand = req.query.strand;
    // let genomes = '' + req.query.genome;
    // let runMode = ''+ req.query.runMode;
    genomes = genomes.trim();
    if (!strand) {
        strand = '+-'
    }
    // Note: 0 is a valid edit distance — only default when actually absent.
    if (editDistance === undefined || editDistance === null || editDistance === '') {
        editDistance = '3'
    }
    if (!runMode && runMode.length === 0) {
        runMode = 'count'
    }
    console.log(' Run mode : ' + runMode);
    console.log(' genomes ' + genomes)
    if (!genomes && genomes.length <= 0) {
        genomes = 'Homo_sapiens.GRCh38.88.3utr'
    }
    let glist = []
    if (genomes.indexOf(',') > 0) {
        glist = genomes.split(',')
    }
    else {
        glist = [genomes]
    }
    // --- Local off-target service -----------------------------------------
    // If every requested genome has a locally-built 2-bit/seed index, compute
    // here via search.py instead of spooling to the external levenshtein
    // worker. Any missing name falls through to the legacy spool path below.
    try {
        const localNames = glist.map((g: string) => resolveLocalIndexName(g));
        if (localNames.length > 0 && localNames.every((n: string | null) => !!n)) {
            const result = await runSearchLocal(
                req, localNames as string[], sequence, +editDistance, strand, runMode);
            return res.json(result);
        }
    } catch (e) {
        console.error("local off-target failed, falling back to external worker:", e);
    }
    const glist_input = []
    for (const g of glist) {
        glist_input.push({
            "gid": `${ott_root}/${g}.4bit`,
            "glink": "foolink"
        })
    }
    if (!runMode) {
        runMode = 'traceBack'
    }
    const inputfiler = [
        {
            "runParameters": {
                "editdistance": +editDistance,
                "strand": strand,
                "returnMode": runMode,
                "genomes": glist_input,
            },
            "oligoQuery": sequence
        }
    ]

    const strv = JSON.stringify(inputfiler)

    if (!fs.existsSync(inputfile)) {
        return res.json(inputfiler)
    }




    const keys = Object.keys(cache)
    for (const c of keys) {
        if (c === strv) {
            return res.json((cache[c]))
        }
    }

    try {
        let waitIndex = 0;
        while (fs.readdirSync(inputtemplate).length > 0) {
            timer(1000);
            console.log(' Waiting for a slot... ');
            waitIndex++;
            if (waitIndex > 10000) {
                return res.json({
                    'server': 'busy'
                })
            }
        }



        console.log(' Writing to file ' + inputfile);

        let index = 0;
        while (fs.existsSync(inputfile)) {
            console.log(' ... ' + index++)
            timer(1000);
            if (index > 60) {
                return res.json({
                    'input': 'failed'
                })
            }
        }



        if (inputfiler == null || inputfiler.length == 0) {
            return res.json({
                'input': 'failed.. not data'
            })

        }
        console.log('\n\n\n \t\tjson file \n' + JSON.stringify(inputfiler))
        try {



            fs.writeFileSync(inputfile, JSON.stringify(inputfiler));
            // file written successfully
        } catch (err) {
            console.error(err);
        }
        index = 0;
        while (!fs.existsSync(resultsfile)) {
            console.log(resultsfile + ' +++ ' + index++)
            timer(1000);
            if (index > 60) {
                return res.json({
                    'input': 'failed'
                })
            }
        }
        timer(1000);
        let resultsJSON = fs.readFileSync(resultsfile);
        if (resultsJSON == null || resultsJSON.length == 0) {
            timer(2000);
            resultsJSON = fs.readFileSync(resultsfile);
            let t = 0;
            console.log(' ... loading the results ... ' + resultsfile);
            while (resultsJSON.length == 0) {
                console.log(' ... loading the results ... t = ' + t);
                timer(500);
                resultsJSON = fs.readFileSync(resultsfile);
                if (t > 60) {
                    break;
                }
                t++;
            }
        }

        if (resultsJSON == null || resultsJSON.length == 0) {
            return res.json({ "status": "failed to read the results file.. this could be a very large dataset" })
        }

        let resultObject;
        try {
            resultObject = JSON.parse(resultsJSON.toString());
        } catch (exception) {

            let notparsed = true;
            while (notparsed) {
                console.log("trying to read and parse again ")
                // try it again
                try {
                    timer(1000);
                    console.log(' reading again... ');
                    resultsJSON = fs.readFileSync(resultsfile);
                    console.log(' reading complete... ');
                    timer(2000);
                    console.log(" Parsing again... ")

                    resultObject = JSON.parse(resultsJSON.toString());
                    console.log(" Parsing complete... ")
                    notparsed = false;
                } catch (exception_) {

                    notparsed = true;
                }
            }
        }


        fs.unlinkSync(resultsfile);

        if (Object.keys(cache).length > 20) {
            cache = {}
        }

        cache[JSON.stringify(inputfiler)] = resultObject
        return res.json(resultObject)
    } catch (exception) {
        console.log(" Failed " + exception)
    }
});






app.post('/publish-file', async (req, res) => {
    // console.log(req.body);
    console.log(" save dev ")
    let ppath = req.body.spath
    const key = getKey(req.body.key + '')
    ppath = ppath.trim()
    console.log(' key ' + key);
    console.log(' path' + ppath);

    if (ppath.startsWith(key)) {
        ppath = ppath.substring(key.length + 1).trim();
    }


    console.log(key + '/' + ppath + '/' + req.body.name)
    if (!fs.existsSync(key + '/' + ppath + '/')) {
        fs.mkdirSync(key + '/' + ppath + '/');
    }
    fs.writeFileSync(key + '/' + ppath + '/' + req.body.name, req.body.value);
    res.json({ 'status': 'published' });
});

function replaceEmailsWithPlaceholder(filePath: string, replace_string: string) {
    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
    return filePath.replace(emailRegex, replace_string);
}

function decompressJson(compressedData: any) {
    try {
        const decompressedData = pako.inflate(compressedData, { to: 'string' });
        console.log(decompressString)
        const jsonObject = JSON.parse(decompressedData);
        return jsonObject;
    } catch (error) {
        console.log(error)
        return null;
    }
}
function stringToBinary(stringData: string) {
    const byteValues = [];
    for (let i = 0; i < stringData.length; i += 0x8000) {
        const chunk = stringData.substring(i, i + 0x8000);
        for (let j = 0; j < chunk.length; j++) {
            byteValues.push(chunk.charCodeAt(j));
        } ``
    }

    // Create a Uint8Array from the byte values array
    const binaryData = new Uint8Array(byteValues);

    return binaryData;
}



// Example usage
// const stringData = "stringData"; // Replace with your string data
// const binaryData = stringToBinary(stringData);
// console.log(binaryData);









app.post('/load-file', async (req, res) => {
    let c = '' + req.body.path;
    const user = req.body.user + '';
    console.log(' user ' + user)



    if (req.body.key) {
        const key = getKey(req.body.key + '');
        c = key + c;
        const user = req.body.user + '';
        const userId = user;
        console.log('User_ID:', userId);

        if (c.indexOf('/myfiles/') >= 0) {
            const puser = encodeEmail(user);
            console.log(' c ' + c);
            c = c.replace('/myfiles/', '/' + puser + '/');
            console.log(' c ' + c);
        } else {
            const puser = encodeEmail(user);
            c = c.replace('/user/', '/' + puser + '/');
        }
        c = c.replace(/\/+/g, '/');
        const sessionuser = encodeEmail(userId.toString());
        if (c.indexOf(sessionuser) < 0) {
            try {
                const path = require('path');
                const dir = path.dirname(c);
                const shareFilePath = path.join(dir, '.share');
                if (fs.existsSync(shareFilePath)) {
                    const shareData = fs.readFileSync(shareFilePath, 'utf-8');

                    const lines = shareData.split('\n').map((line: string) => line.trim());
                    const isPublic = lines.includes('/public');
                    const isSharedWithUser = lines.includes(userId);

                    if (!isPublic && !isSharedWithUser) {
                        return res.json({
                            msg: 'You do not have access to this resource.',
                        });
                    }
                    // else continue to read the file
                } else {
                    return res.json({
                        msg: 'You do not have access to this resource.',
                    });
                }
            } catch (e) {
                console.error('Error checking .share file:', e);
                return res.json({
                    msg: 'You do not have access to this resource.',
                });
            }
        }

        try {
            if (c.endsWith('.share')) {
                const data = fs.readFileSync(c, 'utf-8');
                return res.json(data);
            } else {
                let data = fs.readFileSync(c);
                try {
                    const udata = stringToBinary(data.toString());
                    const decompressedData = pako.inflate(udata, { to: 'string' });
                    const tjs = JSON.parse(decompressedData);
                    return res.json(tjs);
                } catch (exc) {
                    data = JSON.parse(data.toString());
                }
                return res.json(data);
            }
        } catch (exception) {
            console.log("Failed to load " + exception + ' \n ' + c);
            res.json({
                msg: 'Failed to load the file',
            });
        }

    } else {
        let key = htsFilesPath;


        console.log(' =-= ' + c);


        if (!c.startsWith(key)) {
            if (!c.startsWith('/')) {
                c = '/' + c
            }
            if (c.startsWith('/user/')) {
                const user = req.body.user + '';
                console.log(" user " + user);
                const puser = encodeEmail(user)
                c = c.replace('/user/', '/' + puser + '/')
                key = getKey('user')
                c = key + c;
            }
            else if (c.indexOf('@') > 0) {
                const user = req.body.user + '';
                const emailPattern = /[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
                const match = c.match(emailPattern);
                if (match != null && match.length > 0) {
                    console.log(' match ' + match[0])
                    const decodedPath = encodeEmail('' + match[0]);
                    const emailIndex = match.index + match[0].length;
                    const p = c.substring(emailIndex);
                    let __path = userData + '/' + decodedPath + '/' + p;
                    __path = __path.replace(/\/\//g, '/');
                    console.log(' path ' + __path)
                    c = __path;
                    if (user.toLocaleLowerCase() === match[0]) {

                    } else {
                        const folder = userData + '/' + decodedPath + '/' + getLastDirectoryFromPath(c);
                        console.log('decoded  folder :' + folder)
                        if (fs.existsSync(folder + '/.share')) {
                            const data = fs.readFileSync(folder + '/.share', 'utf-8');
                            console.log(" checking for email " + user)
                            console.log(" in file : " + data)
                            if (isEmailInList(data, user)) {

                            } else {
                                return res.json({
                                    'msg': 'You do not have access to this file'
                                })
                            }
                        } else {
                            return res.json({
                                'msg': 'Protected'
                            })

                        }
                    }
                }
            }
        }

        try {

            c = c.replace(/\/\//g, '/');
            const key = getKey('user');
            let data = ''
            try {
                console.log(' loading the file --> ' + c);
                data = fs.readFileSync(c, 'utf-8');
            } catch (exception) {
                c = path.join(key, c); // Adjust base path as needed
                data = fs.readFileSync(c, 'utf-8');

            }



            try {
                const udata = stringToBinary(data.toString())
                const decompressedData = pako.inflate(udata, { to: 'string' });
                const tjs = JSON.parse(decompressedData)
                return res.json(tjs)

            } catch (exc) {
                console.log(exc)
                data = JSON.parse(data.toString());
            }
            return res.json(data)
        } catch (exception) {
            try {
                const user = req.body.user + '';
                const normalizedPath = c.replace(/\\/g, '/');
                const segments = normalizedPath.split('/');
                const filteredSegments = segments.filter(segment => segment.length > 0);
                const firstFolder = filteredSegments.length > 0 ? filteredSegments[0] : '';
                const userfolder = decodeEmail(firstFolder)
                if (userfolder === user) {
                    let __path = userData + '/' + normalizedPath;
                    __path = __path.replace('//', '/');
                    console.log(': loading the file ' + __path);
                    let data = fs.readFileSync(__path, 'utf-8');
                    data = JSON.parse(data);
                    res.json(data)
                }
            } catch (exc_) {
                console.log("------- Failed to load the file \n\n\n " + exc_)

                return res.json({
                    'msg': 'Failed to load the file '
                })
            }
            console.log("------- exception \n\n\n " + exception)
            return res.json({
                'msg': 'Failed to load the file '
            })
        }
    }
})


function renameFileOrDirectory(source: string, destination: string): void {
    try {
        if (!fs.existsSync(source)) {
            throw new Error(`Source path does not exist: ${source}`);
        }
        fs.renameSync(source, destination);
        console.log(`Successfully renamed ${source} to ${destination}`);
    } catch (err) {
        console.error(`Error renaming ${source} to ${destination}:`, err);
        throw err;
    }
}


app.post('/mv', async (req, res) => {
    let sourcePath: string = req.body.sourcePath;
    let destinationPath: string = req.body.destinationPath;

    try {
        const key: string | null = req.body.key ? req.body.key : null;
        const user: string = req.body.user;

        sourcePath = __modifyPath(sourcePath, key, user);
        destinationPath = __modifyPath(destinationPath, key, user);

        console.log(`${sourcePath} ===> ${destinationPath}`);

        // Wildcard support
        if (sourcePath.includes('*')) {
            const dirPath = path.dirname(sourcePath);
            const basePattern = path.basename(sourcePath).replace('*', '.*');
            const regex = new RegExp('^' + basePattern + '$');
            const files = fs.readdirSync(dirPath).filter((file: string) => regex.test(file));

            // destinationPath must be a directory for wildcard moves (usually)
            files.forEach((file: any) => {
                const sourceFilePath = path.join(dirPath, file);

                let destPath = destinationPath;
                const destStat = fs.existsSync(destinationPath) ? fs.statSync(destinationPath) : null;
                if (destStat?.isDirectory()) {
                    destPath = path.join(destinationPath, file);
                }

                console.log(`${sourceFilePath} ===> ${destPath}`);
                renameFileOrDirectory(sourceFilePath, destPath); // or fs.renameSync
            });

            return res.json({ msg: `Files moved to ${destinationPath}` });
        }

        // Single move
        let destPath = destinationPath;

        const destExists = fs.existsSync(destinationPath);
        if (destExists) {
            const destStat = fs.statSync(destinationPath);
            if (destStat.isDirectory()) {
                destPath = path.join(destinationPath, path.basename(sourcePath));
            }
        }

        console.log(`${sourcePath} ===> ${destPath}`);
        renameFileOrDirectory(sourcePath, destPath); // or fs.renameSync(sourcePath, destPath)

        return res.json({ msg: `File moved to ${destPath}` });
    } catch (exception) {
        console.error("Failed to move file: ", exception);
        return res.status(500).json({ msg: 'Failed to move the file' });
    }
});

// // function getLastDirectoryFromPath(filePath) {
// //     return path.basename(path.dirname(filePath));
// // }

// app.post('/mv', async (req, res) => {
//     let sourcePath = '' + req.body.sourcePath;
//     let destinationPath = '' + req.body.destinationPath;

//     try {
//         const key = req.body.key ? req.body.key + '' : null;
//         const user = req.body.user + '';

//         sourcePath = __modifyPath(sourcePath, key, user);
//         destinationPath = __modifyPath(destinationPath, key, user);

//         console.log(sourcePath + ' ===> ' + destinationPath);

//         const destinationStat = fs.statSync(destinationPath);
//         if (destinationStat && destinationStat.isDirectory()) {
//             destinationPath = path.join(destinationPath, path.basename(sourcePath));
//         }
//         console.log(sourcePath + ' ===> ' + destinationPath);
//         fs.renameSync(sourcePath, destinationPath);
//         res.json({ 'msg': `File moved to ${destinationPath}` });
//     } catch (exception) {
//         console.error("Failed to move file: ", exception);
//         res.json({ 'msg': 'Failed to move the file' });
//     }
// });

const __modifyPath = (initialPath: string, key: string, user: string) => {
    let modifiedPath = initialPath;
    if (key) {
        const keyValue = getKey(key);
        modifiedPath = keyValue + modifiedPath;
        console.log(' keyvalue + modifiedPath ' + modifiedPath);

        const encodedUser = encodeEmail(user);

        if (modifiedPath.includes('/myfiles/')) {
            modifiedPath = modifiedPath.replace('/myfiles/', '/' + encodedUser + '/');
        } else {
            // Normalize path for consistent comparison
            const cleanedInitial = initialPath.replace(/^\/+/, '').split(/[/\\]/)[0];
            if (cleanedInitial !== encodedUser) {
                modifiedPath = userData + '/' + encodedUser + '/' + initialPath;
            } else {
                modifiedPath = userData + '/' + initialPath;
            }
        }

        // Remove duplicate slashes
        modifiedPath = modifiedPath.replace(/\/+/g, '/');
    }
    return modifiedPath;
};



app.post('/mkdir', async (req, res) => {
    let sourcePath = '' + req.body.path;

    try {
        const key = req.body.key ? req.body.key + '' : null;
        const user = req.body.user + '';

        sourcePath = __modifyPath(sourcePath, key, user);


        console.log('mkdir' + sourcePath);
        fs.mkdirSync(sourcePath);
        res.json({ 'msg': `File moved to ${sourcePath}` });
    } catch (exception) {
        console.error("Failed to move file: ", exception);
        res.json({ 'msg': 'Failed to move the file' });
    }
});

app.post('/cd', async (req, res) => {
    let sourcePath = '' + req.body.path;

    try {
        const key = req.body.key ? req.body.key + '' : null;
        const user = req.body.user + '';

        sourcePath = __modifyPath(sourcePath, key, user);


        console.log("cd -> " + sourcePath);
        // fs.(sourcePath);
        res.json({ 'msg': `File moved to ${sourcePath}` });
    } catch (exception) {
        console.error("Failed to move file: ", exception);
        res.json({ 'msg': 'Failed to move the file' });
    }
});


function updatePythonPath(newPath: string) {
    // Get the current PYTHONPATH
    const currentPythonPath = process.env.PYTHONPATH || '';
    const pathSeparator = process.platform === 'win32' ? ';' : ':';

    // Split the current PYTHONPATH into an array of paths
    let paths = currentPythonPath.split(pathSeparator).filter(Boolean);

    // Add the new path
    if (!paths.includes(newPath)) {
        paths.push(newPath);
    }

    // Remove duplicates
    paths = [...new Set(paths)];

    // Join the paths back into a string
    const updatedPythonPath = paths.join(pathSeparator);

    // Export the updated PYTHONPATH to the current shell
    const exportCommand = process.platform === 'win32'
        ? `set PYTHONPATH=${updatedPythonPath}`
        : `export PYTHONPATH="${updatedPythonPath}"`;

    // Execute the export command in the current shell
    exec(exportCommand, (error, stdout, stderr) => {
        if (error) {
            console.error(`Failed to export PYTHONPATH. Error: ${error.message}`);
            return;
        }

        console.log(`Updated PYTHONPATH: ${updatedPythonPath}`);
    });
}




app.get('/install-py', async (req, res) => {
    const packageName = req.query.pym;
    if (!packageName) {
        return res.status(400).json({ error: 'Module name is required' });
    }

    updatePythonPath(('' + htsFilesPath + '/py/ion-lib'))
    exec(`pip install ${packageName}`, (installError, installStdout, installStderr) => {
        if (installError) {
            console.error(`Failed to install package '${packageName}'. Error: ${installError.message}`);
            return res.json({ 'output': installError.message })
        }

        console.log(`Package '${packageName}' installed successfully.`);
        console.log(installStdout);
        return res.json({ 'output': installStdout })

    });

})


app.get('/validate-file', async (req, res) => {
    let c = '' + req.query.path;
    const key = getKey(req.query.key + '')
    c = key + c;
    console.log(' --<> ' + c);



    if (c.indexOf('/myfiles/') >= 0) {
        const user = req.query.user + '';
        const puser = encodeEmail(user)
        console.log(' c ' + c);
        c = reduceContiguousNodes(c, puser);

        c = c.replace('/myfiles/', '/' + puser + '/')
    } else {
        const user = req.query.user + '';
        const puser = encodeEmail(user)
        c = reduceContiguousNodes(c, puser);

        c = c.replace('/user/', '/' + puser + '/')
        c = c.replace(user, puser)
    }
    c = c.replace(/\/+/g, '/');
    try {
        const user = req.query.user + '';
        const puser = encodeEmail(user)
        c = reduceContiguousNodes(c, puser);

        console.log(' validating the file ' + c);
        const data = fs.readFileSync(c);
        const udata = stringToBinary(data.toString())
        const decompressedData = pako.inflate(udata, { to: 'string' });
        const tjs = JSON.parse(decompressedData)
        return res.json(tjs)

    } catch (exc) {
        return res.json({ "msg": exc.toString() })
    }
    return res.json({ "msg": "validation failed" })
});



function extractIdFromPath(path: string) {
    const segments = path.split('/');
    const shareIndex = segments.indexOf('share');
    if (shareIndex !== -1 && shareIndex + 1 < segments.length) {
        return segments[shareIndex + 1];
    } else {
        return null;
    }
}
function generateUniqueIdFromPath(path: string) {
    let hash = 0;
    for (let i = 0; i < path.length; i++) {
        const char = path.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return 'id_' + hash.toString(16); // Convert to hexadecimal
}
function getLastDirectoryFromPath(filePath: string) {
    const sanitizedPath = filePath.endsWith('/') ? filePath.slice(0, -1) : filePath;
    const pathSegments = sanitizedPath.split('/').filter(Boolean);
    return pathSegments.length > 1 ? pathSegments[pathSegments.length - 2] : null;
}

function isEmailInList(emailsString: string, searchEmail: string) {
    const delimiters = /\s+|,|;|\n/;
    const emailList = emailsString.split(delimiters).map(email => email.trim()).filter(email => email);
    return emailList.includes(searchEmail);
}


app.get('/load-file', async (req, res) => {
    let c = '' + req.query.path;
    if (req.query.key) {
        const key = getKey(req.query.key + '')
        c = key + c;
        if (c.indexOf('/myfiles/') >= 0) {
            const user = req.query.user + '';
            const puser = encodeEmail(user)
            console.log(' c ' + c);
            c = c.replace('/myfiles/', '/' + puser + '/')
            console.log(' c ' + c);
        }
        else {
            const user = req.query.user + '';
            const puser = encodeEmail(user)
            c = c.replace('/user/', '/' + puser + '/')
        }
        c = c.replace(/\/+/g, '/');
        try {
            let data = fs.readFileSync(c, 'utf-8');
            data = JSON.parse(data);
            res.json(data)
        } catch (exception) {
            console.log(" failed to load the file : " + c);
            res.json({
                'msg': 'Failed to load the file '
            })
        }
    } else {
        let key = htsFilesPath;
        if (!c.startsWith(key)) {
            if (!c.startsWith('/')) {
                c = '/' + c
            }
            if (c.startsWith('/user/')) {
                const user = req.query.user + '';
                console.log(" user " + user);
                const puser = encodeEmail(user)
                c = c.replace('/user/', '/' + puser + '/')
                key = getKey('user')
            }
            c = key + c;
        }
        else if (c.indexOf('@') > 0) {
            const user = req.query.user + '';
            const emailPattern = /[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
            const match = c.match(emailPattern);
            if (match != null && match.length > 0) {
                const decodedPath = encodeEmail(match[0]);
                const emailIndex = match.index + match[0].length;
                const p = c.substring(emailIndex);
                let __path = userData + '/' + decodedPath + '/' + p;
                __path = __path.replace(/\/\//g, '/');
                console.log('\t\t path ' + __path)
                c = __path;
                if (user.toLocaleLowerCase() === match[0]) {
                } else {
                    const folder = userData + '/' + getLastDirectoryFromPath(c);
                    if (fs.existsSync(folder + '/.share')) {
                        const data = fs.readFileSync(c, 'utf-8');
                        if (isEmailInList(data, user)) {
                        } else {
                            return res.json({
                                'msg': 'Access denied for protected file.'
                            })
                        }
                    } else {
                        return res.json({
                            'msg': 'Protected.'
                        })

                    }
                }
            }
        }
        try {
            console.log('____ loading the file ' + c);
            let data = fs.readFileSync(c, 'utf-8');
            data = JSON.parse(data);
            res.json(data)
        } catch (exception) {
            console.log("\n\n+++++++ exception \n\n\n " + exception)
            res.json({
                'msg': 'Failed to load the file '
            })
        }
    }
})


/**
 *  Can only remove user files not other drive files
 */
app.post('/rm', async (req, res) => {
    let sourcePath = '' + req.body.path;
    try {
        const key = req.body.key ? req.body.key + '' : null;
        const user = req.body.user + '';
        const encodedUser = encodeEmail(user);

        // Normalize path separators
        const pathSegments = sourcePath.split(/[/\\]/).filter(Boolean);

        for (const p of pathSegments) {
            console.log('p x  ; ' + p)
        }

        // Check if the first segment is the encoded user email
        if (pathSegments[0] !== encodedUser) {
            pathSegments.unshift(encodedUser);
        }

        sourcePath = __modifyPath(pathSegments.join('/'), key, user);
        console.log('rm ' + sourcePath);

        const stat = await fsPromises.lstat(sourcePath);
        if (stat.isDirectory()) {
            const lastSegment = sourcePath.split(/[/\\]/).pop();
            if (lastSegment === encodedUser) {
                return res.json({ msg: 'will not remove root' });
            }
            fs.rmSync(sourcePath, { recursive: true });
            return res.json({ msg: 'directory removed' });
        } else {
            console.log('removing file: ' + sourcePath);
            fs.rmSync(sourcePath);
            return res.json({ msg: 'file removed' });
        }
    } catch (exception) {
        console.error("Exception: " + exception.message);
        console.error("Failed to remove: " + sourcePath);
        res.json({ msg: 'Failed to remove file' });
    }
});


app.get('/load-files', async (req, res) => {
    let c = '' + req.query.path;

    let key = htsFilesPath;
    if (req.query.key)
        key = getKey(req.query.key + '')

    if (!c) {
        c = '/tmp'
    } else {

        if (!c.startsWith(key)) {
            if (!c.startsWith('/')) {
                c = '/' + c

            }
            c = key + c;
        }
        const l: string[] = []
        browseFolder(c, l);
        const jsonArray = []
        for (const f of l) {
            try {
                let data = fs.readFileSync(f, 'utf-8');
                data = JSON.parse(data);
                jsonArray.push(data);
            } catch (exception) {
                console.log(" Failed to load the data for file " + f)
            }
        }
        res.json(jsonArray)
    }
})




app.get('/root', async (req, res) => {
});





app.get('/list-gff', async (req, res) => {
    const f: string[] = [];

    const ls = spawn("ls", ['/tmp/bd/gff']);
    ls.stdout.on("data", data => {
        data = data.toString().split('\n')
        for (const d of data) {
            if (d.toString().toLowerCase().endsWith('.gff') ||
                d.toString().toLowerCase().endsWith('.gff3') ||
                d.toString().toLowerCase().endsWith('.gff3.gzip')) {
                f.push(d.toString());

            }
        }
    })
});

app.get('/list-installed-files', async (req, res) => {
    const f: string[] = [];
    const ls = spawn("ls", ['/tmp']);
    ls.stdout.on("data", data => {
        data = data.toString().split('\n')
        for (const d of data) {
            if (d.toString().toLowerCase().endsWith('.bigwig') ||
                d.toString().toLowerCase().endsWith('.bw') ||
                d.toString().toLowerCase().endsWith('.gz') ||
                d.toString().toLowerCase().endsWith('.txt') ||
                d.toString().toLowerCase().endsWith('.bed') ||
                d.toString().toLowerCase().endsWith('.bam') ||
                d.toString().toLowerCase().endsWith('.bam') ||
                d.toString().toLowerCase().endsWith('.json') ||
                d.toString().toLowerCase().endsWith('.baja') ||
                d.toString().toLowerCase().endsWith('.vcf')


            ) {
                f.push(d.toString());

            }
        }
    });

    ls.stderr.on("data", data => {
        console.log(`stderr: ${data}`);
    });

    ls.on('error', (error) => {
        console.log(`error: ${error.message}`);
    });

    ls.on("close", code => {
        console.log(`child process exited with code ${code}`);
    });
    setTimeout(() => {
        return res.json(f)
    }, 1000)
})


app.get('/get-cached-datasets', async (req, res) => {
    const list = []
    const cache_items = cache.o;
    for (const ci of cache_items) {
        list.push(ci.name);
    }
    return res.json(list)
})


app.post('/get-dev-package', async (req, res) => {
    let ppath = req.body.spath

    if (ppath.startsWith('..')) {
        return;
    }

    ppath = ppath.trim()
    console.log(devPath + '/' + ppath)
    const tree = dirTree(devPath + '/' + ppath);
    if (tree == null) {
        console.log(" No files found in " + devPath + '/' + ppath)
        const tr = [{ 'spath': ppath }]
        return res.json(tr);

    } else {

        const chl = tree.children;
        const t: { spath: string; rule_type: string; id: string; rule_value: string; rule_name: string; }[] = []
        const c = 0;

        for (let ii = 0; ii < chl.length; ii++) {
            // console.log(chl[ii].path)
            if (chl[ii].path.endsWith('.js')) {
                const data = fs.readFileSync(chl[ii].path, 'utf-8');
                // , (err, data) => {
                // if (err) throw err;
                // console.log(" data " + data);
                t.push({
                    'rule_type': 'lionscript',
                    'rule_name': chl[ii].name,
                    'spath': ppath,
                    'id': chl[ii].path,
                    'rule_value': data,
                });
            }
            else if (chl[ii].path.endsWith('.gff3')) {
                const stats = fs.statSync(chl[ii].path);// , (err, stats) => { });//, (err, stats) => {

                console.log(`<>>>` + chl[ii].path);
                console.log(stats);
                if (stats.size > 5.12e+8) {
                    const data = '**not loaded**';// fs.readFileSync(chl[ii].path, 'utf-8');
                    t.push({
                        'rule_type': 'gff3',
                        'rule_name': chl[ii].name,
                        'spath': ppath,
                        'id': chl[ii].path,
                        'rule_value': data,
                    });
                } else {
                    const data = fs.readFileSync(chl[ii].path, 'utf-8');
                    t.push({
                        'rule_type': 'gff3',
                        'rule_name': chl[ii].name,
                        'spath': ppath,
                        'id': chl[ii].path,
                        'rule_value': data,
                    });

                }
            }
            else if (chl[ii].path.endsWith('.py')) {
                const data = fs.readFileSync(chl[ii].path, 'utf-8');
                // , (err, data) => {
                // if (err) throw err;
                // console.log(" data " + data);
                t.push({
                    'rule_type': 'py',
                    'rule_name': chl[ii].name,
                    'spath': ppath,
                    'id': chl[ii].path,
                    'rule_value': data,
                });
            }


            else {
                const stat = await fsPromises.lstat(chl[ii].path);
                if (stat.isDirectory()) {
                    t.push({
                        'rule_type': 'directory',
                        'rule_name': chl[ii].name,
                        'spath': ppath,
                        'id': chl[ii].path,
                        'rule_value': "",
                    })
                }
            }
        }
        return res.json(t);
    }
});






app.post('/get-package', async (req, res) => {
    let ppath = req.body.spath
    ppath = ppath.trim()
    // console.log(wd + '/' + ppath)
    const tree = dirTree(wd + '/' + ppath);




    if (tree == null) {
        console.log(" No files found in " + wd + '/' + ppath)
        const tr = [{ 'spath': ppath }]
        return res.json(tr);

    } else {

        const chl = tree.children;
        const t: { spath: string; rule_type: string; id: string; rule_value: string; rule_name: string; }[] = []
        const c = 0;

        for (let ii = 0; ii < chl.length; ii++) {
            // console.log(chl[ii].path)
            if (chl[ii].path.endsWith('.js')) {
                const data = fs.readFileSync(chl[ii].path, 'utf-8');
                // , (err, data) => {
                // if (err) throw err;
                // console.log(" data " + data);
                const val = {
                    'rule_type': 'lionscript',
                    'rule_name': chl[ii].name,
                    'spath': ppath,
                    'id': chl[ii].path,
                    'rule_value': data,
                }

                t.push(val);
            }
            else if (chl[ii].path.endsWith('.gff3')) {
                const stats = fs.statSync(chl[ii].path);// , (err, stats) => { });//, (err, stats) => {

                console.log(` gff ` + chl[ii].path);
                console.log(stats);
                if (stats.size > 5.12e+8) {
                    const data = '**not loaded**';// fs.readFileSync(chl[ii].path, 'utf-8');
                    t.push({
                        'rule_type': 'gff3',
                        'rule_name': chl[ii].name,
                        'spath': ppath,
                        'id': chl[ii].path,
                        'rule_value': data,
                    });
                } else {
                    const data = fs.readFileSync(chl[ii].path, 'utf-8');
                    t.push({
                        'rule_type': 'gff3',
                        'rule_name': chl[ii].name,
                        'spath': ppath,
                        'id': chl[ii].path,
                        'rule_value': data,
                    });

                }
            }
            else if (chl[ii].path.endsWith('.py')) {
                const data = fs.readFileSync(chl[ii].path, 'utf-8');
                // , (err, data) => {
                // if (err) throw err;
                // console.log(" data " + data);
                t.push({
                    'rule_type': 'py',
                    'rule_name': chl[ii].name,
                    'spath': ppath,
                    'id': chl[ii].path,
                    'rule_value': data,
                });
            }


            else {
                const stat = await fsPromises.lstat(chl[ii].path);
                if (stat.isDirectory()) {
                    t.push({
                        'rule_type': 'directory',
                        'rule_name': chl[ii].name,
                        'spath': ppath,
                        'id': chl[ii].path,
                        'rule_value': "",
                    })
                }
            }
        }
        return res.json(t);
    }
});



app.post('/git', async (req, res) => {
    const gitgo = req.body.cmds
    try {
        let rf = ''

        const dk = decodeEmail(heaader)


        for (const cmd of gitgo) {
            console.log(cmd)
            const r = await gitcmd(cmd, wd, dk)
            console.log('Response \t\t\t\t ' + JSON.stringify(r));
            rf += JSON.stringify(r);
        }
        return res.json(rf)
    } catch (exception) {

        console.log(' Failed ')

        return res.json(JSON.stringify(exception))
    }
});

app.post('/git-pull-current-branch', async (req, res) => {
    // pull(remote?: string, branch?: string, options?: types.TaskOptions, callback?: types.SimpleGitTaskCallback<resp.PullResult>): Response<resp.PullResult>;
    try {
        const branchSummary = await git.branch();
        const currentBranch = branchSummary.current;
        console.log('Current branch:', currentBranch);
        const pullResult: PullResult = await git.pull('origin', currentBranch); // Adjust the branch name if necessary
        console.log('Pull successful:', pullResult);
        return res.json(pullResult);

    } catch (error) {
        console.error('Failed to pull from repository:', error);
        return res.json(error)

    }

})
// app.get('/git-pull', async (req, res) => {
//     // pull(remote?: string, branch?: string, options?: types.TaskOptions, callback?: types.SimpleGitTaskCallback<resp.PullResult>): Response<resp.PullResult>;
//     try {
//         const branchSummary = await git.branch();
//         const currentBranch = branchSummary.current;
//         console.log('Current branch:', currentBranch);
//         const pullResult: PullResult = await git.pull('origin', currentBranch); // Adjust the branch name if necessary
//         console.log('Pull successful:', pullResult);
//         return res.json(pullResult);

//     } catch (error) {
//         console.error('Failed to pull from repository:', error);
//         return res.json(error)

//     }

// })


app.post('/checkout', async (req, res) => {
    const branch = req.body.branch
    const options = req.body.options
    let start_point = req.body.start_point
    try {
        console.log(' branch to checkout : ' + branch)
        start_point = 'origin'
        const checkout = await git.checkout(branch, options)
        res.json(checkout);
    } catch (exception) {
        return res.json(exception)
    }
});

app.post('/git-branch', async (req, res) => {
    const branch = req.body.branch
    const start_point = req.body.start_point
    try {
        const bresp = await git.branch(branch, start_point)
        const resb = await git.checkoutBranch(branch, start_point)
        return res.json(bresp);
    } catch (exception) {
        console.log(exception);
        return res.json(exception)
    }
});
app.post('/git-branch', async (req, res) => {
    const branch = req.body.branch
    const start_point = req.body.start_point
    try {
        const bresp = await git.branch(branch, start_point)
        const resb = await git.checkoutBranch(branch, start_point)
        return res.json(bresp);
    } catch (exception) {
        console.log(exception);
        return res.json(exception)
    }
});


app.post('/list-branches', async (req, res) => {
    const b = await git.branch();
    // {
    //     "all": [
    //         "master",
    //         "vb"
    //     ],
    //     "branches": {
    //         "master": {
    //             "current": false,
    //             "name": "master",
    //             "commit": "6eee879",
    //             "label": "added the eln"
    //         },
    //         "vb": {
    //             "current": true,
    //             "name": "vb",
    //             "commit": "509d251",
    //             "label": "testing vb"
    //         }
    //     },
    //     "current": "vb",
    //     "detached": false
    // }
    res.json(b);
});
app.post('/list', async (req, res) => {
    const b = await git.branch();
    console.log(" getting the branch.;... " + JSON.stringify(b))
    res.json(b);
});


app.post('/status', async (req, res) => {
    const status = await git.status();
    res.json(status);
});



app.post('/git-tag-release', async (req, res) => {
    console.log(req.body);
    const annotation = req.body.annotation
    const version = req.body.version
    const v = await git.tag(['-a', version, '-m', annotation])
    res.json(v);
})
app.post('/git-add', async (req, res) => {
    console.log(req.body);
    const ppath = req.body.filepath
    const v = await git.add(ppath);
    res.json(v);
})
app.post('/git-reset', async (req, res) => {
    const path = req.body.path;
    const v = await git.reset(ResetMode.HARD, path);
    res.json(v);
})


app.get('/git-show', async (req, res) => {
    const c = req.query.commits + '';
    const commits = c.split(',')
    const v = await git.log(commits)
    res.json(v);
})
app.get('/git-status', async (req, res) => {
    const v = await git.status();
    console.log(git.cwd + '');
    res.json(v);
})

app.get('/git-tags', async (req, res) => {
    const v = await git.tags()
    res.json(v);
})

const fcache: Record<string, any> = {}; // assuming this exists somewhere
// Endpoint to clear the cache
app.post('/clear-cache', (req, res) => {
    try {
        // Clear the cache by resetting the object
        Object.keys(fcache).forEach(key => delete fcache[key]);

        res.json({ success: true, message: 'Cache cleared' });
    } catch (err) {
        console.error('clear-cache error:', err);
        res.status(500).json({ success: false, error: 'Failed to clear cache' });
    }
});




const scriptCache = new Map<
    string,
    {
        data: {
            rule_type: string;
            rule_name: string;
            spath: string;
            id: string;
            rule_value: string;
        };
        timestamp: number;
    }
>();

app.post('/get-script', async (req, res) => {
    try {
        const spath: string = (req.body.spath || '').trim();
        let name: string = req.body.rule_name || '';

        if (!spath || !name) {
            return res.json([{ spath }]);
        }

        const basePath = path.join(wd, spath);

        if (name.indexOf('.') <= 0) {
            name = name + '.js';
        }

        const filePath = path.join(basePath, name);
        const ext = name.split('.').pop() || 'lionscript';

        const cacheKey = filePath;
        const cached = scriptCache.get(cacheKey);
        const cacheTTL = await getDynamicCacheTTL();

        if (cached && Date.now() - cached.timestamp < cacheTTL) {
            return res.json({ ...cached.data, cached: true, cacheTTL });
        }

        await fs.promises.access(filePath, fs.constants.R_OK);
        const data = await fs.promises.readFile(filePath, 'utf-8');

        const ob = {
            rule_type: ext,
            rule_name: name,
            spath: basePath,
            id: basePath,
            rule_value: data,
        };

        scriptCache.set(cacheKey, {
            data: ob,
            timestamp: Date.now(),
        });

        return res.json({ ...ob, cached: false, cacheTTL });
    } catch (err) {
        console.error('get-script error:', err);
        const spath = (req.body?.spath || '').trim();
        const basePath = spath ? path.join(wd, spath) : '';
        return res.json([{ spath: basePath }]);
    }
});

// A version that changes whenever the server (re)starts — i.e. on every deploy.
// The frontend fetches this once and stamps it onto module URLs (?v=…) so that a
// deploy busts the browser cache, while within a version modules cache forever.
const APPS_VERSION = String(Date.now());
app.get('/apps-version', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=15');
    res.json({ version: APPS_VERSION });
});

// CACHEABLE module fetch (GET twin of POST /get-script). Same JSON shape, but the
// browser can cache it: with a ?v=<version> cache-buster the response is immutable
// (zero refetch on reload/revisit), so hundreds of per-module round-trips collapse
// to disk-cache hits. Without ?v it falls back to a short max-age.
app.get('/script', async (req, res) => {
    try {
        const spath: string = String(req.query.spath || '').trim();
        let name: string = String(req.query.rule_name || req.query.name || '');
        if (!spath || !name) return res.status(400).json({ error: 'spath and rule_name required' });
        if (name.indexOf('.') <= 0) name = name + '.js';

        const basePath = path.join(wd, spath);
        const filePath = path.join(basePath, name);
        const ext = name.split('.').pop() || 'lionscript';

        const cacheKey = filePath;
        const cached = scriptCache.get(cacheKey);
        const cacheTTL = await getDynamicCacheTTL();

        let data: string;
        if (cached && Date.now() - cached.timestamp < cacheTTL) {
            data = cached.data.rule_value;
        } else {
            await fs.promises.access(filePath, fs.constants.R_OK);
            data = await fs.promises.readFile(filePath, 'utf-8');
            scriptCache.set(cacheKey, {
                data: { rule_type: ext, rule_name: name, spath: basePath, id: basePath, rule_value: data },
                timestamp: Date.now(),
            });
        }

        // Versioned URLs are immutable for a year; unversioned get a short cache.
        if (req.query.v) res.set('Cache-Control', 'public, max-age=31536000, immutable');
        else res.set('Cache-Control', 'public, max-age=60');
        return res.json({ rule_type: ext, rule_name: name, spath: basePath, id: basePath, rule_value: data });
    } catch (err) {
        return res.status(404).json({ error: 'not found' });
    }
});

app.post('/get-dev-script', async (req, res) => {
    console.log(req.body);
    let ppath = req.body.spath
    let name = req.body.rule_name;
    ppath = devPath + '/' + ppath.trim()
    const tree = dirTree(ppath);
    if (name.indexOf('.') <= 0) {
        name = name
            + '.js';
    }
    const ext = name.split('.').pop(); //
    console.log(' loading ' + ppath + '/' + name)
    const tree2 = dirTree(ppath + '/' + name)
    if (tree == null || tree2 == null) {
        const tr = [{ 'spath': ppath }]
        return res.json(tr);
    } else {
        try {
            console.log(' ' + ppath + '/' + name);
            const data = fs.readFileSync(ppath + '/' + name, 'utf-8');
            const t: { spath: string; rule_type: string; id: string; rule_value: string; rule_name: string; }[] = []
            let type = ext;
            if (type == null) {
                type = 'lionscript'
            }
            const ob = {
                'rule_type': type,
                'rule_name': name,
                'spath': ppath,
                'id': ppath,
                'rule_value': data,
            };
            return res.json(ob);
        } catch (exception) {
            const tr = [{ 'spath': ppath }]
            return res.json(tr);
        }
    }
});






app.get('/git-init', (req, res) => {
    git.init()
    const script = '\n  log("hello world");\n'
    const obj = {
        id: 'test',
        spath: 'test',
        rule_type: 'lionscript',
        rul_value: JSON.stringify(script)
    }
    const scriptValue = JSON.stringify(obj);
    fs.writeFile(wd + '/' + 'hello-world.json', scriptValue, (err: any) => {
        if (err) return console.log(err);
    });
});



/**
 * Recursively builds a tree of .ljl files from a root directory
 * @param {string} dir - The root directory
 * @returns {Object[]} - Tree structure of files
 */
function getLjlFileTree(dir: string, base: string = dir): { type: string; name: string; path: string; children?: any[] }[] {
    const results: { type: string; name: string; path: string; children?: any[] }[] = [];

    const list = fs.readdirSync(dir);
    list.forEach((file: any) => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);

        const relativePath = path.relative(base, fullPath).replace(/\\/g, '/'); // normalize slashes


        if (stat && stat.isDirectory()) {
            const children = getLjlFileTree(fullPath, base);
            if (children.length > 0) {
                results.push({
                    type: 'directory',
                    name: file,
                    path: relativePath,
                    children
                });
            }
        } else if (path.extname(file) === '.ljl') {
            results.push({
                type: 'file',
                name: file,
                path: relativePath
            });
        } else if (path.extname(file) === '.ljt') {
            results.push({
                type: 'file',
                name: file,
                path: relativePath
            });
        }
        else if (path.extname(file) === '.ljp') {
            results.push({
                type: 'file',
                name: file,
                path: relativePath
            });
        }
        else if (path.extname(file) === '.ljt') {
            results.push({
                type: 'file',
                name: file,
                path: relativePath
            });
        }
    });

    return results;
}


app.post('/ljl-tree', (req, res) => {
    let ppath = req.body.spath

    ppath = ppath.trim()
    ppath = normalizePathSeparators(wd + '/' + ppath)
    const rootDir = path.resolve(ppath); // set your root directory here
    console.log(" ppath  " + rootDir)

    if (!rootDir || typeof rootDir !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid root directory' });
    }
    const absRoot = path.resolve(rootDir);
    try {
        const tree = getLjlFileTree(absRoot);
        res.json(tree);
    } catch (error) {
        res.status(500).json({ error: 'Failed to read directory structure', details: error.message });
    }
});



app.post('/save-script', async (req, res) => {
    // console.log(req.body);
    let ppath = req.body.spath
    ppath = ppath.trim()
    ppath = normalizePathSeparators(ppath)

    console.log(normalizePathSeparators(wd + '/' + ppath + '/' + req.body.name))
    if (!fs.existsSync(wd + '/' + ppath + '/')) {
        fs.mkdirSync(normalizePathSeparators(wd + '/' + ppath + '/'));
    }
    fs.writeFileSync(normalizePathSeparators(wd + '/' + ppath + '/' + req.body.name), req.body.value);
    res.json({ 'status': 'saved' });
});


app.post('/save-file', async (req, res) => {
    // console.log(req.body);

    const data = req.body.data;
    const typedata = req.body.type;
    const filename = req.body.filename;
    ljio.save(typedata, filename, data);
    res.json({ 'status': 'saved' });
});


const assets_src = '../ljlos2/src/assets/img/icons/png'
const assets_dist = '../ljlos2/dist/assets/img/icons/png'

const formidable = require('formidable');
function normalizePathSeparators(path: string) {
    return path.replace(/\/{2,}/g, '/');
}

app.post('/save-icon', (req, res) => {
    const form = new formidable.IncomingForm();

    form.parse(req, async (err: any, fields: any, files: { file: any; }) => {
        if (err) {
            console.error('Error parsing form:', err);
            res.status(500).send('Error parsing form');
            return;
        }

        const file = files.file;



        const filePath_src = assets_src + '/' + fields.name[0]
        const filePath_dist = assets_dist + '/' + fields.name[0]

        // const file = files.file;
        // const filePath = assets + '/' + file.name;
        // console.log(' file ' + file)
        console.log(' file ' + JSON.stringify(fields))
        // const type = Object.prototype.toString.call(file);
        // console.log(type); // Outputs: "[object Array]"
        for (const f of file) {
            console.log('old path ' + f.filepath)
            fs.copyFile(f.filepath, filePath_src, (err: any) => {
                if (err) {
                    console.error('Error saving file:', err);
                    res.status(500).send('Error saving file');
                } else {
                    fs.copyFile(f.filepath, filePath_dist, (err: any) => {
                        if (err) {
                            console.error('Error saving file:', err);
                            res.status(500).send('Error saving file');
                        } else {
                            res.sendStatus(200); // Respond with success status
                        }
                    });

                }
            });
        }

    });
});
app.post('/save-dev-script', async (req, res) => {
    // console.log(req.body);
    console.log(" save dev ")
    let ppath = req.body.spath
    ppath = normalizePathSeparators(ppath)
    ppath = ppath.trim()
    console.log(devPath + '/' + ppath + '/' + req.body.rule_name)
    if (ppath.startsWith(devPath)) {
        `       `
        ppath = ppath.substring(devPath.length + 1).trim();
    }
    if (!fs.existsSync(devPath + '/' + ppath + '/')) {
        fs.mkdirSync(devPath + '/' + ppath + '/');
    }
    fs.writeFileSync(devPath + '/' + ppath + '/' + req.body.rule_name, req.body.rule_value);
    res.json({ 'status': 'saved' });
});

function mkDirByPathSync(targetDir: string, { isRelativeToScript = false } = {}) {
    const sep = path.sep;
    const initDir = path.isAbsolute(targetDir) ? sep : '';
    const baseDir = isRelativeToScript ? __dirname : '.';

    return targetDir.split(sep).reduce((parentDir, childDir) => {
        const curDir = path.resolve(baseDir, parentDir, childDir);
        try {
            fs.mkdirSync(curDir);
        } catch (err) {
            if (err.code === 'EEXIST') { // curDir already exists!
                return curDir;
            }

            // To avoid `EISDIR` error on Mac and `EACCES`-->`ENOENT` and `EPERM` on Windows.
            if (err.code === 'ENOENT') { // Throw the original parentDir error on curDir `ENOENT` failure.
                throw new Error(`EACCES: permission denied, mkdir '${parentDir}'`);
            }

            const caughtErr = ['EACCES', 'EPERM', 'EISDIR'].indexOf(err.code) > -1;
            if (!caughtErr || caughtErr && curDir === path.resolve(targetDir)) {
                throw err; // Throw if it's just the last created dir.
            }
        }

        return curDir;
    }, initDir);
}

const writeFile = promisify(fs.writeFile);




// --- NEW: normalize incoming data URL into a Buffer ---
function dataUrlToBuffer(dataUrl: string): Buffer {
    // Accept data:image/png;base64,....  (also tolerate image/*)
    const stripped = dataUrl.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "");
    return Buffer.from(stripped, "base64");
}

// --- NEW: force LinkedIn-friendly 1200x627 PNG (cover + center/attention) ---
async function toLinkedInPng(input: Buffer): Promise<Buffer> {
    // LinkedIn likes 1.91:1; 1200x627 is the common recommendation.
    // - fit: 'cover' crops as needed while filling the box
    // - position: 'attention' tries to keep salient content
    // - flatten: remove alpha (LinkedIn can render odd backgrounds with transparency)
    return await sharp(input)
        .resize(1200, 627, { fit: "cover", position: "attention", withoutEnlargement: false })
        .withMetadata({}) // keep sRGB profile if present
        .flatten({ background: "#ffffff" })
        .png({ compressionLevel: 9, adaptiveFiltering: true, palette: true })
        .toBuffer();
}

app.post('/save-to-user-public', async (req, res) => {
    try {
        let ppath = (req.body.spath || '').trim();
        let user: string = req.body.user;
        const type: string = req.body.type;
        const value: string = req.body.value;
        let name: string = req.body.name;

        if (!user) {
            console.log('No user specified');
            return res.json({ status: 'Must be logged in' });
        }

        // Normalize path and user
        if (ppath.includes('/myfiles/')) {
            const puser = encodeEmail(String(user));
            ppath = ppath.replace('/myfiles/', '/' + puser + '/');
        }

        if (user.indexOf('@') >= 0) {
            user = encodeEmail(user);
        }

        if (ppath.startsWith(userData)) {
            ppath = ppath.substring(userData.length + 1).trim();
        }
        if (ppath.startsWith('/')) {
            ppath = ppath.substring(1).trim();
        }

        // Ensure .png extension when saving images
        if (type === 'image' && !/\.png$/i.test(name)) {
            name = name + '.png';
        }

        const basePath = path.join(userData, 'public', user, ppath);
        const fullPath = path.join(basePath, name);

        mkDirByPathSync(basePath);

        if (name.toLowerCase().endsWith('.png')) {
            // Accept either a data URL or raw base64 string
            let buffer: Buffer;
            if (typeof value === 'string' && value.startsWith('data:image/')) {
                buffer = dataUrlToBuffer(value);
            } else {
                buffer = Buffer.from(
                    value.replace(/^data:image\/png;base64,/, ''),
                    'base64'
                );
            }

            // 🔵 KEY STEP: convert to LinkedIn-friendly 1200x627 PNG
            const liPng = await toLinkedInPng(buffer);

            await writeFile(fullPath, liPng);
        } else {
            await writeFile(fullPath, String(value));
        }

        return res.json({
            status: 'saved',
            path: `/public/${user}/${ppath}/${name}`,
            width: 1200,
            height: 627,
            hint: 'Saved as 1200x627 PNG optimized for LinkedIn large-link previews'
        });
    } catch (err: any) {
        console.error('Save failed:', err?.message || err);
        return res.status(500).json({ status: 'Save failed: ' + (err?.message || String(err)) });
    }
});

app.post('/save-to-user-internal', async (req, res) => {
    try {
        let ppath = (req.body.spath || '').trim();
        let user: string = req.body.user;
        const type: string = req.body.type;
        const value: string = req.body.value;
        let name: string = req.body.name;

        if (!user) {
            console.log('No user specified');
            return res.json({ status: 'Must be logged in' });
        }

        // Normalize path and user
        if (ppath.includes('/myfiles/')) {
            const puser = encodeEmail(String(user));
            ppath = ppath.replace('/myfiles/', '/' + puser + '/');
        }

        if (user.indexOf('@') >= 0) {
            user = encodeEmail(user);
        }

        if (ppath.startsWith(userData)) {
            ppath = ppath.substring(userData.length + 1).trim();
        }
        if (ppath.startsWith('/')) {
            ppath = ppath.substring(1).trim();
        }

        // Ensure .png extension when saving images
        if (type === 'image' && !/\.png$/i.test(name)) {
            name = name + '.png';
        }

        const basePath = path.join(userData, 'internal', user, ppath);
        const fullPath = path.join(basePath, name);

        mkDirByPathSync(basePath);

        if (name.toLowerCase().endsWith('.png')) {
            // Accept either a data URL or raw base64 string
            let buffer: Buffer;
            if (typeof value === 'string' && value.startsWith('data:image/')) {
                buffer = dataUrlToBuffer(value);
            } else {
                buffer = Buffer.from(
                    value.replace(/^data:image\/png;base64,/, ''),
                    'base64'
                );
            }

            // 🔵 KEY STEP: convert to LinkedIn-friendly 1200x627 PNG
            const liPng = await toLinkedInPng(buffer);

            await writeFile(fullPath, liPng);
        } else {
            await writeFile(fullPath, String(value));
        }

        return res.json({
            status: 'saved',
            path: `/internal/${user}/${ppath}/${name}`,
            width: 1200,
            height: 627,
            hint: 'Saved as 1200x627 PNG optimized for LinkedIn large-link previews'
        });
    } catch (err: any) {
        console.error('Save failed:', err?.message || err);
        return res.status(500).json({ status: 'Save failed: ' + (err?.message || String(err)) });
    }
});


app.post('/save-user-data', async (req, res) => {
    // console.log(" saveing data " + req.body.spath)
    let ppath = req.body.spath
    if (!ppath) {
        ppath = '';
    }
    ppath = ppath.trim()
    let user = req.body.user;
    const type = req.body.type;
    const value = req.body.value;
    if (ppath.indexOf('/myfiles/') >= 0) {
        const user = req.body.user + '';
        const puser = encodeEmail(user)
        ppath = ppath.replace('/myfiles/', '/' + puser + '/')
    }
    if (req.body.shared_user) {
    }
    if (type === 'autosave') {
        try {
            fs.writeFileSync(ppath, value);
            return res.status(400).json({ status: 'Autosave' });

        } catch (exception) {
            return res.status(400).json({ status: 'Autosave failed ' + exception.message });
        }
    }

    if (user) {
        if (user && user.indexOf('@')) {
            user = encodeEmail(user);
        }
        console.log(userData + '/' + user + '/' + ppath + '/' + req.body.name)
        if (ppath.startsWith(userData)) {
            ppath = ppath.substring(userData.length + 1).trim();
        }
        if (ppath.startsWith('/')) {
            ppath = ppath.substring(1).trim();
        }
        let vc = userData + '/' + user + '/' + ppath + '/' + req.body.name
        vc = vc.replace(/\/\//g, '/');
        vc = vc.replace(`${user}/${user}`, user)
        console.log('userdata vc ' + vc);
        let vcdir = userData + '/' + user + '/' + ppath;
        vcdir = vcdir.replace(`${user}/${user}`, user)
        mkDirByPathSync(vcdir);
        fs.writeFileSync(vc, '' + req.body.value);




        res.json({ 'status': 'saved', 'path': '/' + decodeEmail(user) + '/' + ppath + '/' + req.body.name });
    } else {
        console.log(' no user ');
        return res.json({ 'status': 'Must be logged in' });
    }
});


const os = require('os');

app.post('/tempfile', async (req, res) => {
    const { user, type, value, name } = req.body as {
        user?: string;
        type?: string;
        value?: any;
        name?: string;
    };

    if (!value) {
        return res.status(400).json({ status: 'Missing value' });
    }

    const fileExtension = type ? `.${type}` : '.txt';
    const safeName = name
        ? encodeURIComponent(name).replace(/\s+/g, '_')
        : crypto.randomBytes(8).toString('hex');

    let tempFilePath: string;

    if (user) {
        const encodedUser = encodeEmail(user);
        const tempDir = path.join(userData, encodedUser, '.temp');

        try {
            await fsPromises.mkdir(tempDir, { recursive: true }); // ensure .temp exists
        } catch (mkdirErr: any) {
            return res.status(500).json({ status: 'Failed to create .temp folder', error: mkdirErr.message });
        }

        const tempFileName = `${safeName}${fileExtension}`;
        tempFilePath = path.join(tempDir, tempFileName);
    } else {
        const tempFileName = `${safeName}${fileExtension}`;
        tempFilePath = path.join(os.tmpdir(), tempFileName);
    }

    try {
        console.log('Writing temp file:', tempFilePath);

        await fsPromises.writeFile(tempFilePath, JSON.stringify(value), 'utf8');
        return res.json({ status: 'success', path: tempFilePath });
    } catch (writeErr: any) {
        return res.status(500).json({ status: 'temp file failed', error: writeErr.message });
    }
});

app.post('/readtempfile', async (req, res) => {
    const { user, name, type } = req.body as {
        user?: string;
        name?: string;
        type?: string;
    };

    if (!name) {
        return res.status(400).json({ status: 'Missing name' });
    }

    const fileExtension = type ? `.${type}` : '.txt';
    const safeName = encodeURIComponent(name).replace(/\s+/g, '_');

    let tempFilePath: string;

    if (user) {
        const encodedUser = encodeEmail(user);
        const tempDir = path.join(userData, encodedUser, '.temp');
        const tempFileName = `${safeName}${fileExtension}`;
        tempFilePath = path.join(tempDir, tempFileName);
    } else {
        const tempFileName = `${safeName}${fileExtension}`;
        tempFilePath = path.join(os.tmpdir(), tempFileName);
    }

    try {
        const content = await fsPromises.readFile(tempFilePath, 'utf8');
        return res.json({ status: 'success', content });
    } catch (err: any) {
        return res.status(404).json({ status: 'file not found', error: err.message });
    }
});
app.post('/rmtempfile', async (req, res) => {
    const { user, name, type } = req.body as {
        user?: string;
        name?: string;
        type?: string;
    };

    if (!name) {
        return res.status(400).json({ status: 'Missing name' });
    }

    const fileExtension = type ? `.${type}` : '.txt';
    const safeName = encodeURIComponent(name).replace(/\s+/g, '_');

    let tempFilePath: string;

    if (user) {
        const encodedUser = encodeEmail(user);
        const tempDir = path.join(userData, encodedUser, '.temp');
        const tempFileName = `${safeName}${fileExtension}`;
        tempFilePath = path.join(tempDir, tempFileName);
    } else {
        const tempFileName = `${safeName}${fileExtension}`;
        tempFilePath = path.join(os.tmpdir(), tempFileName);
    }

    try {
        await fsPromises.unlink(tempFilePath);
        return res.json({ status: 'success', message: 'File deleted' });
    } catch (err: any) {
        return res.status(404).json({ status: 'file not found or cannot be deleted', error: err.message });
    }
});



app.post('/save-user-dir', async (req, res) => {
    // console.log(req.body);
    let ppath = req.body.spath
    ppath = ppath.trim()
    let user = req.body.user;
    if (user && user.indexOf('@')) {
        user = encodeEmail(user);
    }
    console.log(userData + '/' + user + '/' + ppath)
    if (ppath.startsWith(userData)) {
        ppath = ppath.substring(userData.length + 1).trim();
    }
    if (ppath.startsWith('/')) {
        ppath = ppath.substring(1).trim();
    }
    let vc = userData + '/' + user + '/' + ppath
    vc = vc.replace(/\/\//g, '/');
    console.log('user directory vc ' + vc);
    mkDirByPathSync(userData + '/' + user + '/' + ppath);
    res.json({ 'status': 'saved', 'path': ppath });
});



app.post('/commit', async (req, res) => {
    let ppath = req.body.package_name
    const message = req.body.message
    console.log(" commit " + ppath);
    console.log("message  " + message);
    ppath = ppath.trim()
    git.add(wd + '/' + ppath);
    git.add(wd + '/*/*.js');
    git.commit(message)
    return res.json({
        'status': 'commited'
    })
});



app.post('/stash-file', async (req, res) => {
    let ppath = req.body.package_name
    const name = req.body.file_name
    ppath = ppath.trim()
    const lpath = wd + '/' + ppath + '/' + name
    console.log(" reading " + lpath)
    await git.stash();
    const data = fs.readFileSync(lpath, 'utf-8');
    console.log(" data : " + data)
    return res.json({
        'file': data
    })
});








app.get('/add-files', (req, res) => {
    git.add('./' + 'hello-world.json');
    git.commit('first commit')
    return res.json({
        'commited': 'hello-world.json'
    })
    // git.status().status((status: any) => {
    //     console.log(status);
    // })
});



app.post('/add-files', (req, res) => {
    git.add('./' + 'hello-world.json');
    git.commit('first commit')
    return res.json({
        'commited': 'hello-world.json'
    })
});


app.get('/test', (req, res) => {
    const obj = { hello: 'world' }
    return res.json(obj)
    // const scriptValue = JSON.stringify(obj);
    // fs.writeFile(wd + '/' + 'test.json', scriptValue, (err) => {
    //     if (err) return console.log(err);
    // });

    // git.add('./' + 'test.json');
    // git.commit('first commit')
    // return res.json({
    //     'commited': 'test.json'
    // })
});




app.get('/exec', (req, res) => {

    const c = req.query.command + '';
    const p = req.query.params + '';
    console.log(' params ' + p);
    console.log(' params ' + p.length);
    let lines = '';
    let complete = false;
    if (req.query.params && p && p.length > 0) {
        let options = [p.trim()]
        if (p.trim().indexOf(',') > 0) {
            options = p.split(',')
        }
        setTimeout(() => {
            complete = true;
        }, 10000)
        const command = spawn(c + '', options)
        command.stdout.on('data', output => {
            lines += output.toString();
            // console.log(lines)
        })

        command.stdout.on('exit', function (code) {
            console.log('child process exited with code ' + code.toString());
            complete = true;
        });
        command.stdout.on('close', function (code: { toString: () => string; }) {
            console.log('child process exited with code ' + code.toString());
            complete = true;
        });




    } else {
        setTimeout(() => {
            complete = true;
        }, 10000)
        console.log(" command " + c)

        const command = spawn(c)

        command.stdout.on('data', output => {
            lines += output.toString();
            // console.log(lines)
        })

        command.stdout.on('exit', function (code) {
            console.log('child process exited with code ' + code.toString());
            complete = true;
        });
        command.stdout.on('close', function (code: { toString: () => string; }) {
            console.log('- - - - - - - - - - -  child process close with code ' + code.toString());
            complete = true;
        });

    }


    const i = setInterval(() => {
        if (complete) {
            const obj = { lines }
            clearInterval(i)
            return res.json(obj)
        }
    }, 10)


});




app.get('/track-axis', (req, res) => {
    // pyGenomeTracks --tracks axis.init  --region chrX:31,119,222-33,211,549 -o dmd.svg
    const complete = false;
    const region = req.query.region;
    const tmpname = (new Date().getTime());
    const tmpfile = `/tmp/${tmpname}.svg`;
    const c = `pyGenomeTracks`
    const params = ['--tracks', '/ionworks-server/dist/config/axis.ini', '--region', `${region}`, `-o`, `${tmpfile}`];
    const data = '';
    const command = spawn(c + '', params)
    const invt = setInterval(() => {

        try {
            console.log(" lookning for the file " + tmpfile)
            if (fs.existsSync(tmpfile)) {

                let svgObjct = fs.readFileSync(tmpfile).toString()
                const svgarray = svgObjct.split("\n");
                svgObjct = '';
                for (const s of svgarray) {
                    if (s.startsWith('<svg '))
                        svgObjct = `<svg xmlns:xlink="http://www.w3.org/1999/xlink" width="900px" height="50px" viewBox="65.5 0 918.5 51.78" xmlns="http://www.w3.org/2000/svg" version="1.1">`
                    else
                        svgObjct += s

                }

                clearInterval(invt);
                res.setHeader('Content-Type', 'image/svg+xml');
                // return res.sendFile ( tmpfile )a
                res.send(svgObjct.toString())

            }
        } catch (err) {
            console.error(err)
        }
    }, 100)


});



app.get('/make-track-file', (req, res) => {
    const filename = req.query.filename + '';
    console.log(" Making the track file for " + filename)
    const tmpname = filename.substring(0, filename.lastIndexOf('.'))
    const c = `make_tracks_file`
    const initpath = tmpname + '.ini'; // `/tmp/${tmpname}.ini`;




    const params = ['--trackFiles', '' + filename, `-o`, initpath];
    const data = '';
    const command = spawn(c + '', params)
    const invt = setInterval(() => {
        try {
            console.log(" lookning for the file " + initpath)
            if (fs.existsSync(initpath)) {
                clearInterval(invt);
                return res.json({ 'inipath': initpath })
            }
        } catch (err) {
            console.error(err)
        }
    }, 200)

});





app.get('/get-track-file', (req, res) => {
    const file = '' + req.query.path;
    res.sendFile(file)
});












app.get('/make-py-genome-track', (req, res) => {
    // pyGenomeTracks --tracks axis.init  --region chrX:31,119,222-33,211,549 -o dmd.svg
    const region = req.query.region;
    const inifile = req.query.inifile;
    const tmpname = (new Date().getTime());
    const tmpfile = `/tmp/${tmpname}.svg`;
    const c = `pyGenomeTracks`
    const params = ['--tracks', '' + inifile, '--region', `${region}`, `-o`, `${tmpfile}`];
    const command = spawn(c + '', params)
    console.log(command)

    let complete = false;

    command.stdout.on('close', () => {
        setTimeout(() => {
            complete = true;
        }, 600)
    })
    command.stderr.on('data', (data) => {
        const line = data.toString();
        if (line.startsWith(`DEBUG:pygenometracks.tracks.GenomeTrack:ylim`)) {
            // 	complete = true;
        }
        console.log(data.toString())
    })
    const invt = setInterval(() => {
        try {
            console.log("file " + tmpfile)
            if (fs.existsSync(tmpfile) && complete) {
                const svgObjct = fs.readFileSync(tmpfile).toString()
                // #const svgarray = svgObjct.split("\n");
                // #svgObjct = '';
                // #for (const s of svgarray) {
                // #    if (s.startsWith('<svg '))
                // #        svgObjct = `<svg xmlns:xlink="http://www.w3.org/1999/xlink" width="900px" height="50px" viewBox="65.5 0 918.5 51.78" xmlns="http://www.w3.org/2000/svg" version="1.1">`
                // #    else
                // #        svgObjct += s
                // }
                clearInterval(invt);
                res.setHeader('Content-Type', 'image/svg+xml');
                res.send(svgObjct)

            }
        } catch (err) {
            console.error(err)
        }
    }, 100)


});









app.get('/make-track', (req, res) => {
    // pyGenomeTracks --tracks axis.init  --region chrX:31,119,222-33,211,549 -o dmd.svg
    const region = req.query.region;
    const inifile = req.query.inifile;
    const tmpname = (new Date().getTime());
    const tmpfile = `/tmp/${tmpname}.svg`;
    const c = `pyGenomeTracks`
    const params = ['--tracks', '' + inifile, '--region', `${region}`, `-o`, `${tmpfile}`];
    const command = spawn(c + '', params)
    console.log(command)

    let complete = false;

    command.stdout.on('close', () => {
        setTimeout(() => {
            complete = true;
        }, 600)
    })
    command.stderr.on('data', (data) => {
        const line = data.toString();
        if (line.startsWith(`DEBUG:pygenometracks.tracks.GenomeTrack:ylim`)) {
            // 	complete = true;
        }
        console.log(data.toString())
    })
    const invt = setInterval(() => {
        try {
            if (fs.existsSync(tmpfile) && complete) {
                const svgObjct = fs.readFileSync(tmpfile).toString()
                // #const svgarray = svgObjct.split("\n");
                // #svgObjct = '';
                // #for (const s of svgarray) {
                // #    if (s.startsWith('<svg '))
                // #        svgObjct = `<svg xmlns:xlink="http://www.w3.org/1999/xlink" width="900px" height="50px" viewBox="65.5 0 918.5 51.78" xmlns="http://www.w3.org/2000/svg" version="1.1">`
                // #    else
                // #        svgObjct += s
                // }
                clearInterval(invt);
                res.setHeader('Content-Type', 'image/svg+xml');
                res.send(svgObjct)

            }
        } catch (err) {
            console.error(err)
        }
    }, 100)


});









// data+= `<svg xmlns:xlink="http://www.w3.org/1999/xlink" width="900px" height="50px" viewBox="65.5 0 918.5 51.78" xmlns="http://www.w3.org/2000/svg" version="1.1">`


app.get('/list-experiments', (req, res) => {
    let userid = req.query.userid + '';
    userid = userid.toLocaleLowerCase();
    const status = req.query.status;
    const client = new Client(dbconfig)
    client.connect(
        err => {
            if (err) {
                console.log(JSON.stringify(err))
                throw err;
            }
            else {
                // queryDatabase();
            }
        }
    )
    let queryString = `select id, name, summary, author, date_created, drive_item_id from exp.experiments where (exp_status = 'active' || exp_status is null) order by id desc limit 10000`;
    if (userid != null && userid.trim().length > 0 && userid != undefined && userid != 'undefined') {
        const ind = userid.indexOf('@');
        if (ind > 0) {
            userid = userid.substring(0, ind);
        }
        // ' id, name, summary, author, date_created'
        queryString = `select id, name, summary, author, date_created, drive_item_id from  exp.experiments where author = '${userid}' and (exp_status = 'active' || exp_status is null) order by id desc limit 10000`;
        if (status != null && status.length != 0) {
            queryString = `select id, name, summary, author, date_created, drive_item_id from exp.experiments where author = '` + userid + `' and exp_status = '${status}' limit 10000`;
        }
    }
    client.query(queryString, (err, _res: { rowCount?: any; rows: any }) => {
        if (err !== undefined && err != null) {
            console.log("Postgres INSERT error:", err);
            console.log("Postgres error position:", err);
        }
        if (_res !== undefined) {
            if (_res.rowCount > 0) {
                return res.json({ 'status': 'success', 'msg': _res.rowCount, 'rows': _res.rows });
            } else {
                return res.json({ 'status': 'None', 'msg': 'No experiments for user ' + userid, 'rows': [] });
            }
        }
    });
});




app.get('/get-folder-id-for-experiment', (req, res) => {
    const experiment = '' + req.query.exp;
    const v = /[0-9]*$/gm
    const fi = v.exec('' + experiment);
    const expid = experiment.substring(fi.index)
    console.log(' experiment id ' + expid)


    const client = new Client(dbconfig)
    client.connect(
        err => {
            if (err) {
                // console.log(JSON.stringify(err))
                throw err;
            }
            else {
                // queryDatabase();
            }
        }
    )
    const queryString = `select drive_item_id from exp.experiments where id = ${expid}`;
    client.query(queryString, (err, _res: { rowCount?: any; rows: any }) => {
        if (err !== undefined && err != null) {
            console.log("Postgres INSERT error:", err);
            console.log("Postgres error position:", err);
        }
        if (_res !== undefined) {
            if (_res.rowCount > 0) {

                const did = _res.rows[0].drive_item_id
                return res.json({ 'id': did });
            } else {
                return res.json({ 'status': 'None', 'msg': 'No experiment found for expid  ' + experiment, 'rows': [] });
            }
        }
    });
});




app.get('/archive-experiment', (req, res) => {
    let userid = req.query.userid + '';
    const exp = '' + req.query.expid;
    const client = new Client(dbconfig)
    client.connect(
        err => {
            if (err) {
                console.log(JSON.stringify(err))
                throw err;
            }
            else {
                // queryDatabase();
            }
        }
    )
    const ind = userid.indexOf('@');
    if (ind > 0) {
        userid = userid.substring(0, ind);
    }
    const expid = exp.split('EXP')[1]
    const queryString = `UPDATE exp.experiments SET exp_status = 'archive' where author ='${userid}' and id=${expid}`;
    console.log(queryString)
    client.query(queryString, (err, _res: { rowCount?: any; rows: any }) => {
        if (err !== undefined && err != null) {
            console.log("Error :", err);
        }
        if (_res !== undefined) {
            return res.json({ 'status': 'success', 'msg': 'Experiment ' + expid + ' has set to archive status ' });
        }
    });
});






function verify(key: number) {
    const date = new Date();
    const day = date.getDate();
    const month = date.getMonth() + 1;
    if ((900807 / day) + 1 > key && (900807 / day) - 1 < key)
        return true;
    else
        return false;
}


app.get('/delete-experiment', async (req, res) => {
    const client = new Client(dbconfig)
    const expid = '' + req.query.expid;
    const pwd = verify(+req.query.key);
    if (!pwd) {
        return res.json({
            'msg': 'Failed delete experiment; incorrect key value'

        });
    }

    console.log(' exepriment id ' + expid)
    client.connect(
        err => {
            if (err) {
                console.log(JSON.stringify(err))
                throw err;
            }
            else {
                // queryDatabase();
            }
        }
    )
    // create a string object for Postgres SQL statement
    const queryString = `delete from exp.experiments where id = ${expid}`
    console.log(" query string : " + queryString);
    client.query(queryString, (err, _res: { rowCount?: any; }) => {
        if (err !== undefined && err != null) {
            console.log("Postgres  error:", err);
            console.log("Postgres error position:", err);
        }
        if (_res !== undefined) {
            return res.json(_res);
        }

    });
})



app.post('/update-experiment-folder-id', async (req, res) => {
    const expid = '' + req.body.expID;
    const folderid = '' + req.body.folderID;
    console.log(' exepriment id ' + expid + ' --' + folderid)
    const db_client = new Client(dbconfig)
    db_client.connect(
        async err => {
            if (err) {
                console.log(JSON.stringify(err))
                throw err;
            }
            else {
                const sql = `UPDATE exp.experiments SET drive_item_id = '${folderid}' WHERE id = ${expid}`
                console.log(' sql : ' + sql)
                db_client.query(sql, (err: any, _res: { rowCount?: any; }) => {
                    if (err !== undefined && err != null) {
                        console.log("Postgres INSERT error:", err);
                        console.log("Postgres error position:", err);
                    }
                    if (_res !== undefined) {
                        console.log(" done. ");
                        res.json(_res);
                    }

                });
            }
        }
    )
})




app.get('/create-experiment', async (req, res) => {
    // const ppath = req.query.spath
    const client = new Client(dbconfig)

    let author = '' + req.query.author;
    let name = '' + req.query.name;
    let summary = '' + req.query.summary;
    let experiment_type = '' + req.query.type;
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0'); // January is 0!
    const yyyy = today.getFullYear();
    client.connect(
        err => {
            if (err) {
                console.log(JSON.stringify(err))
                throw err;
            }
            else {
                // queryDatabase();
            }
        }
    )




    name = name.replace(/^"(.*)"$/, '$1');
    summary = summary.replace(/^"(.*)"$/, '$1');
    name = name.replace(/'/g, '');
    name = name.replace(/"/g, ' ');
    summary = summary.replace(/^"(.*)"$/, '$1');
    summary = summary.replace(/'/g, '');
    experiment_type = experiment_type.replace(/^"(.*)"$/, '$1');
    author = author.replace(/^"(.*)"$/, '$1');
    author = author.toLowerCase();
    // create a string object for Postgres SQL statement
    const queryString = `INSERT INTO exp.experiments(name, summary, author, experiment_type) VALUES ('${name}','${summary}','${author}','${experiment_type}')`


    console.log(" query string : " + queryString);
    client.query(queryString, (err, _res: { rowCount?: any; }) => {
        if (err !== undefined && err != null) {
            console.log("Postgres INSERT error:", err);
            console.log("Postgres error position:", err);
        }
        if (_res !== undefined) {
            if (_res.rowCount > 0) {
                client.query('select id from exp.experiments order by date_created desc', (err, ores: { rowCount?: any; rows: any }) => {
                    if (ores.rows.length > 0) {
                        const idv = ores.rows[0].id
                        return res.json({ 'status': 'success', 'msg': '', 'id': idv });
                    } else {
                        console.log(JSON.stringify(ores))
                        return res.json({ 'status': 'failed', 'msg': 'Insert into db failed' });
                    }
                });
            } else {
                console.log("No records were inserted.");
                return res.json({ 'status': 'failed', 'msg': 'Insert into db failed' });
            }
        }

    });
});




app.post('/create-exp', async (req, res) => {
    const client = new Client(dbconfig)
    let author = '' + req.body.author;
    let name = '' + decodeURI(req.body.name);
    let summary = '' + decodeURI(req.body.summary);
    let experiment_type = '' + req.body.experiment_type;
    client.connect(
        err => {
            if (err) {
                console.log(JSON.stringify(err))
                throw err;
            }
            else {
                // queryDatabase();
            }
        }
    )

    name = name.replace(/^"(.*)"$/, '$1');
    summary = summary.replace(/^"(.*)"$/, '$1');
    name = name.replace(/'/g, '');
    name = name.replace(/"/g, ' ');
    summary = summary.replace(/^"(.*)"$/, '$1');
    summary = summary.replace(/'/g, '');
    experiment_type = experiment_type.replace(/^"(.*)"$/, '$1');
    author = author.replace(/^"(.*)"$/, '$1');
    author = author.toLowerCase();
    // create a string object for Postgres SQL statement
    const queryString = `INSERT INTO exp.experiments(name, summary, author, experiment_type) VALUES ('${name}','${summary}','${author}','${experiment_type}')`

    console.log(" query string : " + queryString);
    client.query(queryString, (err, _res: { rowCount?: any; }) => {
        if (err !== undefined && err != null) {
            console.log("Postgres INSERT error:", err);
            console.log("Postgres error position:", err);
        }
        if (_res !== undefined) {
            if (_res.rowCount > 0) {
                client.query('select id from exp.experiments order by date_created desc', (err, ores: { rowCount?: any; rows: any }) => {
                    if (ores.rows.length > 0) {
                        const idv = ores.rows[0].id
                        return res.json({ 'status': 'success', 'msg': '', 'id': idv });
                    } else {
                        console.log(JSON.stringify(ores))
                        return res.json({ 'status': 'failed', 'msg': 'Insert into db failed' });
                    }
                });
            } else {
                console.log("No records were inserted.");
                return res.json({ 'status': 'failed', 'msg': 'Insert into db failed' });
            }
        }

    });
});




/**
 *  this is an incopmplete method.  I need to define the drive_id here... iot's just a place holder right now.
 * This is going to be important for taggin the files when they are dropped into the ELN.
 */
app.get('/exp-file-drop', async (req, res) => {

    const drive_id = '';
    const experiment = '' + req.query.exp;
    const v = /[0-9]*$/gm
    const fi = v.exec('' + experiment);
    const expid = experiment.substring(fi.index)
    console.log(' experiment id ' + expid)
    const client = new Client(dbconfig)
    client.connect(
        err => {
            if (err) {
                console.log(JSON.stringify(err))
                throw err;
            }
            else {
                // queryDatabase();
            }
        }
    )
    const queryString = `select drive_item_id from exp.experiments where id = ${expid}`;
    console.log(queryString)
    client.query(queryString, (err, _res: { rowCount?: any; rows: any }) => {
        if (err !== undefined && err != null) {
            console.log("Postgres INSERT error:", err);
            console.log("Postgres error position:", err);
        }
        if (_res !== undefined) {
            if (_res.rowCount > 0) {

                const did = _res.rows[0].drive_item_id
                const path = `/drives/${drive_id}/item/${did}:/${experiment}.docx`


                return res.json({ 'id': did });
            } else {
                return res.json({ 'status': 'None', 'msg': 'No experiment found for expid  ' + experiment, 'rows': [] });
            }
        }
    });

});



app.post("/usr___/reg", async (req: any, res: any) => {


    console.log(" req " + JSON.stringify(req.body))

    return res.sendStatus(200);
})



app.post('/get', (req, res) => {
    return res.json({
        'commited': 'hello-world.json'
    })
});

app.post('/file-bug', async (req, res) => {
    const auth = Buffer.from(process.env.ATLASSIAN_CREDENTIALS, 'binary').toString('base64')
    await fetch('https://lajollalabs.atlassian.net/rest/api/2/issue/', {
        method: 'POST',
        body: JSON.stringify(req.body),
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-Atlassian-Token': 'no-check',
            'Authorization': `Basic ${auth}`
        },
    }).then(result => {
        return result.json();
    }).then(js => {
        console.log(js);
        res.json(js)
    }).catch(err => {
        console.log(err)
        res.send(err)
    });
});

app.post('/bug-attachment', async (req, res) => {
    const auth = Buffer.from(process.env.ATLASSIAN_CREDENTIALS, 'binary').toString('base64')
    const uri = req.body.uri;
    const imb = Buffer.from(req.body.image, 'base64');

    // Write tmp file to disk
    try {

        const fdata = new formData();

        await fsPromises.writeFile(`/tmp/${req.body.name}`, imb);
        const stats = fsPromises.stat(`/tmp/${req.body.name}`);
        const fileStream = fs.createReadStream(`/tmp/${req.body.name}`);

        fdata.append(
            'file',
            fileStream,
            {
                knownLength: stats.size,
            });

        await fetch(uri, {
            method: 'POST',
            body: fdata,
            headers: {
                'Accept': 'application/json',
                'X-Atlassian-Token': 'no-check',
                'Authorization': `Basic ${auth}`,
            },
        }).then(async (result) => {
            console.log(result)
            await fsPromises.unlink(`/tmp/${req.body.name}`)
            return result.json();
        }).then(js => {
            res.json(js)
        }).catch(err => {
            console.log(err)
            res.send(err)
        });

    } catch (exception) {
        console.log(exception);
        res.send(exception);
    }
});

function getReferenceDbPath(): string {
    const ljlUsers = process.env.LJLUSERS || '';
    if (!ljlUsers) return '';
    return path.join(path.dirname(ljlUsers), 'reference_db');
}

function buildPythonEnv(req: any) {
    const protocol = req.protocol;
    const host = req.get?.("host") || "";
    const serverBaseUrl = host ? `${protocol}://${host}` : "";

    const env: NodeJS.ProcessEnv = {
        ...process.env,

        // ----------------------------
        // Core filesystem paths
        // ----------------------------
        WD: String(wd || ""),
        DEV_PATH: String(devPath || ""),
        HTS_FILES_PATH: String(htsFilesPath || ""),
        BIGDATA: String(bigDataFilesPath || ""),
        CONFIG_PATH: String(configPath || ""),
        USER_DATA: String(userData || ""),
        reference_db: String(process.env.reference_db || getReferenceDbPath() || ""),
        OTT_ROOT: String(ott_root || ""),
        OFFTARGET_INDEX_DIR: String(offtarget_index_root || ""),

        // ----------------------------
        // Ion / BigData plumbing
        // ----------------------------
        SERVER_BASE_URL: String(serverBaseUrl || ""),
        BIGDATA_EXISTS_PATH: "/bigdata-exists",
        BIGDATA_SERVER_PULL_PATH: "/download-bigdata",
        BIGDATA_TIMEOUT_SEC: "30",
        BIGDATA_POLL_SEC: "2",
        BIGDATA_POLL_MAX_SEC: "600",
        BIGDATA_LOCK_TTL_SEC: "21600",

        // ----------------------------
        // Python runtime behavior
        // ----------------------------
        PYTHONUNBUFFERED: "1",

        // ----------------------------
        // AI / LLM credentials for python tools invoked through the js->py
        // exec bridge (e.g. resolving Ensembl transcript IDs from a natural
        // language user prompt via the Anthropic API). These are already
        // covered by the `...process.env` spread above, but are set
        // explicitly so the contract is guaranteed and self-documenting.
        // Populate them via the server's .env file or shell environment.
        // ----------------------------
        ANTHROPIC_API_KEY: String(process.env.ANTHROPIC_API_KEY || ""),
        ANTHROPIC_MODEL: String(process.env.ANTHROPIC_MODEL || ""),
        OPENAI_API_KEY: String(process.env.OPENAI_API_KEY || ""),

        // Make the bundled `ion` library (py/ion-lib, a namespace package) importable
        // by every python script we spawn, without a separate pip install. Prepend it
        // so it wins over any stale/partial `ion` install, and preserve any existing
        // PYTHONPATH the process was launched with.
        PYTHONPATH: [
            path.resolve(String(wd || "."), "py", "ion-lib"),
            process.env.PYTHONPATH || "",
        ].filter(Boolean).join(path.delimiter),
    };

    // ----------------------------
    // User identity propagation
    // ----------------------------
    // Guard: startup self-checks call this with a synthetic req that has no headers.
    const headers = req.headers || {};
    const userId =
        headers["x-user-id"] ||
        headers.user ||
        "";

    if (typeof userId === "string" && userId.length > 0) {
        env.SENDER_USER_ID = encodeEmail(userId);
        env.SENDER_WORKINGDIRECTORY =
            "/" + getKey("user") + "/" + env.SENDER_USER_ID;
    }

    return env;
}



app.get("/py___/:path*", async (req: any, res: any) => {
    let t = req.path;
    t = t.substring(3); // remove "/py"
    t = wd + t;         // absolute script path

    // User identity (do NOT overwrite one header with the other)
    const xUserId = String(req.headers["x-user-id"] || "");
    const userHdr = String(req.headers.user || "");
    const rawUserId = xUserId || userHdr || "";

    let va = "unknown";
    if (rawUserId && rawUserId !== "info@lajollalabs.com") {
        va = encodeEmail(rawUserId);
    }

    const protocol = req.protocol;
    const host = req.get("host") || "";
    const serverBaseUrl = host ? `${protocol}://${host}` : "";

    // Build env (only add strings; avoid undefined)
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        BIGDATA: String(bigDataFilesPath || ""),
        reference_db: String(process.env.reference_db || getReferenceDbPath() || ""),
        SENDER_USER_ID: String(va || "unknown"),
        WD: String(process.cwd() || ""),
        SERVER_BASE_URL: String(serverBaseUrl || ""),
        BIGDATA_EXISTS_PATH: "/bigdata-exists",
        BIGDATA_SERVER_PULL_PATH: "/download-bigdata",
        BIGDATA_TIMEOUT_SEC: "300",
        BIGDATA_POLL_SEC: "2",
        BIGDATA_POLL_MAX_SEC: "600",
        BIGDATA_LOCK_TTL_SEC: "21600",

        // AI / LLM credentials for python tools invoked through the js->py exec
        // bridge (e.g. resolving Ensembl transcript IDs from a user prompt via
        // the Anthropic API). Covered by `...process.env` above, set explicitly
        // so the contract is guaranteed. Populate via the server .env / shell.
        ANTHROPIC_API_KEY: String(process.env.ANTHROPIC_API_KEY || ""),
        ANTHROPIC_MODEL: String(process.env.ANTHROPIC_MODEL || ""),
        OPENAI_API_KEY: String(process.env.OPENAI_API_KEY || ""),

        // Make the bundled `ion` library (py/ion-lib) importable without a pip install.
        PYTHONPATH: [
            path.resolve(String(wd || "."), "py", "ion-lib"),
            process.env.PYTHONPATH || "",
        ].filter(Boolean).join(path.delimiter),
    };

    // Validate required env vars BEFORE spawning python
    const missing: string[] = [];

    // BIGDATA must be provided and point to a writable dir (create if missing)
    if (!env.BIGDATA) missing.push("BIGDATA");
    if (!env.reference_db) missing.push("reference_db");
    if (!env.WD) missing.push("WD");
    if (!env.SERVER_BASE_URL) missing.push("SERVER_BASE_URL");
    if (!env.SENDER_USER_ID) missing.push("SENDER_USER_ID");

    if (missing.length) {
        console.error("Missing required env vars:", missing, {
            BIGDATA: env.BIGDATA,
            reference_db: env.reference_db,
            WD: env.WD,
            SERVER_BASE_URL: env.SERVER_BASE_URL,
            SENDER_USER_ID: env.SENDER_USER_ID,
        });
        return res.status(500).json({
            ok: false,
            msg: `Missing required env vars: ${missing.join(", ")}`,
            missing,
        });
    }

    // Ensure BIGDATA directory exists and is writable
    try {
        fs.mkdirSync(env.BIGDATA!, { recursive: true });
        fs.accessSync(env.BIGDATA!, fs.constants.W_OK);
    } catch (e: any) {
        console.error("BIGDATA path not usable:", env.BIGDATA, e?.message || e);
        return res.status(500).json({
            ok: false,
            msg: "BIGDATA path is missing or not writable",
            BIGDATA: env.BIGDATA,
            error: e?.message || String(e),
        });
    }

    // Optional: ensure script exists (nice failure mode)
    try {
        fs.accessSync(t, fs.constants.R_OK);
    } catch (e: any) {
        console.error("Python script path not readable:", t, e?.message || e);
        return res.status(404).json({
            ok: false,
            msg: "Python script not found or not readable",
            script: t,
            error: e?.message || String(e),
        });
    }
    console.log("ENV CHECK", {
        BIGDATA: env.BIGDATA,
        reference_db: env.reference_db,
        WD: env.WD,
        SERVER_BASE_URL: env.SERVER_BASE_URL,
        SENDER_USER_ID: env.SENDER_USER_ID,
    });

    // 🔥 Debug: confirm what we're actually passing (don’t dump entire env)
    console.log("SPAWN python:", t);
    console.log("ENV BIGDATA:", env.BIGDATA);
    console.log("ENV reference_db:", env.reference_db);
    console.log("ENV WD:", env.WD);
    console.log("ENV SERVER_BASE_URL:", env.SERVER_BASE_URL);
    console.log("ENV SENDER_USER_ID:", env.SENDER_USER_ID);

    try {
        const python = spawn("python3", ["-u", t], { env });

        python.stdout.on("data", (data: any) => {
            const sanitizedData = data.toString().replace(/"/g, "");
            fs.appendFile(filePath.toString(), sanitizedData + "\n", (err: any) => {
                if (err) console.error("Error writing to file:", err);
            });
        });

        python.stderr.on("data", (data: any) => {
            console.log("PY STDERR:", data.toString());
        }); console.log("ENV CHECK", {
            BIGDATA: env.BIGDATA,
            reference_db: env.reference_db,
            WD: env.WD,
            SERVER_BASE_URL: env.SERVER_BASE_URL,
            SENDER_USER_ID: env.SENDER_USER_ID,
        });


        python.on("close", async (code) => {
            console.log(`child process closed with code ${code}`);
            fs.appendFile(filePath.toString(), `\nEXIT_CODE:${code}\n`, () => { });
        });
    } catch (exc) {
        console.log(exc);
        return res.status(500).json({ ok: false, msg: "Failed to spawn python", error: String(exc) });
    }

    return res.json({ ok: true, path: filePath });
});





function tempFile(name = 'temp_file', data = '', encoding = 'utf-8') {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    return new Promise((resolve, reject) => {
        const tempPath = path.join(os.tmpdir(), 'foobar-');
        fs.mkdtemp(tempPath, (err: any, folder: any) => {
            if (err)
                return reject(err)

            const file_name = path.join(folder, name);

            fs.writeFile(file_name, data, encoding, (error_file: any) => {
                if (error_file)
                    return reject(error_file);

                resolve(file_name)
            })
        })
    })
}



const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function resolveUserPath(incomingPath: string): string {
    if (!process.env.LJLUSERS) {
        throw new Error('LJLUSERS environment variable is not set');
    }

    // Normalize and split
    const normalized = path.posix.normalize(incomingPath);
    const parts = normalized.split('/').filter(Boolean);

    if (parts.length === 0) {
        return incomingPath;
    }

    const firstNode = parts[0];

    try {
        const decoded = decodeEmail(firstNode);

        // Validate email structure
        if (EMAIL_REGEX.test(decoded)) {
            return path.join(
                process.env.LJLUSERS,
                ...parts
            );
        }
    } catch {
        // Decryption failed → not an encoded email
    }

    // Not user-scoped
    return incomingPath;
}




const ppath = async (req: {
    [x: string]: any; path: any; query: { args: string; };
}, res: { json: (arg0: { path: unknown; }) => void; }) => {
    let t = req.path;
    t = t.trim();
    if (t.startsWith('/ionworks')) {
        t = t.substring(9);
    } else if (t.startsWith('/py/ionworks')) {
        t = '/py/' + t.substring(12);
    }
    console.log(" t " + t);
    t = t.substring(3);
    t = wd + t;

    let argstr: string = req.query.args;
    let args: string[] = [];
    const cog = [];

    if (argstr != null && argstr.indexOf('&') > 0) {
        argstr = decodeURIComponent(argstr);
        args = argstr.split('&');
    }

    if (args && args.length > 0) {
        for (const a of args) {
            const temp = a.split('=')[1];
            console.log(' param ' + a)
            cog.push(temp);
        }
    }







    args = cog;

    const __filePath = await tempFile();
    const pythonScriptPath = t;
    const filePath: string = __filePath.toString();

    try {

        const env = buildPythonEnv(req);


        const userIdHeader = req.headers['x-user-id'];
        console.log(" user id " + userIdHeader)
        if (userIdHeader && typeof userIdHeader === 'string') {
            env.SENDER_USER_ID = decodeEmail(userIdHeader);
        }



        console.log("PY ENV CHECK", {
            WD: env.WD,
            BIGDATA: env.BIGDATA,
            reference_db: env.reference_db,
            SERVER_BASE_URL: env.SERVER_BASE_URL,
            BIGDATA_EXISTS_PATH: env.BIGDATA_EXISTS_PATH,
            BIGDATA_SERVER_PULL_PATH: env.BIGDATA_SERVER_PULL_PATH,
            SENDER_USER_ID: env.SENDER_USER_ID,
        });

        const pythonProcess = spawn(
            "python3",
            ["-u", pythonScriptPath, ...args],
            { env }
        );

        const outputFileStream = fs.createWriteStream(filePath, { flags: 'a' });
        pythonProcess.stdout.on('data', (data: Buffer) => {
            console.log(`Python stdout: ${data.toString()}`);
            outputFileStream.write(data);
        });

        pythonProcess.stderr.on('data', (data: Buffer) => {
            console.error(`Python stderr: ${data.toString()}`);
            outputFileStream.write(data);
        });

        pythonProcess.on('close', (code: number | null) => {
            console.log(`Python script exited with code ${code}`);
            // outputFileStream.end(); // Optional: close after process ends
        });

    } catch (exc) {
        console.log(exc);
        return res.json(exc);
    }

    return res.json({ path: filePath });
}

const post_ppath = async (req: { path: any; body: any; headers: { [x: string]: any; }; }, res: { json: (arg0: { path: unknown; }) => any; }) => {
    const path = req.path;
    const value = req.body;

    let t = path.trim();

    if (t.startsWith('/ionworks')) {
        t = t.substring(9);
    } else if (t.startsWith('/py/ionworks')) {
        t = '/py/' + t.substring(12);
    }

    console.log(" t " + t);

    t = t.substring(3);
    t = wd + t;

    let args: string[] = [];
    let writeToFile = false;
    let count = 0;

    if (value != null) {
        const keys = Object.keys(value);
        for (const key of keys) {
            const vk = value[key];
            if (vk != null && typeof vk === 'string') {
                count += vk.length;
            }
            args.push(vk);
        }
        writeToFile = true;
    }

    const filePath = await tempFile();
    console.log(' file path ' + filePath);

    if (writeToFile) {
        const argFile = await tempFile();
        try {
            const vargs = [];
            vargs.push(filePath);

            for (const a of args) {
                let value: string | unknown = a;

                console.log('value', value);

                if (
                    typeof value === 'string' &&
                    value.length > 0 &&
                    value.startsWith('/')
                ) {
                    const parts: string[] = value.split('/').filter(Boolean);
                    const firstNode: string | undefined = parts[0];

                    if (firstNode) {
                        let isUserPath = false;

                        try {
                            const decoded: string = decodeEmail(firstNode);
                            if (decoded.includes('@')) {
                                isUserPath = true;
                            }
                        } catch {
                            isUserPath = false;
                        }

                        if (isUserPath && typeof process.env.LJLUSERS === 'string') {
                            value = process.env.LJLUSERS + value;
                        }
                    }
                }

                vargs.push(value);
            }



            fs.writeFileSync(argFile.toString(), JSON.stringify(vargs), { encoding: 'utf-8' });
            args = ['jfile:' + argFile.toString()];
        } catch (err) {
            console.error('Unhandled error:', err);
            try {
                const contents = fs.readFileSync(filePath.toString(), 'utf-8');
                console.log('Contents of output file after error:\n', contents);
            } catch (innerErr) {
                console.error('Failed to read filePath after error:', innerErr);
            }
        }
    }

    const pythonScriptPath = t;

    // ✅ Clone current environment and optionally add x-user-id header
    const env = buildPythonEnv(req);
    const userId = req.headers['x-user-id'];
    console.log(" userId   " + userId)
    if (userId && typeof userId === 'string') {
        env.SENDER_USER_ID = encodeEmail(userId);
        env.SENDER_WORKINGDIRECTORY = '/' + getKey('user') + '/' + env.SENDER_USER_ID
    }



    console.log("PY ENV CHECK (POST)", {
        WD: env.WD,
        BIGDATA: env.BIGDATA,
        reference_db: env.reference_db,
        SERVER_BASE_URL: env.SERVER_BASE_URL,
        BIGDATA_TIMEOUT_SEC: env.BIGDATA_TIMEOUT_SEC,
        BIGDATA_POLL_SEC: env.BIGDATA_POLL_SEC,
        BIGDATA_LOCK_TTL_SEC: env.BIGDATA_LOCK_TTL_SEC,
    });

    const pythonProcess = spawn(
        "python3",
        ["-u", pythonScriptPath, ...args],
        { env }
    );

    const outputFileStream = fs.createWriteStream(filePath.toString(), { flags: 'a' });

    pythonProcess.stdout.on('data', (data: Buffer) => {
        outputFileStream.write(data.toString() + '\n');
    });

    pythonProcess.stderr.on('data', (data: Buffer) => {
        outputFileStream.write(data.toString().trim() + '\n');
    });

    pythonProcess.on('close', (code: number | null) => {
        console.log(`Python script exited with code ${code}`);
        outputFileStream.write('\nEXIT_CODE:' + code + '\n');
        outputFileStream.end();
    });

    return res.json({ 'path': filePath });
};

app.get("/py/:path*", ppath);
app.get("/ionworks/py/:path*", ppath);

app.post("/py/:path*", post_ppath);
app.post("/ionworks/py/:path*", post_ppath);



function isNumeric(str: string) {
    if (typeof str != "string") return false // we only process strings!
    return !isNaN(+str) && // use type coercion to parse the _entirety_ of the string (`parseFloat` alone does not do this)...
        !isNaN(parseFloat(str)) // ...and ensure strings of whitespace fail
}


app.get("/get-dictionary-item", async (req, res) => {
    const dictionary_name: string = req.query.dictionary.toString();
    const key_name: string = req.query.key.toString();
    const value_name: string = req.query.value.toString();
    const dict = cachd.get(dictionary_name)
    if (dict == undefined) {
        return res.json({ 'msg': 'Dictionary is not available' })
    }

    for (const r of dict) {
        const val = r[key_name]
        // console.log ( value_name + '  ==== ' + val )
        if (val.toLowerCase() === value_name.toLowerCase()) {
            return res.json(r)
        }
    }

    res.json({ 'msg': 'Item not found' })

})


app.get("/load-host-dictionary", async (req, res) => {
    try {
        console.log(" load the dictionary ")
        const text = fs.readFileSync(req.query.path.toString()).toString('utf-8');
        let header = req.query.header;
        const dictionary_name: string = req.query.name.toString();
        header = header.toString().split(',')
        const lines = text.split('\n')
        const dl = []
        for (const l of lines) {
            const li = l.split('\t')
            let index = 0;
            const row: { [key: string]: string } = {}
            for (const h of header.toString()) {
                const _value = li[index++]
                if (_value && _value.length > 0) {
                    row[h] = (_value);
                }
            }
            dl.push(row)
        }


        cachd.set(dictionary_name, dl)
        return res.json(dl)
    } catch (exception) {
        return res.json({ 'msg': 'failed ' + exception })
    }
})

app.post("/put-memcache", async (req, res) => {
    console.log(' ------------------------ put memcache ---------------------- ')
    const name = req.body.name
    const value = req.body.data
    cache.add(name, value)
    return res.json({ 'msg': 'allgood' })
})

app.get("/get-memcache", async (req: any, res: any) => {
    console.log(' ------------------------ get memcache ---------------------- ')
    console.log(` ------------------------ ${req.query.name} ---------------------- `)
    const cache_item = cache.get(req.query.name)
    console.log(" cache size " + cache)
    return res.json(cache_item)
})

app.get("/api/health", (_req, res) => {



});




// app.get('/verify-payment', async (req: any, res: any) => {

//     verifyPayment('<user_payment_id_here>')
//         .then((isPaid:any) => {
//             if (isPaid) {
//                 console.log('User has paid');
//                 return res.json({'status':'paid'})

//             } else {
//                 console.log('User has not paid');
//                 return res.json({'status':'not-paid'})
//             }
//         })
//         .catch((error:any) => {
//             console.error(error);
//         });

// })

// app.post('/paypal/ipn', (req, res) => {
//     // verify the IPN message with PayPal
//     const ipn_url = 'https://www.sandbox.paypal.com/cgi-bin/webscr';
//     const body = `cmd=_notify-validate&${req.body}`;
//     request.post(ipn_url, { body }, (error, response, body) => {
//       if (error || body !== 'VERIFIED') {
//         console.error(error || 'Invalid response from PayPal');
//         return res.sendStatus(400);
//       }

//       // parse the IPN message and extract the relevant informatione
//       const txn_id = req.body.txn_id;
//       const item_id = req.body.item_number;

//       // update your database or take other action based on the IPN message
//       console.log(`Payment received: transaction ID ${txn_id}, item ID ${item_id}`);
//       // ...

//       res.sendStatus(200);
//     });
//   });



// var create_payment_json = {
//     "intent": "sale",
//     "payer": {
//         "payment_method": "paypal"
//     },
//     "redirect_urls": {
//         "return_url": "http://localhost:3000/success",
//         "cancel_url": "http://localhost:3000/cancel"
//     },
//     "transactions": [{
//         "amount": {
//             "currency": "USD",
//             "total": "10.00"
//         },
//         "description": "My Awesome Payment"
//     }]
// };

// paypal.payment.create(create_payment_json, function (error, payment) {
//     if (error) {
//         console.log(error);
//     } else {
//         console.log(payment.id);
//     }
// });



function checkFileExists(filePath: fs.PathLike) {
    try {
        // Use fs.accessSync to check if the file exists
        // console.log(" checking for file ")
        fs.accessSync(filePath, fs.constants.F_OK);
        return true; // File exists
    } catch (err) {
        console.log(' error ' + err)
        console.log("Does not exist  " + filePath)
        return false; // File does not exist
    }
}




function streamFile(filePath: string, res: any) {
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${path.basename(filePath + '')}"`,
    });
    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
    readStream.on('error', (err: any) => {
        console.error('Error streaming file:', err);
        res.sendStatus(500);
    });
    readStream.on('end', () => {
        console.log('File streamed successfully');
    });
}

function readLastLines(filePath: fs.PathLike, numLines = 1000) {
    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 1024 * 1024 });
        const data = '';
        let lines: any[] | ConcatArray<string> = [];
        let leftover = '';

        stream.on('data', (chunk: string) => {
            // Prepend leftover from the previous chunk
            chunk = leftover + chunk;

            // Split the chunk into lines
            const parts = chunk.split('\n');

            // Save the last part as leftover
            leftover = parts.pop();

            // Add the lines to the beginning of the lines array
            lines = parts.concat(lines);

            // Check if we have enough lines
            if (lines.length >= numLines) {
                stream.destroy();
                resolve(lines.slice(-numLines).join('\n'));
            }
        });

        stream.on('end', () => {
            // Handle the remaining lines if the stream ends
            if (leftover) {
                lines = [leftover].concat(lines);
            }
            resolve(lines.slice(-numLines).join('\n'));
        });

        stream.on('error', (err: any) => {
            reject(err);
        });
    });
}



const pyread = (req: any, res: any) => {
    const t = req.query.path;
    let startLine = req.query.start;
    if (startLine == undefined) {
        startLine = 0;
    }
    try {

        if (!checkFileExists(t)) {
            return res.json({ 'msg': 'undefined file' })

        }
        const lines = fs.readFileSync(t).toString()
        const l = []
        // console.log(t + ' ll-> : ' + lines.length)
        let index = 0;
        if (lines && lines.length > 0) {
            for (const line of lines.split('\n')) {
                if (index >= startLine)
                    l.push(encodeURI(line))
                index++;
            }
            return res.json({ 'lines': l });
        }
    } catch (exception) {
        res.json({ 'msg': 'nothing yet' })
    }
    res.json({ 'msg': 'nothing yet' })
};



app.get("/py-out/read", pyread)
app.get("/ionworks/py-out/read", pyread)


const dir = path.join(__dirname, 'public');

const mime: any = {
    html: 'text/html',
    txt: 'text/plain',
    css: 'text/css',
    gif: 'image/gif',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    js: 'application/javascript'
};

app.get('/py-fi/*', function (req, res) {
    const file_path_ = req.path.substring(req.path.indexOf('/py-fi/') + 6)
    if (file_path_.endsWith('.xlsx')) {
        if (res.statusCode === 200) {
            res.download(file_path_)
        }
    }
    const type: any = mime[path.extname(file_path_).slice(1)] || 'text/plain';
    const s = fs.createReadStream(file_path_);
    s.on('open', function () {
        res.set('Content-Type', type);
        s.pipe(res);
    });
    s.on('error', function () {
        res.set('Content-Type', 'text/plain');
        res.status(404).end('Not found');
    });
});

function resolveLibraryPdfPath(inputPath: string) {
    const baseRoot = path.posix.normalize(path.posix.join(wd, "library"));

    const libraryPath = inputPath
        .trim()
        .replace(/^\/?library\/?/, "");

    if (!libraryPath) {
        throw new Error("Missing library PDF path.");
    }

    const filePath = path.posix.normalize(path.posix.join(baseRoot, libraryPath));

    if (!(filePath === baseRoot || filePath.startsWith(baseRoot + "/"))) {
        throw new Error("Security Error Logged.");
    }

    return { filePath, baseRoot };
}

app.post("/load-pdf", async (req: Request, res: Response) => {
    try {
        const c = String(req.body.path || "").trim();

        if (!c) {
            return res.status(400).json({ msg: "Missing path parameter." });
        }

        if (!req.body.key) {
            return res.status(400).json({ msg: "Missing key parameter." });
        }

        const rawKey = String(req.body.key);
        const user = String(req.body.user || "");
        const userId = user;
        const sessionUser = encodeEmail(userId);

        const isLibrary =
            rawKey === "library" ||
            c === "/library" ||
            c.startsWith("/library/") ||
            c === "library" ||
            c.startsWith("library/");

        let filePath: string;
        let baseRoot: string;

        if (isLibrary) {
            const resolved = resolveLibraryPdfPath(c);
            filePath = resolved.filePath;
            baseRoot = resolved.baseRoot;
        } else {
            const key = getKey(rawKey);

            if (!key) {
                return res.status(400).json({ msg: "Invalid key parameter." });
            }

            const normalizedKey = path.posix.normalize(key.replace(/\/+$/, ""));

            filePath = path.posix.join(normalizedKey, c);

            if (filePath.includes("/myfiles/")) {
                filePath = filePath.replace("/myfiles/", "/" + sessionUser + "/");
            } else {
                filePath = filePath.replace("/user/", "/" + sessionUser + "/");
            }

            filePath = filePath.replace(/\/+/g, "/");
            filePath = path.posix.normalize(filePath);

            baseRoot = path.posix.normalize(path.posix.join(normalizedKey, sessionUser));

            if (!(filePath === baseRoot || filePath.startsWith(baseRoot + "/"))) {
                return res.status(403).json({ msg: "Security Error Logged." });
            }

            if (!filePath.includes(sessionUser)) {
                try {
                    const dir = path.dirname(filePath);
                    const shareFilePath = path.join(dir, ".share");

                    if (!fs.existsSync(shareFilePath)) {
                        return res.status(403).json({ msg: "Access denied." });
                    }

                    const shareData = fs.readFileSync(shareFilePath, "utf-8");
                    const lines = shareData.split("\n").map((line: string) => line.trim());

                    const isPublic = lines.includes("public");
                    const isSharedWithUser = lines.includes(userId);

                    if (!isPublic && !isSharedWithUser) {
                        return res.status(403).json({ msg: "Access denied." });
                    }
                } catch (e) {
                    console.error("Error checking .share file:", e);
                    return res.status(403).json({ msg: "Access denied." });
                }
            }
        }

        console.log("[load-pdf POST] resolved:", {
            rawKey,
            path: c,
            filePath,
            baseRoot,
            isLibrary,
        });

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ msg: "File not found." });
        }

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
            "Content-Disposition",
            `inline; filename="${path.basename(filePath)}"`
        );

        return res.sendFile(path.resolve(filePath));
    } catch (exception) {
        const msg = (exception as Error).message || "Failed to load the file";

        console.log("Failed to load PDF:", exception);

        if (msg === "Security Error Logged.") {
            return res.status(403).json({ msg });
        }

        if (msg === "Missing library PDF path.") {
            return res.status(400).json({ msg });
        }

        return res.status(500).json({ msg: "Failed to load the file" });
    }
});



import { PDFDocument, StandardFonts } from "pdf-lib";


app.get("/load-pdf", async (req: Request, res: Response) => {
    try {
        let c = String(req.query.path || "").trim();

        if (!c) {
            return res.status(400).json({ msg: "Missing path." });
        }

        const isLibrary =
            c === "/library" ||
            c.startsWith("/library/") ||
            c === "library" ||
            c.startsWith("library/");

        let filePath: string;
        let baseRoot: string;

        if (isLibrary) {
            const resolved = resolveLibraryPdfPath(c);
            filePath = resolved.filePath;
            baseRoot = resolved.baseRoot;
        } else {
            const dir = getKey("user");

            if (!dir) {
                return res.status(500).json({ msg: "Missing user directory." });
            }

            baseRoot = path.posix.normalize(dir.replace(/\/+$/, ""));

            if (c.startsWith("/")) {
                c = c.substring(1).trim();
            }

            filePath = path.posix.normalize(path.posix.join(baseRoot, c));

            if (!(filePath === baseRoot || filePath.startsWith(baseRoot + "/"))) {
                return res.status(403).json({ msg: "Security Error Logged." });
            }
        }

        console.log("[load-pdf GET] resolved:", {
            path: c,
            filePath,
            baseRoot,
            isLibrary,
        });

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ msg: "File not found." });
        }

        const fileBytes = fs.readFileSync(filePath);
        // const pdfDoc = await PDFDocument.load(fileBytes);

        // const totalPages = pdfDoc.getPageCount();
        // const pagesToKeep = Math.min(5, totalPages);

        // const newPdf = await PDFDocument.create();

        // const copiedPages = await newPdf.copyPages(
        //     pdfDoc,
        //     Array.from({ length: pagesToKeep }, (_, i) => i)
        // );

        // copiedPages.forEach((page) => newPdf.addPage(page));

        // const previewPage = newPdf.addPage();
        // const { width, height } = previewPage.getSize();

        // const font = await newPdf.embedFont(StandardFonts.Helvetica);

        // const text = "(Preview)\nComplete resource available for purchase.";
        // const lines = text.split("\n");
        // const fontSize = 18;
        // const lineHeight = fontSize * 1.5;

        // let y = height / 2 + (lines.length * lineHeight) / 2;

        // lines.forEach((line) => {
        //     const textWidth = font.widthOfTextAtSize(line, fontSize);

        //     previewPage.drawText(line, {
        //         x: (width - textWidth) / 2,
        //         y,
        //         size: fontSize,
        //         font,
        //     });

        //     y -= lineHeight;
        // });

        // const newPdfBytes = await newPdf.save();

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
            "Content-Disposition",
            `inline; filename="${path.basename(filePath)}"`
        );

        return res.send(Buffer.from(fileBytes));
    } catch (exception) {
        const msg = (exception as Error).message || "Failed to process the file";

        console.log("Failed to process PDF:", exception);

        if (msg === "Security Error Logged.") {
            return res.status(403).json({ msg });
        }

        if (msg === "Missing library PDF path.") {
            return res.status(400).json({ msg });
        }

        return res.status(500).json({ msg: "Failed to process the file" });
    }
});


app.get("/load-library-pdf", async (req: Request, res: Response) => {
    try {
        let c = String(req.query.path || "").trim();

        if (!c) {
            return res.status(400).json({ msg: "Missing path." });
        }

        const isLibrary =
            c === "/library" ||
            c.startsWith("/library/") ||
            c === "library" ||
            c.startsWith("library/");

        let filePath: string;
        let baseRoot: string;

        if (isLibrary) {
            baseRoot = path.posix.normalize(path.posix.join(wd, "library"));

            const libraryPath = c.replace(/^\/?library\/?/, "");

            if (!libraryPath) {
                return res.status(400).json({ msg: "Missing library PDF path." });
            }

            filePath = path.posix.join(baseRoot, libraryPath);
        } else {
            const dir = getKey("user");

            if (!dir) {
                return res.status(500).json({ msg: "Missing user directory." });
            }

            baseRoot = path.posix.normalize(dir.replace(/\/+$/, ""));

            if (c.startsWith("/")) {
                c = c.substring(1).trim();
            }

            filePath = path.posix.join(baseRoot, c);
        }

        filePath = path.posix.normalize(filePath);
        baseRoot = path.posix.normalize(baseRoot);

        if (!(filePath === baseRoot || filePath.startsWith(baseRoot + "/"))) {
            return res.status(403).json({ msg: "Security Error Logged." });
        }

        console.log("[load-pdf GET] current path:", filePath);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ msg: "File not found." });
        }

        const fileBytes = fs.readFileSync(filePath);
        // const pdfDoc = await PDFDocument.load(fileBytes);

        // const totalPages = pdfDoc.getPageCount();
        // const pagesToKeep = Math.min(5, totalPages);

        // const newPdf = await PDFDocument.create();

        // const copiedPages = await newPdf.copyPages(
        //     pdfDoc,
        //     Array.from({ length: pagesToKeep }, (_, i) => i)
        // );

        // copiedPages.forEach((page) => newPdf.addPage(page));

        // const previewPage = newPdf.addPage();
        // const { width, height } = previewPage.getSize();

        // const font = await newPdf.embedFont(StandardFonts.Helvetica);

        // const text = "(Preview)\nComplete resource available for purchase.";
        // const lines = text.split("\n");
        // const fontSize = 18;
        // const lineHeight = fontSize * 1.5;

        // let y = height / 2 + (lines.length * lineHeight) / 2;

        // lines.forEach((line) => {
        //     const textWidth = font.widthOfTextAtSize(line, fontSize);

        //     previewPage.drawText(line, {
        //         x: (width - textWidth) / 2,
        //         y,
        //         size: fontSize,
        //         font,
        //     });

        //     y -= lineHeight;
        // });

        // const newPdfBytes = await newPdf.save();

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${path.basename(filePath)}"`);

        return res.send(Buffer.from(fileBytes));
    } catch (exception) {
        console.log("Failed to process PDF:", exception);
        return res.status(500).json({ msg: "Failed to process the file" });
    }
});

app.get('/load-purchased-pdf', async (req, res) => {
    let c = '' + req.query.path;

    if (c.startsWith('/')) {
        c = c.substring(1).trim();
    }
    const usernode = c.split('/')[0];
    const requestingfrom = decodeEmail(usernode);

    const dir = getKey('user');

    c = dir + '/' + c;


    c = c.replace(/\/+/g, '/');
    console.log(usernode + ' current path ' + c);

    try {
        if (!fs.existsSync(c)) {
            return res.status(404).json({ msg: 'File not found.' });
        }

        const fileBytes = fs.readFileSync(c);
        const pdfDoc = await PDFDocument.load(fileBytes);

        const totalPages = pdfDoc.getPageCount();
        const pagesToKeep = Math.min(5, totalPages);

        const newPdf = await PDFDocument.create();

        const copiedPages = await newPdf.copyPages(
            pdfDoc,
            Array.from({ length: pagesToKeep }, (_, i) => i)
        );

        copiedPages.forEach((page) => newPdf.addPage(page));

        const previewPage = newPdf.addPage();
        const { width, height } = previewPage.getSize();

        const font = await newPdf.embedFont(require('pdf-lib').StandardFonts.Helvetica);

        const text = "(Preview)\nComplete resource available for purchase.";
        const lines = text.split('\n');
        const fontSize = 18;
        const lineHeight = fontSize * 1.5;

        let y = height / 2 + (lines.length * lineHeight) / 2;

        lines.forEach((line) => {
            const textWidth = font.widthOfTextAtSize(line, fontSize);

            previewPage.drawText(line, {
                x: (width - textWidth) / 2,
                y,
                size: fontSize,
                font,
            });

            y -= lineHeight;
        });

        const newPdfBytes = await newPdf.save();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${path.basename(c)}"`);

        return res.send(Buffer.from(newPdfBytes));
    } catch (exception) {
        console.log('Failed to process PDF:', exception);
        return res.status(500).json({ msg: 'Failed to process the file' });
    }
});

app.get('/temp-download-book', (req: Request, res: Response) => {
    try {
        const token = String(req.query.token || '').trim();

        if (!token) {
            return res.status(400).json({ error: 'Missing token' });
        }

        const tempRoot = path.join(configPath, 'temp-downloads');
        const metaFilePath = path.join(tempRoot, `${token}.json`);

        if (!fs.existsSync(metaFilePath)) {
            return res.status(404).json({ error: 'Download token not found or expired' });
        }

        const meta = JSON.parse(fs.readFileSync(metaFilePath, 'utf8'));
        const now = Date.now();

        if (!meta.tempFilePath || !fs.existsSync(meta.tempFilePath)) {
            try { fs.unlinkSync(metaFilePath); } catch { }
            return res.status(404).json({ error: 'Temp file not found' });
        }

        if (now > Number(meta.expiresAt)) {
            try { fs.unlinkSync(meta.tempFilePath); } catch { }
            try { fs.unlinkSync(metaFilePath); } catch { }
            return res.status(410).json({ error: 'Download link expired' });
        }

        return res.download(
            meta.tempFilePath,
            meta.originalFileName || 'download.pdf',
            (err) => {
                try { fs.unlinkSync(meta.tempFilePath); } catch { }
                try { fs.unlinkSync(metaFilePath); } catch { }

                if (err) {
                    console.error('Temp download error:', err);
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'Internal Server Error' });
                    }
                }
            }
        );
    } catch (error) {
        console.error('Error in /temp-download-book:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});


app.post('/create-temp-book-download', (req: Request, res: Response) => {
    try {
        const userId = String(req.body.userId || '').trim().toLowerCase();
        const appName = String(req.body.app || '').trim();

        if (!userId) {
            return res.status(400).json({ error: 'Missing userId' });
        }

        if (!appName) {
            return res.status(400).json({ error: 'Missing app' });
        }

        let sourceFilePath: string | null = null;
        let downloadName = 'download.pdf';

        if (appName === 'Chemistry of RNA Therapeutics') {
            const baseDir = getKey('user');
            sourceFilePath = path.join(
                baseDir,
                '15f6ec086b1f9ba44f97a73447ac83a004ab605507199c9ce2bfc6ccd5994c12',
                'publish',
                'Chemistry_of_RNA_Therapeutics.pdf'
            );
            downloadName = 'Chemistry_of_RNA_Therapeutics.pdf';
        }

        if (!sourceFilePath || !fs.existsSync(sourceFilePath)) {
            return res.status(404).json({ error: 'Source file not found' });
        }

        const tempRoot = path.join(configPath, 'temp-downloads');
        if (!fs.existsSync(tempRoot)) {
            fs.mkdirSync(tempRoot, { recursive: true });
        }

        const token = crypto.randomBytes(24).toString('hex');
        const expiresAt = Date.now() + 3_600_000;
        const tempFilePath = path.join(tempRoot, `${token}.pdf`);
        const metaFilePath = path.join(tempRoot, `${token}.json`);

        fs.copyFileSync(sourceFilePath, tempFilePath);

        fs.writeFileSync(
            metaFilePath,
            JSON.stringify(
                {
                    token,
                    userId,
                    app: appName,
                    originalFileName: downloadName,
                    tempFilePath,
                    expiresAt,
                    createdAt: Date.now()
                },
                null,
                2
            )
        );

        return res.status(200).json({
            message: 'Temp download created',
            token,
            expiresAt,
            downloadUrl: `/temp-download-book?token=${encodeURIComponent(token)}`
        });
    } catch (error) {
        console.error('Error in /create-temp-book-download:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/download-book', requireAppAccess, async (req: AuthedRequest, res: Response) => {
    try {
        const emailFromQuery = (req.query.email as string | undefined)?.trim();
        const appName = req.resolvedAppName!;
        const position = req.resolvedPosition!;
        const licenseResult = req.licenseResult!;

        const resolvedEmail = emailFromQuery || licenseResult.email;
        if (!resolvedEmail) {
            return res.status(400).json({ error: 'Unable to resolve user email' });
        }

        if (!userData || typeof userData !== 'string') {
            console.error('userData is invalid:', userData);
            return res.status(500).json({ error: 'Server configuration error' });
        }

        const encodedUser = encodeEmail(resolvedEmail);
        if (!encodedUser || typeof encodedUser !== 'string') {
            console.error('encodeEmail failed:', encodedUser);
            return res.status(500).json({ error: 'Could not resolve user folder' });
        }

        const userDir = path.join(userData, encodedUser);
        console.log('Resolved userDir:', userDir);
        console.log('Authorized app:', appName, 'position:', position);

        if (appName === 'Chemistry of RNA Therapeutics') {
            const baseDir = getKey('user');
            const filePath = path.join(
                baseDir,
                '15f6ec086b1f9ba44f97a73447ac83a004ab605507199c9ce2bfc6ccd5994c12',
                'publish',
                'Chemistry_of_RNA_Therapeutics.pdf'
            );

            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: 'File not found on disk' });
            }

            console.log('Downloading file:', filePath);

            return res.download(filePath, 'Chemistry_of_RNA_Therapeutics.pdf', (err) => {
                if (err) {
                    console.error('Download error:', err);
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'Internal Server Error' });
                    }
                }
            });
        }

        return res.status(404).json({ error: 'Unknown app or no downloadable asset configured' });
    } catch (error) {
        console.error('Error in /download-book:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});



app.get('/download', async (req, res) => {
    const tempFilePath = req.query.path + '';
    if (!tempFilePath || !fs.existsSync(tempFilePath)) {
        return res.status(400).json({ error: 'File not found or path not provided' });
    }
    const fileName = path.basename(tempFilePath);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    const fileStream = fs.createReadStream(tempFilePath);
    fileStream.pipe(res);
    fileStream.on('end', () => {
        fs.unlink(tempFilePath, (err: any) => {
            if (err) {
                console.error(`Error deleting temp file: ${err}`);
            } else {
                console.log(`Temp file ${tempFilePath} deleted.`);
            }
        });
    });
    fileStream.on('error', (err: any) => {
        console.error(`Error reading temp file: ${err}`);
        res.status(500).send('Internal Server Error');
    });
});



/**
 *
 * The following code is incomplete but is intended to permit getting the most recent file that a users created
 * @param rootDir
 * @returns
 */

async function findMostRecentlyEditedFiles(rootDir: string) {
    async function exploreDir(dir: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const files = entries.filter((entry: { isDirectory: () => any; }) => !entry.isDirectory()).map((entry: { name: any; }) => path.join(dir, entry.name));
        const dirs = entries.filter((entry: { isDirectory: () => any; }) => entry.isDirectory()).map((entry: { name: any; }) => path.join(dir, entry.name));
        for (const d of dirs) {
            const moreFiles = await exploreDir(d);
            files.push(...moreFiles);
        }
        return files;
    }

    async function getFileStats(files: string[]) {
        const statsPromises = files.map(async file => {
            const stats = fs.statSync(file);
            return { file, mtime: stats.mtime.getTime() };
        });
        return Promise.all(statsPromises);
    }



    try {
        const allFiles = await exploreDir(rootDir);
        const filesWithStats = await getFileStats(allFiles);
        filesWithStats.sort((a, b) => b.mtime - a.mtime); // Sort by modified time, most recent first
        // Optionally, map to return only file paths or return full stats
        return filesWithStats.map(fws => fws.file);
    } catch (error) {
        console.error("Error finding most recently edited files:", error);
        return [];
    }
}

app.get('/get-recent-files', async (req, res) => {
    let c = '' + req.query.path;
    const key = getKey(req.query.key + '')
    let name = c;
    c = c.replace(/\/\//g, '/');
    if (key.toLowerCase() + '/' === c.toLowerCase()) {
        c = key + '/'
    } else {
        c = key + '/' + c;
    }
    if (c.toLowerCase() === '../files/') {
        name = '/'
    } else {
        name = c.substring(c.lastIndexOf('/'))
    }

    c = c.replace(/\/\//g, '/');


    if (hasEmailInPath(c)) {
        const email = extractEmailFromPath(c);
        c = replaceEmailsWithPlaceholder(c, encodeEmail(email));
    }
    console.log(" does this exist  " + c)

    try {
        const l: any[] = []
        if (!fs.existsSync(c)) {
            fs.mkdirSync(c);
        }
        const stats = fs.statSync(c);
        if (name.indexOf('/') >= 0) {
            name = name.substring(name.lastIndexOf('/') + 1)
        }


        if (key)
            c = scrub(c, key);

        console.log(" scrubbed c " + c)

        const rootDirectory = c.replace(/\/+/g, '/');
        findMostRecentlyEditedFiles(rootDirectory)
            .then(files => {
                console.log("Most recently edited files:", files);
                res.json(files)
            })
            .catch(error => {
                console.error(error);
                res.json({ 'msg': '--' })

            });
    } catch (exception) {
        console.error(exception);
        res.json({ 'msg': '--' })

    }
})


app.post('/recent-file', async (req, res) => {
    let c = '' + req.body.path;
    if (req.body.key) {
        const key = getKey(req.body.key + '')
        c = key + c;
        if (c.indexOf('/myfiles/') >= 0) {
            const user = req.body.user + '';
            const puser = encodeEmail(user)
            console.log(' c ' + c);
            c = c.replace('/myfiles/', '/' + puser + '/')
            console.log(' c ' + c);
        }

        else {
            const user = req.body.user + '';
            const puser = encodeEmail(user)
            c = c.replace('/user/', '/' + puser + '/')
        }
        const rootDirectory = c.replace(/\/+/g, '/');
        findMostRecentlyEditedFiles(rootDirectory)
            .then(files => {
                console.log("Most recently edited files:", files);
                res.json(files)
            })
            .catch(error => {
                console.error(error);
                res.json({ 'msg': '--' })

            });
    }
})
// // Example usage
// const rootDirectory = '/path/to/your/directory'; // Replace with your directory path
// findMostRecentlyEditedFiles(rootDirectory)
//   .then(files => {
//     console.log("Most recently edited files:", files);
//   })
//   .catch(error => {
//     console.error(error);
//   });

// -------------------------------------------------------------------------------------------------------------------------



interface DataRow {
    [key: string]: string;
}

let searchableMap: DataRow[] = [];
function loadgenelookup(filePath: string): Promise<DataRow[]> {
    return new Promise((resolve, reject) => {
        fs.readFile(filePath, (err: any, data: zlib.InputType) => {
            if (err) {
                return reject(new Error('File not found or could not be read.'));
            }
            zlib.gunzip(data, (err, decompressedData) => {
                if (err) {
                    return reject(new Error('Could not decompress the file.'));
                }
                const fileContent = decompressedData.toString('utf-8');
                const parsedData = Papa.parse<DataRow>(fileContent, {
                    header: true,
                    delimiter: '\t',
                    skipEmptyLines: true
                });
                resolve(parsedData.data);
            });
        });
    });
}

function searchKey(searchableMap: Map<any, any>, key: string) {
    return searchableMap.get(key) || null;
}
const filePath = `${wd}/data/genes.tsv.gz`;
const primaryKeyColumn = 'Gene name';
const secondaryKeyColumn = 'Gene Synonym';
function searchSubstring(searchKey: string, limit = 100) {
    const lowerCaseSearchKey = searchKey.toLowerCase();
    const results = [];



    // First search using the primary key column
    for (const row of searchableMap) {
        const primaryColumnValue = row[primaryKeyColumn];
        if (primaryColumnValue && primaryColumnValue.toLowerCase().startsWith(lowerCaseSearchKey)) {
            if (row["Ensembl Canonical"] != null && row["Ensembl Canonical"] === "1") {
                results.push(row);
            }
            if (results.length >= limit) {
                break;
            }
        }
    }

    // If no results found using the primary key, search using the secondary key column
    if (results.length < limit) {
        for (const row of searchableMap) {
            const secondaryColumnValue = row[secondaryKeyColumn];
            if (secondaryColumnValue && secondaryColumnValue.toLowerCase().startsWith(lowerCaseSearchKey)) {
                results.push(row);
                if (results.length >= limit) {
                    break;
                }
            }
        }
    }

    // Sort the results: exact matches first, then the rest
    return results.sort((a, b) => {
        const primaryA = a[primaryKeyColumn] ? a[primaryKeyColumn].toLowerCase() : '';
        const primaryB = b[primaryKeyColumn] ? b[primaryKeyColumn].toLowerCase() : '';
        const secondaryA = a[secondaryKeyColumn] ? a[secondaryKeyColumn].toLowerCase() : '';
        const secondaryB = b[secondaryKeyColumn] ? b[secondaryKeyColumn].toLowerCase() : '';

        const exactMatchA = primaryA === lowerCaseSearchKey || secondaryA === lowerCaseSearchKey;
        const exactMatchB = primaryB === lowerCaseSearchKey || secondaryB === lowerCaseSearchKey;

        // Sort exact matches first
        if (exactMatchA && !exactMatchB) return -1;
        if (!exactMatchA && exactMatchB) return 1;

        // If both are exact matches or neither are, maintain original order
        return 0;
    });
}

function searchField(column: string, searchKey: string, limit = 100) {
    const lowerCaseSearchKey = searchKey.trim().toLowerCase();
    const results = [];


    if (!column || column.length <= 0)
        column = primaryKeyColumn;
    column = column.trim();

    // Gene stable ID  Gene stable ID version  Transcript stable ID    Transcript stable ID version    Gene description        Gene name       Ensembl Canonical       RefSeq match transcript (MANE Select)   Gene Synonym
    // First search using the primary key column
    for (const row of searchableMap) {
        // this is not fucking workig and I hasve no fuckign time to debug so there:
        // const primaryColumnValue = row[`"${column}"`];
        const primaryColumnValue = row["Gene stable ID"];
        // console.log (column.toString() +  " primary colum " + primaryColumnValue )

        if (primaryColumnValue && primaryColumnValue.toLowerCase() === (lowerCaseSearchKey)) {
            if (row["Ensembl Canonical"] != null && row["Ensembl Canonical"] === "1") {

                console.log(" row " + JSON.stringify(row))
                results.push(row);
                if (results.length >= limit) {
                    break;
                }
            }
        }
    }

    // If no results found using the primary key, search using the secondary key column
    if (results.length < limit) {
        for (const row of searchableMap) {
            const secondaryColumnValue = row[secondaryKeyColumn];
            if (secondaryColumnValue && secondaryColumnValue.toLowerCase().startsWith(lowerCaseSearchKey)) {
                results.push(row);
                if (results.length >= limit) {
                    break;
                }
            }
        }
    }

    return results
}




app.get('/gene-lookup', (req, res) => {
    const key = '' + req.query.key;
    const field = '' + req.query.field;
    if (!key) {
        return res.json({ 'error': 'nothing' });
    }
    let results = []
    if (field && field.length > 0 && field != 'undefined') {
        results = searchField(field, key, 1);
    } else {

        results = searchSubstring(key);
    }
    if (!results) {
        return res.status(404).send('Key not found.');
    }
    res.json(results);
});




// Endpoint to process subscription and write license for the user
app.post('/subscription', (req, res) => {
    try {
        const inputData = req.body;
        const id = inputData.id;
        const userEmail: string | undefined = inputData?.payer?.email_address;
        const appName: string | undefined = inputData.app;       // expected in payload
        let position: string | undefined = inputData.position; // expected in payload



        const userId = (req.headers['x-user-id'] as string) || (req.headers.user as string) || userEmail;
        // const userEmail = ;
        console.log("verify user", userId);






        if (!position || position.length === 0) {
            position = 'all'
        }

        if (!id || !userEmail) {
            return res.status(400).json({ error: 'Invalid input: Missing id or payer.email_address' });
        }
        if (!appName) {
            return res.status(400).json({ error: 'Invalid input: Missing app' });
        }
        const normalizedEmail = userId.trim().toLowerCase();
        const base64EncodedJson = Buffer.from(JSON.stringify(inputData)).toString('base64');
        function splitEmail(email: string): { username: string; domain: string } {
            const parts = email.split('@');
            if (parts.length !== 2) {
                throw new Error('Invalid email: ' + email);
            }
            return { username: parts[0], domain: parts[1] };
        }

        function sanitizeForDir(name: string): string {
            // Keep letters, digits, dot, dash, underscore
            return name.replace(/[^a-zA-Z0-9._-]/g, '_');
        }

        function ensureDirSync(dir: string) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }

        function loadPricingApps(configPath: string): string[] {
            const pricingPath = path.join(configPath, 'subscriptions', 'pricing.json');
            if (!fs.existsSync(pricingPath)) {
                console.warn('pricing.json not found at', pricingPath);
                return [];
            }

            try {
                const raw = fs.readFileSync(pricingPath, 'utf8');
                const parsed = JSON.parse(raw);
                const plans = Array.isArray(parsed.plans) ? parsed.plans : [];
                const appSet = new Set<string>();
                for (const p of plans) {
                    if (p.app) {
                        appSet.add(p.app);
                    }
                }
                return Array.from(appSet);
            } catch (err) {
                console.error('Error reading pricing.json:', err);
                return [];
            }
        }
        const { username, domain } = splitEmail(normalizedEmail);
        const sanitizedDomain = sanitizeForDir(domain);
        const subscriptionsRoot = path.join(configPath, 'subscriptions');
        const domainDir = path.join(subscriptionsRoot, sanitizedDomain);
        ensureDirSync(domainDir);
        const licenseFilePath = path.join(domainDir, `${username}.json`);
        let existingLicense: any = null;

        if (fs.existsSync(licenseFilePath)) {
            try {
                const raw = fs.readFileSync(licenseFilePath, 'utf8');
                existingLicense = JSON.parse(raw);
            } catch (err) {
                console.error('Error reading existing license file, overwriting:', err);
                existingLicense = null;
            }
        }

        const nowIso = new Date().toISOString();

        // Start with existing license object or create a new one
        const licenseObject: any = existingLicense || {
            email: normalizedEmail,
            username,
            domain,
            subscriptionId: id,
            createdAt: nowIso,
            licenses: []
        };

        // Always update subscriptionId and updatedAt to latest
        licenseObject.subscriptionId = id;
        licenseObject.updatedAt = nowIso;
        licenseObject.lastPayment = base64EncodedJson;

        if (!Array.isArray(licenseObject.licenses)) {
            licenseObject.licenses = [];
        }

        const licenses: any[] = licenseObject.licenses;

        // Helper to upsert a license for a single app/position
        function upsertLicenseForApp(app: string, pos?: string) {
            let entry = licenses.find(l => l.app === app);
            if (!entry) {
                entry = { app, positions: [] as string[] };
                licenses.push(entry);
            }
            if (pos) {
                if (!Array.isArray(entry.positions)) {
                    entry.positions = [];
                }
                if (!entry.positions.includes(pos)) {
                    entry.positions.push(pos);
                }
            }
        }

        // --- 4. Apply license logic based on appName ---
        if (appName === 'All-LJL-Apps') {
            // Grant a license for ALL apps listed in pricing.json
            const appsFromPricing = loadPricingApps(configPath);

            if (!appsFromPricing.length) {
                console.warn('No apps found in pricing.json when processing All-LJL-Apps');
            }

            for (const app of appsFromPricing) {
                // For all-apps product, we give position "all" by default
                upsertLicenseForApp(app, 'all');
            }
        } else {
            // Normal single-app license
            const effectivePosition = position && String(position).trim() !== ''
                ? String(position).trim()
                : 'all';

            upsertLicenseForApp(appName, effectivePosition);
        }

        // --- 5. Write license file back to disk ---
        fs.writeFileSync(licenseFilePath, JSON.stringify(licenseObject, null, 2));

        console.log(`License updated for ${normalizedEmail} at: ${licenseFilePath}`);

        return res.status(200).json({
            message: 'License updated successfully',
            licenseFilePath,
            license: licenseObject
        });
    } catch (error) {
        console.error('Error processing subscription:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

import { determineLicenseStatus, LicenseCheckResult } from './license-status';
import { findPriceFor } from './pricing';



type AuthedRequest = Request & {
    licenseResult?: LicenseCheckResult;
    resolvedPosition?: string;
    resolvedAppName?: string;
    resolvedUserId?: string;
};

function getUserIdFromRequest(req: Request): string {
    return (
        (req.headers['x-user-id'] as string) ||
        (req.headers.user as string) ||
        'what@---.--'
    );
}

function normalizePosition(position?: string): string {
    return position && position.trim().length > 0 ? position.trim() : 'all';
}

function isLicenseAllowed(licenseResult: LicenseCheckResult): boolean {
    const coreStatus = String(licenseResult.coreStatus || '').toLowerCase();
    const licenseStatus = String(licenseResult.licenseStatus || '').toLowerCase();

    return coreStatus === 'active' && (
        licenseStatus === 'granted' || licenseStatus === 'active'
    );
}
function attachLicenseResult(req: AuthedRequest, res: Response, next: NextFunction) {
    try {
        const appName =
            ((req.method === 'GET' ? req.query.app : req.body.app) as string | undefined)?.trim();

        const rawPosition =
            (req.method === 'GET' ? req.query.position : req.body.position) as string | undefined;

        const emailFromRequest =
            ((req.method === 'GET' ? req.query.email : req.body.email) as string | undefined)?.trim();

        const position = normalizePosition(rawPosition);

        const userId =
            (req.headers['x-user-id'] as string) ||
            (req.headers.user as string) ||
            emailFromRequest ||
            'what@---.--';

        if (!appName) {
            return res.status(400).json({ error: 'Missing app name' });
        }

        const licenseResult: LicenseCheckResult = determineLicenseStatus(
            userId,
            appName,
            position,
            configPath
        );

        console.log('===== LICENSE CHECK RESULT =====');
        console.log('User ID:         ', userId);
        console.log('Email:           ', licenseResult.email);
        console.log('App Requested:   ', appName);
        console.log('Position:        ', position);
        console.log('Subscription ID: ', licenseResult.subscriptionId);
        console.log('Core Status:     ', licenseResult.coreStatus);
        console.log('License Status:  ', licenseResult.licenseStatus);
        console.log('Reason:          ', licenseResult.reason);
        console.log('Licenses Found:  ', JSON.stringify(licenseResult.licenses, null, 2));
        console.log('================================');

        req.licenseResult = licenseResult;
        req.resolvedPosition = position;
        req.resolvedAppName = appName;
        req.resolvedUserId = userId;

        next();
    } catch (error) {
        console.error('Error in attachLicenseResult:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}

function requireAppAccess(req: AuthedRequest, res: Response, next: NextFunction) {
    attachLicenseResult(req, res, () => {
        if (!req.licenseResult) {
            return res.status(500).json({ error: 'License resolution failed' });
        }

        if (!isLicenseAllowed(req.licenseResult)) {
            return res.status(403).json({
                error: 'Access denied',
                reason: req.licenseResult.reason,
                coreStatus: req.licenseResult.coreStatus,
                licenseStatus: req.licenseResult.licenseStatus,
                subscriptionId: req.licenseResult.subscriptionId,
                app: req.licenseResult.app,
                position: req.licenseResult.position
            });
        }

        next();
    });
}

// -------------------------------
// VERIFY USER
// -------------------------------
app.post('/verify-user', attachLicenseResult, (req: AuthedRequest, res: Response) => {
    try {
        const emailFromBody: string | undefined = req.body.email;
        const appName = req.resolvedAppName!;
        const position = req.resolvedPosition!;
        const licenseResult = req.licenseResult!;

        const priceEntry = findPriceFor(appName, position, configPath);

        if (priceEntry) {
            console.log('Pricing match:', {
                app: priceEntry.app,
                position: priceEntry.position,
                price: priceEntry.price,
                currency: priceEntry.currency,
                billingPeriod: priceEntry.billingPeriod,
                features: priceEntry.features
            });
        } else {
            console.log('No pricing entry found for', { appName, position });
        }

        let tempFiles: string[] | null = null;
        const emailForTemp = emailFromBody || licenseResult.email;

        if (!emailForTemp) {
            console.warn('No email available for temp folder check; skipping .temp lookup.');
        } else if (!userData || typeof userData !== 'string') {
            console.error('userData is not a valid string:', userData);
        } else {
            const encodedUser = encodeEmail(emailForTemp);

            if (!encodedUser || typeof encodedUser !== 'string') {
                console.error('encodeEmail(email) did not return a string:', encodedUser);
            } else {
                const userDir = path.join(userData, encodedUser);
                const tempDir = path.join(userDir, '.temp');

                console.log('Temp directory:', tempDir);

                if (fs.existsSync(tempDir)) {
                    const files = fs.readdirSync(tempDir);
                    tempFiles = files.length > 0
                        ? files.map((file) => path.join(tempDir, file))
                        : [];
                } else {
                    tempFiles = [];
                }
            }
        }

        const responseBody = {
            email: licenseResult.email,
            coreStatus: licenseResult.coreStatus,
            licenseStatus: licenseResult.licenseStatus,
            subscriptionId: licenseResult.subscriptionId,
            app: licenseResult.app,
            position: licenseResult.position,
            reason: licenseResult.reason,
            licenses: licenseResult.licenses,
            tempFiles,
            price: priceEntry ? priceEntry.price : null,
            currency: priceEntry ? priceEntry.currency : null,
            billingPeriod: priceEntry ? priceEntry.billingPeriod : null,
            features: priceEntry?.features ?? null
        };

        return res.status(200).json(responseBody);
    } catch (error: unknown) {
        console.error('Error in /verify-user:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// -------------------------------
// DOWNLOAD BOOK
// -------------------------------
app.get('/download-book', requireAppAccess, async (req: AuthedRequest, res: Response) => {
    try {
        const emailFromQuery = (req.query.email as string | undefined)?.trim();
        const appName = req.resolvedAppName!;
        const position = req.resolvedPosition!;
        const licenseResult = req.licenseResult!;

        const resolvedEmail = emailFromQuery || licenseResult.email;
        if (!resolvedEmail) {
            return res.status(400).json({ error: 'Unable to resolve user email' });
        }

        if (!userData || typeof userData !== 'string') {
            console.error('userData is invalid:', userData);
            return res.status(500).json({ error: 'Server configuration error' });
        }

        const encodedUser = encodeEmail(resolvedEmail);
        if (!encodedUser || typeof encodedUser !== 'string') {
            console.error('encodeEmail failed:', encodedUser);
            return res.status(500).json({ error: 'Could not resolve user folder' });
        }

        const userDir = path.join(userData, encodedUser);
        console.log('Resolved userDir:', userDir);
        console.log('Authorized app:', appName, 'position:', position);

        if (appName === 'Chemistry of RNA Therapeutics') {
            const baseDir = getKey('user');
            const filePath = path.join(
                baseDir,
                '15f6ec086b1f9ba44f97a73447ac83a004ab605507199c9ce2bfc6ccd5994c12',
                'publish',
                'Chemistry_of_RNA_Therapeutics.pdf'
            );

            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: 'File not found on disk' });
            }

            console.log('Downloading file:', filePath);

            return res.download(filePath, 'Chemistry_of_RNA_Therapeutics.pdf', (err) => {
                if (err) {
                    console.error('Download error:', err);
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'Internal Server Error' });
                    }
                }
            });
        }

        return res.status(404).json({ error: 'Unknown app or no downloadable asset configured' });
    } catch (error: unknown) {
        console.error('Error in /download-book:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// app.post('/---depbugverify-user', requireAppAccess, (req: AuthedRequest, res: Response) => {
//     try {
//         const emailFromBody: string | undefined = req.body.email;
//         const appName = req.resolvedAppName!;
//         const position = req.resolvedPosition!;
//         const licenseResult = req.licenseResult!;

//         const priceEntry = findPriceFor(appName, position, configPath);

//         if (priceEntry) {
//             console.log('Pricing match:', {
//                 app: priceEntry.app,
//                 position: priceEntry.position,
//                 price: priceEntry.price,
//                 currency: priceEntry.currency,
//                 billingPeriod: priceEntry.billingPeriod,
//                 features: priceEntry.features
//             });
//         } else {
//             console.log('No pricing entry found for', { appName, position });
//         }

//         let tempFiles: string[] | null = null;
//         const emailForTemp = emailFromBody || licenseResult.email;

//         if (!emailForTemp) {
//             console.warn('No email available for temp folder check; skipping .temp lookup.');
//         } else if (!userData || typeof userData !== 'string') {
//             console.error('userData is not a valid string:', userData);
//         } else {
//             const encodedUser = encodeEmail(emailForTemp);

//             if (!encodedUser || typeof encodedUser !== 'string') {
//                 console.error('encodeEmail(email) did not return a string:', encodedUser);
//             } else {
//                 const userDir = path.join(userData, encodedUser);
//                 const tempDir = path.join(userDir, '.temp');

//                 console.log('Temp directory:', tempDir);

//                 if (fs.existsSync(tempDir)) {
//                     const files = fs.readdirSync(tempDir);
//                     tempFiles = files.length > 0
//                         ? files.map((file) => path.join(tempDir, file))
//                         : [];
//                 } else {
//                     tempFiles = [];
//                 }
//             }
//         }

//         const responseBody = {
//             email: licenseResult.email,
//             coreStatus: licenseResult.coreStatus,
//             licenseStatus: licenseResult.licenseStatus,
//             subscriptionId: licenseResult.subscriptionId,
//             app: licenseResult.app,
//             position: licenseResult.position,
//             reason: licenseResult.reason,
//             licenses: licenseResult.licenses,
//             tempFiles,
//             price: priceEntry ? priceEntry.price : null,
//             currency: priceEntry ? priceEntry.currency : null,
//             billingPeriod: priceEntry ? priceEntry.billingPeriod : null,
//             features: priceEntry?.features ?? null
//         };

//         return res.status(200).json(responseBody);
//     } catch (error: unknown) {
//         console.error('Error in /verify-user:', error);
//         return res.status(500).json({ error: 'Internal Server Error' });
//     }
// });

// --- Email and File Utilities ---
function isValidEmail(line: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line.trim());
}

function findShareFiles(dir: string, found: string[] = []): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            findShareFiles(fullPath, found);
        } else if (entry.isFile() && entry.name.endsWith('.share')) {
            found.push(fullPath);
        }
    }
    return found;
}

function findFolderByName(dir: string, name: string, found: string[] = []): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === name) {
                found.push(fullPath);
            } else {
                findFolderByName(fullPath, name, found);
            }
        }
    }
    return found;
}


function processShares(rootDir: string): void {
    const shareFiles = findShareFiles(rootDir);

    for (const shareFile of shareFiles) {
        const lines = fs.readFileSync(shareFile, 'utf-8')
            .split('\n')
            .map((l: string) => l.trim())
            .filter(Boolean);

        for (const line of lines) {
            if (isValidEmail(line)) {
                const encodedEmail = encodeEmail(line);
                const folders = findFolderByName(rootDir, encodedEmail);

                for (const folder of folders) {
                    const sharedDir = path.join(folder, 'shared_with_me');

                    // Extract first node from shareFile path
                    const relativePath = path.relative(rootDir, shareFile);
                    const pathParts = relativePath.split(path.sep);
                    const firstNode = pathParts[0];

                    // Get the folder that contains the shareFile
                    const sourceFolderPath = path.dirname(shareFile);
                    const sourceFolderName = path.basename(sourceFolderPath);
                    const rawFolderName = decodeEmail(firstNode);
                    const safeFolderName = rawFolderName.replace(/[^a-zA-Z0-9]/g, '_');

                    // Create a folder for this share
                    const targetShareFolder = path.join(sharedDir, safeFolderName, sourceFolderName);

                    if (!fs.existsSync(targetShareFolder)) {
                        fs.mkdirSync(targetShareFolder, { recursive: true });
                    }

                    const filesInSource = fs.readdirSync(sourceFolderPath).filter((file: any) => {
                        const fullPath = path.join(sourceFolderPath, file);
                        return fs.statSync(fullPath).isFile();
                    });

                    for (const file of filesInSource) {
                        const relativeFilePath = path.relative(rootDir, path.join(sourceFolderPath, file));
                        if (!file.startsWith('.')) {
                            const ljlFileName = `${file}`;
                            const ljlFilePath = path.join(targetShareFolder, ljlFileName);

                            const shareInfo = {
                                shared_from: relativeFilePath
                            };

                            fs.writeFileSync(ljlFilePath, JSON.stringify(shareInfo, null, 2), 'utf-8');
                            console.log(`Created or Overwritten: ${ljlFilePath}`);
                        }
                    }
                }
            }
        }
    }
}




const timerTrigger = async function (context: InvocationContext): Promise<void> {
    // Read environment variables safely
    const tenantId = process.env.LJL_TENTANT_ID;
    const clientId = process.env.LJL_CLIENT_ID;
    const clientSecret = process.env.LJL_SCR;
    const sender = "milton@lajollalabs.com";
    const recipient = "jeff@hts.bio"; // Can be changed dynamically if needed

    // Check for required environment variables
    if (!tenantId || !clientId || !clientSecret) {
        context.log("❌ Missing one or more required environment variables: LJL_TENTANT_ID, LJL_CLIENT_ID, or LJL_SCR");
        return;
    }

    let credential: ClientSecretCredential;
    try {
        credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    } catch (err) {
        context.log("❌ Failed to create ClientSecretCredential:", err);
        return;
    }

    let graphClient;
    try {
        graphClient = GraphClient.initWithMiddleware({
            authProvider: {
                getAccessToken: async () => {
                    const token = await credential.getToken("https://graph.microsoft.com/.default");
                    if (!token) throw new Error("Failed to obtain access token");
                    return token.token;
                }
            }
        });
    } catch (err) {
        context.log("❌ Failed to initialize Microsoft Graph client:", err);
        return;
    }

    const message = {
        message: {
            subject: "HTS Bio Email Alert",
            body: {
                contentType: "Text",
                content: "This is a scheduled alert email sent by Azure Function via Microsoft Graph."
            },
            toRecipients: [
                {
                    emailAddress: {
                        address: recipient
                    }
                }
            ]
        }
    };

    try {
        await graphClient.api(`/users/${sender}/sendMail`).post(message);
        context.log(`✅ Email sent successfully from ${sender} to ${recipient}`);
    } catch (error) {
        context.log("❌ Failed to send email:", error);
    }
};

export default timerTrigger;




// --- Types ---
type Point = {
    type: string;
    url?: string;
    [key: string]: any;
};

type Plot = {
    type: string;
    scatterData?: {
        points?: Point[];
    };
};

type Graph = {
    plots?: Plot[];
};

type LjLFileContent = {
    graph?: Graph;
};

// --- Helpers ---
function getLjlFilesRecursively(dir: string, files: string[] = []): string[] {
    const items = fs.readdirSync(dir);
    for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            getLjlFilesRecursively(fullPath, files);
        } else if (fullPath.endsWith('.ljl')) {
            files.push(fullPath);
        }
    }
    return files;
}

function isEmail(value: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(value);
}



// ✅ Correct decompression method
function __decompressBuffer(compressedBuffer: Buffer): string {
    const compressedString = compressedBuffer.toString('utf-8');
    const chunkSize = 0x8000; // 32,768
    const binaryData: number[] = [];

    for (let i = 0; i < compressedString.length; i += chunkSize) {
        const chunk = compressedString.substring(i, i + chunkSize);
        for (let j = 0; j < chunk.length; j++) {
            binaryData.push(chunk.charCodeAt(j));
        }
    }

    const uint8 = Uint8Array.from(binaryData);
    const decompressed = pako.inflate(uint8, { to: 'string' });
    return decompressed;
}

function findMilestonesWithEmails(rootDir: string): Point[] {
    const ljlFiles = getLjlFilesRecursively(rootDir);
    const result: Point[] = [];
    for (const filePath of ljlFiles) {
        try {
            const compressedBuffer = fs.readFileSync(filePath);
            const decompressedJson = __decompressBuffer(compressedBuffer)
            const parsed = JSON.parse(decompressedJson);
            const plots = parsed.plateTrack?.m_plots;
            if (Array.isArray(plots)) {
                for (const plot of plots) {
                    if (plot.type === 'timeline') {
                        const points = plot.scatterData?.points || [];
                        for (const point of points) {
                            if (
                                point.type === 'milestone' &&
                                typeof point.url === 'string' &&
                                isEmail(point.url)
                            ) {
                                result.push(point);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            // console.warn(`Could not parse ${filePath}: ${(error as Error).message}`);
        }
    }
    return result;
}
// --- Express API setup ---
app.get('/test-milestones', async (req, res) => {
    const dir = getKey('user');
    if (!dir || !fs.existsSync(dir)) {
        return res.status(400).json({ error: 'Missing or invalid `dir` query parameter' });
    }
    try {
        const milestones = findMilestonesWithEmails(dir);
        for (const m of milestones) {



        }
        res.json(milestones);
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});
// Matches how your app is configured elsewhere
declare const publicUserData: string; // root of "public" data on disk

// const TEN_MIN_MS = 2 * 60 * 1000;
const TEN_MIN_MS = 2 * 1000;
const THREE_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Cached news items (rebuilt every 10 minutes)
let cachedNews: { title: string; url: string }[] = [];
// let cachedInternalNews: { title: string; url: string, desc: string }[] = [];
let cachedInternalNews: { title: string; url: string; desc?: string }[] = [];

// --------------------------------------------------
// Recursively traverse a directory and collect files
// modified since cutoffMs
// --------------------------------------------------
async function getRecentFiles(rootDir: string, cutoffMs: number) {
    const results: { fullPath: string; mtime: Date }[] = [];

    async function walk(dir: string) {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                await walk(fullPath);
            } else if (entry.isFile()) {
                const stats = await fs.promises.stat(fullPath);
                if (stats.mtime.getTime() >= cutoffMs) {
                    results.push({ fullPath, mtime: stats.mtime });
                }
            }
        }
    }

    await walk(rootDir);
    return results;
}

// --------------------------------------------------
// Build click URL exactly the way /ln does:
//
// if path ends with .ljt  → /app/cpd/viewer
// else                    → /app/cpd/view
//
// cleanPath here is like: "public/<userHash>/.../file.ext"
// --------------------------------------------------
function buildClickUrl(cleanPath: string): string {
    const ext = path.extname(cleanPath).toLowerCase();
    const host_link = process.env.HOST_LINK
    if (ext === '.ljt') {
        return `https://${host_link}/app/cpd/viewer?path=${encodeURIComponent(cleanPath)}`;
    } else {
        return `https://${host_link}/app/cpd/view?path=${encodeURIComponent(cleanPath)}`;
    }
}
// --------------------------------------------------
// Rebuild the news list from all users' public files
// under userData/public AND from ../internal
// with added fault tolerance
// --------------------------------------------------
async function refreshNewsList() {
    const previousCache = Array.isArray(cachedNews) ? cachedNews : [];


    /**
     *
     *     NOTE this only loads the last month
     *
     *
     */





    try {
        const cutoff = Date.now() - THREE_DAYS_MS;

        let userDataRoot;
        try {
            userDataRoot = getKey('user');
        } catch (e) {
            console.error('Error getting userData root key:', e);
            // Keep existing cache; nothing we can do without userDataRoot
            return;
        }

        if (!userDataRoot) {
            console.warn('userData root key is missing; keeping existing news cache');
            return;
        }

        if (!safeExistsSync(userDataRoot)) {
            console.warn('userData root path does not exist; clearing news cache');
            cachedNews = [];
            return;
        }

        const publicRoot = path.join(userDataRoot, '/public');

        // Locate "internal" as a sibling of userData:
        //   <base>/userData
        //   <base>/internal
        const baseRoot = path.dirname(userDataRoot);
        const rootsToScan = [];

        if (safeExistsSync(publicRoot)) {
            rootsToScan.push({ root: publicRoot, prefix: 'public' });
        } else {
            // console.warn('public folder not found under userData');
        }

        if (!rootsToScan.length) {
            // console.warn('No content roots found; clearing news cache');
            cachedNews = [];
            return;
        }

        let items: any = [];

        for (const { root, prefix } of rootsToScan) {
            let recentFiles = [];
            try {
                recentFiles = await getRecentFiles(root, cutoff);
            } catch (e) {
                console.error(`Failed to get recent files for root "${root}":`, e);
                // Skip this root but continue with others
                continue;
            }

            const filtered = recentFiles.filter(({ fullPath }) => {
                try {
                    const name = path.basename(fullPath || '').toLowerCase();
                    return (
                        name.endsWith('.ljlpx') ||
                        name.endsWith('.ljl') ||
                        name.endsWith('.baja')
                    );
                } catch (e) {
                    console.error('Error filtering file by extension:', fullPath, e);
                    return false;
                }
            });

            const rootItems = filtered
                .map(({ fullPath, mtime }) => {
                    try {
                        if (!fullPath) return null;

                        const relative = path
                            .relative(root, fullPath)
                            .replace(/\\/g, '/');

                        const segments = relative.split('/');
                        if (segments.some((seg: string) => seg.toLowerCase().startsWith('shared'))) {
                            return null;
                        }

                        const cleanPath = `${prefix}/${relative}`;
                        const fileName = path.basename(relative);

                        // ---- FIXED TITLE HANDLING ----
                        const rawTitle = fileName.replace(/\.[^.]+$/, '');  // remove any extension of any length
                        const title = rawTitle.replace(/_/g, ' ').trim();    // underscores → spaces

                        const url = buildClickUrl(cleanPath);

                        return { title, url, modifiedAt: mtime };
                    } catch (e) {
                        console.error('Error mapping file to news item:', { fullPath }, e);
                        return null;
                    }
                })
                .filter(Boolean)
                .map(({ title, url }) => ({ title, url }));


            items = items.concat(rootItems);
        }

        // If we found nothing at all but roots existed, keep old cache instead of nuking it
        if (items.length === 0) {
            // console.warn('No news items found; keeping existing news cache');
            return;
        }

        cachedNews = items;
    } catch (err) {
        console.error('Unexpected failure while refreshing news list:', err);
        // Fall back to previous cache on unexpected top-level error
        cachedNews = previousCache;
    }

    // --------------- helpers -----------------

    function safeExistsSync(p: string) {
        try {
            return !!p && fs.existsSync(p);
        } catch (e) {
            console.error('existsSync failed for path:', p, e);
            return false;
        }
    }
}
async function refreshInternalNewsList() {
    const previousCache = Array.isArray(cachedInternalNews) ? cachedInternalNews : [];


    /**
     *
     *     NOTE this only loads the last month
     *
     *
     */
    try {
        const cutoff = Date.now() - THREE_DAYS_MS;

        let userDataRoot;
        try {
            userDataRoot = getKey('user');
        } catch (e) {
            console.error('Error getting userData root key:', e);
            return;
        }
        if (!userDataRoot) {
            console.warn('userData root key is missing; keeping existing news cache');
            return;
        }
        if (!safeExistsSync(userDataRoot)) {
            console.warn('userData root path does not exist; clearing news cache' + userDataRoot);
            cachedInternalNews = [];
            return;
        }

        const internalRoot = path.join(userDataRoot, 'internal');
        const rootsToScan: { root: string; prefix: string }[] = [];

        if (safeExistsSync(internalRoot)) {
            rootsToScan.push({ root: internalRoot, prefix: 'internal' });
        } else {
            // console.warn(userDataRoot + 'internal folder not found next to userData');
        }

        if (!rootsToScan.length) {
            // console.warn('No content roots found; clearing news cache');
            cachedInternalNews = [];
            return;
        }

        // FIX: use let and accumulate items from all roots
        let items: { title: string; url: string; desc?: string }[] = [];

        for (const { root, prefix } of rootsToScan) {
            let recentFiles: any[] = [];
            try {
                recentFiles = await getRecentFiles(root, cutoff);
            } catch (e) {
                console.error(`Failed to get recent files for root "${root}":`, e);
                // Skip this root but continue with others
                continue;
            }

            const filtered = recentFiles.filter(({ fullPath }) => {
                try {
                    const name = path.basename(fullPath || '').toLowerCase();
                    return (
                        name.endsWith('.ljlpx') ||
                        name.endsWith('.ljl') ||
                        name.endsWith('.baja')
                    );
                } catch (e) {
                    console.error('Error filtering file by extension:', fullPath, e);
                    return false;
                }
            });

            const rootItems = filtered
                .map(({ fullPath, mtime }) => {
                    try {
                        if (!fullPath) return null;

                        const relative = path
                            .relative(root, fullPath)
                            .replace(/\\/g, '/');

                        const segments = relative.split('/');
                        if (segments.some((seg: string) => seg.toLowerCase().startsWith('shared'))) {
                            return null;
                        }

                        const cleanPath = `${prefix}/${relative}`;
                        const fileName = path.basename(relative);

                        // base name without extension (for both title & .desc match)
                        const baseNoExt = path.basename(fileName, path.extname(fileName));

                        const rawTitle = baseNoExt; // no extension
                        const title = rawTitle.replace(/_/g, ' ').trim(); // underscores → spaces

                        const url = buildClickUrl(cleanPath);

                        // ---------- NEW: look for a matching .desc file ----------
                        const dir = path.dirname(fullPath);
                        const descFilePath = path.join(dir, `${baseNoExt}.desc`);
                        let desc: string | undefined;

                        if (safeExistsSync(descFilePath)) {
                            try {
                                desc = fs.readFileSync(descFilePath, 'utf8').trim();
                            } catch (e) {
                                console.error('Error reading .desc file for news item:', descFilePath, e);
                            }
                        }
                        // ---------------------------------------------------------

                        return { title, url, modifiedAt: mtime, desc };
                    } catch (e) {
                        console.error('Error mapping file to news item:', { fullPath }, e);
                        return null;
                    }
                })
                .filter(Boolean)
                .map(({ title, url, desc }) => ({ title, url, desc }));

            // FIX: actually add them to the global items array
            items = items.concat(rootItems);
        }

        // If we found nothing at all but roots existed, keep old cache instead of nuking it
        if (items.length === 0) {
            // console.warn('No news items found; keeping existing news cache');
            return;
        }

        cachedInternalNews = items;

        const host_link = process.env.HOST_LINK;
        // console.log(" host link " + host_link)

        // try {
        //     console.info('Refreshed internal news cache:', {
        //         count: Array.isArray(cachedInternalNews) ? cachedInternalNews.length : 0,
        //         items: cachedInternalNews
        //     });
        // } catch (e) {
        //     console.error('Failed to print updated news cache:', e);
        // }
    } catch (err) {
        console.error('Unexpected failure while refreshing news list:', err);
        // Fall back to previous cache on unexpected top-level error
        cachedInternalNews = previousCache;
    }

    // --------------- helpers -----------------

    function safeExistsSync(p: string) {
        try {
            return !!p && fs.existsSync(p);
        } catch (e) {
            console.error('existsSync failed for path:', p, e);
            return false;
        }
    }
}

// --------------------------------------------------
// Background refresh every 10 minutes
// --------------------------------------------------
setInterval(() => {
    refreshNewsList().catch(err =>
        console.error('Periodic news refresh failed:', err)
    );
    refreshInternalNewsList().catch(err =>
        console.error('Periodic news refresh failed:', err)
    );
}, TEN_MIN_MS);

// Initial build at startup
refreshNewsList().catch(err =>
    console.error('Initial news refresh failed:', err)
);

// --------------------------------------------------
// GET /news → returns cached list (no filesystem work)
// --------------------------------------------------
app.get('/news', (req, res) => {
    res.json(cachedNews);
});
// --------------------------------------------------
// GET /news → returns cached list (no filesystem work)
// --------------------------------------------------
app.get('/internal-news', (req, res) => {
    res.json(cachedInternalNews);
});


// === Utility functions ===
const generateTitle = (filePath: string): string => {
    const fileName = filePath.split('/').pop();
    return `Preview: ${fileName || 'Document'}`;
};

const generateDescription = (filePath: string): string => {
    return `You're previewing a secure document from La Jolla Labs.\nPath: ${filePath}`;
};

const generateImageUrl = (filePath: string): string => {
    const host_link = process.env.HOST_LINK


    const safePath = encodeURIComponent(`${filePath}.png`);
    return `https://${host_link}/ionworks/get-og-images/?path=${safePath}`;
    // /get-og-images/?path
};


/**
 * Serves the raw image file (used by the OG card below).
 * ?path=/relative/path/within/LJLUSERS (no leading ../)
 */
app.get('/get-og-images', (req, res) => {
    let { path: imagePath } = req.query as { path?: string | string[] };

    // Ensure it's a single string
    if (Array.isArray(imagePath)) {
        imagePath = imagePath[0];
    }

    if (!imagePath || typeof imagePath !== 'string') {
        return res.status(400).send('Missing or invalid path parameter');
    }

    const rlju = process.env.LJLUSERS!;
    const cleanPath = imagePath.replace(/\.\./g, '').replace(/^\/+/, '');
    const normalizedPath = path.join(rlju, cleanPath) + '.png';

    if (!fs.existsSync(normalizedPath)) {
        return res.status(404).send('Image not found');
    }

    // Strong caching for the image file itself
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', 'image/png');
    res.sendFile(normalizedPath);
});

/**
 * Returns an HTML page with Open Graph tags so LinkedIn shows a thumbnail.
 * The image itself is served by /get-og-images, and the body wraps it in an <a>
 * so clicking the preview (when opened) goes to the target URL.
 *
 * Query params:
 *  - path: required, same as /get-og-images (without .png)
 *  - to:   required, absolute URL to send clicks to
 *  - title: optional (default provided)
 *  - desc:  optional (default provided)
 */
app.get('/ln', (req, res) => {
    const { path: imagePathRaw, title: titleRaw, desc: descRaw } = req.query as {
        path?: string | string[],
        title?: string | string[],
        desc?: string | string[]
    };

    const imagePath = Array.isArray(imagePathRaw) ? imagePathRaw[0] : imagePathRaw;
    const ogTitle = (Array.isArray(titleRaw) ? titleRaw[0] : titleRaw) || '';

    if (!imagePath || typeof imagePath !== 'string') {
        return res.status(400).send('Missing or invalid "path" parameter');
    }

    const cleanPath = imagePath.replace(/\.\./g, '').replace(/^\/+/, '');
    const rawFileName = cleanPath.split('/').pop() || '';
    const imageNameClean = rawFileName
        .replace(/\.[^/.]+$/, '')
        .replace(/[_-]+/g, ' ')
        .trim();

    const ogDesc = (Array.isArray(descRaw) ? descRaw[0] : descRaw) || `${imageNameClean}`;
    const host_link = process.env.HOST_LINK

    let clickUrl: string;
    try {
        if (cleanPath.endsWith(".ljt")) {
            clickUrl = `https://${host_link}/app/cpd/viewer?path=${encodeURIComponent(cleanPath)}`;

        } else {
            clickUrl = `https://${host_link}/app/cpd/view?path=${encodeURIComponent(cleanPath)}`;
        }
    } catch {
        return res.status(400).send('Invalid "to" URL. Must be absolute http(s) URL.');
    }


    // This is the URL you're actually posting to LinkedIn, i.e. /ln?...
    const shareUrl = `https://${host_link}${req.originalUrl}`;

    const baseUrl = `https://${host_link}/ionworks`;
    const imageUrl = `${baseUrl}/get-og-images?path=${encodeURIComponent(cleanPath)}`;

    // Safely embed URL into JS string literal
    const jsClickUrl = JSON.stringify(clickUrl);

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(ogTitle || imageNameClean)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />

  <!-- Open Graph -->

    <meta property="og:image:secure_url" content="${escapeHtml(imageUrl)}">
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${escapeHtml(ogTitle || imageNameClean)}" />
    <meta property="og:description" content="${escapeHtml(ogDesc)}" />
    <meta property="og:url" content="${escapeHtml(shareUrl)}" />
    <meta property="og:image" content="${escapeHtml(imageUrl)}" />


  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(ogTitle || imageNameClean)}" />
  <meta name="twitter:description" content="${escapeHtml(ogDesc)}" />
  <meta name="twitter:image" content="${escapeHtml(imageUrl)}" />

  <meta http-equiv="Cache-Control" content="max-age=600" />
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; }
    .wrap { padding: 16px; text-align: center; }
    img { max-width: 100%; height: auto; display: block; border-radius: 12px; }
    a { text-decoration: none; }
    .caption { margin-top: 12px; color: #444; }
    .status { margin-top: 8px; font-size: 0.95rem; color: #555; }
  </style>
</head>
<body>
  <div class="wrap">
    <a href="${escapeHtml(clickUrl)}" target="_blank" rel="noopener noreferrer">
      <img id="ogimg" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(imageNameClean)}" />
    </a>
    <div class="caption">${escapeHtml(ogDesc)}</div>
    <div class="status" id="status">Loading preview…</div>
    <noscript><div class="status">JavaScript is disabled. <a href="${escapeHtml(clickUrl)}">Continue</a>.</div></noscript>
  </div>

  <script>
    (function () {
      const img = document.getElementById('ogimg');
      const status = document.getElementById('status');
      const target = ${jsClickUrl};

      function goSoon() {
        status && (status.textContent = 'Redirecting…');
        setTimeout(function () {
          window.location.href = target;
        }, 4000); // 1 second after loading
      }

      if (img && img.complete) {
        // Image may already be cached/loaded
        goSoon();
      } else if (img) {
        img.addEventListener('load', goSoon, { once: true });
        img.addEventListener('error', function () {
          status && (status.textContent = 'Preview failed to load. Redirecting…');
          goSoon(); // still redirect after 1s even if the image fails
        }, { once: true });
      } else {
        goSoon();
      }
    })();
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});


app.get('/internal-news-links', (req, res) => {
    try {
        const iworks = process.env.IONWORKS;
        if (!iworks) {
            return res.status(500).json({ error: 'IONWORKS environment variable is not configured' });
        }

        if (!Array.isArray(cachedInternalNews)) {
            return res.json([]);
        }

        let base = `https://${iworks}/ionworks/ln`;
        if (iworks.indexOf('localhost') >= 0) {
            // for localhost, just hit the app root
            base = `http://${iworks}/ln`;
        }

        const links = cachedInternalNews.map(item => {
            try {
                if (!item || !item.url) {
                    return null;
                }

                const cleanTitle = item.title || '';
                const cleanDesc = item.desc || '';

                let internalPath = '';

                try {
                    // Parse the URL and pull out ?path=...
                    const urlObj = new URL(item.url);
                    const rawPathParam = urlObj.searchParams.get('path') || '';

                    // rawPathParam is "internal%2F..."; decode once to "internal/..."
                    const decoded = rawPathParam ? decodeURIComponent(rawPathParam) : '';

                    // encode once for use as a query param on /ionworks/ln
                    internalPath = decoded ? encodeURIComponent(decoded) : '';
                } catch (e) {
                    console.error('Error parsing item.url', item.url, e);

                    // Fallback: strip protocol + host and leading slash
                    const relative = item.url.replace(/^https?:\/\/[^/]+\/?/, '');
                    internalPath = encodeURIComponent(relative);
                }

                if (!internalPath) {
                    return null;
                }

                const encodedTitle = encodeURIComponent(cleanTitle);
                const encodedDesc = encodeURIComponent(cleanDesc);

                const finalUrl = `${base}?path=${internalPath}&title=${encodedTitle}&desc=${encodedDesc}`;

                return {
                    title: cleanTitle,
                    link: finalUrl
                };
            } catch (e) {
                console.error("Error building internal-news-link:", item, e);
                return null;
            }
        }).filter(Boolean);

        res.json(links);

    } catch (err) {
        console.error("Failed to build /internal-news-links", err);
        res.status(500).json({ error: "Internal error" });
    }
});

// Small helper
function escapeHtml(s: string) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}



app.use('/static', express.static(path.join(userData, 'public')));



// app.post('/og-images', async (req, res) => {
//     let { user, spath = '', name, value } = req.body;

//     if (!user || !name || !value) {
//         return res.status(400).json({ status: 'Missing required fields' });
//     }

//     try {
//         // Normalize user
//         if (user.includes('@')) {
//             user = encodeEmail(user);
//         }

//         // Normalize path
//         spath = spath.trim().replace(/^\/+/, '');
//         if (spath.includes('/myfiles/')) {
//             const encodedUser = encodeEmail(user);
//             spath = spath.replace('/myfiles/', `/${encodedUser}/`);
//         }

//         const relativePath = path.join('og-images', user, spath);
//         const basePath = path.join(userData, 'public', relativePath);
//         const fullPath = path.join(basePath, name.endsWith('.ljl.png') ? name : `${name}.ljl.png`);

//         mkDirByPathSync(basePath);

//         // Decode base64 image string (remove header if present)
//         const base64Data = value.replace(/^data:image\/png;base64,/, '');
//         fs.writeFileSync(fullPath, base64Data, 'base64');

//         return res.json({
//             status: 'saved',
//             path: `/public/${relativePath}/${name}`
//         });
//     } catch (err: any) {
//         console.error('Save failed:', err.message);
//         return res.status(500).json({ status: 'Save failed: ' + err.message });
//     }
// });

// === Main Route ===
app.get('/fetch-og', async (req, res) => {
    const pathParam = req.query.path;

    if (typeof pathParam !== 'string') {
        res.status(400).send('Missing or invalid "path" query parameter');
        return;
    }

    const decodedPath = decodeURIComponent(pathParam);
    const title = generateTitle(decodedPath);
    const description = generateDescription(decodedPath);
    const ogImageUrl = generateImageUrl(decodedPath);
    const host_link = process.env.HOST_LINK

    const targetUrl = `https://${host_link}/app/cpd/view?path=${encodeURIComponent(pathParam)}`;

    const html = `
<!doctype html>
<html lang="no">
<head>
  <meta charset="utf-8">
  <meta name="google" value="notranslate">
  <title>${title}</title>
  <base href="/">
  <meta name="viewport" content="width=device-width, initial-scale=1">

  <!-- ✅ Open Graph Tags -->
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:image" content="${ogImageUrl}" />
  <meta property="og:url" content="${targetUrl}" />
  <meta property="og:type" content="website" />

  <!-- ✅ Twitter Tags -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${ogImageUrl}" />

  <style>
    :root { color-scheme: light dark; }
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      gap: 12px;
      padding: 16px;
      text-align: center;
    }
    img {
      max-width: 90%;
      /* 50% larger visual size than before */
      transform: scale(1.5);
      transform-origin: center;
      border-radius: 8px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.2);
    }
    p {
      margin: 0;
      color: #555;
    }
    #status { font-size: 0.95rem; }
    #count { font-variant-numeric: tabular-nums; font-weight: 600; }
  </style>
</head>
<body>
  <img id="preview" src="${ogImageUrl}" alt="Preview Image" />
  <p id="status">Loading preview…</p>

  <script>
    const targetUrl = '${targetUrl}';
    const img = document.getElementById('preview');
    const statusEl = document.getElementById('status');

    function startCountdown(seconds) {
      let remaining = seconds;
      statusEl.innerHTML = 'Redirecting in <span id="count">' + remaining + '</span>s…';
      const countEl = document.getElementById('count');

      const timer = setInterval(() => {
        remaining -= 1;
        countEl.textContent = remaining;
        if (remaining <= 0) {
          clearInterval(timer);
          window.location.href = targetUrl;
        }
      }, 1000);
    }

    function whenVisible(el, cb) {
      if ('IntersectionObserver' in window) {
        const obs = new IntersectionObserver((entries) => {
          if (entries[0].isIntersecting) {
            obs.disconnect();
            cb();
          }
        });
        obs.observe(el);
      } else {
        // Fallback: assume visible once loaded
        cb();
      }
    }

    img.addEventListener('load', () => {
      statusEl.textContent = 'Preview loaded.';
      whenVisible(img, () => {
        // Start 3-second countdown once the image is on screen
        startCountdown(3);
      });
    });

    img.addEventListener('error', () => {
      statusEl.textContent = 'Failed to load preview. Redirecting…';
      // Fail fast if image can’t load
      window.location.href = targetUrl;
    });
  </script>
</body>
</html>
  `;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
});



setInterval(() => {
    console.log(' updating shared folders....... ')
    processShares(environment.userData)
}, 3000000)


async function startServer() {
    try {
        await initializeAnnotationCache();
    } catch (err) {
        console.error("[startup] Failed to initialize annotations:", err);
        process.exit(1);
    }
}

startServer();


// Warm local reference data (download + index) at startup when configured.
// Set PRELOAD_REFERENCES to a comma list (e.g. "human,mouse,rat") or "all".
// Runs in the background so it never blocks the server from accepting requests.
async function preloadReferences(): Promise<void> {
    const raw = String(process.env.PRELOAD_REFERENCES || "").trim();
    if (!raw) return;

    const list = raw.toLowerCase() === "all"
        ? ["human", "mouse", "rat"]
        : raw.split(",").map((s) => normalizeSpecies(s)).filter(Boolean);

    const unique = Array.from(new Set(list));
    if (unique.length === 0) return;
    console.log(`[reference] preloading: ${unique.join(", ")}`);

    for (const sp of unique) {
        if (!speciesRegistry[sp]) {
            console.warn(`[reference] preload: skipping unknown species '${sp}'`);
            continue;
        }
        try {
            console.log(`[reference] preload ${sp}: annotations...`);
            await loadSpeciesAnnotations(sp);
            console.log(`[reference] preload ${sp}: cDNA sequences...`);
            await loadSpeciesCdna(sp);
            console.log(
                `[reference] preload ${sp}: ready ` +
                `(${Object.keys(annotationsCache[sp] || {}).length} annotated transcripts, ` +
                `${Object.keys(cdnaCache[sp] || {}).length} cDNA sequences)`
            );
        } catch (e: any) {
            console.error(`[reference] preload ${sp} failed:`, e?.message || e);
        }
    }
    console.log(`[reference] preload complete`);
}

server.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}`);

    // Verify the off-target python runtime (numpy) and report local indexes.
    checkOffTargetPython();

    // Always warm HUMAN references on startup (download + index if not already
    // present) in the background — never blocks the server from serving requests.
    console.log('[reference] warming human references on startup...');
    Promise.allSettled([
        loadSpeciesAnnotations('human'),
        loadSpeciesCdna('human'),
    ]).then((results) => {
        const failed = results.filter((r) => r.status === 'rejected');
        if (failed.length) {
            console.warn('[reference] human warm: some parts failed',
                failed.map((f: any) => f.reason?.message || f.reason));
        } else {
            console.log('[reference] human references ready');
        }
    });

    // Additional species from PRELOAD_REFERENCES (non-blocking). The in-flight
    // guards dedupe human if it is also listed there.
    preloadReferences().catch((e) =>
        console.error("[reference] preload error:", e?.message || e)
    );
});




// server.listen(port, () => {

// })
// app.listen(port, () => {
//     // tslint:disable-next-line:no-console
//     console.log(`server started at http://localhost:${port}`);
// });
function uuidv4(): string {
    return ([1e7] as any[]).toString().replace(/[018]/g, (c: any) =>
        (Number(c) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(c) / 4).toString(16)
    );
}
function timer(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

loadgenelookup(filePath).then((data: any) => {
    searchableMap = data;
    console.log('Data loaded successfully.');
})
    .catch((err: { message: any; }) => {
        console.error(err.message);
    });


const heaader = `e723622fe57107e4e289c1fffeb507b4c5ce5c6255a9fd3f411323c000247dff85350c1e1d456e4b30e47f5fcc12b69757002a81ce072f65589b7fbbf3cac1836fb949b0735cfecb7325ee63b7e50b1bae04d90eb1be1fa7fc2564a69071ce7671809830bd96bdd724c588f6dde8b79addcda631e104fb574ca2599bf687cbde42c8bd26dbba8814f48e9bdc597292d2e73e9d91025cce644b39faea8a80d8dd285e0e73fa4f8f4dd44a46d91cd1a4d59f54ed44bc5d2a346dbd3308c649ec31f746bf72cc1c6a3b15268ed1b14ac5c5c543815d0d64ed1451a5b1d2002f2b57153af3ede508badfe9479dfd6be5997826761e607f1dbc119dc3470c98638bb06f6ecff9615fc879af3bc7f5a8539cb5fdaa16ff7a177965a22b451d7850584af4922e2a58ae43eb43c64283d7354995af4257759587cb407fd47e745f2aaad1b79de785fd1a0787c24a80819bf5ad9b447dfc255691397738f44fbc38cc024bf63c23e8dcb03bfdc881768b7130ccadd8fc5f6303f497b31e525420926e418579aa19c0809419301db558002b3477244a4cc34035adbc022425fdc195ec83b9352c0b4ad293cf34eb8bac7ca46c2673643d6d8a079197615cc9befc9b3acea2d36865e7511b8970163f1fe9d19fdf42`
function csv(): any {
    throw new Error('Function not implemented.');
}


// const { ClientSecretCredential } = require('@azure/identity');
// const { Client } = require('@microsoft/microsoft-graph-client');
// require('isomorphic-fetch'); // Required by MS Graph SDK

const tenantId = process.env.LJL_TENTANT_ID || '';
const clientId = process.env.LJL_CLIENT_ID || '';
const clientSecret = process.env.LJL_SCR || '';
const userId = process.env.SENDER_USER_ID || ''; // e.g. 'user@yourdomain.com'



console.log(" user ID " + userId)
console.log(" tenantId " + tenantId)
console.log(" clientId " + clientId)
console.log(" clientSecret " + clientSecret)


try {

    // ✅ Use client secret instead of PEM
    const credential = new ClientSecretCredential(
        tenantId,
        clientId,
        clientSecret
    );

    // Initialize Graph client
    const graphClient = GraphClient.initWithMiddleware({
        authProvider: {
            getAccessToken: async () => {
                const token = await credential.getToken('https://graph.microsoft.com/.default');
                return token.token;
            },
        },
    });

    async function sendMail(arg0: { to: string; subject: string; text: string }) {
        const message = {
            message: {
                subject: arg0.subject,
                body: {
                    contentType: 'Text',
                    content: arg0.text,
                },
                toRecipients: [
                    {
                        emailAddress: {
                            address: arg0.to,
                        },
                    },
                ],
            },
            saveToSentItems: true,
        };

        try {
            await graphClient.api(`/users/${userId}/sendMail`).post(message);
            console.log('Email sent via Microsoft Graph.');
        } catch (err) {
            console.error('Error sending mail:', err);
            throw err;
        }
    }



    app.get('/test-mail', async (req, res) => {
        try {
            sendMail({
                to: 'milton@lajollalabs.com',
                subject: 'Test Email',
                text: 'This is a test email from /test-mail endpoint.',
            });
            res.status(200).send('Test email sent successfully.');
        } catch (error) {
            console.error('Error sending test email:', error);
            res.status(500).send('Failed to send test email.');
        }
    });

} catch {
    console.log(" No graphclient ")
}

