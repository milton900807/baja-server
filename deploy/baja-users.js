#!/usr/bin/env node
//
// Suspend, restore and sign out users of oligodesigner.com, by email address.
//
//   node deploy/baja-users.js list                     everyone, with their state
//   node deploy/baja-users.js status <email>           one account
//   node deploy/baja-users.js block <email> [reason]   refuse them (403) until unblocked
//   node deploy/baja-users.js unblock <email>          let them back in
//   node deploy/baja-users.js logout <email>           sign them out (401) until they
//                                                      authenticate again
//   node deploy/baja-users.js logout-all               sign EVERY user out
//   node deploy/baja-users.js clear-logout <email>     cancel a forced sign-out
//
//   --json    machine-readable
//   --yes     skip the confirmation on the destructive ones
//
// WHAT BLOCK ACTUALLY DOES, SO THE LIMIT IS KNOWN BEFORE IT IS RELIED ON
//
// The API has no session store and does not verify the sign-in token on ordinary requests:
// a request says who it is by putting an email in the query string or the body, and the
// server takes its word. Blocking therefore stops a person USING THE APP -- their client
// sends their address and every identified call is refused -- but it is account suspension,
// not authentication. Someone willing to edit a request can send a different address. If
// this needs to withstand that, the id_token has to be verified per request, which is a
// different piece of work and is not what this script pretends to do.
//
// BLOCK vs LOGOUT
//
//   block   survives a fresh sign-in. Lifted only by unblock.
//   logout  is cleared the moment they authenticate again -- the OIDC token endpoint clears
//           it. Use it to end a session, not to keep someone out.
//
// WHERE THE STATE LIVES
//
// /home/ubuntu/baja-users/access-control.json on the production server, read by the API on
// demand and cached against its mtime -- so a change here takes effect within a second, with
// no restart. The deploy script preserves this directory.
//
// WHERE THE USER LIST COMES FROM
//
// A user's directory under baja-users IS their email address, AES-256-CBC encrypted and
// hex-encoded; nothing is stored in plaintext. The decode below is the same one
// generate_users_list.js and deploy/fetch-user-emails.js perform, including the quirk that
// the key handed to createDecipheriv is the HEX STRING of those 16 bytes. Only directory
// NAMES and the access-control file cross the wire -- no user file is read or copied.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const readline = require('readline');

const SERVER = process.env.SERVER || 'ubuntu@52.87.30.101';
const SSH_KEY = process.env.SSH_KEY || path.join(os.homedir(), '.ssh', 'baja.pem');
const USERS_DIR = process.env.USERS_DIR || '/home/ubuntu/baja-users';
const ACCESS_FILE = USERS_DIR + '/access-control.json';

const SECRET_HEX = 'A4BA8B43795566F988FF8FCBC3016E70';
const KEY = Buffer.from(SECRET_HEX, 'hex').toString('hex');
const IV = crypto.createHash('md5').update('powers').digest();

function decodeEmail(encoded) {
    try {
        if (!encoded || typeof encoded !== 'string') return null;
        if (encoded.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(encoded)) return null;
        const d = crypto.createDecipheriv('aes-256-cbc', KEY, IV);
        let out = d.update(encoded, 'hex', 'utf-8');
        out += d.final('utf-8');
        return out;
    } catch (e) {
        return null;
    }
}

// A decode can "succeed" on the wrong input and hand back mojibake, so the shape is checked
// before the result is believed.
function looksLikeEmail(s) {
    return typeof s === 'string'
        && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
        && s.length < 254;
}

function ssh(cmd, input) {
    return execFileSync('ssh', [
        '-i', SSH_KEY,
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'BatchMode=yes',
        SERVER, cmd,
    ], { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, input: input });
}

function knownUsers() {
    let entries;
    try {
        entries = ssh('ls -1 ' + JSON.stringify(USERS_DIR)).split('\n').map((l) => l.trim()).filter(Boolean);
    } catch (e) {
        die('Could not list ' + SERVER + ':' + USERS_DIR + ': ' + e.message
            + '\nCheck that ' + SSH_KEY + ' exists and reaches ' + SERVER + '.');
    }
    const seen = new Set(), out = [];
    for (const name of entries) {
        const email = decodeEmail(name);
        if (!email || !looksLikeEmail(email)) continue;
        const k = email.trim().toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(k);
    }
    return out.sort();
}

function readAccess() {
    // `cat || echo {}` so a server that has never had the file is not an error.
    let txt;
    try {
        txt = ssh('cat ' + JSON.stringify(ACCESS_FILE) + ' 2>/dev/null || echo "{}"');
    } catch (e) {
        die('Could not read ' + ACCESS_FILE + ': ' + e.message);
    }
    let j;
    try { j = JSON.parse(txt || '{}'); } catch (e) {
        die('The access-control file on the server is not valid JSON. Fix or remove it:\n  '
            + ACCESS_FILE + '\n' + e.message);
    }
    j.blocked = j.blocked || {};
    j.signedOut = j.signedOut || {};
    return j;
}

function writeAccess(obj) {
    const body = JSON.stringify(obj, null, 2) + '\n';
    // Written to a temp file and moved into place, so the API -- which re-reads this on its
    // own -- can never catch it half-written and parse a truncated file as "nobody blocked".
    const tmp = ACCESS_FILE + '.tmp';
    ssh('cat > ' + JSON.stringify(tmp) + ' && mv ' + JSON.stringify(tmp) + ' '
        + JSON.stringify(ACCESS_FILE), body);
}

function die(msg) { console.error(msg); process.exit(1); }

function normalise(email) {
    const e = ('' + (email || '')).trim().toLowerCase();
    if (!looksLikeEmail(e)) die('Not an email address: ' + JSON.stringify(email || ''));
    return e;
}

// A typo in an address silently blocks nobody, which is worse than an error, so an address
// that is not a known user has to be confirmed.
function warnUnknown(email, users, yes) {
    if (users.indexOf(email) >= 0) return Promise.resolve(true);
    console.error('  ' + email + ' is not among the ' + users.length + ' known users.');
    console.error('  A misspelled address blocks nobody and looks like it worked.');
    if (yes) { console.error('  --yes given, continuing.'); return Promise.resolve(true); }
    return confirm('  Continue anyway?');
}

function confirm(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        rl.question(question + ' [y/N] ', (a) => {
            rl.close();
            resolve(/^y(es)?$/i.test((a || '').trim()));
        });
    });
}

async function main() {
    const argv = process.argv.slice(2);
    const asJson = argv.includes('--json');
    const yes = argv.includes('--yes');
    const args = argv.filter((a) => a !== '--json' && a !== '--yes');
    const cmd = (args[0] || 'list').toLowerCase();
    const now = new Date().toISOString();

    if (cmd === 'list') {
        const users = knownUsers();
        const acc = readAccess();
        const rows = users.map((e) => ({
            email: e,
            blocked: !!acc.blocked[e],
            blockedReason: acc.blocked[e] ? (acc.blocked[e].reason || '') : '',
            blockedAt: acc.blocked[e] ? (acc.blocked[e].at || '') : '',
            signedOut: !!acc.signedOut[e],
            signedOutAt: acc.signedOut[e] ? (acc.signedOut[e].at || '') : '',
        }));
        // Anyone blocked who is not a known user still has to be visible, or an entry made
        // by hand -- or a typo -- becomes invisible the moment it stops matching a directory.
        for (const e of Object.keys(acc.blocked)) {
            if (!rows.some((r) => r.email === e)) {
                rows.push({ email: e, blocked: true, blockedReason: acc.blocked[e].reason || '',
                    blockedAt: acc.blocked[e].at || '', signedOut: !!acc.signedOut[e],
                    signedOutAt: '', unknown: true });
            }
        }
        if (asJson) { console.log(JSON.stringify(rows, null, 2)); return; }
        const nb = rows.filter((r) => r.blocked).length;
        const ns = rows.filter((r) => r.signedOut).length;
        console.log(rows.length + ' users   ' + nb + ' blocked   ' + ns + ' forced sign-out\n');
        for (const r of rows) {
            const marks = (r.blocked ? 'BLOCKED ' : '') + (r.signedOut ? 'SIGNED-OUT ' : '')
                + (r.unknown ? '(not a known user) ' : '');
            console.log('  %s%s%s', r.email.padEnd(40), marks,
                r.blockedReason ? ('- ' + r.blockedReason) : '');
        }
        return;
    }

    if (cmd === 'status') {
        const email = normalise(args[1]);
        const acc = readAccess();
        const users = knownUsers();
        const out = {
            email,
            known: users.indexOf(email) >= 0,
            blocked: acc.blocked[email] || null,
            signedOut: acc.signedOut[email] || null,
        };
        if (asJson) { console.log(JSON.stringify(out, null, 2)); return; }
        console.log('  ' + email);
        console.log('    known user : ' + (out.known ? 'yes' : 'NO'));
        console.log('    blocked    : ' + (out.blocked
            ? ('yes, ' + (out.blocked.at || '?') + (out.blocked.reason ? ' -- ' + out.blocked.reason : ''))
            : 'no'));
        console.log('    signed out : ' + (out.signedOut
            ? ('yes, ' + (out.signedOut.at || '?') + ' (cleared when they sign in again)')
            : 'no'));
        return;
    }

    if (cmd === 'block') {
        const email = normalise(args[1]);
        const reason = args.slice(2).join(' ');
        const users = knownUsers();
        if (!(await warnUnknown(email, users, yes))) die('Cancelled.');
        const acc = readAccess();
        acc.blocked[email] = { at: now, reason: reason || '', by: os.userInfo().username };
        writeAccess(acc);
        console.log('  blocked ' + email + (reason ? ' -- ' + reason : ''));
        console.log('  Their next request is refused with 403. Signing in again will NOT lift it.');
        return;
    }

    if (cmd === 'unblock') {
        const email = normalise(args[1]);
        const acc = readAccess();
        if (!acc.blocked[email]) { console.log('  ' + email + ' was not blocked.'); return; }
        delete acc.blocked[email];
        writeAccess(acc);
        console.log('  unblocked ' + email);
        return;
    }

    if (cmd === 'logout') {
        const email = normalise(args[1]);
        const users = knownUsers();
        if (!(await warnUnknown(email, users, yes))) die('Cancelled.');
        const acc = readAccess();
        acc.signedOut[email] = { at: now, by: os.userInfo().username };
        writeAccess(acc);
        console.log('  signed out ' + email);
        console.log('  Their next request is refused with 401 until they authenticate again.');
        return;
    }

    if (cmd === 'clear-logout') {
        const email = normalise(args[1]);
        const acc = readAccess();
        if (!acc.signedOut[email]) { console.log('  ' + email + ' was not signed out.'); return; }
        delete acc.signedOut[email];
        writeAccess(acc);
        console.log('  cleared the forced sign-out for ' + email);
        return;
    }

    if (cmd === 'logout-all') {
        const users = knownUsers();
        if (!yes && !(await confirm('  Sign out all ' + users.length + ' users?'))) die('Cancelled.');
        const acc = readAccess();
        for (const e of users) acc.signedOut[e] = { at: now, by: os.userInfo().username };
        writeAccess(acc);
        console.log('  signed out ' + users.length + ' users. Each is refused until they sign in again.');
        return;
    }

    // No command, or one that does not exist: print the header comment rather than a
    // one-line usage, because the block/logout distinction is the part worth reading.
    const src = require('fs').readFileSync(__filename, 'utf-8').split('\n');
    console.log(src.slice(1, 34).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(cmd === 'help' || cmd === '--help' ? 0 : 1);
}

main().catch((e) => die(e && e.stack || String(e)));
