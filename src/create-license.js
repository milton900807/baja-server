#!/usr/bin/env node
'use strict';

/**
 * Standalone script to create a license file for a user.
 *
 * New scheme:
 *   - Directory:  <configPath>/subscriptions/<sanitizedDomain>/
 *   - File name:  <username>.json  (username = part before '@')
 *
 * Example usage:
 *
 *   node create-license.js \
 *     --configPath /opt/app/config \
 *     --email alice@example.com \
 *     --subscriptionId d123 \
 *     --app ptx_designer \
 *     --positions designer,viewer \
 *     --expires 2026-01-01
 */

const fs = require('fs');
const path = require('path');

// ------------------------- CLI ARG PARSING -------------------------

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;

        const key = arg.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            args[key] = true;
        } else {
            args[key] = next;
            i++;
        }
    }
    return args;
}

const args = parseArgs(process.argv);

if (!args.email) {
    console.error('ERROR: --email is required');
    process.exit(1);
}
if (!args.configPath) {
    console.error('ERROR: --configPath is required (e.g. /opt/app/config)');
    process.exit(1);
}
if (!args.subscriptionId) {
    console.error('ERROR: --subscriptionId is required (e.g. d123)');
    process.exit(1);
}
if (!args.app) {
    console.error('ERROR: --app is required (e.g. ptx_designer)');
    process.exit(1);
}

// Optional: positions comma-separated
const positions = args.positions
    ? args.positions.split(',').map(p => p.trim()).filter(Boolean)
    : [];

// Optional: expires date (ISO or YYYY-MM-DD); if omitted, no expiresAt field
let expiresAt = undefined;
if (args.expires) {
    const d = new Date(args.expires);
    if (isNaN(d.getTime())) {
        console.error('ERROR: --expires is not a valid date:', args.expires);
        process.exit(1);
    }
    expiresAt = d.toISOString();
}

// ------------------------- HELPERS -------------------------

function splitEmail(email) {
    const parts = String(email).split('@');
    if (parts.length !== 2) {
        throw new Error('Invalid email: ' + email);
    }
    return { username: parts[0], domain: parts[1] };
}

function sanitizeForDir(name) {
    // Keep letters, digits, dot, dash, underscore
    // Replace other characters with "_"
    return String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function ensureDirSync(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// ------------------------- MAIN LOGIC -------------------------

const email = args.email;
const configPath = args.configPath;
const subscriptionId = args.subscriptionId;
const appName = args.app;

let username, domain;
try {
    const parts = splitEmail(email);
    username = parts.username;
    domain = parts.domain;
} catch (e) {
    console.error('ERROR:', e.message);
    process.exit(1);
}

const sanitizedDomain = sanitizeForDir(domain);

// Directory: <configPath>/subscriptions/<sanitizedDomain>/
const subscriptionsRoot = path.join(configPath, 'subscriptions');
const domainDir = path.join(subscriptionsRoot, sanitizedDomain);

// File: <username>.json
const licenseFilePath = path.join(domainDir, `${username}.json`);

ensureDirSync(domainDir);

const nowIso = new Date().toISOString();

const licenseObject = {
    email: email,
    username: username,
    domain: domain,
    subscriptionId: subscriptionId,
    createdAt: nowIso,
    // Only include expiresAt if supplied
    ...(expiresAt ? { expiresAt } : {}),
    licenses: [
        {
            app: appName,
            // Only include positions array if we actually got some
            ...(positions.length > 0 ? { positions } : {})
        }
    ]
};

fs.writeFileSync(licenseFilePath, JSON.stringify(licenseObject, null, 2), 'utf-8');

console.log('License file written successfully:');
console.log('  Email:          ', email);
console.log('  Subscription ID:', subscriptionId);
console.log('  App:            ', appName);
console.log('  Positions:      ', positions.length ? positions.join(', ') : '(none)');
console.log('  Config path:    ', configPath);
console.log('  Domain dir:     ', domainDir);
console.log('  File:           ', licenseFilePath);
