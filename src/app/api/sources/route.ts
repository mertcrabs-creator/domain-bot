import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET() {
  const session = await getSession();
  if (!session?.fullAccess) return NextResponse.json({ error: "Yetkisiz erişim." }, { status: 401 });

  const sources = await prisma.sourceSite.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { domains: true } } },
  });
  return NextResponse.json(sources);
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.fullAccess) return NextResponse.json({ error: "Yetkisiz erişim." }, { status: 401 });

  try {
    const body = (await request.json()) as { name?: string; url?: string };
    const name = body.name?.trim();
    const url = body.url?.trim();
    if (!name || !url) return NextResponse.json({ error: "Kaynak adı ve URL gerekli." }, { status: 400 });

    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return NextResponse.json({ error: "Yalnızca HTTP veya HTTPS URL kullanılabilir." }, { status: 400 });
    }

    const source = await prisma.sourceSite.create({ data: { name, url } });
    return NextResponse.json(source, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Kaynak eklenemedi.";
    return NextResponse.json({ error: message.includes("Unique constraint") ? "Bu URL zaten kayıtlı." : message }, { status: 400 });
  }
}
