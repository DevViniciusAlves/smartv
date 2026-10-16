import { describe, expect, it } from "vitest";
import { CLOSE_CODES, describeClose } from "./closeCodes.js";

describe("describeClose", () => {
  it("maps application codes", () => {
    expect(describeClose(CLOSE_CODES.AUTH_FAILED)).toEqual({ kind: "auth", retry: false });
    expect(describeClose(CLOSE_CODES.ORIGIN_NOT_ALLOWED)).toEqual({ kind: "origin", retry: false });
    expect(describeClose(CLOSE_CODES.REPLACED_BY_NEW_AGENT)).toEqual({ kind: "replaced", retry: true });
    expect(describeClose(CLOSE_CODES.MESSAGE_TOO_LARGE)).toEqual({ kind: "too_large", retry: true });
  });
  it("treats standard codes as retryable network issues", () => {
    for (const code of [1000, 1001, 1005, 1006, 1012]) {
      expect(describeClose(code)).toEqual({ kind: "network", retry: true });
    }
  });
});
