// Ported from fadeinflames/wom-games (src/lib/validation.ts), auth schemas only.
import { z } from "zod";

// Passwords that top every leaked-credential list; the length rule alone lets "password" through.
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "passw0rd", "qwerty123", "qwertyuiop", "qwerty12345", "1q2w3e4r", "1q2w3e4r5t",
  "12345678", "123456789", "1234567890", "987654321", "11111111", "00000000", "abcd1234", "abc12345", "iloveyou",
  "letmein1", "welcome1", "admin123", "administrator", "changeme", "qazwsxedc", "zaq12wsx", "football", "monkey123",
  "йцукенгшщ", "привет123", "пароль123",
]);

/** a Russian reason when the password is too guessable, otherwise null */
export function passwordProblem(password: string, username: string): string | null {
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return "Этот пароль слишком распространённый, придумай другой";
  if (/^(.)\1+$/.test(password)) return "Пароль не должен состоять из одного повторяющегося символа";
  if (username.length >= 3 && lower.includes(username.toLowerCase())) return "Пароль не должен содержать имя пользователя";
  return null;
}

export const registerSchema = z
  .object({
    email: z.string().trim().toLowerCase().email("Некорректный адрес почты").min(5).max(254).optional().or(z.literal("")),
    username: z
      .string()
      .trim()
      .min(3, "Имя пользователя: от 3 до 32 символов")
      .max(32, "Имя пользователя: от 3 до 32 символов")
      .regex(/^[a-zA-Z0-9._-]+$/, "Имя пользователя: латинские буквы, цифры, точка, дефис и подчёркивание")
      .toLowerCase(),
    password: z.string().min(8, "Пароль: от 8 до 128 символов").max(128, "Пароль: от 8 до 128 символов"),
  })
  .superRefine((value, ctx) => {
    const problem = passwordProblem(value.password, value.username);
    if (problem) ctx.addIssue({ code: "custom", path: ["password"], message: problem });
  });

export const loginSchema = z.object({
  identity: z.string().trim().min(3, "Укажи логин или почту").max(254, "Укажи логин или почту").toLowerCase(),
  password: z.string().min(8, "Пароль: не короче 8 символов"),
});
