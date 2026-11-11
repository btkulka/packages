import { createRoot, type Root } from "react-dom/client";
import { httpTransport } from "../client/index.js";
import type { NewChatOptions } from "../types.js";
import { ClaudeProvider } from "../react/context.js";
import { askClaude, ClaudeWidget } from "../react/widget.js";
// The stylesheet as text (esbuild's text loader), for the shadow root.
import css from "../styles.css";

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
// From script anywhere: window.dispatchEvent(new CustomEvent("claude-kit:open",
// { detail: { text, context, about } })).

class ClaudeWidgetElement extends HTMLElement {
  static observedAttributes = ["base", "variant", "hotkey", "title", "theme", "width"];
  private root?: Root;
  private shell?: HTMLDivElement;
  private portal?: HTMLDivElement;

  connectedCallback() {
    if (this.root) return this.draw();
    const shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = css;
    this.shell = document.createElement("div");
    this.portal = document.createElement("div");
    this.portal.className = "ck-portal";
    shadow.append(style, this.shell, this.portal);
    this.root = createRoot(this.shell);
    this.draw();
  }

  disconnectedCallback() {
    // Moved within the page, it's connected again at once; only really gone does it unmount.
    queueMicrotask(() => {
      if (this.isConnected || !this.root) return;
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
