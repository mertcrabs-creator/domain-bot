import { cookies } from "next/headers";
import { compare, hash } from "bcryptjs";

import { prisma } from "@/lib/db";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  fullAccess: boolean;
};

const SESSION_COOKIE = "domain_bot_session";

export async function hashPassword(password: string) {
  return hash(password, 10);
}

export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const sessionValue = cookieStore.get(SESSION_COOKIE)?.value;

  if (!sessionValue) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(sessionValue, "base64url").toString("utf8")) as {
      id: string;
      email: string;
      name: string;
      role: string;
      fullAccess: boolean;
    };

    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        fullAccess: true,
        isActive: true,
      },
    });

    if (!user || !user.isActive) {
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      fullAccess: user.fullAccess,
    };
  } catch {
    return null;
  }
}

export async function setSession(user: SessionUser) {
  const cookieStore = await cookies();
  const sessionPayload = Buffer.from(
    JSON.stringify({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      fullAccess: user.fullAccess,
    }),
    "utf8",
  ).toString("base64url");

  cookieStore.set(SESSION_COOKIE, sessionPayload, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function clearSession() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export async function verifyPassword(password: string, passwordHash: string) {
  return compare(password, passwordHash);
}

export async function getUserByEmail(email: string) {
  return prisma.user.findUnique({
    where: { email },
  });
}
