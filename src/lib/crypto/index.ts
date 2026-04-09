/**
 * AES-256-GCM encryption utilities for ManageT.
 * Used to encrypt/decrypt server passwords at rest.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey(): Buffer {
  const hex = process.env.MANAGET_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "MANAGET_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)"
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypt a plaintext password using AES-256-GCM.
 * @returns cipher string in format `iv:authTag:ciphertext` (hex encoded)
 */
export function encryptPassword(plain: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plain, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypt a cipher string produced by encryptPassword.
 * @param cipherStr cipher string in format `iv:authTag:ciphertext` (hex encoded)
 * @returns the original plaintext password
 */
export function decryptPassword(cipherStr: string): string {
  const key = getKey();
  const parts = cipherStr.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid cipher format: expected iv:authTag:ciphertext");
  }
  const [ivHex, authTagHex, ciphertext] = parts;

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
