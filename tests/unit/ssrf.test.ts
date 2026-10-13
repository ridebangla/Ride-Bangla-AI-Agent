import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:dns/promises", () => ({
  default: {
    lookup: vi.fn(),
  },
}));

import dns from "node:dns/promises";
import { validateOutboundUrl } from "@/lib/ssrf";

const mockLookup = vi.mocked(dns.lookup);

describe("validateOutboundUrl (C-08 SSRF blocklist)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Default: hostname resolves to a public IP.
    mockLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
  });

  it("allows a public https URL", async () => {
    await expect(
      validateOutboundUrl("https://example.com/hook")
    ).resolves.toEqual({ ok: true });
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(validateOutboundUrl("ftp://example.com/x")).resolves
      .toMatchObject({ ok: false });
    await expect(validateOutboundUrl("file:///etc/passwd")).resolves
      .toMatchObject({ ok: false });
    await expect(validateOutboundUrl("gopher://example.com/")).resolves
      .toMatchObject({ ok: false });
  });

  it("rejects URLs with embedded credentials", async () => {
    await expect(
      validateOutboundUrl("https://user:pass@example.com/")
    ).resolves.toMatchObject({ ok: false });
  });

  it("rejects the cloud metadata IP", async () => {
    await expect(
      validateOutboundUrl("http://169.254.169.254/latest/meta-data/")
    ).resolves.toMatchObject({ ok: false });
  });

  it("rejects private / loopback / link-local literal IPs", async () => {
    for (const url of [
      "http://10.0.0.5/",
      "http://172.16.0.9/",
      "http://192.168.1.1/",
      "http://127.0.0.1/admin",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://[fe80::1]/",
      "http://[fc00::1]/",
    ]) {
      await expect(validateOutboundUrl(url)).resolves.toMatchObject({
        ok: false,
      });
    }
  });

  it("rejects blocked hostnames", async () => {
    for (const url of [
      "http://localhost/admin",
      "http://metadata.google.internal/",
      "http://metadata/latest/meta-data/",
      "http://foo.localhost/",
      "http://db.internal/",
    ]) {
      await expect(validateOutboundUrl(url)).resolves.toMatchObject({
        ok: false,
      });
    }
  });

  it("rejects non-standard numeric IP spellings", async () => {
    for (const url of [
      "http://2130706433/", // decimal 127.0.0.1
      "http://0x7f000001/", // hex 127.0.0.1
      "http://127.1/", // short form 127.0.0.1
      "http://0177.0.0.1/", // octal 127.0.0.1
    ]) {
      await expect(validateOutboundUrl(url)).resolves.toMatchObject({
        ok: false,
      });
    }
  });

  it("rejects a hostname that resolves to a private IP", async () => {
    mockLookup.mockResolvedValue([
      { address: "10.1.2.3", family: 4 },
    ] as never);
    await expect(
      validateOutboundUrl("https://evil.example.com/hook")
    ).resolves.toMatchObject({ ok: false });
  });

  it("rejects a hostname that resolves to an IPv4-mapped private IPv6", async () => {
    mockLookup.mockResolvedValue([
      { address: "::ffff:127.0.0.1", family: 6 },
    ] as never);
    await expect(
      validateOutboundUrl("https://evil.example.com/hook")
    ).resolves.toMatchObject({ ok: false });
  });

  it("rejects when DNS resolution fails (fail closed)", async () => {
    mockLookup.mockRejectedValue(new Error("ENOTFOUND") as never);
    await expect(
      validateOutboundUrl("https://nonexistent.invalid/hook")
    ).resolves.toMatchObject({ ok: false });
  });

  it("rejects malformed URLs", async () => {
    await expect(validateOutboundUrl("not a url")).resolves.toMatchObject({
      ok: false,
    });
    await expect(validateOutboundUrl("")).resolves.toMatchObject({
      ok: false,
    });
  });
});
