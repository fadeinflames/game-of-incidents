import { afterEach, describe, expect, it, vi } from "vitest";
import { ContactLink, NO_CONTACT_TEXT, contactUrl } from "@/components/contact-link";

afterEach(() => vi.unstubAllEnvs());

describe("ContactLink", () => {
  it("renders nothing without CONTACT_URL and without a fallback", () => {
    vi.stubEnv("CONTACT_URL", "");
    expect(ContactLink({})).toBeNull();
  });

  it("renders the fallback text instead of a dead end when CONTACT_URL is empty", () => {
    vi.stubEnv("CONTACT_URL", "  ");
    const el = ContactLink({ fallback: NO_CONTACT_TEXT });
    expect(el?.props["data-testid"]).toBe("contact-missing");
    expect(el?.props.children).toBe(NO_CONTACT_TEXT);
    expect(NO_CONTACT_TEXT).toContain("пока не настроен");
  });

  it("renders the link when CONTACT_URL is set, ignoring the fallback", () => {
    vi.stubEnv("CONTACT_URL", "https://t.me/example");
    const el = ContactLink({ fallback: NO_CONTACT_TEXT });
    expect(el?.props.href).toBe("https://t.me/example");
  });

  it("refuses a link with another scheme", () => {
    vi.stubEnv("CONTACT_URL", "javascript:alert(1)");
    expect(contactUrl()).toBeNull();
  });
});
