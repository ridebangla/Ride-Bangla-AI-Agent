"use client";

/**
 * Dashboard > Profile — the signed-in admin's profile, editable after
 * creation: profile photo (upload + 1:1 crop, face centered in the frame),
 * contact name, phone and address. The sign-in email is read-only here —
 * it is the Firebase identity and is managed in the Firebase console
 * (this app never touches credentials).
 *
 * Photo storage: no image-upload endpoint exists and Storage is
 * billing-gated, so the cropped photo is persisted as a data URL in the
 * business record — the same pattern the catalog uses for product images.
 * Payment-proof and support-attachment uploads are NOT cropped (evidence
 * must stay whole) and are untouched by this page.
 */

import { useEffect, useRef, useState } from "react";
import { Header } from "@/components/layout/header";
import { ImageCropper } from "@/components/ui/image-cropper";
import { Camera, Trash2, Save, Loader2, UserRound, CheckCircle, AlertCircle, ImagePlus } from "lucide-react";
import Link from "next/link";
import { isImageDataUrl } from "@/lib/data-url";
import { t } from "@/lib/i18n";

const inputClass =
  "w-full rounded-lg border border-rbai-border bg-rbai-bg px-3.5 py-2.5 text-sm text-rbai-text placeholder:text-rbai-text-light focus:outline-none focus:ring-2 focus:ring-rbai-primary focus:border-transparent transition-shadow";

const SQUARE_ONLY = [{ id: "square", label: "Square 1:1", ratio: 1 } as const];

interface ProfileState {
  adminName: string;
  adminEmail: string;
  adminRole: string;
  businessName: string;
  hasBusiness: boolean;
  profilePhoto: string;
  contactName: string;
  contactPhone: string;
  contactAddress: string;
}

interface Toast {
  id: number;
  type: "success" | "error";
  message: string;
}

function field(labelKey: string, children: React.ReactNode) {
  return (
    <div>
      <label className="block text-sm font-medium text-rbai-text mb-1.5">
        {t(labelKey)}
      </label>
      {children}
    </div>
  );
}

export default function ProfilePage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profile, setProfile] = useState<ProfileState | null>(null);
  const [photo, setPhoto] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactAddress, setContactAddress] = useState("");
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const toast = (type: "success" | "error", message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, type, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/profile");
        if (!res.ok) throw new Error("load failed");
        const json = await res.json();
        const b = json.business ?? null;
        const state: ProfileState = {
          adminName: json.admin?.name ?? "",
          adminEmail: json.admin?.email ?? "",
          adminRole: json.admin?.role ?? "",
          businessName: b?.name ?? "",
          hasBusiness: !!b,
          profilePhoto: b?.profilePhoto ?? "",
          contactName: b?.contactName ?? "",
          contactPhone: b?.contactPhone ?? "",
          contactAddress: b?.contactAddress ?? "",
        };
        setProfile(state);
        setPhoto(state.profilePhoto);
        setContactName(state.contactName || state.adminName);
        setContactPhone(state.contactPhone);
        setContactAddress(state.contactAddress);
      } catch {
        toast("error", "Could not load your profile.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactName: contactName.trim(),
          contactPhone: contactPhone.trim(),
          contactAddress: contactAddress.trim(),
          profilePhoto: photo,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed.");
      toast("success", t("profile.saved_toast"));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const initial = (contactName.trim() || profile?.adminName || "U")
    .trim()
    .charAt(0)
    .toUpperCase();

  return (
    <>
      <Header
        title="Profile"
        description="Your photo and contact details — shown to your customers"
      />
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          {loading || !profile ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-rbai-primary" />
            </div>
          ) : !profile.hasBusiness ? (
            <div className="bg-rbai-surface border border-rbai-border rounded-2xl p-6 sm:p-8">
              <div className="flex items-start gap-3 rounded-xl bg-rbai-bg border border-rbai-border p-4 text-sm text-rbai-text">
                <AlertCircle className="h-5 w-5 text-rbai-primary flex-shrink-0 mt-0.5" />
                <p>
                  You are signed in as <strong>{profile.adminRole === "super_admin" ? "Super Admin" : "an administrator"}</strong>{" "}
                  without a business workspace. Profile photo and contact details are set inside a business workspace — they
                  are not needed for your admin account.
                </p>
              </div>
              <div className="mt-6 space-y-4">
                {field("profile.name_label", (
                  <input value={profile.adminName} readOnly className={inputClass} />
                ))}
                {field("profile.email_label", (
                  <input value={profile.adminEmail} readOnly className={inputClass} />
                ))}
              </div>
            </div>
          ) : (
            <>
              {/* Photo card */}
              <div className="bg-rbai-surface border border-rbai-border rounded-2xl p-6 sm:p-8">
                <div className="flex items-center gap-3 mb-6">
                  <span className="p-3 rounded-xl bg-rbai-primary-50 text-rbai-primary">
                    <Camera className="h-5 w-5" />
                  </span>
                  <div>
                    <h3 className="font-semibold text-rbai-text">
                      {t("profile.photo_title")}
                    </h3>
                    <p className="text-xs text-rbai-text-light mt-0.5">
                      Your face appears next to your name across the dashboard.
                    </p>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
                  <div className="flex-shrink-0">
                    {photo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={photo}
                        alt="Profile photo"
                        className="h-28 w-28 rounded-full object-cover border-2 border-rbai-primary/40"
                      />
                    ) : (
                      <div className="h-28 w-28 rounded-full bg-rbai-primary text-white flex items-center justify-center text-4xl font-semibold">
                        {initial}
                      </div>
                    )}
                  </div>
                  <div className="space-y-3">
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (f) setCropFile(f);
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-rbai-primary text-white hover:bg-rbai-primary-dark transition-colors"
                    >
                      <ImagePlus className="h-4 w-4" />
                      {photo ? t("profile.change_photo") : t("profile.upload_photo")}
                    </button>
                    {photo && (
                      <button
                        type="button"
                        onClick={() => setPhoto("")}
                        className="ml-2 inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-rbai-border text-rbai-text hover:bg-rbai-bg transition-colors"
                      >
                        <Trash2 className="h-4 w-4" /> Remove
                      </button>
                    )}
                    <p className="text-xs text-rbai-text-light leading-relaxed">
                      After you pick a photo, a crop window opens: <strong>center your face inside the square</strong> — that
                      square is exactly what gets saved.
                    </p>
                  </div>
                </div>
              </div>

              {/* Details card */}
              <div className="bg-rbai-surface border border-rbai-border rounded-2xl p-6 sm:p-8">
                <div className="flex items-center gap-3 mb-6">
                  <span className="p-3 rounded-xl bg-rbai-primary-50 text-rbai-primary">
                    <UserRound className="h-5 w-5" />
                  </span>
                  <div>
                    <h3 className="font-semibold text-rbai-text">
                      {t("profile.contact_details_title")}
                    </h3>
                    <p className="text-xs text-rbai-text-light mt-0.5">
                      You can change these any time — a profile is never locked after creation.
                    </p>
                  </div>
                </div>

                <div className="space-y-4">
                  {field("profile.contact_name_label", (
                    <input
                      value={contactName}
                      onChange={(e) => setContactName(e.target.value)}
                      placeholder="Your full name"
                      maxLength={120}
                      className={inputClass}
                    />
                  ))}
                  {field("profile.email_label", (
                    <>
                      <input value={profile.adminEmail} readOnly className={`${inputClass} opacity-70`} />
                      <p className="text-xs text-rbai-text-light mt-1.5">
                        This is your sign-in email. It is managed by your login account and cannot be changed here.
                      </p>
                    </>
                  ))}
                  {field("profile.phone_label", (
                    <input
                      value={contactPhone}
                      onChange={(e) => setContactPhone(e.target.value)}
                      placeholder="+880 1XXX-XXXXXX"
                      maxLength={40}
                      className={inputClass}
                    />
                  ))}
                  {field("profile.address_label", (
                    <textarea
                      value={contactAddress}
                      onChange={(e) => setContactAddress(e.target.value)}
                      placeholder="Street, area, city"
                      maxLength={300}
                      rows={3}
                      className={inputClass}
                    />
                  ))}
                </div>

                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={save}
                    disabled={saving}
                    className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg bg-rbai-primary text-white hover:bg-rbai-primary-dark transition-colors disabled:opacity-50"
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {saving ? "Saving…" : t("profile.save_button")}
                  </button>
                  <Link
                    href="/landing"
                    className="text-sm text-rbai-primary hover:underline underline-offset-2"
                  >
                    Manage your business logo on the Landing Page settings
                  </Link>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Crop step — 1:1 only; the centered square is what gets saved. */}
      <ImageCropper
        open={cropFile !== null}
        file={cropFile}
        title="Crop your photo"
        aspects={SQUARE_ONLY}
        defaultAspectId="square"
        maxOutputSize={512}
        onConfirm={(dataUrl) => {
          setCropFile(null);
          if (!isImageDataUrl(dataUrl)) {
            toast("error", "That image could not be cropped. Please try a different photo.");
            return;
          }
          setPhoto(dataUrl);
        }}
        onCancel={() => setCropFile(null)}
      />

      {/* Toasts */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium text-white ${
              t.type === "success" ? "bg-rbai-success" : "bg-rbai-danger"
            }`}
          >
            {t.type === "success" ? (
              <CheckCircle className="h-4 w-4 flex-shrink-0" />
            ) : (
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
            )}
            {t.message}
          </div>
        ))}
      </div>
    </>
  );
}
