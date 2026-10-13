import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  sanitizeEmailSubject,
  maskSecret,
  maskSettingsSecrets,
  SECRET_FIELDS,
} from "@/lib/security";

describe("Security Utilities", () => {
  describe("escapeHtml", () => {
    it("should escape all HTML special characters", () => {
      expect(escapeHtml("<script>alert('xss')</script>")).toBe(
        "&lt;script&gt;alert(&#x27;xss&#x27;)&lt;/script&gt;"
      );
    });

    it("should escape ampersand", () => {
      expect(escapeHtml("foo & bar")).toBe("foo &amp; bar");
    });

    it("should escape double quotes", () => {
      expect(escapeHtml('attr="value"')).toBe("attr=&quot;value&quot;");
    });

    it("should handle empty string", () => {
      expect(escapeHtml("")).toBe("");
    });

    it("should not modify safe text", () => {
      expect(escapeHtml("Hello World 123")).toBe("Hello World 123");
    });

    it("should escape nested injection attempts", () => {
      expect(escapeHtml('<img onerror="alert(1)" src=x>')).toBe(
        '&lt;img onerror=&quot;alert(1)&quot; src=x&gt;'
      );
    });
  });

  describe("sanitizeEmailSubject", () => {
    it("should strip carriage return characters", () => {
      const result = sanitizeEmailSubject("Subject\r\nBcc: attacker@evil.com");
      expect(result).not.toContain("\r");
      expect(result).not.toContain("\n");
    });

    it("should strip newline characters", () => {
      expect(sanitizeEmailSubject("Subject\nInjected-Header: value")).toBe(
        "Subject Injected-Header: value"
      );
    });

    it("should trim whitespace", () => {
      expect(sanitizeEmailSubject("  Subject  ")).toBe("Subject");
    });

    it("should handle clean subjects unchanged", () => {
      expect(sanitizeEmailSubject("Re: Your Order #123")).toBe(
        "Re: Your Order #123"
      );
    });
  });

  describe("maskSecret", () => {
    it("should mask non-empty values", () => {
      expect(maskSecret("sk-12345")).toBe("***");
    });

    it("should return empty for null", () => {
      expect(maskSecret(null)).toBe("");
    });

    it("should return empty for undefined", () => {
      expect(maskSecret(undefined)).toBe("");
    });

    it("should return empty for empty string", () => {
      expect(maskSecret("")).toBe("");
    });

    it("should return empty for whitespace-only", () => {
      expect(maskSecret("   ")).toBe("");
    });
  });

  describe("maskSettingsSecrets", () => {
    it("should mask all secret fields", () => {
      const settings = {
        id: "default",
        businessName: "Owly",
        aiApiKey: "sk-test-key",
        smtpPass: "smtp-pass",
        imapPass: "imap-pass",
        twilioToken: "twilio-token",
        elevenLabsKey: "el-key",
        whatsappApiKey: "wa-key",
        telegramBotToken: "tg-bot-token",
        telegramWebhookSecret: "tg-webhook-secret",
      };

      const masked = maskSettingsSecrets(settings);

      expect(masked.businessName).toBe("Owly");
      expect(masked.id).toBe("default");
      for (const field of SECRET_FIELDS) {
        expect(masked[field]).toBe("***");
      }
    });

    it("should handle missing secret fields gracefully", () => {
      const settings = {
        id: "default",
        businessName: "Owly",
      };

      const masked = maskSettingsSecrets(settings);
      expect(masked.businessName).toBe("Owly");
    });

    it("should not mutate original object", () => {
      const settings = { aiApiKey: "sk-test" };
      maskSettingsSecrets(settings);
      expect(settings.aiApiKey).toBe("sk-test");
    });
  });
});
