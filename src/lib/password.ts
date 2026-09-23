export const passwordLengthMessage = "Use a password of 8 to 128 characters.";

// Count Unicode code points, matching Rust chars(), rather than UTF-16 units.
export function validPasswordLength(password: string): boolean {
  const length = Array.from(password).length;
  return length >= 8 && length <= 128;
}
