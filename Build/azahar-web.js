const DEFAULT_FRONTEND_HTML_URL =
  "https://cdn.jsdelivr.net/gh/SomeRandomFella/Azahar-Web/index.html";
const DEFAULT_FRONTEND_APP_FILE = "app.js";

function resolveElement(target) {
  if (!target) {
    return document.body;
  }
  if (typeof target === "string") {
    const element = document.querySelector(target);
    if (!element) {
      throw new Error(`Could not find mount target: ${target}`);
    }
    return element;
  }
  return target;
}

function ensureTrailingSlash(text) {
  return text.endsWith("/") ? text : `${text}/`;
}

function deriveFrontendBaseUrl(frontendHtmlUrl) {
  return new URL(".", frontendHtmlUrl).href;
}

async function fetchText(url, fetchInit) {
  const response = await fetch(url, fetchInit);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function fetchBytes(url, fetchInit) {
  const response = await fetch(url, fetchInit);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function guessFileName(url, fallback) {
  try {
    const pathname = new URL(url, window.location.href).pathname;
    const leaf = pathname.split("/").filter(Boolean).pop();
    return leaf || fallback;
  } catch {
    return fallback;
  }
}

function forceEmbedMode(html) {
  const embedCheck = 'new URLSearchParams(window.location.search).get("embed") === "1"';
  if (html.includes(embedCheck)) {
    return html.replace(embedCheck, "true");
  }
  return html;
}

function injectHeadMarkup(html, markup) {
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>\n${markup}`);
  }
  return `${markup}\n${html}`;
}

function injectInlineFrontendScript(html, scriptContent) {
  const inlineScript = `<script>\n${scriptContent}\n<\/script>`;
  const scriptTagPattern = /<script[^>]*src=["'][^"']*app\.js["'][^>]*>\s*<\/script>/i;
  if (scriptTagPattern.test(html)) {
    return html.replace(scriptTagPattern, inlineScript);
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${inlineScript}\n</body>`);
  }
  return `${html}\n${inlineScript}`;
}

function patchFrontendScript(scriptContent) {
  return scriptContent.replace(
    /new URL\(([^,]+),\s*window\.location\.href\)/g,
    "new URL($1, window.__AZAHAR_FRONTEND_BASE_URL__ || document.baseURI || window.location.href)",
  );
}

async function prepareFrontendHtml(html, frontendHtmlUrl, fetchInit) {
  const frontendBaseUrl = ensureTrailingSlash(deriveFrontendBaseUrl(frontendHtmlUrl));
  const frontendAppUrl = new URL(DEFAULT_FRONTEND_APP_FILE, frontendBaseUrl).href;
  let prepared = forceEmbedMode(html);
  const headMarkup =
    `<base href="${frontendBaseUrl}">\n` +
    `<script>window.__AZAHAR_SRC_DOC__ = true; window.__AZAHAR_FRONTEND_BASE_URL__ = ${JSON.stringify(frontendBaseUrl)};<\/script>`;
  prepared = injectHeadMarkup(prepared, headMarkup);
  const appScript = await fetchText(frontendAppUrl, fetchInit);
  return injectInlineFrontendScript(prepared, patchFrontendScript(appScript));
}

class AzaharWebPlayer {
  constructor(options = {}) {
    this.options = {
      target: document.body,
      frontendHtmlUrl: DEFAULT_FRONTEND_HTML_URL,
      autoLoadCore: true,
      width: "100%",
      height: "100%",
      iframeTitle: "Azahar Web",
      ...options,
    };
    this.mount = resolveElement(this.options.target);
    this.iframe = null;
    this.app = null;
    this.ready = null;
    this.frontendHtmlPromise = null;
  }

  async fetchFrontendHtml() {
    if (!this.frontendHtmlPromise) {
      this.frontendHtmlPromise = fetchText(
        this.options.frontendHtmlUrl,
        this.options.frontendFetchInit,
      ).then((html) =>
        prepareFrontendHtml(
          html,
          this.options.frontendHtmlUrl,
          this.options.frontendFetchInit,
        ),
      );
    }
    return this.frontendHtmlPromise;
  }

  async init() {
    if (this.ready) {
      return this.ready;
    }

    const iframe = document.createElement("iframe");
    iframe.allow = "fullscreen";
    iframe.style.width = this.options.width;
    iframe.style.height = this.options.height;
    iframe.style.border = "0";
    iframe.style.display = "block";
    iframe.style.background = "#000";
    iframe.title = this.options.iframeTitle;
    this.mount.replaceChildren(iframe);
    this.iframe = iframe;

    this.ready = (async () => {
      const html = await this.fetchFrontendHtml();
      await new Promise((resolve, reject) => {
        iframe.addEventListener("load", resolve, { once: true });
        iframe.addEventListener(
          "error",
          () => reject(new Error("Failed to load Azahar frontend srcdoc")),
          { once: true },
        );
        iframe.srcdoc = html;
      });

      this.app = await this.waitForApp();
      if (this.options.autoLoadCore) {
        await this.app.loadCore();
      }
      if (this.options.sdEntries?.length) {
        await this.importSdEntriesFromUrls(this.options.sdEntries, {
          autoSelectExecutable: false,
        });
      }
      if (this.options.autoBoot) {
        await this.handleAutoBoot(this.options.autoBoot);
      }
      return this;
    })();

    return this.ready;
  }

  async waitForApp(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const app = this.iframe?.contentWindow?.AzaharWebApp;
      if (app) {
        return app;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for Azahar frontend API");
  }

  async call(method, ...args) {
    await this.init();
    const fn = this.app?.[method];
    if (typeof fn !== "function") {
      throw new Error(`Azahar frontend API is missing method: ${method}`);
    }
    return fn(...args);
  }

  async handleAutoBoot(autoBoot) {
    if (autoBoot.homebrew) {
      if (Array.isArray(autoBoot.homebrew)) {
        await this.importSdEntriesFromUrls(autoBoot.homebrew);
      } else {
        await this.bootHomebrewFromUrl(autoBoot.homebrew.url, autoBoot.homebrew);
        return;
      }
    }
    if (autoBoot.romUrl) {
      await this.bootRomFromUrl(autoBoot.romUrl, autoBoot);
    }
  }

  async loadCore() {
    return this.call("loadCore");
  }

  async unloadGame() {
    return this.call("unloadGame");
  }

  async stopCore() {
    return this.call("stopCore");
  }

  async resetCore() {
    return this.call("resetCore");
  }

  async selectRomData(name, bytes, options = {}) {
    return this.call("selectRomData", name, bytes, options);
  }

  async bootSelected() {
    return this.call("bootGame");
  }

  async bootRomData(name, bytes, options = {}) {
    return this.call("bootRomData", name, bytes, options);
  }

  async bootRomFromBuffer(buffer, options = {}) {
    const bytes =
      buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const name = options.name || "game.3ds";
    return this.bootRomData(name, bytes, options);
  }

  async bootRomFromUrl(url, options = {}) {
    const bytes = await fetchBytes(url, options.fetchInit);
    const name = options.name || guessFileName(url, "game.3ds");
    return this.bootRomData(name, bytes, options);
  }

  async bootHomebrewFromUrl(url, options = {}) {
    const bytes = await fetchBytes(url, options.fetchInit);
    const name = options.name || guessFileName(url, "app.3dsx");
    return this.bootRomData(name, bytes, options);
  }

  async bootHomebrewFromBuffer(buffer, options = {}) {
    const bytes =
      buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const name = options.name || "app.3dsx";
    return this.bootRomData(name, bytes, options);
  }

  async importSdEntries(entries, options = {}) {
    return this.call("importSdEntries", entries, options);
  }

  async importSdEntriesFromUrls(entries, options = {}) {
    const resolved = await Promise.all(
      Array.from(entries || []).map(async (entry) => {
        const bytes = await fetchBytes(entry.url, entry.fetchInit);
        return {
          name: entry.name || guessFileName(entry.url, "file.bin"),
          bytes,
          relativePath: entry.relativePath,
          virtualPath: entry.virtualPath,
        };
      }),
    );
    return this.importSdEntries(resolved, options);
  }

  async getState() {
    return this.call("getState");
  }

  destroy() {
    this.app = null;
    this.ready = null;
    if (this.iframe) {
      this.iframe.remove();
      this.iframe = null;
    }
  }
}

async function createAzaharWeb(options = {}) {
  const player = new AzaharWebPlayer(options);
  await player.init();
  return player;
}

const azaharWebApi = { AzaharWebPlayer, createAzaharWeb };

if (typeof globalThis !== "undefined") {
  globalThis.AzaharWeb = azaharWebApi;
  globalThis.AzaharWebPlayer = AzaharWebPlayer;
  globalThis.createAzaharWeb = createAzaharWeb;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = azaharWebApi;
}
