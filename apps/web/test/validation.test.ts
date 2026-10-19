import { describe, expect, it } from "vitest";
import { passwordProblem, registerSchema } from "@/lib/validation";

describe("password policy", () => {
  it("refuses leaked passwords, repeats and the username", () => {
    expect(passwordProblem("Password123", "alice")).not.toBeNull();
    expect(passwordProblem("aaaaaaaaaa", "alice")).not.toBeNull();
    expect(passwordProblem("my-ALICE-secret", "alice")).not.toBeNull();
  });

  it("accepts an ordinary passphrase", () => {
    expect(passwordProblem("correct horse battery", "alice")).toBeNull();
  });

  it("is applied by the register schema with the message for the user", () => {
    const r = registerSchema.safeParse({ username: "alice", password: "qwerty123" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toContain("распространённый");
    expect(registerSchema.safeParse({ username: "alice", password: "correct horse battery" }).success).toBe(true);
  });
});
