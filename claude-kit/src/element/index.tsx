import { createRoot, type Root } from "react-dom/client";
import { httpTransport } from "../client/index.js";
import type { NewChatOptions } from "../types.js";
import { ClaudeProvider } from "../react/context.js";
import { askClaude, ClaudeWidget } from "../react/widget.js";
// The stylesheet as text (esbuild's text loader), for the shadow root.
import kit from "../styles.css";
import frame from "@btkulka/chat-blocks/frame.css";

/** The kit's stylesheet with chat-blocks' frame after it (blocks), as dist/styles.css has them. */
const css = `${kit}
${frame}`;

// <claude-widget>: the corner button and its drawer for a page without React
// (an express + EJS app). React rides inside this bundle, and the widget lives
// in a shadow root, so the page's styles and its own don't meet.
//
//   <script type="module" src="/claude/element.js"></script>
//   <claude-widget></claude-widget>
//
// Attributes: base (the http handler's path, "/claude"), variant ("drawer" or
// "float"), hotkey ("ctrl+shift+k"), title ("Claude"), theme ("light", "dark",
// or the system's), width (px). Methods: open(options?), close(), toggle().
// Theming: any --ck-* variable the page sets on the element (in a media query
// too, like --ck-fab-bottom above a tab bar) reaches the widget inside.
// From script anywhere: window.dispatchEvent(new CustomEvent("claude-kit:open",
// { detail: { text, context, about } })).

/** Every --ck-* variable the stylesheet uses: the ones a page may set on the element. */
const VARS = [...new Set(css.match(/--ck-[a-z0-9-]+/g) ?? [])];

class ClaudeWidgetElement extends HTMLElement {
  // style too: a page setting --ck-* inline (hiding the button while its own sheet is open) takes effect at once.
  static observedAttributes = ["base", "variant", "hotkey", "title", "theme", "width", "style"];
  private root?: Root;
  private shell?: HTMLDivElement;
  private portal?: HTMLDivElement;
  private hostVars?: HTMLStyleElement;
  private frame = 0;

  /** The page's --ck-* values on this element, set on the widget's roots (above the stylesheet's :where() defaults). */
  private applyVars = () => {
    this.frame = 0;
    if (!this.hostVars) return;
    const cs = getComputedStyle(this);
    const decl = VARS.map((n) => [n, cs.getPropertyValue(n).trim()] as const)
      .filter(([, v]) => v)
      .map(([n, v]) => `${n}: ${v};`)
      .join(" ");
    const text = decl ? `.ck-root, .ck-portal { ${decl} }` : "";
    if (this.hostVars.textContent !== text) this.hostVars.textContent = text;
  };
  private onResize = () => {
    if (!this.frame) this.frame = requestAnimationFrame(this.applyVars);
  };

  connectedCallback() {
    if (this.root) return this.draw();
    const shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = css;
    this.hostVars = document.createElement("style");
    this.shell = document.createElement("div");
    this.portal = document.createElement("div");
    this.portal.className = "ck-portal";
    shadow.append(style, this.hostVars, this.shell, this.portal);
    this.root = createRoot(this.shell);
    window.addEventListener("resize", this.onResize);
    this.draw();
  }

  disconnectedCallback() {
    // Moved within the page, it's connected again at once; only really gone does it unmount.
    queueMicrotask(() => {
      if (this.isConnected || !this.root) return;
      window.removeEventListener("resize", this.onResize);
      this.root.unmount();
      this.root = undefined;
    });
  }

  attributeChangedCallback() {
    if (this.root) this.draw();
  }

  open(o?: NewChatOptions) {
    askClaude(o ?? {});
  }

  close() {
    askClaude(false);
  }

  toggle() {
    const open = localStorage.getItem("claude-kit:open") === "1";
    if (open) this.close();
    else this.open();
  }

  private transport?: ReturnType<typeof httpTransport>;
  private transportBase?: string;

  private draw() {
    const base = this.getAttribute("base") || "/claude";
    if (!this.transport || this.transportBase !== base) {
      this.transport = httpTransport(base);
      this.transportBase = base;
    }
    const theme = this.getAttribute("theme");
    if (theme) this.shell!.dataset.ckTheme = theme;
    else delete this.shell!.dataset.ckTheme;
    if (theme) this.portal!.dataset.ckTheme = theme;
    else delete this.portal!.dataset.ckTheme;
    this.applyVars();
    const width = Number(this.getAttribute("width")) || undefined;
    const portal = this.portal!;
    this.root!.render(
      <ClaudeProvider transport={this.transport} ui={{ title: this.getAttribute("title") || "Claude", portal: () => portal }}>
        <ClaudeWidget variant={this.getAttribute("variant") === "float" ? "float" : "drawer"} hotkey={this.getAttribute("hotkey") ?? undefined} width={width} />
      </ClaudeProvider>,
    );
  }
}

if (!customElements.get("claude-widget")) customElements.define("claude-widget", ClaudeWidgetElement);

export { ClaudeWidgetElement, askClaude };
