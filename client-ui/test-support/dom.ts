// A tiny DOM stub.
//
// The panel is written against the plain DOM API. Playwright is not always
// installed, so these stubs let the rendering be exercised under `node
// --test` as well. Only the handful of methods the panel actually uses are
// implemented.

/** A stubbed element. */
export class StubElement {
  tagName: string;
  className = "";
  textContent = "";
  title = "";
  value = "";
  hidden = false;
  open = false;
  children: StubElement[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "class") this.className = value;
    if (name === "id") this.id = value;
    if (name === "value") this.value = value;
  }

  getAttribute(name: string): string | null {
    const attribute = this.attributes.get(name);
    if (attribute !== undefined) return attribute;
    if (name === "class") return this.className;
    if (name === "id") return this.id || null;
    if (name === "value") return this.value;
    return null;
  }

  id = "";

  append(...nodes: Array<StubElement | string>): void {
    for (const node of nodes) {
      if (typeof node === "string") this.textContent += node;
      else this.children.push(node);
    }
  }

  replaceChildren(...nodes: StubElement[]): void {
    this.children = [...nodes];
    this.textContent = "";
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
  }

  /** Invokes the handlers registered for `type`. */
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    const payload = { preventDefault() {}, ...event };
    for (const handler of this.listeners.get(type) ?? []) handler(payload);
  }

  focus(): void {}

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
  }
}

/** The stubbed document. */
export class StubDocument {
  elements = new Map<string, StubElement>();

  createElement(tagName: string): StubElement {
    return new StubElement(tagName);
  }

  getElementById(id: string): StubElement | null {
    return this.elements.get(id) ?? null;
  }

  /** Registers an element under an id, like the markup would. */
  register(id: string, tagName = "div"): StubElement {
    const element = new StubElement(tagName);
    element.id = id;
    this.elements.set(id, element);
    return element;
  }
}

/** Depth-first search for an element carrying a data-testid. */
export function findByTestId(root: StubElement, testId: string): StubElement | null {
  for (const child of root.children) {
    if (child.getAttribute("data-testid") === testId) return child;
    const found = findByTestId(child, testId);
    if (found) return found;
  }
  return null;
}

/** Every element carrying a data-testid, in document order. */
export function findAllByTestId(root: StubElement, testId: string): StubElement[] {
  const found: StubElement[] = [];
  for (const child of root.children) {
    if (child.getAttribute("data-testid") === testId) found.push(child);
    found.push(...findAllByTestId(child, testId));
  }
  return found;
}

/** The text of an element and all of its descendants. */
export function textOf(element: StubElement): string {
  let text = element.textContent;
  for (const child of element.children) text += textOf(child);
  return text;
}

/** Installs the stubs as globals and returns the document plus the timers. */
export function installDom(): { document: StubDocument; tick: () => void } {
  const document = new StubDocument();
  const timers: Array<() => void> = [];

  const globals = globalThis as unknown as Record<string, unknown>;
  globals.document = document;
  globals.window = {
    setInterval(handler: () => void): number {
      timers.push(handler);
      return timers.length;
    },
    clearInterval(): void {},
    addEventListener(): void {},
    removeEventListener(): void {},
  };

  return {
    document,
    tick: () => {
      for (const handler of timers) handler();
    },
  };
}
