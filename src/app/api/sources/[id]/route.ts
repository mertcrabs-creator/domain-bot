import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.fullAccess) return NextResponse.json({ error: "Yetkisiz erişim." }, { status: 401 });

  const { id } = await context.params;
  const assigned = await prisma.domainAssignment.count({ where: { domain: { sourceSiteId: id } } });
  if (assigned > 0) return NextResponse.json({ error: "Bu kaynaktan müşteriye atanmış domainler var, silinemez." }, { status: 409 });

  // deleteMany is a no-op when the source is already gone (double click, two tabs), instead of throwing P2025.
  await prisma.sourceSite.deleteMany({ where: { id } });
  return new NextResponse(null, { status: 204 });
}
