#!/usr/bin/env node
/*
 * login-alert.js — email milton@baja.bio (LOGIN_ALERT_TO) whenever a user signs in to baja.
 *
 * Runs on the production host as a small systemd service (baja-login-alert.service). It
 * follows the baja-server journal and treats two things as a sign-in:
 *
 *   1. An explicit "[login] provider=<p> user=<email>" line, which baja-server writes when
 *      it exchanges an OAuth code for the browser (Google, Facebook, GitHub, Apple).
 *   2. The first request carrying a user identity after that user has been quiet for
 *      LOGIN_ALERT_QUIET_HOURS (default 6). This catches sign-ins that never touch the
 *      server's token proxy (Microsoft) and app reloads that start a new session.
 *
 * Mail goes out through Microsoft Graph with the same app credentials baja-server uses
 * (LJL_TENTANT_ID / LJL_CLIENT_ID / LJL_SCR from /opt/baja-server/.env), from
 * LOGIN_ALERT_FROM (default milton@lajollalabs.com). One email per user per session.
 *
 * Env (all optional):
 *   LOGIN_ALERT_TO           recipient                       default milton@baja.bio
 *   LOGIN_ALERT_FROM         Graph mailbox to send from      default milton@lajollalabs.com
 *   LOGIN_ALERT_QUIET_HOURS  idle gap that starts a session  default 6
 *   LOGIN_ALERT_IGNORE       comma-separated emails to skip  default (none)
 *   LOGIN_ALERT_STATE        state file                      default ./state.json
 *   LOGIN_ALERT_UNIT         journal unit to follow          default baja-server
 *   LOGIN_ALERT_DRY_RUN=1    log instead of sending
 *
 * Usage:  node login-alert.js                              follow the journal (what the service runs)
 *         node login-alert.js --test [--env-file FILE]      send one test email and exit
 *
 * --env-file loads KEY=VALUE lines (quotes and CR stripped) the way systemd's
 * EnvironmentFile does, so a manual test sees exactly what the service sees.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

(function loadEnvFile() {
    const i = process.argv.indexOf('--env-file');
    if (i < 0 || !process.argv[i + 1]) return;
    try {
        for (const raw of fs.readFileSync(process.argv[i + 1], 'utf8').split('\n')) {
            const line = raw.replace(/\r$/, '').trim();
            if (!line || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq <= 0) continue;
            const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
            let val = line.slice(eq + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
            if (process.env[key] === undefined) process.env[key] = val;
        }
    } catch (e) { console.error('could not read env file:', e.message); }
})();

const NODE_MODULES = process.env.LOGIN_ALERT_NODE_MODULES || '/opt/baja-server/node_modules';
function req(name) {
    try { return require(name); } catch (e) { return require(path.join(NODE_MODULES, name)); }
}
const { ClientSecretCredential } = req('@azure/identity');
const { Client: GraphClient } = req('@microsoft/microsoft-graph-client');

const TO = process.env.LOGIN_ALERT_TO || 'milton@baja.bio';
const FROM = process.env.LOGIN_ALERT_FROM || 'milton@lajollalabs.com';
const QUIET_MS = Math.max(0.25, parseFloat(process.env.LOGIN_ALERT_QUIET_HOURS || '6')) * 3600 * 1000;
const IGNORE = new Set((process.env.LOGIN_ALERT_IGNORE || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const STATE_FILE = process.env.LOGIN_ALERT_STATE || path.join(__dirname, 'state.json');
const UNIT = process.env.LOGIN_ALERT_UNIT || 'baja-server';
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.LOGIN_ALERT_DRY_RUN || '');
const EXPLICIT_DEDUP_MS = 10 * 60 * 1000;   // a [login] line within 10 min of the last alert is the same session
const HOST = require('os').hostname();

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- state
// { users: { email: { lastSeen: ms, lastAlert: ms, sessions: n } } }
let state = { users: {} };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || state; if (!state.users) state.users = {}; } catch (e) { }
let saveTimer = null;
function saveState() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
            fs.writeFileSync(STATE_FILE, JSON.stringify(state));
        } catch (e) { log('state save failed:', e.message); }
    }, 2000);
}

// ---------------------------------------------------------------- mail
let graph = null;
function graphClient() {
    if (graph) return graph;
    const tenantId = process.env.LJL_TENTANT_ID, clientId = process.env.LJL_CLIENT_ID, secret = process.env.LJL_SCR;
    if (!tenantId || !clientId || !secret) throw new Error('LJL_TENTANT_ID / LJL_CLIENT_ID / LJL_SCR are not set');
    const credential = new ClientSecretCredential(tenantId, clientId, secret);
    graph = GraphClient.initWithMiddleware({
        authProvider: {
            getAccessToken: async () => {
                const t = await credential.getToken('https://graph.microsoft.com/.default');
                if (!t) throw new Error('could not obtain a Graph access token');
                return t.token;
            }
        }
    });
    return graph;
}

async function sendMail(subject, text) {
    if (DRY_RUN) { log('[dry-run] would send:', subject, '\n' + text); return; }
    const message = {
        message: {
            subject,
            body: { contentType: 'Text', content: text },
            toRecipients: [{ emailAddress: { address: TO } }]
        },
        saveToSentItems: false
    };
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await graphClient().api(`/users/${FROM}/sendMail`).post(message);
            log('sent:', subject);
            return;
        } catch (e) {
            lastErr = e;
            log(`send failed (attempt ${attempt + 1}/3):`, e && e.message ? e.message : e);
            await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
        }
    }
    throw lastErr;
}

// ---------------------------------------------------------------- detection
const RE_LOGIN = /\[login\]\s+provider=(\S+)\s+user=(\S+)/i;
const RE_IDENT = [
    /\buser=([^\s@"'<>]+@[^\s"'<>]+)/i,          // [subscription] ... user=a@b
    /\buserId:\s*([^\s@"'<>]+@[^\s"'<>]+)/i,      // [get-nodes] userId: a@b
    /\bUser-ID:\s*([^\s@"'<>]+@[^\s"'<>]+)/i,     // User-ID: a@b
];

function normEmail(s) {
    return ('' + (s || '')).trim().replace(/[),.;:]+$/g, '').toLowerCase();
}

function describe(user, kind, provider, now) {
    const rec = state.users[user] || {};
    const when = new Date(now);
    const lines = [
        `${user} signed in to baja (${HOST}).`,
        '',
        `When:      ${when.toISOString()}  (${when.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} Pacific)`,
        `How:       ${kind === 'explicit' ? 'OAuth code exchange via ' + (provider || 'unknown') : 'first request after ' + (QUIET_MS / 3600000).toFixed(1) + 'h+ of inactivity'}`,
        `Sessions:  ${rec.sessions || 1} seen by this watcher`,
        rec.lastSeen ? `Previous:  ${new Date(rec.lastSeen).toISOString()}` : `Previous:  (first time seen)`,
        '',
        `— baja-login-alert on ${HOST}`
    ];
    return lines.join('\n');
}

async function onIdentity(user, kind, provider) {
    user = normEmail(user);
    if (!user || !user.includes('@') || IGNORE.has(user)) return;
    const now = Date.now();
    const rec = state.users[user] || { lastSeen: 0, lastAlert: 0, sessions: 0 };
    const idle = now - (rec.lastSeen || 0);
    let alert = false;
    if (kind === 'explicit') {
        alert = (now - (rec.lastAlert || 0)) > EXPLICIT_DEDUP_MS;
    } else {
        alert = !rec.lastSeen || idle > QUIET_MS;
    }
    const prev = { ...rec };
    rec.lastSeen = now;
    if (alert) { rec.sessions = (rec.sessions || 0) + 1; rec.lastAlert = now; }
    state.users[user] = rec;
    saveState();
    if (!alert) return;
    const subject = `baja: ${user} signed in`;
    const body = describe(user, kind, provider, now).replace(/Previous:  .*/, prev.lastSeen ? `Previous:  ${new Date(prev.lastSeen).toISOString()}` : 'Previous:  (first time seen)');
    try { await sendMail(subject, body); }
    catch (e) { log('giving up on alert for', user, ':', e && e.message ? e.message : e); }
}

function handleLine(line) {
    const m = RE_LOGIN.exec(line);
    if (m) { onIdentity(m[2], 'explicit', m[1]); return; }
    for (const re of RE_IDENT) {
        const k = re.exec(line);
        if (k) { onIdentity(k[1], 'activity', null); return; }
    }
}

// ---------------------------------------------------------------- journal follower
function follow() {
    log(`following journal for unit ${UNIT}; alerts to ${TO} from ${FROM}; quiet gap ${QUIET_MS / 3600000}h${DRY_RUN ? ' (dry run)' : ''}`);
    const p = spawn('journalctl', ['-u', UNIT, '-f', '-n', '0', '-o', 'cat'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            try { handleLine(line); } catch (e) { log('line error:', e.message); }
        }
    });
    p.stderr.on('data', (d) => log('journalctl:', d.toString().trim()));
    p.on('exit', (code) => {
        log('journalctl exited with', code, '- restarting in 5s');
        setTimeout(follow, 5000);
    });
}

async function main() {
    if (process.argv.includes('--test')) {
        await sendMail('baja: login alert test', `Test message from baja-login-alert on ${HOST} at ${new Date().toISOString()}.\nIf you can read this, sign-in alerts will reach ${TO}.`);
        return;
    }
    follow();
}

main().catch((e) => { log('fatal:', e && e.message ? e.message : e); process.exit(1); });
