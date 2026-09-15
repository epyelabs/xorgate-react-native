import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("scaffold", () => {
  it("exports the package name", () => {
    expect(PACKAGE_NAME).toBe("@xorgate/react-native");
  });
});
