// Calls to clinuxflow-abdm-gateway (ABDM registries and UHI). Unlike api(), this throws on any
// failure with a message a person can act on, because every caller is a journey step that shows
// the message and asks again.
//
// Ported from clinux-cubo (src/lib/gateway.js) so the workspace's registry journeys call the
// gateway exactly the way Cübo's do. Only the transport differs: api() here is fhirApi.js's,
// built on this app's apiFetch() (X-Service-Key + the ClinuxFlow session as Bearer).
import { ABDM_GATEWAY_BASE } from '../config.js';
import { api } from './fhirApi.js';

export class GatewayError extends Error {
    constructor(message, { status, details = [] } = {}) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

/** ABDM's own messages from a gateway error body: { error, abdmStatus, abdmBody: { message, details: [{ message }] } }. */
export function abdmMessages(data) {
    const details = data?.abdmBody?.details;
    if (Array.isArray(details) && details.length) return details.map((d) => d?.message).filter(Boolean);
    return [data?.abdmBody?.message || data?.abdmBody?.error?.message].filter(Boolean);
}

export function gatewayErrorText(res) {
    const messages = abdmMessages(res.data);
    // ABDM's REQUEST-ID is what NHA support asks for, especially for a bare HIS-500.
    const ref = res.data?.abdmRequestId ? ` (ABDM REQUEST-ID ${res.data.abdmRequestId})` : '';
    if (messages.length) return messages.join(' ') + ref;
    if (res.status === 401) return 'Your session was not accepted by the ABDM gateway. Sign out and sign in again.';
    if (res.status === 429) return 'Too many attempts. Wait a few minutes and try again.';
    if (res.status === 503) return res.data?.error || 'The ABDM gateway is not configured for this.';
    return res.data?.error || `The ABDM gateway answered ${res.status}.`;
}

export async function gateway(path, { method = 'GET', body, headers = {} } = {}) {
    let res;
    try {
        res = await api(path, {
            method,
            body,
            base: ABDM_GATEWAY_BASE,
            headers,
        });
    } catch {
        throw new GatewayError('The ABDM gateway is not reachable right now.');
    }
    if (!res.ok || res.data?.success === false) throw new GatewayError(gatewayErrorText(res), { status: res.status, details: abdmMessages(res.data) });
    return res.data;
}

/**
 * ABDM master lists come in several shapes (a bare array, or under data/list/content) and name
 * their fields differently per endpoint. Normalised to [{ value, label, children }].
 */
export function toOptions(raw) {
    const list = Array.isArray(raw) ? raw : raw?.data ?? raw?.list ?? raw?.content ?? [];
    if (!Array.isArray(list)) return [];
    return list.map((e) => {
        if (typeof e === 'string' || typeof e === 'number') return { value: String(e).trim(), label: String(e).trim() };
        const value = e.code ?? e.id ?? e.value ?? e.key ?? e.stateCode ?? e.districtCode ?? '';
        const label = e.value ?? e.display ?? e.name ?? e.label ?? e.description ?? e.stateName ?? e.districtName ?? String(value);
        const children = e.subCategory ?? e.subCategories ?? e.children ?? e.subcategories;
        // HFR pads its codes and labels with trailing spaces ("G         "); sending one back
        // unpadded is what HFR expects, so trim here, once.
        return { value: String(value).trim(), label: String(label).trim(), ...(children ? { children: toOptions(children) } : {}) };
    });
}
