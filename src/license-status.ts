import fs from 'fs';
import path from 'path';

interface SubscriptionLicense {
    app: string;
    positions?: string[];
}

interface SubscriptionFile {
    email: string;
    username: string;
    domain: string;
    subscriptionId: string;
    createdAt?: string;
    expiresAt?: string;
    licenses?: SubscriptionLicense[];
}

export type CoreStatus = 'inactive' | 'active' | 'ptx_active';

export type LicenseStatus =
    | 'granted'
    | 'denied_no_license_for_app'
    | 'denied_position_not_allowed'
    | 'denied_subscription_expired'
    | 'no_subscription';

export interface LicenseCheckResult {
    email: string;
    coreStatus: CoreStatus;
    licenseStatus: LicenseStatus;
    subscriptionId?: string;
    app?: string;
    position?: string;
    reason?: string;
    licenses?: SubscriptionLicense[];
}

function splitEmail(email: string): { username: string; domain: string } {
    const parts = String(email).split('@');
    if (parts.length !== 2) {
        throw new Error(`Invalid email: ${email}`);
    }
    return { username: parts[0], domain: parts[1] };
}

function sanitizeForDir(name: string): string {
    // Only keep letters, digits, dot, dash, underscore
    return String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Helper: create a default/local subscription file for a user.
 * This is a stub that represents "no subscription yet" but
 * ensures a file exists on disk.
 */
function createDefaultSubscriptionForUser(
    email: string,
    configPath: string
): { filePath: string; data: SubscriptionFile } {
    const { username, domain } = splitEmail(email);
    const sanitizedDomain = sanitizeForDir(domain);

    const subscriptionsRoot = path.join(configPath, 'subscriptions');
    const domainDir = path.join(subscriptionsRoot, sanitizedDomain);

    if (!fs.existsSync(domainDir)) {
        fs.mkdirSync(domainDir, { recursive: true });
    }

    const filePath = path.join(domainDir, `${username}.json`);

    const nowIso = new Date().toISOString();

    const data: SubscriptionFile = {
        email,
        username,
        domain,
        // Empty subscriptionId means: stub/default, no real subscription.
        subscriptionId: '',
        createdAt: nowIso,
        // No expiresAt, no licenses by default.
        licenses: []
    };

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

    return { filePath, data };
}

/**
 * NEW SCHEME:
 *   subscriptions/<sanitizedDomain>/<username>.json
 * Example:
 *   email = "alice@example.com"
 *   => subscriptions/example.com/alice.json
 *
 * If the subscription file does not exist, we create a default stub.
 */
export function loadSubscriptionForUser(
    email: string,
    configPath: string
): { filePath: string; data: SubscriptionFile } | null {
    const { username, domain } = splitEmail(email);
    const sanitizedDomain = sanitizeForDir(domain);

    const subscriptionsRoot = path.join(configPath, 'subscriptions');
    const domainDir = path.join(subscriptionsRoot, sanitizedDomain);
    const filePath = path.join(domainDir, `${username}.json`);

    if (!fs.existsSync(filePath)) {
        // Auto-create a default subscription file for this user.
        return createDefaultSubscriptionForUser(email, configPath);
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const data: SubscriptionFile = JSON.parse(raw);
    return { filePath, data };
}

export function determineCoreStatus(subscriptionId?: string): CoreStatus {
    if (!subscriptionId) return 'inactive';
    if (subscriptionId.startsWith('d')) return 'ptx_active';
    return 'active';
}

export function determineLicenseStatus(
    email: string,
    app: string | undefined,
    position: string | undefined,
    configPath: string
): LicenseCheckResult {
    const sub = loadSubscriptionForUser(email, configPath);

    // Defensive check; in practice loadSubscriptionForUser now always returns a value.
    if (!sub) {
        return {
            email,
            coreStatus: 'inactive',
            licenseStatus: 'no_subscription',
            reason: 'No subscription file found for this user.'
        };
    }

    const { data } = sub;
    const subscriptionId = data.subscriptionId;
    const coreStatus = determineCoreStatus(subscriptionId);
    const now = new Date();

    // If this is the auto-created default subscription (no real subscriptionId),
    // treat it as "no_subscription" while still having a file on disk.
    if (!subscriptionId) {
        return {
            email,
            app,
            position,
            coreStatus,
            licenseStatus: 'no_subscription',
            reason: 'Default subscription stub created; no active subscription exists.',
            licenses: data.licenses ?? []
        };
    }

    // Expiration check
    if (data.expiresAt) {
        const exp = new Date(data.expiresAt);
        if (exp.getTime() < now.getTime()) {
            return {
                email,
                app,
                position,
                subscriptionId,
                coreStatus,
                licenseStatus: 'denied_subscription_expired',
                reason: 'Subscription is expired.',
                licenses: data.licenses ?? []
            };
        }
    }

    // If no specific app requested, just return core status
    if (!app) {
        return {
            email,
            app,
            coreStatus,
            subscriptionId,
            licenseStatus: 'granted',
            reason: 'Subscription is valid; no specific app/position requested.',
            licenses: data.licenses ?? []
        };
    }

    const licenses = data.licenses ?? [];

    // 👇 CASE-INSENSITIVE APP MATCH
    const appLower = app.toLowerCase();
    const appLicense = licenses.find(
        (l) => (l.app || '').toLowerCase() === appLower
    );

    if (!appLicense) {
        return {
            email,
            app,
            position,
            subscriptionId,
            coreStatus,
            licenseStatus: 'denied_no_license_for_app',
            reason: `User does not have a license for app "${app}".`,
            licenses
        };
    }

    // No position restriction
    if (!position || !appLicense.positions || appLicense.positions.length === 0) {
        return {
            email,
            app,
            position,
            subscriptionId,
            coreStatus,
            licenseStatus: 'granted',
            reason: 'User has a license for this app (no position restriction).',
            licenses
        };
    }

    const positionLower = position.toLowerCase();
    const allowed = appLicense.positions.some(
        (p) => p.toLowerCase() === positionLower
    );

    if (!allowed) {
        return {
            email,
            app,
            position,
            subscriptionId,
            coreStatus,
            licenseStatus: 'denied_position_not_allowed',
            reason: `User has a license for app "${app}" but not for position "${position}".`,
            licenses
        };
    }

    return {
        email,
        app,
        position,
        subscriptionId,
        coreStatus,
        licenseStatus: 'granted',
        reason: 'User is licensed for this app and position.',
        licenses
    };
}
