/* Rack Compatibility — front end.
 *
 * Self-contained on purpose: it renders into #compat and never touches the
 * FAQ's app.js, so the two can't break each other. Verdicts compute in the
 * browser via CompatRules, same as the FAQ scores its search client-side.
 */
(function () {
  "use strict";
  var R = window.CompatRules;
  var DATA = { racks: [], attachments: [], measurements: [] };
  var SEL = { attachment: null, rack: null, claim: "" };
  var LAST = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function actor() { try { return localStorage.getItem("faq_name") || "unknown"; } catch (e) { return "unknown"; } }

  var CHIP = {
    FITS:              { label: "Fits",                cls: "v-fits" },
    DOESNT_FIT:        { label: "Won't fit",           cls: "v-no" },
    LIKELY_NOT:        { label: "Not guaranteed",      cls: "v-warn" },
    NEED_SPEC:         { label: "Ask the customer",    cls: "v-ask" },
    NEEDS_MEASUREMENT: { label: "Needs measuring",     cls: "v-meas" },
    UNKNOWN:           { label: "Can't confirm",       cls: "v-warn" }
  };

  /* Customer-facing wording per verdict. Never says a non-BOS rack fits, and
   * for the single-pin metric case it explains the capacity problem rather
   * than claiming it won't physically mount — because it will. */
  function script(res, att, rack) {
    var a = att ? att.name : "this attachment";
    switch (res.verdict) {
      case "FITS":
        return "Yes — the " + a + " is designed for your " + (rack ? rack.name : "rack") + " and will fit.";
      case "DOESNT_FIT":
        return "Unfortunately the " + a + " won't fit your " + (rack ? rack.name : "rack") + ". " + res.reason;
      case "LIKELY_NOT":
        if (res.dimension === "tubing")
          return "We can only guarantee compatibility with our own racks. Based on what you've described, the "
            + a + " would physically mount, but it wouldn't sit flush against your uprights — the load would go "
            + "through the pin rather than bearing on the rack itself, so we can't stand behind the rated capacity. "
            + "If you'd like to check, measure across the flat of one upright: ours are 76.2 mm.";
        return "We can only guarantee compatibility with our own racks, and based on what you've described the "
          + a + " isn't likely to fit. " + res.reason;
      case "NEED_SPEC":
        return "Happy to check. " + res.reason + " Once you send that over I can confirm.";
      case "NEEDS_MEASUREMENT":
        return "Good question — let me confirm that with the team and come straight back to you.";
      default:
        return "We can only guarantee compatibility with our own racks. If you can send the tubing size, hole size "
          + "and internal width of yours, I'll tell you what I can.";
    }
  }

  function post(payload) {
    payload.actor = actor();
    return fetch("/api/compat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t); });
      return r.json();
    });
  }

  function toast(msg, bad) {
    var t = $("toast"); if (!t) { return; }
    t.textContent = msg; t.className = "toast" + (bad ? " bad" : "");
    clearTimeout(t._h); t._h = setTimeout(function () { t.className = "toast hidden"; }, 3200);
  }

  /* ------------------------------------------------------------- render */
  function openQueue() {
    return DATA.measurements.filter(function (m) { return String(m.status) !== "done"; })
      .sort(function (a, b) { return (parseInt(b.blocking, 10) || 0) - (parseInt(a.blocking, 10) || 0); });
  }

  function render() {
    var q = openQueue();
    $("compat").innerHTML =
      '<div class="cpanel">' +
        '<div class="crow">' +
          '<label>Attachment' +
            '<select id="cAtt"><option value="">— pick an attachment —</option>' +
              DATA.attachments.map(function (a) {
                return '<option value="' + esc(a.id) + '"' + (SEL.attachment === a.id ? " selected" : "") + '>' + esc(a.name) + "</option>";
              }).join("") +
            "</select></label>" +
          '<label>Their rack' +
            '<select id="cRack"><option value="">— unknown / describe below —</option>' +
              DATA.racks.map(function (r) {
                return '<option value="' + esc(r.id) + '"' + (SEL.rack === r.id ? " selected" : "") + ">" +
                  esc(r.name) + (String(r.is_bos).toLowerCase() === "true" ? "" : " (other brand)") + "</option>";
              }).join("") +
            "</select></label>" +
        "</div>" +
        '<label>What did the customer say about their rack?' +
          '<input id="cClaim" type="text" placeholder="e.g. 3x3 rack with 1 inch holes, or Rogue Monster Lite" value="' + esc(SEL.claim) + '" /></label>' +
        '<div class="chint">Paste their words — the wording itself is evidence. "3×3" without "true" or "76.2" usually means a metric rack.</div>' +
        '<div id="cOut"></div>' +
      "</div>" +
      '<div class="cpanel">' +
        "<h3>Showroom list " + (q.length ? '<span class="cbadge">' + q.length + "</span>" : "") + "</h3>" +
        '<div class="chint">Things only we can settle, most-blocking first. One trip clears every question waiting on the same number.</div>' +
        (q.length ? q.map(measRow).join("") : '<div class="chint">Nothing outstanding.</div>') +
      "</div>";

    $("cAtt").onchange = function () { SEL.attachment = this.value; evaluate(); };
    $("cRack").onchange = function () { SEL.rack = this.value; evaluate(); };
    $("cClaim").oninput = function () { SEL.claim = this.value; evaluate(); };
    wireQueue();
    evaluate();
  }

  function measRow(m) {
    /* "Question is wrong" matters as much as "here is the answer". The Kraken
     * is a bolt-on that mounts in several places, so asking for a pin count
     * produced a question with no possible answer. Where the reason is a
     * mis-modelled mount type, fixing that stops it being asked again. */
    return '<div class="cmeas">' +
      "<div><b>" + esc(m.subject_name) + "</b> — " + esc(String(m.spec_key).replace(/_/g, " ")) +
      (parseInt(m.blocking, 10) > 1 ? ' <span class="cbadge">' + esc(m.blocking) + " waiting</span>" : "") + "</div>" +
      '<div class="chint">' + esc(m.why) + "</div>" +
      '<div class="crow">' +
        '<input type="text" data-mval="' + esc(m.id) + '" placeholder="value" />' +
        '<input type="text" data-munit="' + esc(m.id) + '" placeholder="unit (in, mm, count)" value="' + esc(m.unit || "") + '" />' +
        '<button class="btn sm primary" data-msave="' + esc(m.id) + '">Save</button>' +
        '<button class="btn sm" data-mbad="' + esc(m.id) + '">Question is wrong</button>' +
      "</div>" +
      '<div class="cbad hidden" data-mbadbox="' + esc(m.id) + '">' +
        '<div class="chint">Why doesn\'t this question apply?</div>' +
        '<div class="crow">' +
          '<input type="text" data-mreason="' + esc(m.id) + '" placeholder="e.g. it is a bolt-on, not pinned" />' +
          '<select data-mtype="' + esc(m.id) + '">' +
            '<option value="">don\'t change how it mounts</option>' +
            '<option value="bolt-on">it is bolt-on</option>' +
            '<option value="bespoke">it is bespoke — mounts in several places</option>' +
            '<option value="pin">it is pin-mounted</option>' +
          "</select>" +
          '<button class="btn sm danger" data-mbadgo="' + esc(m.id) + '">Retire the question</button>' +
        "</div>" +
        /* Bespoke means "we go by a confirmed list", so the list has to be
         * captured at the same moment — otherwise the tool has nothing to
         * answer from and every rack comes back as "go ask someone". */
        '<div class="crow hidden" data-mfitswrap="' + esc(m.id) + '">' +
          '<input type="text" data-mfits="' + esc(m.id) + '" style="flex:1" ' +
            'placeholder="Racks it IS confirmed on, comma separated — e.g. hydra, manticore" />' +
        "</div>" +
        "</div></div>";
  }

  function wireQueue() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-msave]"), function (b) {
      b.onclick = function () {
        var id = b.dataset.msave;
        var val = document.querySelector('[data-mval="' + id + '"]').value.trim();
        if (!val) { toast("Enter a value first", true); return; }
        b.disabled = true;
        post({ action: "save_measurement", id: id, value: val,
               unit: document.querySelector('[data-munit="' + id + '"]').value.trim() })
          .then(function (r) {
            toast(r.applied && r.applied.applied ? "Saved and written into the data" : "Saved — but not written back, check the request");
            return load();
          })
          .catch(function (e) { toast(e.message, true); b.disabled = false; });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-mbad]"), function (b) {
      b.onclick = function () {
        var box = document.querySelector('[data-mbadbox="' + b.dataset.mbad + '"]');
        if (box) box.classList.toggle("hidden");
      };
    });
    /* Only bespoke needs the confirmed-rack list; show the field when it's
     * picked so the other options stay a one-click retire. */
    Array.prototype.forEach.call(document.querySelectorAll("[data-mtype]"), function (s) {
      s.onchange = function () {
        var wrap = document.querySelector('[data-mfitswrap="' + s.dataset.mtype + '"]');
        if (wrap) wrap.classList.toggle("hidden", s.value !== "bespoke");
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-mbadgo]"), function (b) {
      b.onclick = function () {
        var id = b.dataset.mbadgo;
        var reason = document.querySelector('[data-mreason="' + id + '"]').value.trim();
        if (!reason) { toast("Say why it doesn't apply", true); return; }
        var mtype = document.querySelector('[data-mtype="' + id + '"]').value;
        var fitsEl = document.querySelector('[data-mfits="' + id + '"]');
        var fits = fitsEl ? fitsEl.value.trim() : "";
        if (mtype === "bespoke" && !fits) {
          toast("Bespoke goes by a confirmed list — name the racks it fits", true);
          return;
        }
        b.disabled = true;
        post({ action: "invalidate_measurement", id: id, reason: reason,
               set_mount_type: mtype, set_fits_racks: fits })
          .then(function (r) {
            toast(r.fixed ? "Retired — and " + r.fixed.attachment + " is now " + r.fixed.mount_type
                          : "Question retired");
            return load();
          })
          .catch(function (e) { toast(e.message, true); b.disabled = false; });
      };
    });
  }

  function evaluate() {
    var out = $("cOut"); if (!out) return;
    var att = DATA.attachments.find(function (a) { return a.id === SEL.attachment; });
    if (!att) { out.innerHTML = '<div class="chint">Pick an attachment to get a verdict.</div>'; LAST = null; return; }
    var rack = DATA.racks.find(function (r) { return r.id === SEL.rack; }) || null;

    var res = R.evaluate(att, rack, SEL.claim);
    LAST = { res: res, att: att, rack: rack };
    var chip = CHIP[res.verdict] || CHIP.UNKNOWN;

    out.innerHTML =
      '<div class="cverdict ' + chip.cls + '"><span class="cchip">' + chip.label + "</span>" +
        (res.dimension ? '<span class="cdim">' + esc(String(res.dimension).replace(/_/g, " ")) + "</span>" : "") +
      "</div>" +
      "<p class=\"creason\">" + esc(res.reason) + "</p>" +
      (res.notes.length ? res.notes.map(function (n) { return '<p class="chint">' + esc(n) + "</p>"; }).join("") : "") +
      (res.measurement_requests.length
        ? '<div class="cgap">We don\'t have this on file yet.' +
          '<button class="btn sm" id="cRaise">Add ' + res.measurement_requests.length + " to the showroom list</button></div>"
        : "") +
      '<label>Reply to send' +
        '<textarea id="cScript" rows="4">' + esc(script(res, att, rack)) + "</textarea></label>" +
      '<button class="btn sm" id="cCopy">Copy reply</button>' +
      '<div class="coutcome"><h4>How did it end?</h4>' +
        '<div class="chint">Only fill this in once you know. A return is strong evidence and updates the data; a customer saying it fits is recorded but doesn\'t change anything on its own.</div>' +
        '<div class="crow">' +
          '<input id="cGorgias" type="text" placeholder="Gorgias ticket link (optional)" />' +
          '<button class="btn sm" data-outcome="confirmed_fits">Customer confirmed it fits</button>' +
          '<button class="btn sm danger" data-outcome="returned_didnt_fit">Returned — didn\'t fit</button>' +
        "</div></div>";

    if ($("cRaise")) $("cRaise").onclick = raiseGaps;
    $("cCopy").onclick = function () {
      navigator.clipboard.writeText($("cScript").value).then(function () { toast("Reply copied"); },
        function () { toast("Copy failed", true); });
    };
    Array.prototype.forEach.call(document.querySelectorAll("[data-outcome]"), function (b) {
      b.onclick = function () { logOutcome(b.dataset.outcome); };
    });
  }

  function raiseGaps() {
    var reqs = LAST ? LAST.res.measurement_requests : [];
    if (!reqs.length) return;
    $("cRaise").disabled = true;
    Promise.all(reqs.map(function (m) {
      return post({ action: "request_measurement", subject_type: m.subject_type,
                    subject_id: m.subject_id, subject_name: m.subject_name,
                    spec_key: m.spec_key, why: m.why });
    })).then(function () { toast("Added to the showroom list"); return load(); })
      .catch(function (e) { toast(e.message, true); });
  }

  function logOutcome(kind) {
    if (!LAST) return;
    var reclassify = false;
    if (kind === "returned_didnt_fit" && LAST.rack && String(LAST.rack.is_bos).toLowerCase() !== "true") {
      reclassify = confirm('Mark "' + LAST.rack.name + '" as a metric 3×3 rack from now on?\n\n' +
        "A return is the strongest evidence we get. Say yes only if the fit was the reason it came back.");
    }
    post({ action: "log_outcome", outcome: kind, reclassify: reclassify,
           attachment_id: LAST.att.id, rack_id: LAST.rack ? LAST.rack.id : "",
           claim_text: SEL.claim, verdict: LAST.res.verdict,
           gorgias_url: ($("cGorgias") || {}).value || "" })
      .then(function (r) {
        toast(r.reclassified ? "Logged — " + r.reclassified + " reclassified as metric" : "Logged");
        if (r.reclassified) return load();
      })
      .catch(function (e) { toast(e.message, true); });
  }

  /* --------------------------------------------------------------- boot */
  function load() {
    return fetch("/api/compat").then(function (r) { return r.json(); }).then(function (d) {
      DATA = { racks: d.racks || [], attachments: d.attachments || [], measurements: d.measurements || [] };
      render();
    }).catch(function (e) {
      $("compat").innerHTML = '<div class="cpanel">Couldn\'t load compatibility data: ' + esc(e.message) + "</div>";
    });
  }

  window.CompatUI = { load: load };
})();
