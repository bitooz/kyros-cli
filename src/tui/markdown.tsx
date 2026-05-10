import { Box, Text } from "ink";
import { lexer, type Token, type Tokens } from "marked";
import React from "react";

export function normalizeMarkdownForDisplay(text: string): string {
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) {
    return "";
  }

  const unwrapped = unwrapWholeMarkdownFence(normalized);
  const content = unwrapped ?? normalized;
  return formatJsonForDisplay(content) ?? content;
}

function unwrapWholeMarkdownFence(text: string): string | undefined {
  const completeFence = text.match(/^```(?:markdown|md)\s*\n([\s\S]*)\n```$/i);
  if (completeFence?.[1]) {
    return completeFence[1].trim();
  }

  const liveFence = text.match(/^```(?:markdown|md)\s*\n([\s\S]*)$/i);
  if (liveFence?.[1] && !liveFence[1].includes("\n```")) {
    return liveFence[1].trimStart();
  }

  return undefined;
}

function formatJsonForDisplay(text: string): string | undefined {
  const fencedJson = text.match(/^```(?:json|jsonc)\s*\n([\s\S]*)\n```$/i);
  if (fencedJson?.[1]) {
    const pretty = tryPrettyJson(fencedJson[1]);
    return pretty ? `\`\`\`json\n${pretty}\n\`\`\`` : undefined;
  }

  const pretty = tryPrettyJson(text);
  return pretty ? `\`\`\`json\n${pretty}\n\`\`\`` : undefined;
}

function tryPrettyJson(text: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return undefined;
  }
}

export function MarkdownMessageView({ text, columns }: { text: string; columns?: number }) {
  const rendered = renderMarkdownToAnsi(text, columns);

  if (!rendered) {
    return (
      <Box flexDirection="row">
        <Text color="white">{"● "}</Text>
        <Text color="gray">...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row">
      <Text color="white">{"● "}</Text>
      <Box flexDirection="column" flexGrow={1}>
        <Text>{rendered}</Text>
      </Box>
    </Box>
  );
}

export function renderMarkdownToAnsi(text: string, columns?: number): string {
  const content = normalizeMarkdownForDisplay(text);
  if (!content) {
    return "";
  }

  const width = columns ? Math.max(24, columns - 4) : undefined;
  const rendered = renderMarkdownTokens(lexer(content), width ?? 80);

  return rendered.trimEnd();
}

function renderMarkdownTokens(tokens: Token[], width: number): string {
  return renderBlockTokens(tokens, width).join("\n");
}

function renderBlockTokens(tokens: Token[], width: number): string[] {
  const lines: string[] = [];

  for (const token of tokens) {
    lines.push(...renderBlockToken(token, width));
  }

  return lines.filter((line, index, current) =>
    line.trim() || (current[index - 1]?.trim() && current[index + 1]?.trim()));
}

function renderBlockToken(token: Token, width: number): string[] {
  switch (token.type) {
    case "space":
    case "def":
      return [];
    case "heading": {
      const heading = token as Tokens.Heading;
      return wrapText(renderInlineTokens(heading.tokens) || heading.text, width);
    }
    case "paragraph": {
      const paragraph = token as Tokens.Paragraph;
      return wrapText(renderInlineTokens(paragraph.tokens) || paragraph.text, width);
    }
    case "text": {
      const text = token as Tokens.Text;
      return wrapText(renderInlineTokens(text.tokens) || text.text, width);
    }
    case "code": {
      const code = token as Tokens.Code;
      return code.text.split("\n").map((line: string) => `  ${line}`);
    }
    case "blockquote": {
      const blockquote = token as Tokens.Blockquote;
      return renderBlockTokens(blockquote.tokens, Math.max(12, width - 2)).map((line: string) => `> ${line}`);
    }
    case "list":
      return renderList(token as Tokens.List, width);
    case "table":
      return renderTable(token as Tokens.Table, width);
    case "hr":
      return [];
    case "html":
      return wrapText(stripHtml(token.text), width);
    default:
      return renderFallbackBlock(token, width);
  }
}

function renderList(token: Tokens.List, width: number): string[] {
  const start = typeof token.start === "number" ? token.start : 1;
  return token.items.flatMap((item, index) => {
    const baseMarker = token.ordered ? `${start + index}. ` : "- ";
    const marker = item.task
      ? `${baseMarker}${item.checked ? "[x]" : "[ ]"} `
      : baseMarker;
    const itemWidth = Math.max(12, width - marker.length);
    const content = renderBlockTokens(item.tokens, itemWidth);
    const lines = content.length > 0
      ? content
      : wrapText(renderInlineTokens(item.tokens) || item.text, itemWidth);
    const indent = " ".repeat(marker.length);

    return lines.map((line, lineIndex) =>
      lineIndex === 0 ? `${marker}${line}` : `${indent}${line}`);
  });
}

function renderTable(token: Tokens.Table, width: number): string[] {
  const headers = token.header.map(renderTableCell);
  const rows = token.rows.map((row) => row.map(renderTableCell));

  if (headers.length === 2) {
    return rows.flatMap((row) => wrapText(`${row[0] ?? ""}: ${row[1] ?? ""}`, width));
  }

  return rows.flatMap((row) => wrapText(row.filter(Boolean).join(" · "), width));
}

function renderTableCell(cell: Tokens.TableCell): string {
  return normalizeInlineWhitespace(renderInlineTokens(cell.tokens) || cell.text);
}

function renderInlineTokens(tokens: Token[] | undefined): string {
  if (!tokens) {
    return "";
  }

  return normalizeInlineWhitespace(tokens.map(renderInlineToken).join(""));
}

function renderInlineToken(token: Token): string {
  switch (token.type) {
    case "text":
    case "escape":
    case "codespan":
      return token.text;
    case "strong":
    case "em":
    case "del":
    case "link":
      return renderInlineTokens(token.tokens) || token.text;
    case "image":
      return token.text;
    case "br":
      return "\n";
    case "html":
      return stripHtml(token.text);
    default:
      return renderFallbackInline(token);
  }
}

function renderFallbackBlock(token: Token, width: number): string[] {
  const record = token as { text?: unknown; tokens?: unknown };
  if (Array.isArray(record.tokens)) {
    return wrapText(renderInlineTokens(record.tokens as Token[]), width);
  }

  return typeof record.text === "string"
    ? wrapText(record.text, width)
    : [];
}

function renderFallbackInline(token: Token): string {
  const record = token as { text?: unknown; tokens?: unknown };
  if (Array.isArray(record.tokens)) {
    return renderInlineTokens(record.tokens as Token[]);
  }

  return typeof record.text === "string" ? record.text : "";
}

function normalizeInlineWhitespace(value: string): string {
  return value.replace(/[ \t\r\n]+/g, " ").trim();
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

function wrapText(value: string, width: number): string[] {
  const maxWidth = Math.max(24, width);
  const lines: string[] = [];

  for (const rawLine of value.split("\n")) {
    let remaining = rawLine.replace(/[ \t]+/g, " ").trim();
    if (!remaining) {
      continue;
    }

    while (remaining.length > maxWidth) {
      const slice = remaining.slice(0, maxWidth + 1);
      const breakIndex = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("\t"));
      const cut = breakIndex > Math.floor(maxWidth / 3) ? breakIndex : maxWidth;
      lines.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }

    lines.push(remaining);
  }

  return lines;
}
