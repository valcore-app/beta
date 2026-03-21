import { describe, expect, it } from "vitest";
import { cn } from "../../components/utils";

describe("cn", () => {
  it("merges class names and resolves Tailwind conflicts", () => {
    const result = cn("px-2", "text-sm", false && "hidden", "px-4", undefined, null);
    expect(result).toBe("text-sm px-4");
  });
});