"use client";

import { FormEvent, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Giriş başarısız oldu.");
      }

      router.push("/");
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Giriş başarısız oldu.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <div className="login-shell">
        <div className="login-panel">
          <div className="brand-block">
            <div className="brand-badge"><Image src="https://www.crabsmedia.com/wp-content/uploads/2025/02/logo.png" alt="Crabs Media" width={42} height={42} /></div>
            <div>
              <p className="brand-kicker">Crabs Media</p>
              <h1>domain.bot</h1>
            </div>
          </div>

          <div className="login-copy">
            <p className="eyebrow">YÖNETİM PANELİ</p>
            <h2>Giriş yap</h2>
            <p>Yetkili kullanıcılar için güvenli erişim paneli.</p>
          </div>

          <form className="login-form" onSubmit={handleSubmit}>
            <label>
              <span>E-posta</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </label>

            <label>
              <span>Şifre</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>

            {error ? <div className="login-error">{error}</div> : null}

            <button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Giriş yapılıyor..." : "Giriş yap"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
