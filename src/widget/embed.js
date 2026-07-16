/*
 * Bouncr embed loader (Spec §10). Script tag → iframe, so it works on any stack.
 *
 * Auto-mount from data attributes:
 *   <script src="https://bouncr.tech/embed.js"
 *           data-plan="pro_monthly" data-user="user_123"
 *           data-mount="#bouncr" data-accent="7C3AED"
 *           data-fallback="https://yourapp.com/pricing"
 *           data-split="0.9"></script>
 *
 * data-channel="sms" swaps the chat iframe for the compact SMS install: a small
 * phone-number input, and the agent texts the visitor instead (the haggle
 * continues over SMS — same engine, same floor). Everything else (mount,
 * accent, split/fallback) works the same.
 *
 * data-split opts into the A/B lift experiment: the fraction of visitors routed
 * to the negotiated widget (0.9 → 90% treatment, 10% control sent to data-fallback).
 * Absent → no experiment, everyone gets the widget (unchanged behavior).
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

  // --- A/B lift experiment (Spec §11) --------------------------------------
  // When data-split is set (the fraction of visitors routed to the negotiated
  // widget, e.g. 0.9 → 90% treatment / 10% control), every visitor is bucketed
  // by a STABLE hash of their user ref — so a refresh never re-rolls them — and
  // an impression is beaconed for BOTH arms. The impression must fire here, not
  // in the widget: control visitors never load the widget, so only the loader
  // sees the whole top-of-funnel. Control is routed to the merchant's own flat
  // page (data-fallback) and never mounts the negotiator.

  // FNV-1a → a uniform unit float in [0,1). Pure, deterministic, dependency-free.
  function hashUnit(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
  }

  // split = treatment fraction. <split → treatment, else control.
  function assignCohort(userRef, split) {
    return hashUnit(String(userRef)) < split ? "treatment" : "control";
  }

  // Best-effort, non-blocking — survives the control-arm navigation via sendBeacon.
  function beaconImpression(planId, userRef, cohort) {
    try {
      var url = ORIGIN + "/v1/impressions";
      var body = JSON.stringify({ plan: planId, user: userRef, cohort: cohort });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      } else {
        fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body, keepalive: true });
      }
    } catch (_) { /* analytics best-effort: never block the page */ }
  }

  // Active only with a real split in [0,1) AND a user ref to hash. Returns the
  // cohort when the experiment runs, or null to mount normally (unchanged behavior).
  function runExperiment(opts) {
    var split = typeof opts.split === "number" ? opts.split : Number(opts.split);
    if (!opts.userRef || !isFinite(split) || split < 0 || split >= 1) return null;
    var cohort = assignCohort(opts.userRef, split);
    beaconImpression(opts.planId, opts.userRef, cohort);
    return cohort;
  }

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
    // SMS install: the compact phone-input page instead of the chat UI.
    return ORIGIN + (opts.channel === "sms" ? "/widget/sms?" : "/widget?") + p.toString();
  }

  function resolveEl(el, compact) {
    if (!el) {
      var d = document.createElement("div");
      d.style.cssText = compact
        ? "position:fixed;right:20px;bottom:20px;width:340px;height:150px;max-width:92vw;z-index:2147483000;box-shadow:0 20px 60px rgba(0,0,0,.45);border-radius:16px;overflow:hidden"
        : "position:fixed;right:20px;bottom:20px;width:380px;height:560px;max-width:92vw;max-height:80vh;z-index:2147483000;box-shadow:0 20px 60px rgba(0,0,0,.45);border-radius:16px;overflow:hidden";
      document.body.appendChild(d);
      return d;
    }
    return typeof el === "string" ? document.querySelector(el) : el;
  }

  function mount(opts) {
    opts = opts || {};

    // A/B holdout: bucket BEFORE building the iframe. Control never mounts the
    // negotiator — it falls through to the merchant's flat page (data-fallback)
    // if given, else just leaves the host page as-is. Either way the impression
    // is already counted, so both arms share the same visitor denominator.
    var cohort = runExperiment(opts);
    if (cohort === "control") {
      if (opts.fallbackUrl) window.location.href = opts.fallbackUrl;
      return { cohort: "control" };
    }

    var host = resolveEl(opts.el, opts.channel === "sms");
    if (!host) { console.error("[bouncr] mount target not found:", opts.el); return; }

    var iframe = document.createElement("iframe");
    iframe.src = buildUrl(opts);
    iframe.title = "Bouncr negotiation";
    iframe.allow = "clipboard-write";
    iframe.style.cssText = "width:100%;height:100%;border:0;display:block;background:#0B0B12";
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
      split: d.split, // A/B treatment fraction (e.g. "0.9"); absent → no experiment
      channel: d.channel, // "sms" → the phone-input install; absent → chat widget
    });
  }
})();
