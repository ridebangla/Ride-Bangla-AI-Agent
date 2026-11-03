"use client";

/**
 * Dashboard > Security — authenticator-app 2FA self-service.
 *
 * TEAM 2FA (2026-11-03). This component is the account holder's own
 * setup surface, reached only inside an authenticated session:
 *  1. "Start setup" -> server stores an ENCRYPTED pending secret and
 *     returns a QR code + manual secret, shown here once.
 *  2. The holder scans the QR in their authenticator app, then enters
 *     the app's current code and submits.
 *  3. ONLY after that code verifies does the server mark 2FA active and
 *     return single-use backup codes, shown here once.
 * Nothing here can activate 2FA without the code, and nothing here can
 * touch another account: every call is authenticated as the caller and
 * the server only ever writes the caller's own record.
 *
 * If the holder loses both the authenticator device AND the backup
 * codes, this screen offers no bypass — that path is deliberately
 * unbuilt (see the coordinator report); do not add one here.
 */
import { useCallback, useEffect, useState } from "react";

const inputClass =
  "w-full rounded-lg border border-rbai-border bg-rbai-bg px-3.5 py-2.5 text-sm text-rbai-text placeholder:text-rbai-text-light focus:outline-none focus:ring-2 focus:ring-rbai-primary focus:border-transparent transition-shadow";
const buttonClass =
  "rounded-lg bg-rbai-primary text-white font-medium py-2.5 px-4 text-sm hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors";

async function postJson(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export function TwoFactorSetup() {
  const [status, setStatus] = useState<{ enabled: boolean; pending: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [manualSecret, setManualSecret] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [manageCode, setManageCode] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/two-factor/setup");
      const data = await res.json();
      if (res.ok) setStatus({ enabled: !!data.enabled, pending: !!data.pending });
    } catch {
      /* status stays unknown; actions surface their own errors */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function startSetup() {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const { ok, data } = await postJson("/api/auth/two-factor/setup", {});
      if (!ok) {
        setError(data.error || "Could not start setup. Please try again.");
        return;
      }
      setQrDataUrl(data.qrDataUrl || "");
      setManualSecret(data.manualSecret || "");
      setBackupCodes(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const { ok, data } = await postJson("/api/auth/two-factor/activate", {
        code: setupCode,
      });
      if (!ok) {
        setError(data.error || "Activation failed. Please try again.");
        return;
      }
      setBackupCodes(data.backupCodes || []);
      setQrDataUrl("");
      setManualSecret("");
      setSetupCode("");
      setNotice(
        "Two-factor authentication is now ON. Save the backup codes below — each works once, and they will not be shown again."
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const { ok, data } = await postJson("/api/auth/two-factor/disable", {
        code: manageCode,
      });
      if (!ok) {
        setError(data.error || "Could not disable. Please try again.");
        return;
      }
      setManageCode("");
      setBackupCodes(null);
      setNotice("Two-factor authentication is now OFF for this account.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const { ok, data } = await postJson("/api/auth/two-factor/backup-codes", {
        code: manageCode,
      });
      if (!ok) {
        setError(data.error || "Could not regenerate backup codes. Please try again.");
        return;
      }
      setManageCode("");
      setBackupCodes(data.backupCodes || []);
      setNotice(
        "New backup codes issued. Your previous backup codes no longer work. Save these now — they will not be shown again."
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-rbai-text-light">Loading security settings…</p>;
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="bg-rbai-surface rounded-2xl shadow-lg border border-rbai-border p-6">
        <h2 className="text-lg font-bold text-rbai-text">Two-factor authentication</h2>
        <p className="text-sm text-rbai-text-light mt-1">
          Protect this account with your authenticator app (Google Authenticator,
          Microsoft Authenticator, or any TOTP app). After you sign in with your
          email and password, you will also enter a 6-digit code from the app.
        </p>
        <p className="text-sm text-rbai-text-light mt-2">
          Status:{" "}
          <strong className="text-rbai-text">
            {status?.enabled ? "ON" : "OFF"}
          </strong>
        </p>
        <p className="text-sm font-medium text-rbai-text mt-3">
          Important: two-factor authentication turns on ONLY after you enter a
          current code from your authenticator app and it verifies. Starting
          setup alone does not turn it on.
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-3.5 py-2.5 text-sm text-green-800">
          {notice}
        </div>
      )}

      {!status?.enabled && (
        <div className="bg-rbai-surface rounded-2xl shadow-lg border border-rbai-border p-6 space-y-4">
          {!qrDataUrl ? (
            <>
              <p className="text-sm text-rbai-text">
                Step 1 — open your authenticator app, then tap below to get your
                QR code.
              </p>
              <button type="button" onClick={startSetup} disabled={busy} className={buttonClass}>
                {busy ? "Starting…" : "Start setup"}
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-rbai-text">
                Step 2 — scan this QR code with your authenticator app. If you
                cannot scan, enter this secret manually in the app:
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrDataUrl} alt="Authenticator setup QR code" className="w-48 h-48 bg-white rounded-lg" />
              <p className="text-sm text-rbai-text">
                Manual secret: <code className="break-all">{manualSecret}</code>
              </p>
              <p className="text-sm text-rbai-text">
                Step 3 — enter the current 6-digit code from your app, then tap
                Activate. Two-factor authentication turns on ONLY at this step.
              </p>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={setupCode}
                onChange={(e) => setSetupCode(e.target.value)}
                placeholder="6-digit code from your app"
                className={inputClass}
              />
              <div className="flex gap-2">
                <button type="button" onClick={activate} disabled={busy || !setupCode} className={buttonClass}>
                  {busy ? "Verifying…" : "Activate two-factor authentication"}
                </button>
                <button type="button" onClick={startSetup} disabled={busy} className="rounded-lg border border-rbai-border text-rbai-text font-medium py-2.5 px-4 text-sm disabled:opacity-60">
                  Restart setup
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {status?.enabled && (
        <div className="bg-rbai-surface rounded-2xl shadow-lg border border-rbai-border p-6 space-y-4">
          <p className="text-sm text-rbai-text">
            Two-factor authentication is ON for this account. To turn it off or
            get new backup codes, enter a current code from your app (or a
            backup code) first.
          </p>
          <input
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            value={manageCode}
            onChange={(e) => setManageCode(e.target.value)}
            placeholder="Current code or backup code"
            className={inputClass}
          />
          <div className="flex gap-2 flex-wrap">
            <button type="button" onClick={regenerate} disabled={busy || !manageCode} className={buttonClass}>
              {busy ? "Working…" : "Get new backup codes"}
            </button>
            <button type="button" onClick={disable} disabled={busy || !manageCode} className="rounded-lg border border-red-200 text-red-700 font-medium py-2.5 px-4 text-sm disabled:opacity-60">
              Turn off two-factor authentication
            </button>
          </div>
        </div>
      )}

      {backupCodes && backupCodes.length > 0 && (
        <div className="bg-rbai-surface rounded-2xl shadow-lg border border-rbai-border p-6">
          <h3 className="text-base font-bold text-rbai-text">Backup codes — save these now</h3>
          <p className="text-sm text-rbai-text-light mt-1">
            Each code works once, only at sign-in, if you lose access to your
            authenticator app. They will not be shown again after you leave
            this screen.
          </p>
          <ul className="mt-3 grid grid-cols-2 gap-2">
            {backupCodes.map((code) => (
              <li key={code} className="rounded-lg border border-rbai-border bg-rbai-bg px-3 py-2 text-sm font-mono text-rbai-text text-center">
                {code}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="bg-rbai-surface rounded-2xl shadow-lg border border-rbai-border p-6">
        <h3 className="text-base font-bold text-rbai-text">If you lose your authenticator device</h3>
        <p className="text-sm text-rbai-text-light mt-1">
          Use one of your saved backup codes at sign-in. If you also lost your
          backup codes, there is no self-service way back in — contact the
          platform team; a recovery path for that case has not been built and
          must be decided by the owner first.
        </p>
      </div>
    </div>
  );
}
