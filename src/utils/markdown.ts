import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import type { Node, Point, Position } from "unist";

export interface MarkdownPosition {
  line?: number;
  column?: number;
}

export interface ExtractedLink {
  url: string;
  kind: "link" | "image" | "definition" | "html";
  position?: MarkdownPosition;
  rawText?: string;
}

export interface ExtractedReference {
  identifier: string;
  kind: "linkReference" | "imageReference" | "textPattern";
  position?: MarkdownPosition;
}

export interface ExtractedCode {
  value: string;
  lang?: string;
  isInline: boolean;
  position?: MarkdownPosition;
}

export interface ParsedMarkdown {
  content: string;
  links: ExtractedLink[];
  definitions: Map<string, { url: string; position?: MarkdownPosition }>;
  references: ExtractedReference[];
  anchors: Set<string>;
  codes: ExtractedCode[];
}

/**
 * Convert a heading string into a GitHub-compatible markdown anchor slug.
 */
export function slugifyHeading(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    // Remove characters that GitHub markdown strips from anchors
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/\s+/g, "-");
}

/**
 * Extract plain text content from an AST node and its children.
 */
function getNodeText(node: any): string {
  if (!node) return "";
  if (node.value) return node.value;
  if (Array.isArray(node.children)) {
    return node.children.map(getNodeText).join("");
  }
  return "";
}

/**
 * Extract HTML anchors from raw HTML tags (e.g. <a name="...", id="...">, <span id="...">).
 */
function extractHtmlAnchors(html: string): string[] {
  const anchors: string[] = [];
  const idRegex = /\b(?:id|name)=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = idRegex.exec(html)) !== null) {
    if (match[1]) {
      anchors.push(match[1].toLowerCase());
    }
  }
  return anchors;
}

/**
 * Extract href/src attributes from HTML tags.
 */
function extractHtmlLinks(
  html: string,
  basePos?: MarkdownPosition
): { url: string; kind: "link" | "image"; position?: MarkdownPosition }[] {
  const links: { url: string; kind: "link" | "image"; position?: MarkdownPosition }[] = [];
  const hrefRegex = /<(?:a|link)[^>]*\bhref=["']([^"']+)["']/gi;
  const srcRegex = /<(?:img|script|source)[^>]*\bsrc=["']([^"']+)["']/gi;

  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    if (match[1]) {
      links.push({ url: match[1], kind: "link", position: basePos });
    }
  }
  while ((match = srcRegex.exec(html)) !== null) {
    if (match[1]) {
      links.push({ url: match[1], kind: "image", position: basePos });
    }
  }
  return links;
}

/**
 * Parse Markdown document and extract links, definitions, references, anchors, and code.
 */
export function parseMarkdown(content: string): ParsedMarkdown {
  const tree = unified().use(remarkParse).parse(content);

  const links: ExtractedLink[] = [];
  const definitions = new Map<string, { url: string; position?: MarkdownPosition }>();
  const references: ExtractedReference[] = [];
  const anchors = new Set<string>();
  const codes: ExtractedCode[] = [];

  const slugCounts = new Map<string, number>();

  visit(tree, (node: any) => {
    const pos: MarkdownPosition | undefined = node.position?.start
      ? { line: node.position.start.line, column: node.position.start.column }
      : undefined;

    switch (node.type) {
      case "link": {
        if (node.url) {
          links.push({
            url: node.url,
            kind: "link",
            position: pos,
            rawText: getNodeText(node),
          });
        }
        break;
      }
      case "image": {
        if (node.url) {
          links.push({
            url: node.url,
            kind: "image",
            position: pos,
            rawText: node.alt || "",
          });
        }
        break;
      }
      case "definition": {
        const id = (node.identifier || "").toLowerCase();
        if (id) {
          definitions.set(id, { url: node.url, position: pos });
        }
        if (node.url) {
          links.push({
            url: node.url,
            kind: "definition",
            position: pos,
          });
        }
        break;
      }
      case "linkReference": {
        const id = (node.identifier || "").toLowerCase();
        references.push({
          identifier: id,
          kind: "linkReference",
          position: pos,
        });
        break;
      }
      case "imageReference": {
        const id = (node.identifier || "").toLowerCase();
        references.push({
          identifier: id,
          kind: "imageReference",
          position: pos,
        });
        break;
      }
      case "heading": {
        const headingText = getNodeText(node);
        const baseSlug = slugifyHeading(headingText);
        if (baseSlug) {
          const count = slugCounts.get(baseSlug) || 0;
          slugCounts.set(baseSlug, count + 1);
          const finalSlug = count === 0 ? baseSlug : `${baseSlug}-${count}`;
          anchors.add(finalSlug);
        }
        break;
      }
      case "html": {
        const html = node.value || "";
        for (const anchor of extractHtmlAnchors(html)) {
          anchors.add(anchor);
        }
        for (const htmlLink of extractHtmlLinks(html, pos)) {
          links.push({
            url: htmlLink.url,
            kind: htmlLink.kind,
            position: htmlLink.position,
          });
        }
        break;
      }
      case "code": {
        codes.push({
          value: node.value || "",
          lang: node.lang || undefined,
          isInline: false,
          position: pos,
        });
        break;
      }
      case "inlineCode": {
        codes.push({
          value: node.value || "",
          isInline: true,
          position: pos,
        });
        break;
      }
      case "text": {
        // Find reference-style link patterns in raw text like [foo][bar] or [bar][]
        // that CommonMark parser didn't resolve because of missing definitions
        const text = node.value || "";
        const refPattern = /\[([^\]]+)\]\[([^\]]*)\]/g;
        let match: RegExpExecArray | null;
        while ((match = refPattern.exec(text)) !== null) {
          const textPart = match[1];
          const targetPart = match[2];
          const identifier = (targetPart.trim() || textPart.trim()).toLowerCase();
          references.push({
            identifier,
            kind: "textPattern",
            position: pos,
          });
        }
        break;
      }
    }
  });

  return {
    content,
    links,
    definitions,
    references,
    anchors,
    codes,
  };
}
