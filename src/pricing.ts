import fs from 'fs';
import path from 'path';

interface PricingFeatures {
    topics?: string[]; // optional: may be missing
}

interface PriceEntry {
    app: string;
    position?: string;
    price: number;
    currency: string;
    billingPeriod?: string; // "monthly", "yearly", etc.
    features?: PricingFeatures; // ⭐ NEW optional field
}

interface PricingFile {
    plans: PriceEntry[];
}

// Simple in-memory cache so we don't read the file every request
let _pricingCache: { loadedAt: number; data: PriceEntry[] } | null = null;
const PRICING_CACHE_TTL_MS = 60_000; // 1 minute

function loadPricing(configPath: string): PriceEntry[] {
    const now = Date.now();

    if (_pricingCache && now - _pricingCache.loadedAt < PRICING_CACHE_TTL_MS) {
        return _pricingCache.data;
    }

    const pricingPath = path.join(configPath, 'subscriptions', 'pricing.json');

    if (!fs.existsSync(pricingPath)) {
        console.warn('Pricing file not found at', pricingPath);
        _pricingCache = { loadedAt: now, data: [] };
        return [];
    }

    try {
        const raw = fs.readFileSync(pricingPath, 'utf-8');
        const parsed: PricingFile = JSON.parse(raw);

        // ⭐ Ensure plans array is valid
        const plans = Array.isArray(parsed.plans) ? parsed.plans : [];

        // ⭐ Do NOT require features — optional by design
        _pricingCache = { loadedAt: now, data: plans };

        return plans;
    } catch (err) {
        console.error('Error loading pricing file:', err);
        _pricingCache = { loadedAt: now, data: [] };
        return [];
    }
}

/**
 * Find price for a given app + optional position.
 * Priority:
 *   1) exact match { app, position }
 *   2) fallback match { app } with no position
 *
 * ⭐ Features automatically passed through in returned object
 */
export function findPriceFor(
    appName: string | undefined,
    position: string | undefined,
    configPath: string
): PriceEntry | null {
    if (!appName) return null;

    const plans = loadPricing(configPath);
    if (!plans.length) return null;

    // 1) Exact app + position match
    if (position) {
        const exact = plans.find(p => p.app === appName && p.position === position);
        if (exact) return exact;
    }

    // 2) Fallback: app-only
    const fallback = plans.find(
        p =>
            p.app === appName &&
            (p.position === undefined || p.position === null || p.position === 'all')
    );

    return fallback || null;
}
