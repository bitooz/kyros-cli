import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { normalizeMarkdownForDisplay, renderMarkdownToAnsi } from "./markdown.js";

describe("normalizeMarkdownForDisplay", () => {
  it("unwraps a full markdown fence wrapper", () => {
    expect(normalizeMarkdownForDisplay("```markdown\n# Title\n\n- item\n```")).toBe("# Title\n\n- item");
  });

  it("unwraps a live markdown fence wrapper before the closing fence arrives", () => {
    expect(normalizeMarkdownForDisplay("```md\n# Title\n\n- item")).toBe("# Title\n\n- item");
  });

  it("preserves non-markdown fenced code blocks", () => {
    expect(normalizeMarkdownForDisplay("```ts\nconst value = 1;\n```")).toBe("```ts\nconst value = 1;\n```");
  });

  it("pretty-prints raw json objects for display", () => {
    expect(normalizeMarkdownForDisplay('{"b":1,"a":{"c":2}}')).toBe(
      '```json\n{\n  "b": 1,\n  "a": {\n    "c": 2\n  }\n}\n```',
    );
  });

  it("pretty-prints fenced json blocks for display", () => {
    expect(normalizeMarkdownForDisplay("```json\n{\"a\":1}\n```")).toBe(
      '```json\n{\n  "a": 1\n}\n```',
    );
  });

  it("renders markdown compactly", () => {
    const rendered = stripVTControlCharacters(
      renderMarkdownToAnsi("```markdown\n# Title\n\n- item\n```", 48),
    );

    expect(rendered).toContain("Title");
    expect(rendered).toContain("- item");
  });

  it("renders pretty json blocks compactly", () => {
    const rendered = stripVTControlCharacters(
      renderMarkdownToAnsi('{"a":1,"b":{"c":2}}', 64),
    );

    expect(rendered).toContain('"a": 1');
    expect(rendered).toContain('"c": 2');
  });

  it("renders tables without box borders", () => {
    const rendered = stripVTControlCharacters(
      renderMarkdownToAnsi("| Key | Value |\n| - | - |\n| Color | Clean |\n", 64),
    );

    expect(rendered).toContain("Color: Clean");
    expect(rendered).not.toContain("┌");
    expect(rendered).not.toContain("│");
  });
});
