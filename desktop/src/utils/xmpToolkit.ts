/**
 * XMP packet parser for this app — the XMPCore half of Adobe's
 * XMP Toolkit (https://github.com/adobe/XMP-Toolkit-SDK/).
 *
 * The official SDK is C++ (XMPCore + XMPFiles) and is not an npm
 * module. This implements the same data model the Toolkit uses:
 * RDF/XML serialization, namespace URIs, rdf:Description bags,
 * rdf:Seq / rdf:Bag / rdf:Alt arrays, and xml:lang Alt text.
 *
 * Camera Raw *develop* (turning crs: sliders into a LUT) is not part
 * of the Toolkit; that stays in lightroomXmp.ts.
 */

export const XMP_NS = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  crs: "http://ns.adobe.com/camera-raw-settings/1.0/",
  x: "adobe:ns:meta/",
  dc: "http://purl.org/dc/elements/1.1/",
  photoshop: "http://ns.adobe.com/photoshop/1.0/",
} as const;

function localName(node: Node): string {
  const el = node as Element;
  if (el.localName) return el.localName;
  const n = el.nodeName || "";
  const i = n.indexOf(":");
  return i >= 0 ? n.slice(i + 1) : n;
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function nsUri(el: Element): string {
  return (el.namespaceURI || "").toLowerCase();
}

function isNs(el: Element, uri: string): boolean {
  const u = nsUri(el);
  if (u && u === uri.toLowerCase()) return true;
  if (uri === XMP_NS.crs && /camera-raw-settings/i.test(el.nodeName)) return true;
  if (uri === XMP_NS.rdf && /(^|:)rdf$/i.test(el.prefix || "")) return true;
  return false;
}

function walkElements(root: Element): Element[] {
  const out: Element[] = [];
  const stack: Element[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    out.push(el);
    const kids = el.children;
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return out;
}

function textContentTrim(el: Element): string {
  return (el.textContent || "").replace(/\s+/g, " ").trim();
}

function firstLangAlt(el: Element): string {
  const items = [...el.getElementsByTagNameNS(XMP_NS.rdf, "li")];
  const fallback = [...el.getElementsByTagName("rdf:li")];
  const lis = items.length ? items : fallback;
  if (!lis.length) return textContentTrim(el);
  const def = lis.find(
    (li) =>
      li.getAttribute("xml:lang") === "x-default" ||
      li.getAttributeNS("http://www.w3.org/XML/1998/namespace", "lang") ===
        "x-default",
  );
  return textContentTrim(def || lis[0]!);
}

export class XMPMeta {
  private readonly descriptions: Element[];

  private constructor(descriptions: Element[]) {
    this.descriptions = descriptions;
  }

  /** Parse an XMP packet or sidecar .xmp (UTF-8/UTF-16 already decoded). */
  static parse(xml: string): XMPMeta | null {
    const trimmed = xml.replace(/^\uFEFF/, "").trim();
    if (!trimmed) return null;
    const doc = new DOMParser().parseFromString(trimmed, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return null;
    const root = doc.documentElement;
    if (!root) return null;
    const all = walkElements(root);
    const descriptions = all.filter(
      (el) =>
        localName(el) === "Description" &&
        (isNs(el, XMP_NS.rdf) || /rdf/i.test(el.nodeName)),
    );
    if (!descriptions.length) return null;
    return new XMPMeta(descriptions);
  }

  hasCameraRaw(): boolean {
    return this.descriptions.some((desc) => {
      if ([...desc.attributes].some((a) => /camera-raw-settings/i.test(a.value)))
        return true;
      if (
        [...desc.attributes].some(
          (a) => a.localName !== "xmlns" && /crs:/i.test(a.name),
        )
      )
        return true;
      return [...desc.children].some(
        (el) =>
          isNs(el, XMP_NS.crs) ||
          localName(el) === "Version" ||
          localName(el) === "ProcessVersion" ||
          localName(el) === "HasSettings",
      );
    });
  }

  /**
   * XMPCore GetProperty — simple value from the crs (or given) namespace.
   * Checks RDF attributes then child elements.
   */
  getProperty(name: string, ns: string = XMP_NS.crs): string | null {
    for (const desc of this.descriptions) {
      const attr =
        desc.getAttributeNS(ns, name) ||
        desc.getAttribute(`crs:${name}`) ||
        desc.getAttribute(name);
      if (attr != null && attr !== "") return attr.trim();

      for (const child of [...desc.children]) {
        if (localName(child) !== name) continue;
        if (ns === XMP_NS.crs && !isNs(child, XMP_NS.crs) && child.namespaceURI)
          continue;
        const kids = [...child.children].filter(isElement);
        if (kids.some((k) => localName(k) === "Alt")) {
          return firstLangAlt(child);
        }
        const seq = kids.find(
          (k) => localName(k) === "Seq" || localName(k) === "Bag",
        );
        if (seq) {
          const li = [...seq.children].find((k) => localName(k) === "li");
          if (li) return textContentTrim(li);
        }
        const t = textContentTrim(child);
        if (t) return t;
      }
    }
    return null;
  }

  getNumber(name: string, fallback = 0): number {
    const raw = this.getProperty(name);
    if (raw == null || raw === "") return fallback;
    const n = parseFloat(raw.replace(/^\+/, ""));
    return Number.isFinite(n) ? n : fallback;
  }

  getBoolean(name: string): boolean {
    return /true/i.test(this.getProperty(name) || "");
  }

  hasProperty(name: string): boolean {
    return this.getProperty(name) != null;
  }

  /**
   * XMPCore array walk — rdf:Seq / rdf:Bag items under crs:name.
   */
  getArrayItems(name: string, ns: string = XMP_NS.crs): string[] {
    for (const desc of this.descriptions) {
      for (const child of [...desc.children]) {
        if (localName(child) !== name) continue;
        if (ns === XMP_NS.crs && child.namespaceURI && !isNs(child, XMP_NS.crs))
          continue;
        const items: string[] = [];
        const lis = [
          ...child.getElementsByTagNameNS(XMP_NS.rdf, "li"),
          ...[...child.getElementsByTagName("rdf:li")],
        ];
        const seen = new Set<Element>();
        for (const li of lis) {
          if (seen.has(li)) continue;
          seen.add(li);
          const t = textContentTrim(li);
          if (t) items.push(t);
        }
        if (items.length) return items;
      }
    }
    return [];
  }

  getLocalizedName(): string {
    const crsName = this.getProperty("Name");
    if (crsName) return crsName;
    for (const desc of this.descriptions) {
      for (const child of [...desc.children]) {
        if (localName(child) === "title" && isNs(child, XMP_NS.dc)) {
          const t = firstLangAlt(child);
          if (t) return t;
        }
      }
    }
    return "";
  }
}
