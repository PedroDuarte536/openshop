// @ts-check
/* OpenShop storefront script.
 *
 * Shows the visitor's prices and offers, loaded from the shop API. It never computes a price: it only displays what
 * the server returns, and the server recalculates everything when an order is placed. If anything fails, the list
 * prices already in the page stay as they are.
 *
 * The DOM is built with createElement/textContent only (the page's CSP enforces Trusted Types, so HTML-injection
 * sinks such as innerHTML are blocked).
 */
(() => {
  "use strict";

  /** @typedef {{ discountId?: string, label: string, source: string, sourceLabel?: string }} OfferRef */
  /** @typedef {OfferRef & { unitCents: number, status: string, pending: boolean, condition?: { minSubtotalCents?: number, minQty?: number }, endsAt: string | null }} LineOffer */
  /** @typedef {{ showOriginalPrice: boolean, showBadge: boolean, showAlternatives: boolean }} Display */

  const currency = document.querySelector('meta[name="os-currency"]')?.getAttribute("content") || "€";
  /** @param {number} cents */
  const money = (cents) => `${cents < 0 ? "−" : ""}${currency}${(Math.abs(cents) / 100).toFixed(2)}`;

  /**
   * @param {string} tag
   * @param {Record<string, string | boolean | undefined>} [attrs]
   * @param {...(Node | string | null | undefined | false)} children
   * @returns {HTMLElement}
   */
  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false) continue;
      if (k === "class") e.className = String(v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
    return e;
  }

  /**
   * @param {string} method
   * @param {string} url
   * @param {unknown} [body]
   * @returns {Promise<any>}
   */
  async function api(method, url, body) {
    const res = await fetch(url, {
      method, credentials: "same-origin", cache: "no-store",
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong. Please try again."), { status: res.status });
    return data;
  }

  const SOURCE = /** @type {Record<string, string>} */ ({
    shop: "Shop-wide offer", product: "Offer on this product", category: "Category offer",
    customer: "Your personal price", profile: "Member price", code: "Discount code", members: "For signed-in customers",
  });
  /** @param {OfferRef} o */
  const sourceText = (o) => (o.sourceLabel ? o.sourceLabel : SOURCE[o.source] || "Offer");

  /** "Until 31 Dec, 23:59 (Lisbon time)": the end is exclusive, so show the last minute, in the shop's time zone. */
  function until(/** @type {string | null} */ iso, /** @type {string} */ tz) {
    if (!iso) return "";
    const last = new Date(Date.parse(iso) - 60_000);
    try {
      const f = new Intl.DateTimeFormat(undefined, { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
      return `Until ${f.format(last)} (${tz.split("/").pop()?.replace(/_/g, " ")} time)`;
    } catch { return ""; }
  }

  /** Price element: new price, the original struck through, and a % badge (each can be turned off by the shop). */
  function salePrice(/** @type {number} */ now, /** @type {number} */ list, /** @type {Display} */ display, /** @type {number | null} */ badge) {
    /** @type {Node[]} */
    const parts = [el("span", { class: "os-now" }, money(now))];
    if (display.showOriginalPrice) parts.push(document.createTextNode(" "), el("s", { class: "os-was" }, el("span", { class: "os-sr" }, "Original price "), money(list)));
    if (display.showBadge && badge) parts.push(document.createTextNode(" "), el("span", { class: "os-badge" }, `−${badge}%`));
    return parts;
  }

  /** @param {LineOffer} o */
  function offerNote(o) {
    if (o.status === "condition" && o.condition) {
      if (o.condition.minSubtotalCents) return `On orders from ${money(o.condition.minSubtotalCents)}`;
      if (o.condition.minQty) return `When you buy ${o.condition.minQty} or more`;
    }
    if (o.status === "better_offer_applied") return "Also applies; your best price is used";
    if (o.status === "declined") return "Saved for later";
    if (o.status === "not_in_scenario") return "Not used with your current choice";
    return "";
  }

  // ---------------------------------------------------------------- product prices (grids, product pages)

  async function productPrices() {
    const priceEls = /** @type {HTMLElement[]} */ ([...document.querySelectorAll("[data-os-price]")]);
    const boxes = /** @type {HTMLElement[]} */ ([...document.querySelectorAll("[data-os-offers]")]);
    // Product pages designed before the Offers widget existed: add a box under the main price.
    if (!boxes.length) {
      const main = /** @type {HTMLElement | null} */ (document.querySelector(".os-price[data-os-price]"));
      if (main) {
        const box = el("div", { class: "os-offers", "data-os-offers": main.dataset.osPrice, "data-heading": "Offers", "aria-live": "polite", hidden: true });
        main.after(box);
        boxes.push(box);
      }
    }
    const ids = [...new Set([...priceEls.map((e) => e.dataset.osPrice), ...boxes.map((e) => e.dataset.osOffers)].filter((x) => !!x))];
    if (!ids.length) return;
    for (let i = 0; i < ids.length; i += 100) {
      const data = await api("GET", `/api/shop/prices?ids=${encodeURIComponent(ids.slice(i, i + 100).join(","))}`);
      /** @type {Display} */ const display = data.display;
      const byId = new Map(data.items.map((/** @type {any} */ it) => [it.productId, it]));
      for (const e of priceEls) {
        const it = byId.get(e.dataset.osPrice);
        if (!it || it.priceCents >= it.listCents) continue;
        e.replaceChildren(...salePrice(it.priceCents, it.listCents, display, it.badge));
        if (it.appliedFrom) e.title = `${it.appliedFrom.label} (${sourceText(it.appliedFrom)})`;
        e.classList.add("os-has-offer");
      }
      for (const box of boxes) {
        const it = byId.get(box.dataset.osOffers);
        if (!it) continue;
        const rows = [];
        if (it.appliedFrom) {
          const note = [`Applied · ${sourceText(it.appliedFrom)}`, until(it.endsAt, data.timezone), it.pending ? "Checked when you place your order" : ""].filter(Boolean).join(" · ");
          rows.push(el("p", { class: "os-offer os-offer--on" }, el("b", {}, it.appliedFrom.label), el("span", {}, money(it.priceCents)), el("small", {}, note)));
        }
        if (display.showAlternatives) {
          for (const /** @type {LineOffer} */ o of it.alternatives) {
            rows.push(el("p", { class: "os-offer" }, el("b", {}, o.label), el("span", {}, money(o.unitCents)), el("small", {}, [sourceText(o), offerNote(o), until(o.endsAt, data.timezone)].filter(Boolean).join(" · "))));
          }
        }
        if (!rows.length) continue;
        box.replaceChildren(el("p", { class: "os-offers-h" }, box.dataset.heading || "Offers"), ...rows);
        box.hidden = false;
      }
    }
  }

  // ---------------------------------------------------------------- cart

  const CODE_MESSAGES = /** @type {Record<string, (c: any) => string>} */ ({
    invalid: () => "This code isn't valid.",
    min_subtotal: (c) => `Add ${money(c.missingCents)} more to use code ${c.code}.`,
    min_qty: (c) => `Buy at least ${c.minQty} eligible items to use code ${c.code}.`,
    no_matching_items: (c) => `Code ${c.code} doesn't apply to the items in your cart.`,
    other_scenario: (c) => `Code ${c.code} can't be combined with the automatic offers. Choose above which one to use.`,
    better_offer: (c) => `Your prices are already better than code ${c.code} gives.`,
  });

  /** @param {HTMLElement} panel */
  function cartPage(panel) {
    let busy = false;
    /** @type {any} */ let state = null;
    let message = { text: "", bad: false };

    /** @param {() => Promise<any>} fn */
    async function act(fn) {
      if (busy) return;
      busy = true;
      try { state = await fn(); message = { text: "", bad: false }; }
      catch (err) { message = { text: err instanceof Error ? err.message : String(err), bad: true }; }
      finally { busy = false; render(); }
    }

    function render() {
      if (!state) return;
      const display = /** @type {Display} */ (state.display);
      // per-line prices and where they come from
      for (const l of state.lines) {
        const cell = /** @type {HTMLElement | null} */ (document.querySelector(`[data-os-line-total="${CSS.escape(l.productId)}"]`));
        if (cell) cell.replaceChildren(...(l.lineCents < l.lineListCents ? salePrice(l.lineCents, l.lineListCents, display, null) : [money(l.lineListCents)]));
        const info = /** @type {HTMLElement | null} */ (document.querySelector(`[data-os-line-offers="${CSS.escape(l.productId)}"]`));
        if (!info) continue;
        const kids = [];
        if (l.appliedFrom) kids.push(el("div", {}, `${l.appliedFrom.label} · ${sourceText(l.appliedFrom)}`));
        const others = l.offers.filter((/** @type {LineOffer} */ o) => o.status !== "applied");
        if (display.showAlternatives && l.offers.length > 1 || (others.length && !l.appliedFrom)) {
          kids.push(el("details", {},
            el("summary", {}, `${l.offers.length} ${l.offers.length === 1 ? "offer applies" : "offers apply"} to this item`),
            el("ul", {}, ...l.offers.map((/** @type {LineOffer} */ o) => el("li", {}, `${o.label}: ${money(o.unitCents)} each${o.status === "applied" ? " (applied)" : offerNote(o) ? ` (${offerNote(o)})` : ""}`)))));
        }
        info.replaceChildren(...kids);
      }
      const total = /** @type {HTMLElement | null} */ (document.querySelector("[data-os-cart-total]"));
      if (total) total.replaceChildren(...(state.totalCents < state.subtotalCents ? salePrice(state.totalCents, state.subtotalCents, display, null) : [money(state.subtotalCents)]));
      const quote = /** @type {HTMLInputElement | null} */ (document.querySelector("[data-os-quote]"));
      if (quote) quote.value = state.quote;

      const blocks = [];
      // what is applied, and what is left of limited offers
      if (state.applied.length) {
        blocks.push(el("fieldset", {}, el("legend", {}, `Your savings: ${money(state.discountCents)}`),
          ...state.applied.map((/** @type {any} */ a) => {
            const notes = [sourceText(a)];
            if (a.code) notes.push(`code ${a.code}`);
            if (a.remaining?.amountCents != null) notes.push(`${money(a.remaining.amountCents)} left after this order`);
            if (a.remaining?.orders != null) notes.push(`${a.remaining.orders} more ${a.remaining.orders === 1 ? "use" : "uses"} after this order`);
            if (a.pending) notes.push("checked when you place your order");
            return el("p", { class: "os-msg" }, el("b", {}, `${a.label}: −${money(a.cents)}`), ` (${notes.join(", ")})`);
          })));
      }
      // a code that can't be combined with automatic offers: show both totals and let the shopper pick
      if (state.scenarios.length) {
        blocks.push(el("fieldset", {}, el("legend", {}, "Choose how to save"),
          ...state.scenarios.map((/** @type {any} */ s) => {
            const input = /** @type {HTMLInputElement} */ (el("input", { type: "radio", name: "os-scenario", value: s.key, checked: s.selected }));
            input.addEventListener("change", () => act(() => api("PUT", "/api/shop/cart/selection", { scenario: s.key })));
            return el("label", {}, input, el("span", {}, el("b", {}, s.title), `: total ${money(s.totalCents)} (you save ${money(s.savingsCents)})${s.best ? ", best price" : ""}`));
          })));
      }
      // offers with a per-customer limit can be kept for a later order
      if (state.choices.length) {
        blocks.push(el("fieldset", {}, el("legend", {}, "Limited offers"),
          ...state.choices.map((/** @type {any} */ c) => {
            const box = /** @type {HTMLInputElement} */ (el("input", { type: "checkbox", checked: !c.declined }));
            box.addEventListener("change", () => {
              const declined = new Set(state.selection.declined || []);
              if (box.checked) declined.delete(c.discountId); else declined.add(c.discountId);
              act(() => api("PUT", "/api/shop/cart/selection", { declined: [...declined] }));
            });
            return el("label", {}, box, el("span", {}, `Use ${c.label} on this order`, el("small", {}, ` (total ${c.declined ? "if you use it" : "if you save it for later"}: ${money(c.totalIfToggled)})`)));
          })));
      }
      // discount code
      const code = state.codes[0];
      const input = /** @type {HTMLInputElement} */ (el("input", { name: "code", placeholder: "Discount code", "aria-label": "Discount code", autocomplete: "off", maxlength: "32" }));
      const form = el("form", { class: "os-codeform" }, input, el("button", { type: "submit" }, "Apply"));
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const value = input.value.trim();
        if (value) act(() => api("POST", "/api/shop/cart/codes", { code: value }));
      });
      const codeBlock = [form];
      // Signed-in customers: their personal codes, one click to use.
      if (state.personalCodes?.length) {
        codeBlock.push(el("p", { class: "os-msg" }, "Your codes:"));
        for (const pc of state.personalCodes) {
          const use = el("button", { type: "button", class: "os-linkbtn" }, `Use ${pc.code}`);
          use.addEventListener("click", () => act(() => api("POST", "/api/shop/cart/codes", { code: pc.code })));
          codeBlock.push(el("p", { class: "os-msg" }, use, ` ${pc.label} (${pc.description})`));
        }
      }
      if (code) {
        const remove = el("button", { type: "button", class: "os-linkbtn" }, "Remove");
        remove.addEventListener("click", () => act(() => api("DELETE", `/api/shop/cart/codes/${encodeURIComponent(code)}`)));
        codeBlock.push(el("p", { class: "os-msg" }, `Code ${code} added. `, remove));
      }
      // "Choose above" and "you already have better prices" are information, not errors.
      for (const r of state.rejectedCodes) codeBlock.push(el("p", { class: r.reason === "other_scenario" || r.reason === "better_offer" ? "os-msg" : "os-msg os-msg--bad" }, (CODE_MESSAGES[r.reason] || CODE_MESSAGES.invalid)(r)));
      if (message.text) codeBlock.push(el("p", { class: `os-msg${message.bad ? " os-msg--bad" : ""}`, role: "alert" }, message.text));
      blocks.push(el("fieldset", {}, el("legend", {}, "Discount code"), ...codeBlock));
      panel.replaceChildren(...blocks);
    }

    act(() => api("GET", "/api/shop/cart"));
  }

  // ---------------------------------------------------------------- account: "Your offers"

  /** @param {HTMLElement} box */
  async function accountOffers(box) {
    try {
      const data = await api("GET", "/api/shop/account/offers");
      /** @param {any} r */
      const left = (r) => [
        r?.amountCents != null ? `${money(r.amountCents)} of discount left` : "",
        r?.orders != null ? `${r.orders} ${r.orders === 1 ? "use" : "uses"} left` : "",
        r?.firstOrdersLeft != null ? (r.firstOrdersLeft > 0 ? "for your next order" : "already used") : "",
      ].filter(Boolean).join(" · ");
      const blocks = [];
      if (data.profiles.length) {
        blocks.push(el("p", { class: "os-msg" }, "You are a member of: ", ...data.profiles.map((/** @type {any} */ p, /** @type {number} */ i) =>
          el("b", {}, `${i ? ", " : ""}${p.label}${p.validUntil ? ` (${until(p.validUntil, data.timezone).replace(/^Until/, "until")})` : ""}`))));
      }
      const rows = [
        ...data.offers.map((/** @type {any} */ o) => el("p", { class: "os-offer" }, el("b", {}, o.label), el("span", {}, o.description),
          el("small", {}, [o.sourceLabel || SOURCE[o.source] || "For you", o.appliesTo, left(o.remaining), until(o.endsAt, data.timezone), "Applied automatically in your cart"].filter(Boolean).join(" · ")))),
        ...data.codes.map((/** @type {any} */ c) => el("p", { class: "os-offer" }, el("b", {}, c.label), el("span", {}, c.description),
          el("small", {}, [`Your code ${c.code}`, c.appliesTo, left(c.remaining), until(c.endsAt, data.timezone), "Use it from your cart in one click"].filter(Boolean).join(" · ")))),
      ];
      if (rows.length) blocks.push(el("div", { class: "os-offers" }, ...rows));
      else blocks.push(el("p", { class: "os-msg" }, "No personal offers right now. Shop-wide offers are shown next to prices."));
      box.replaceChildren(...blocks);
    } catch (err) {
      box.replaceChildren(el("p", { class: "os-msg" }, "Your offers couldn't be loaded. They are still applied in your cart."));
    }
  }

  // ---------------------------------------------------------------- search and category pages

  /** Filters and sorting apply as soon as they change (the Apply buttons stay for visitors without JavaScript). */
  function liveFilters() {
    for (const form of /** @type {HTMLFormElement[]} */ ([...document.querySelectorAll("form[data-os-filters], form[data-os-sort]")])) {
      for (const b of /** @type {HTMLElement[]} */ ([...form.querySelectorAll(".os-apply")])) b.hidden = true;
      form.addEventListener("change", () => form.requestSubmit());
    }
  }

  /** A product card, like the server renders it. Links only to product pages; the price is filled in by productPrices. */
  function card(/** @type {any} */ it) {
    const href = typeof it.href === "string" && /^\/shop\/product\/[A-Za-z0-9_-]{1,64}$/.test(it.href) ? it.href : null;
    const img = typeof it.image === "string" && /^(\/uploads\/[A-Za-z0-9._-]+|https:\/\/[^\s"'()<>\\]+)$/.test(it.image)
      ? el("img", { src: it.image, alt: String(it.name), loading: "lazy", decoding: "async" }) : el("div", { class: "os-art os-art--plain" });
    return el(href ? "a" : "div", { class: "os-pc", href: href ?? undefined },
      el("div", { class: "os-pc-img" }, img),
      el("div", {}, el("div", { class: "os-pc-n" }, String(it.name)), el("div", { class: "os-pc-p", "data-os-price": String(it.id) }, money(it.listCents)),
        it.soldOut ? el("div", { class: "os-pc-s" }, "Out of stock") : null));
  }

  /**
   * Results sorted or filtered by price: the page was rendered with list prices (it may be cached, so it holds nothing
   * personal). The order and the matches by the visitor's own prices come from the API, and replace the results.
   */
  async function personalResults(/** @type {HTMLElement} */ box) {
    const data = await api("GET", `/api/shop/search?${box.dataset.osSearch}`);
    const cols = box.dataset.osCols || "3";
    const parts = [];
    if (data.corrected) parts.push(el("p", { class: "os-corrected" }, "Showing results for ", el("b", {}, String(data.corrected))));
    if (data.items.length) {
      parts.push(el("div", { class: `os-pg os-pg-${cols}`, "data-os-results": true }, ...data.items.map(card)));
      if (data.pages > 1) {
        const url = new URL(location.href);
        const at = (/** @type {number} */ n) => { url.searchParams.set("page", String(n)); return `${url.pathname}${url.search}`; };
        const links = [];
        for (let n = 1; n <= data.pages; n++) links.push(n === data.page ? el("span", { "aria-current": "page" }, String(n)) : el("a", { href: at(n) }, String(n)));
        parts.push(el("nav", { class: "os-pager", "aria-label": "Pages" }, ...links));
      }
    } else parts.push(el("p", { class: "os-note" }, "No products match at your prices. Try a wider price range or fewer filters."));
    box.className = box.className.replace(/\bos-note\b/, "os-pgw");
    box.replaceChildren(...parts);
    for (const c of /** @type {HTMLElement[]} */ ([...document.querySelectorAll("[data-os-count]")])) c.textContent = `${data.total} ${data.total === 1 ? "product" : "products"}`;
  }

  // ---------------------------------------------------------------- suggestions while typing

  const PRODUCT_HREF = /^\/shop\/product\/[A-Za-z0-9_-]{1,64}$/;
  const IMAGE_SRC = /^(\/uploads\/[A-Za-z0-9._-]+|https:\/\/[^\s"'()<>\\]+)$/;
  const SLUG = /^[a-z0-9-]{1,80}$/;

  /**
   * Search boxes suggest products and categories as the visitor types (an ARIA combobox: arrows move, Enter opens,
   * Escape closes). Without JavaScript, or if anything fails, the box is a plain search form.
   */
  function suggestions() {
    let n = 0;
    for (const form of /** @type {HTMLFormElement[]} */ ([...document.querySelectorAll("form.os-search")])) {
      const input = /** @type {HTMLInputElement | null} */ (form.querySelector('input[name="q"]'));
      if (!input) continue;
      const id = `os-sug-${++n}`;
      const list = el("div", { class: "os-sug", id, role: "listbox", "aria-label": "Suggestions" });
      list.hidden = true;
      form.classList.add("os-search--sug");
      form.append(list);
      Object.entries({ role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": id, autocomplete: "off" }).forEach(([k, v]) => input.setAttribute(k, v));
      /** @type {HTMLElement[]} */ let options = [];
      let active = -1, timer = 0, seq = 0;
      /** @type {AbortController | null} */ let pending = null;
      const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); active = -1; };
      const select = (/** @type {number} */ i) => {
        active = i;
        options.forEach((o, k) => o.setAttribute("aria-selected", String(k === i)));
        if (i >= 0) { input.setAttribute("aria-activedescendant", options[i].id); options[i].scrollIntoView({ block: "nearest" }); } else input.removeAttribute("aria-activedescendant");
      };
      /** @param {string} href @param {...(Node | string | null)} children */
      const option = (href, ...children) => el("a", { class: "os-sug-o", role: "option", id: `${id}-${options.length}`, href, tabindex: "-1", "aria-selected": "false" }, ...children);
      const show = (/** @type {any} */ data, /** @type {string} */ q) => {
        options = [];
        const groups = [];
        // A corrected typo: say so, and name the corrected words (links keep what was typed; the search corrects it too).
        const words = typeof data.corrected === "string" && data.corrected ? data.corrected : q;
        if (words !== q) groups.push(el("p", { class: "os-sug-c" }, "Showing results for ", el("b", {}, words)));
        const products = (Array.isArray(data.products) ? data.products : []).filter((/** @type {any} */ p) => typeof p.href === "string" && PRODUCT_HREF.test(p.href));
        if (products.length) {
          const items = products.map((/** @type {any} */ p) => { const o = option(p.href, typeof p.image === "string" && IMAGE_SRC.test(p.image) ? el("img", { src: p.image, alt: "", loading: "lazy" }) : el("span", { class: "os-sug-i" }), el("span", {}, String(p.name))); options.push(o); return o; });
          groups.push(el("div", { role: "group", "aria-label": "Products" }, el("div", { class: "os-sug-h", "aria-hidden": "true" }, "Products"), ...items));
        }
        const cats = (Array.isArray(data.categories) ? data.categories : []).filter((/** @type {any} */ c) => typeof c.slug === "string" && SLUG.test(c.slug));
        if (cats.length) {
          const items = cats.map((/** @type {any} */ c) => { const o = option(`/search?${new URLSearchParams({ q, category: c.slug })}`, el("span", {}, `“${words}” in `, el("b", {}, String(c.name))), el("small", {}, String(c.count))); options.push(o); return o; });
          groups.push(el("div", { role: "group", "aria-label": "Categories" }, el("div", { class: "os-sug-h", "aria-hidden": "true" }, "Categories"), ...items));
        }
        const all = option(`/search?${new URLSearchParams({ q })}`, el("span", {}, products.length ? `All results for “${words}”` : `No suggestions. Search for “${q}”`));
        options.push(all);
        groups.push(all);
        list.replaceChildren(...groups);
        list.hidden = false;
        input.setAttribute("aria-expanded", "true");
        select(-1);
      };
      const load = async (/** @type {string} */ q) => {
        pending?.abort();
        pending = new AbortController();
        const mine = ++seq;
        try {
          const res = await fetch(`/api/shop/suggest?${new URLSearchParams({ q })}`, { signal: pending.signal, headers: { accept: "application/json" } });
          if (!res.ok) { if (mine === seq) close(); return; }
          const data = await res.json();
          if (mine === seq && input.value.trim() === q) show(data, q);
        } catch (err) { if (!(err instanceof DOMException && err.name === "AbortError")) close(); }
      };
      input.addEventListener("input", () => {
        clearTimeout(timer);
        const q = input.value.trim();
        if ([...q].length < 2) { pending?.abort(); close(); return; }
        timer = window.setTimeout(() => load(q), 150);
      });
      input.addEventListener("keydown", (e) => {
        if (list.hidden || !options.length) return;
        if (e.key === "ArrowDown") { e.preventDefault(); select((active + 1) % options.length); }
        else if (e.key === "ArrowUp") { e.preventDefault(); select(active <= 0 ? options.length - 1 : active - 1); }
        else if (e.key === "Enter" && active >= 0) { e.preventDefault(); location.href = /** @type {HTMLAnchorElement} */ (options[active]).href; }
        else if (e.key === "Escape") { e.preventDefault(); close(); }
      });
      // Closing on blur waits a moment so a click on a suggestion still lands.
      input.addEventListener("blur", () => setTimeout(() => { if (!form.contains(document.activeElement)) close(); }, 150));
      document.addEventListener("click", (e) => { if (!form.contains(/** @type {Node} */ (e.target))) close(); });
    }
  }

  function start() {
    liveFilters();
    suggestions();
    const personal = /** @type {HTMLElement | null} */ (document.querySelector("[data-os-search]"));
    // Prices first come from the visitor's results (when they replace the list-price results), then for every card.
    (personal ? personalResults(personal).catch((err) => console.warn("OpenShop: personal results unavailable", err)) : Promise.resolve())
      .then(() => productPrices())
      .catch((err) => console.warn("OpenShop: prices unavailable", err));
    const panel = document.getElementById("os-cart-pricing");
    if (panel) cartPage(panel);
    const offers = document.getElementById("os-account-offers");
    if (offers) accountOffers(offers);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
