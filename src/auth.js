import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

// In production, set JWT_SECRET as a real environment variable on Render.
// This fallback is only so local/dev runs still work without extra setup.
const JWT_SECRET = process.env.JWT_SECRET || "royalle-dev-secret-change-in-production";

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}
export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}
export function signToken(userId, username) {
  return jwt.sign({ sub: userId, username }, JWT_SECRET, { expiresIn: "30d" });
}
export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}
