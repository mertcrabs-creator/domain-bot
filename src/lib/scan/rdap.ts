import type { DomainAvailability } from "@/generated/prisma/client";

const rdapBaseUrl = "https://rdap.verisign.com/com/v1/domain/";
const requestTimeoutMs = 15_000;
const expiringWindowMs = 30 * 24 * 60 * 60 * 1000;

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
  REDEMPTION: 3 * 24 * hour,
  EXPIRING: 3 * 24 * hour,
  REGISTERED: 30 * 24 * hour,
  UNKNOWN: 6 * hour,
};

export function nextCheckDate(availability: DomainAvailability) {
  return new Date(Date.now() + recheckAfterMs[availability]);
}

export const candidateAvailabilities: DomainAvailability[] = ["AVAILABLE", "PENDING_DELETE", "REDEMPTION", "EXPIRING"];
