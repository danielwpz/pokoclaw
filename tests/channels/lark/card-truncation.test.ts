import { describe, expect, test } from "vitest";

import {
  capLarkCardReasoningTail,
  truncateLarkCardString,
  truncateLarkCardValueDeep,
} from "@/src/channels/lark/render/card-truncation.js";

describe("lark card truncation", () => {
  test("truncates deep string values without mutating the original object", () => {
    const longText = Array.from({ length: 12 }, (_, index) => `line-${index}`).join("\n");
    const input = {
      content: [
        {
          type: "text",
          text: longText,
        },
      ],
      details: {
        stdout: longText,
        nested: {
          excerpt: longText,
        },
      },
    };

    const output = truncateLarkCardValueDeep(input, {
      maxChars: 32,
      maxLines: 3,
    }) as typeof input;

    expect(output).not.toBe(input);
    expect(output.content).not.toBe(input.content);
    expect(output.details).not.toBe(input.details);
    expect(Object.keys(output.details)).toEqual(Object.keys(input.details));
    expect(input.content[0]?.text).toBe(longText);
    expect(input.details.stdout).toBe(longText);
    expect(output.content[0]?.text).toContain("[truncated]");
    expect(output.details.stdout).toContain("[truncated]");
    expect(output.details.nested.excerpt).toContain("[truncated]");
  });

  test("caps reasoning by preserving the tail", () => {
    const reasoning = Array.from({ length: 30 }, (_, index) => `reasoning-${index}`).join("\n");

    const capped = capLarkCardReasoningTail(reasoning, 80);

    expect(capped.startsWith("...\n")).toBe(true);
    expect(capped).not.toContain("reasoning-0");
    expect(capped).toContain("reasoning-29");
  });

  test("truncates strings by both line count and character count", () => {
    const value = ["alpha", "beta", "gamma", "delta", "epsilon"].join("\n");

    const truncated = truncateLarkCardString(value, {
      maxChars: 18,
      maxLines: 2,
    });

    expect(truncated).toContain("[truncated]");
    expect(truncated.split("\n").length).toBeLessThanOrEqual(3);
  });
});
