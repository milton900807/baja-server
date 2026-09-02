#!/usr/bin/env node
//
// Download the list of user email addresses from the production server.
//
//   node deploy/fetch-user-emails.js                 # print them, one per line
//   node deploy/fetch-user-emails.js --out users.txt # and write them to a file
//   node deploy/fetch-user-emails.js --json          # print [{email, dir, ...}]
//   node deploy/fetch-user-emails.js --local DIR     # decode a directory on this machine
//
// A user's directory under baja-users IS their email address, AES-256-CBC encrypted and
// hex-encoded. Nothing is stored in plaintext, so the list has to be decoded rather than read.
// The key and IV below are the ones baja-users/generate_users_list.js already uses; this
// script does the same decode against the DIRECTORY NAMES, which is where the addresses are,
// and pulls the listing from production over the same ssh key deploy.sh uses.
//
// Only the listing crosses the wire -- no user file is read, copied, or opened.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- connection (same host and key as deploy.sh) ---------------------------------------
const SERVER = process.env.SERVER || 'ubuntu@52.87.30.101';
const SSH_KEY = process.env.SSH_KEY || path.join(os.homedir(), '.ssh', 'baja.pem');
const USERS_DIR = process.env.USERS_DIR || '/home/ubuntu/baja-users';

// ---- the decode, exactly as generate_users_list.js performs it --------------------------
//
// Note the quirk, kept deliberately: the key handed to createDecipheriv is the HEX STRING of
// those 16 bytes -- 32 characters, which node then reads as 32 bytes for aes-256. Writing it
// the "correct" way (the 16 raw bytes) yields a different key and decodes nothing. This has
// to match what wrote the names, not what looks right.
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
        return null;   // not an encoded name (a plain file, a stale entry) -- skip it
    }
}

// A decode can "succeed" on the wrong input and hand back mojibake, so check the shape before
// believing it. Better to under-report and say so than to print noise as an address.
function looksLikeEmail(s) {
    return typeof s === 'string'
        && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
        && s.length < 254;
}

function listRemote() {
    // -1 for one entry per line; the listing only, nothing inside any of them.
    const out = execFileSync('ssh', [
        '-i', SSH_KEY,
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'BatchMode=yes',
        SERVER,
        'ls -1 ' + JSON.stringify(USERS_DIR)
    ], { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

function listLocal(dir) {
    return fs.readdirSync(dir);
}

function main() {
    const argv = process.argv.slice(2);
    const asJson = argv.includes('--json');
    const outIdx = argv.indexOf('--out');
    const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
    const localIdx = argv.indexOf('--local');
    const localDir = localIdx >= 0 ? argv[localIdx + 1] : null;

    let entries;
    try {
        entries = localDir ? listLocal(localDir) : listRemote();
    } catch (e) {
        console.error('Could not list ' + (localDir || (SERVER + ':' + USERS_DIR)) + ': ' + e.message);
        console.error('For production, check that ' + SSH_KEY + ' exists and reaches ' + SERVER + '.');
        process.exit(1);
    }

    const rows = [];
    const skipped = [];
    for (const name of entries) {
        const email = decodeEmail(name);
        if (email && looksLikeEmail(email)) rows.push({ email: email.trim(), dir: name });
        else skipped.push(name);
    }

    // De-duplicate: the same address can hold more than one directory over a rename.
    const seen = new Set();
    const unique = rows.filter((r) => {
        const k = r.email.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    }).sort((a, b) => a.email.localeCompare(b.email));

    const text = unique.map((r) => r.email).join('\n');
    if (asJson) console.log(JSON.stringify(unique, null, 2));
    else if (text) console.log(text);

    if (outFile) {
        fs.writeFileSync(outFile, text + (text ? '\n' : ''), 'utf-8');
        console.error('Wrote ' + unique.length + ' address' + (unique.length === 1 ? '' : 'es') + ' to ' + outFile);
    }

    // Counts to stderr, so `> users.txt` stays a clean list of addresses.
    console.error(unique.length + ' address' + (unique.length === 1 ? '' : 'es') + ' from '
        + entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies') + '.');
    if (skipped.length) {
        // Named, not silently dropped: these are the entries that are not encoded addresses
        // (free-usage.json, share-aliases.json, internal/, public/ ...). If a real user is ever
        // in this list, it is a decode problem and should be visible.
        console.error('Skipped ' + skipped.length + ' non-address entr'
            + (skipped.length === 1 ? 'y' : 'ies') + ': ' + skipped.slice(0, 8).join(', ')
            + (skipped.length > 8 ? ', …' : ''));
    }
}

main();
