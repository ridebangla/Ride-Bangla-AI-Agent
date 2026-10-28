"use client";

/**
 * Follow-up schedule settings form — LEG I (video round-2
 * batch), STAGED ONLY. New file; it does not modify any existing
 * dashboard page. Mounting it into the Settings page is apply-time
 * work (the Settings page file was not re-anchored this leg).
 *
 * Real repo path (proposed): src/components/followup-settings-form.tsx
 *
 * What it does:
 * - One preset group: 30min / 1h / 2h / 6h / 12h / 23h, plus Custom.
 * - A custom-minutes input shown only when Custom is chosen.
 * - Client-side validation through Leg I's pure resolver
 *   (src/lib/followup-settings.ts): a custom value above 23h is
 *   REFUSED with an honest error and the save never fires — never
 *   silently clamped, never silently accepted. The server schema
 *   (diffs/002) enforces the same cap, so a bypassed client still
 *   cannot store an over-cap value.
 * - Save goes to the EXISTING tenant-scoped Settings PUT endpoint
 *   (relative /api/settings, no tenant-identifier prop, no cross-tenant
 *   parameter). The two new field names are added to the strict
 *   settings schema by diffs/002; the matching Settings-model field
 *   addition is an apply-time migration (see LEG-REPORT §6) — until
 *   it lands, the PUT will reject the new fields rather than store
 *   them, which is fail-closed, not silent.
 *
 * What it does NOT do (deliberately):
 * - No pre-selected preset: the tenant must choose. A missing choice
 *   disables Save (the resolver refuses "delay_not_set"). No default
 *   is invented here or in the pure module, matching Leg F's
 *   no-invented-default discipline.
 * - No Hot-count field, no broadcast control, no reminder wording:
 *   those are Leg F owner decisions / other legs' scope. This form
 *   touches the follow-up SCHEDULE only.
 * - No fare, price or order logic anywhere in this form.
 *
 * ALL user-facing strings below are PROPOSALS for owner approval,
 * never silently shipped copy. Labels are plain English literals,
 * matching the other legs' staged UI (language wiring is follow-up
 * work, not invented here).
 */

import { useState } from "react";
import {
  FOLLOWUP_DELAY_PRESETS,
  MAX_FOLLOWUP_DELAY_MINUTES,
  resolveFollowUpDelay,
} from "@/lib/followup-settings";

export interface FollowUpSettingsFormProps {
  /** Current stored preset key, or null when nothing is stored yet. */
  initialPreset?: string | null;
  /** Current stored custom minutes, or null when not custom. */
  initialCustomMinutes?: number | null;
}

const PRESET_LABELS: Record<string, string> = {
  "30m": "30 minutes",
  "1h": "1 hour",
  "2h": "2 hours",
  "6h": "6 hours",
  "12h": "12 hours",
  "23h": "23 hours",
};

export default function FollowUpSettingsForm({
  initialPreset = null,
  initialCustomMinutes = null,
}: FollowUpSettingsFormProps) {
  const [preset, setPreset] = useState<string | null>(initialPreset);
  const [customMinutes, setCustomMinutes] = useState<string>(
    initialCustomMinutes === null ? "" : String(initialCustomMinutes)
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  function handleSave() {
    setError(null);
    setSaved(false);
    const parsed =
      preset === "custom" && customMinutes.trim() !== ""
        ? Number(customMinutes)
        : null;
    const resolution = resolveFollowUpDelay({
      preset,
      customMinutes: preset === "custom" ? parsed : null,
    });
    if (!resolution.ok) {
      // PROPOSAL wording — owner approval required before shipping.
      // The refusal itself is the rule: over-cap is never saved.
      if (resolution.error === "custom_delay_exceeds_23h") {
        setError(
          "Custom delay cannot be longer than 23 hours, so the follow-up stays inside the 24-hour platform window. Please choose 23 hours or less."
        );
      } else if (resolution.error === "delay_not_set") {
        setError("Choose a schedule preset or enter a custom delay first.");
      } else if (resolution.error === "custom_delay_required") {
        setError("Enter a custom delay in minutes.");
      } else if (resolution.error === "custom_delay_invalid") {
        setError("Custom delay must be a whole number of minutes, at least 1.");
      } else if (resolution.error === "conflicting_delay_input") {
        setError("Choose either a preset or a custom delay, not both.");
      } else {
        setError("That schedule choice is not recognised. Please choose again.");
      }
      return;
    }
    setSaving(true);
    const body: Record<string, unknown> = { followUpDelayPreset: preset };
    if (preset === "custom") {
      body.followUpDelayCustomMinutes = parsed;
    }
    fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        if (!res.ok) {
          // PROPOSAL wording.
          setError("Could not save the follow-up schedule. Please try again.");
          return;
        }
        setSaved(true);
      })
      .catch(() => {
        // PROPOSAL wording.
        setError("Could not save the follow-up schedule. Please try again.");
      })
      .finally(() => setSaving(false));
  }

  return (
    <div>
      <h3>Follow-up schedule</h3>
      <p>
        When the first follow-up is sent. Choose a preset, or Custom for
        your own delay (at most 23 hours).
      </p>
      <div role="radiogroup" aria-label="Follow-up schedule">
        {FOLLOWUP_DELAY_PRESETS.map((p) => (
          <label key={p.key}>
            <input
              type="radio"
              name="followup-delay-preset"
              value={p.key}
              checked={preset === p.key}
              onChange={() => setPreset(p.key)}
            />
            {PRESET_LABELS[p.key] ?? p.key}
          </label>
        ))}
        <label>
          <input
            type="radio"
            name="followup-delay-preset"
            value="custom"
            checked={preset === "custom"}
            onChange={() => setPreset("custom")}
          />
          Custom
        </label>
      </div>
      {preset === "custom" ? (
        <label>
          Custom delay (minutes, 1 to {MAX_FOLLOWUP_DELAY_MINUTES})
          <input
            type="number"
            min={1}
            max={MAX_FOLLOWUP_DELAY_MINUTES}
            value={customMinutes}
            onChange={(e) => setCustomMinutes(e.target.value)}
          />
        </label>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {saved ? <p>Follow-up schedule saved.</p> : null}
      <button type="button" onClick={handleSave} disabled={saving || preset === null}>
        Save follow-up schedule
      </button>
    </div>
  );
}
