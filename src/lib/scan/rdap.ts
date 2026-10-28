import type { DomainAvailability } from "@/generated/prisma/client";

const rdapBaseUrl = "https://rdap.verisign.com/com/v1/domain/";
const requestTimeoutMs = 15_000;
const dayMs = 24 * 60 * 60 * 1000;
// Registered domains with less than this left until expiry are kept as candidates (product decision).
export const expiringWindowMs = 365 * dayMs;

export class RdapRateLimitError extends Error {}

export type DomainCheck = {
  availability: DomainAvailability;
  statuses: string[];
  registeredAt: Date | null;
  expiresAt: Date | null;
  registrar: string | null;
};

type RdapResponse = {
  status?: string[];
  events?: Array<{ eventAction: string; eventDate: string }>;
  entities?: Array<{ roles?: string[]; vcardArray?: [string, Array<[string, unknown, string, string]>] }>;
};

function eventDate(data: RdapResponse, action: string) {
  const value = data.events?.find((event) => event.eventAction === action)?.eventDate;
  return value ? new Date(value) : null;
}

function classify(statuses: string[], expiresAt: Date | null): DomainAvailability {
  if (statuses.includes("pending delete")) return "PENDING_DELETE";
  if (statuses.includes("redemption period") || statuses.includes("pending restore")) return "REDEMPTION";

  // After expiry the registry auto-renews and registrars usually put the name on hold
  // until they delete it, so these are the names most likely to drop soon.
  const onHold = statuses.includes("client hold") || statuses.includes("server hold");
  const inAutoRenew = statuses.includes("auto renew period");
  const expiresSoon = expiresAt !== null && expiresAt.getTime() - Date.now() < expiringWindowMs;
  if (onHold || inAutoRenew || expiresSoon) return "EXPIRING";

  return "REGISTERED";
}

export async function checkDomain(domain: string): Promise<DomainCheck> {
  const response = await fetch(`${rdapBaseUrl}${encodeURIComponent(domain)}`, {
    headers: { accept: "application/rdap+json" },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  if (response.status === 404) {
    return { availability: "AVAILABLE", statuses: [], registeredAt: null, expiresAt: null, registrar: null };
  }
  if (response.status === 429) throw new RdapRateLimitError("RDAP rate limit");
  if (!response.ok) throw new Error(`RDAP HTTP ${response.status}`);

  const data = (await response.json()) as RdapResponse;
  const statuses = (data.status ?? []).map((status) => status.toLowerCase());
  const expiresAt = eventDate(data, "expiration");
  const registrar = data.entities
    ?.find((entity) => entity.roles?.includes("registrar"))
    ?.vcardArray?.[1]?.find((entry) => entry[0] === "fn")?.[3] ?? null;

  return {
    availability: classify(statuses, expiresAt),
    statuses,
    registeredAt: eventDate(data, "registration"),
    expiresAt,
    registrar,
  };
}

const hour = 60 * 60 * 1000;
const recheckAfterMs: Record<DomainAvailability, number> = {
  UNCHECKED: 0,
  AVAILABLE: 24 * hour,
  PENDING_DELETE: 12 * hour,
  REDEMPTION: 3 * dayMs,
  EXPIRING: 3 * dayMs,
  REGISTERED: 30 * dayMs,
  UNKNOWN: 6 * hour,
};
// A domain can still be deleted or transferred early, so even far-off expiries are looked at again eventually.
const maxRegisteredRecheckMs = 180 * dayMs;

/**
 * When to look at a domain again. Registered domains are not re-checked until they enter the expiry window,
 * and expiring ones more often as their expiry gets close, which keeps registry lookups (and DB writes) low.
 */
export function nextCheckDate(availability: DomainAvailability, expiresAt: Date | null = null) {
  const now = Date.now();
  const left = expiresAt ? expiresAt.getTime() - now : null;
  if (availability === "REGISTERED" && left !== null) {
    return new Date(now + Math.min(maxRegisteredRecheckMs, Math.max(recheckAfterMs.REGISTERED, left - expiringWindowMs)));
  }
  if (availability === "EXPIRING" && left !== null) {
    if (left > 90 * dayMs) return new Date(now + 14 * dayMs);
    if (left > 30 * dayMs) return new Date(now + 7 * dayMs);
  }
  return new Date(now + recheckAfterMs[availability]);
}

export const candidateAvailabilities: DomainAvailability[] = ["AVAILABLE", "PENDING_DELETE", "REDEMPTION", "EXPIRING"];
