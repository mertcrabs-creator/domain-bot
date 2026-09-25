import { NextResponse } from "next/server";

import { getUserByEmail, setSession, verifyPassword } from "@/lib/auth";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { email?: string; password?: string };
    const email = body.email?.trim().toLowerCase();
    const password = body.password ?? "";

    if (!email || !password) {
      return NextResponse.json({ error: "E-posta ve şifre gerekli." }, { status: 400 });
    }

    const user = await getUserByEmail(email);

    if (!user || !user.isActive) {
      return NextResponse.json({ error: "Geçersiz kullanıcı veya pasif hesap." }, { status: 401 });
    }

    const isValidPassword = await verifyPassword(password, user.passwordHash);
    if (!isValidPassword) {
      return NextResponse.json({ error: "Şifre yanlış." }, { status: 401 });
    }

    await setSession({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      fullAccess: user.fullAccess,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json({ error: "Giriş sırasında hata oluştu." }, { status: 500 });
  }
}
