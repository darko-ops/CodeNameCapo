/*
 * Bouncr embed loader (Spec §10). Script tag → iframe, so it works on any stack.
 *
 * Auto-mount from data attributes:
 *   <script src="https://bouncr.tech/embed.js"
 *           data-plan="pro_monthly" data-user="user_123"
 *           data-mount="#bouncr" data-accent="7C3AED"
 *           data-fallback="https://yourapp.com/pricing"></script>
 *
 * Or programmatically:
 *   <script src="https://bouncr.tech/embed.js"></script>
 *   <script>
 *     Bouncr.mount({
 *       el: "#bouncr", planId: "pro_monthly", userRef: user.id,
 *       theme: { accent: "7C3AED" },
 *       onDeal: (d) => { window.location = d.checkoutUrl },   // default if omitted
 *       onWalkaway: () => showStandardPricing(),
 *     });
 *   </script>
 */
(function () {
  var current = document.currentScript;
  var ORIGIN = current ? new URL(current.src).origin : window.location.origin;

  function buildUrl(opts) {
    var p = new URLSearchParams();
    p.set("base", ORIGIN);
    if (opts.planId) p.set("plan", opts.planId);
    if (opts.userRef) p.set("user", opts.userRef);
    if (opts.theme && opts.theme.accent) p.set("accent", String(opts.theme.accent).replace(/^#/, ""));
    if (opts.theme && opts.theme.mode) p.set("mode", opts.theme.mode);
    if (opts.fallbackUrl) p.set("fallback", opts.fallbackUrl);
    if (opts.session) p.set("session", opts.session);
    if (opts.token) p.set("token", opts.token);
    return ORIGIN + "/widget?" + p.toString();
  }

  function resolveEl(el) {
    if (!el) {
      var d = document.createElement("div");
      d.style.cssText =
        "position:fixed;right:20px;bottom:20px;width:380px;height:560px;max-width:92vw;max-height:80vh;z-index:2147483000;box-shadow:0 20px 60px rgba(0,0,0,.45);border-radius:16px;overflow:hidden";
      document.body.appendChild(d);
      return d;
    }
    return typeof el === "string" ? document.querySelector(el) : el;
  }

  function mount(opts) {
    opts = opts || {};
    var host = resolveEl(opts.el);
    if (!host) { console.error("[bouncr] mount target not found:", opts.el); return; }

    var iframe = document.createElement("iframe");
    iframe.src = buildUrl(opts);
    iframe.title = "Bouncr negotiation";
    iframe.allow = "clipboard-write";
    iframe.style.cssText = "width:100%;height:100%;border:0;display:block;background:#0e0e12";
    iframe.setAttribute("loading", "lazy");
    host.appendChild(iframe);

    var onDeal = typeof opts.onDeal === "function" ? opts.onDeal : function (d) {
      if (d && d.checkoutUrl) window.location.href = d.checkoutUrl;
    };
    var onWalkaway = typeof opts.onWalkaway === "function" ? opts.onWalkaway : function () {};

    function handler(e) {
      if (e.origin !== ORIGIN) return; // only trust the Bouncr origin
      var m = e.data;
      if (!m || m.source !== "bouncr") return;
      if (m.type === "deal") onDeal(m.payload || {});
      else if (m.type === "walkaway") onWalkaway(m.payload || {});
    }
    window.addEventListener("message", handler);

    return {
      iframe: iframe,
      destroy: function () { window.removeEventListener("message", handler); iframe.remove(); },
    };
  }

  window.Bouncr = { mount: mount };

  // Auto-mount if the script tag carries data-plan.
  if (current && current.dataset && current.dataset.plan) {
    var d = current.dataset;
    mount({
      el: d.mount || null,
      planId: d.plan,
      userRef: d.user,
      theme: { accent: d.accent, mode: d.mode },
      fallbackUrl: d.fallback,
    });
  }
})();
