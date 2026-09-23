import { expect, it } from "vitest";
import { validPasswordLength } from "./password";

it.each(["a", "界", "😀"])(
  "counts Unicode characters in passwords using %s",
  (character) => {
    for (const length of [0, 4, 7, 8, 100, 128, 129]) {
      expect(validPasswordLength(character.repeat(length))).toBe(
        length >= 8 && length <= 128,
      );
    }
  },
);
