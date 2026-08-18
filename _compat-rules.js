/* Rack compatibility rules engine — pure functions, no I/O.
 *
 * Kept free of Sheets/HTTP on purpose so it can be unit-tested directly and so
 * the same file runs server-side and (if we ever want it) in the browser.
 *
 * Data comes from two Sheet tabs the team edits, never from code:
 *   Racks        — one row per rack or rack-like product, BOS and competitor
 *   Attachments  — one row per BOS attachment and what it needs
 *
 * Verdicts. Non-BOS racks can never return FITS — that's the standing policy
 * from the product knowledge deck ("do not confirm cross brand compatibility"),
 * encoded here so nobody has to remember it while typing fast to a customer.
 */

/* Wrapped so this file leaks NOTHING into the global scope. It has to share a
 * page with app.js, which declares its own top-level `const API` — two classic
 * scripts both declaring the same identifier is a parse error that kills the
 * whole file, and it only shows up in a browser, never in the node tests. */
(function (factory) {
  var API = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof window !== "undefined") window.CompatRules = API;
})(function () {

  const VERDICT = {
    FITS:        "FITS",         // BOS rack, everything satisfied
    DOESNT_FIT:  "DOESNT_FIT",   // known incompatible — safe to say outright
    LIKELY_NOT:  "LIKELY_NOT",   // non-BOS, a rule fires against it
    NEED_SPEC:   "NEED_SPEC",    // one fact from THE CUSTOMER would settle it
    NEEDS_MEASUREMENT: "NEEDS_MEASUREMENT", // one fact from OUR SHOWROOM would settle it
    UNKNOWN:     "UNKNOWN"       // nothing decides it
  };

  /* NEED_SPEC vs NEEDS_MEASUREMENT is a real distinction, not a shade of the same
   * thing. NEED_SPEC is an email to the customer. NEEDS_MEASUREMENT is a job for
   * whoever is next in the showroom with a tape measure — and it's a gap in OUR
   * knowledge, so it should never be asked of a customer and it should only ever
   * be asked once, no matter how many questions are waiting on it. */

  /* Which dimension gets reported when several fail. First match wins, so the
   * agent gets one clear reason instead of a list.
   * OPEN QUESTION (A5): this order is my proposal, not Christian's ruling. */
  const DIMENSION_PRIORITY = [
    "not_listed",      // bespoke attachments answer from a confirmed list only
    "hole_vs_pin",     // pin physically cannot enter — most absolute
    "side_holes",      // structural, not a tolerance
    "posts",           // Oblivyon single upright
    "flat_feet",       // Kraken needs a lower crossmember
    "tubing",          // metric vs true 3x3
    "spacing",         // compounding error across pins
    "internal_width",  // gates three attachments only
    "verify_pair"      // non-rack 2.3" products
  ];

  function norm(s) { return String(s == null ? "" : s).trim().toLowerCase(); }
  /* A field nobody has filled in yet. "?" is what the seed CSVs use so the gaps
   * are visible in the sheet rather than silently empty. */
  function unknown(v) { const s = norm(v); return s === "" || s === "?" || s === "tbd" || s === "unknown"; }
  function isTrue(v) { return v === true || norm(v) === "true" || norm(v) === "yes" || norm(v) === "y" || norm(v) === "1"; }
  function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

  /* ---------------------------------------------------------------- R1
   * Infer tubing from what the customer actually said, including what they
   * didn't say. A true-3x3 owner almost always knows it and says so; silence
   * points metric. Christian: "most often if it just lists 3x3, it's not true
   * 3x3 ... usually safe to assume not fit."
   */
  function inferTubing(claimText) {
    const t = norm(claimText);
    if (!t) return { klass: null, confidence: "none" };

    if (/\b75\s*(mm|x\s*75)/.test(t) || /75\s*x\s*75/.test(t)) {
      return { klass: "metric-3x3", confidence: "stated", why: "customer stated 75 mm" };
    }
    if (/76\.2/.test(t) || /\btrue\s*3\s*["”]?\s*x\s*3/.test(t)) {
      return { klass: "true-3x3", confidence: "stated", why: "customer stated true 3×3 / 76.2 mm" };
    }
    if (/\b3\s*["”]?\s*x\s*3\b/.test(t) || /\b3x3\b/.test(t)) {
      return {
        klass: "metric-3x3", confidence: "inferred",
        why: 'customer said "3×3" without saying true 3×3 or 76.2 mm — most often that means metric 75 mm'
      };
    }
    if (/\b2\.3|60\s*(mm|x\s*60)|60x60/.test(t)) {
      return { klass: "60mm", confidence: "stated", why: "customer stated 2.3″ / 60 mm" };
    }
    if (/\b2\s*["”]?\s*x\s*3\b/.test(t)) {
      return { klass: "2x3", confidence: "stated", why: "customer stated 2×3″" };
    }
    if (/\b2\s*["”]?\s*x\s*2\b/.test(t)) {
      return { klass: "2x2", confidence: "stated", why: "customer stated 2×2″" };
    }
    return { klass: null, confidence: "none" };
  }

  /* ---------------------------------------------------------------- main
   * attachment : row from the Attachments tab
   * rack       : row from the Racks tab, or null when the customer's rack is unknown
   * claimText  : free text of what the customer said about their rack
   */
  function evaluate(attachment, rack, claimText) {
    if (!attachment) throw new Error("evaluate() needs an attachment");

    const failures = [];
    const notes = [];
    const measurements = [];
    const isBos = rack ? isTrue(rack.is_bos) : false;

    /* Record a gap in our own data. Deduped downstream by
     * (subject_type, subject_id, spec_key) so one showroom trip clears every
     * question waiting on the same number. */
    function needMeasurement(subject, subjectType, spec, why) {
      if (!subject) return;
      measurements.push({
        subject_type: subjectType,
        subject_id: subject.id || subject.product_id || norm(subject.name),
        subject_name: subject.name,
        spec_key: spec,
        why
      });
    }

    /* How it attaches decides which questions even make sense.
     *   pin      — pinned through the uprights; pin count and spacing govern
     *   bolt-on  — bolted; bolt/hole diameter governs, pin count is meaningless
     *   bespoke  — non-standard, mounts in several places, no derivable rule
     * The Kraken taught us this: "how many pins?" was a question nobody could
     * answer, because the question itself was wrong. */
    var mountType = norm(attachment.mount_type) || "pin";
    var bespoke = mountType === "bespoke";

    // Attachment fields the rules can't run without.
    if (mountType === "pin" && unknown(attachment.mount_points)) {
      needMeasurement(attachment, "attachment", "mount_points",
        "How many pins does it mount on? Decides whether a metric rack is a loose fit or a hard no.");
    }
    if (!bespoke && unknown(attachment.needs_side_holes)) {
      needMeasurement(attachment, "attachment", "needs_side_holes",
        "Does it mount on the side of the upright? Decides compatibility with every rack that has no side holes.");
    }
    // Rack fields, only when this attachment actually depends on them.
    const widthMatters = !unknown(attachment.min_internal_width) || !unknown(attachment.max_internal_width);
    if (rack && widthMatters && unknown(rack.internal_width)) {
      needMeasurement(rack, "rack", "internal_width",
        `${attachment.name} is width-gated and we have no internal width recorded for this product.`);
    }
    if (rack && unknown(rack.posts) && num(attachment.min_posts) > 1) {
      needMeasurement(rack, "rack", "posts",
        "How many uprights? Decides anything that spans two posts.");
    }

    // Resolve tubing: a known rack's recorded spec beats anything inferred.
    let tubing = rack && rack.tubing_class ? { klass: norm(rack.tubing_class), confidence: "known" } : inferTubing(claimText);
    if (!rack && tubing.why) notes.push(tubing.why);

    const pins    = num(attachment.mount_points);
    const needsSide = isTrue(attachment.needs_side_holes);
    const needsPosts = num(attachment.min_posts) || 1;
    const attachClass = norm(attachment.tubing_class);

    /* --- bespoke: some attachments can't be reasoned about from dimensions.
     * For those we go by an explicit list of racks we've actually confirmed,
     * and say so, rather than inventing a derivation. */
    if (bespoke) {
      var fits = String(attachment.fits_racks || "").split(",").map(function (x) { return norm(x); }).filter(Boolean);
      if (rack && fits.indexOf(norm(rack.id)) === -1) {
        failures.push({ dimension: "not_listed", hard: true,
          reason: `${attachment.name} mounts in a non-standard way, so we go by a confirmed list rather than dimensions — and ${rack.name} isn't on it.` });
      } else if (!rack) {
        failures.push({ dimension: "not_listed", hard: false, needSpec: "which rack",
          reason: `${attachment.name} mounts in a non-standard way. We can only confirm it against racks we've actually checked, so we need to know exactly which rack they have.` });
      }
    }

    /* --- hole_vs_pin: the hole is not larger than our pin, so it can't enter.
     * Confirmed for the Force USA MyRack specifically. */
    if (rack && isTrue(rack.hole_rejects_our_pin)) {
      failures.push({
        dimension: "hole_vs_pin", hard: true,
        reason: `${rack.name}'s holes are the same size as our pins, so the pin won't enter.`
      });
    }

    /* --- side_holes */
    if (needsSide && rack && isTrue(rack.no_side_holes)) {
      failures.push({
        dimension: "side_holes", hard: true,
        reason: `${attachment.name} mounts on the side, and ${rack.name} has no side holes.`
      });
    }

    /* --- posts: the Oblivyon passes tubing and hole type and still fails
     * anything spanning two uprights, because there's only one. */
    if (rack && num(rack.posts) != null && num(rack.posts) < needsPosts) {
      failures.push({
        dimension: "posts", hard: true,
        reason: `${attachment.name} needs ${needsPosts} uprights; ${rack.name} has ${num(rack.posts)}.`
      });
    }

    /* --- flat_feet: currently only the Kraken */
    if (isTrue(attachment.needs_lower_crossmember) && rack && isTrue(rack.flat_feet)) {
      failures.push({
        dimension: "flat_feet", hard: true,
        reason: `${attachment.name} won't mount to flat feet — it needs a lower crossmember.`
      });
    }

    /* --- tubing + spacing.
     * Two different failure modes on a metric rack, and the wording differs:
     *   1 pin  — mounts loose; load goes through the pin in shear instead of
     *            bearing on the rack face, so the rated capacity no longer holds
     *   2+ pins — spacing error compounds across the span; won't fit
     */
    if (tubing.klass && attachClass && tubing.klass !== attachClass) {
      if (attachClass === "true-3x3" && tubing.klass === "metric-3x3") {
        if (mountType === "pin" && pins != null && pins >= 2) {
          failures.push({
            dimension: "spacing", hard: true,
            reason: `${attachment.name} mounts on ${pins} pins. On metric 75 mm tubing the hole spacing is metric too, and the error compounds across the span — it won't fit.`
          });
        } else {
          failures.push({
            dimension: "tubing", hard: false,
            reason: `Metric 75 mm tubing is 1.2 mm narrower per side, so ${attachment.name} will mount but won't sit snug. The load then goes through the pin rather than bearing against the rack face, and we can't stand behind the rated capacity.`
          });
        }
      } else {
        failures.push({
          dimension: "tubing", hard: true,
          reason: `${attachment.name} is built for ${attachment.tubing_class} tubing; this rack is ${tubing.klass}.`
        });
      }
    }

    /* --- internal_width: gates exactly three attachments */
    const needMin = num(attachment.min_internal_width);
    const needMax = num(attachment.max_internal_width);
    const have    = rack ? num(rack.internal_width) : null;
    if ((needMin != null || needMax != null)) {
      if (have == null) {
        failures.push({
          dimension: "internal_width", hard: false, needSpec: "internal width",
          reason: `${attachment.name} depends on internal width. Ask for the INTERNAL width — brands often quote total width.`
        });
      } else if ((needMin != null && have < needMin) || (needMax != null && have > needMax)) {
        failures.push({
          dimension: "internal_width", hard: true,
          reason: `${attachment.name} needs ${needMin != null ? needMin + '″' : ''}${needMin != null && needMax != null ? '–' : ''}${needMax != null ? needMax + '″' : ''} internal width; this rack is ${have}″.`
        });
      }
    }

    /* --- verify_pair: 2.3" products that aren't racks. Matching tubing is
     * necessary, not sufficient — these have to be checked individually. */
    if (rack && isTrue(rack.verify_individually)) {
      failures.push({
        dimension: "verify_pair", hard: false,
        reason: `${rack.name} uses 2.3″ tubing but isn't a rack — attachment fit has to be checked individually rather than assumed.`
      });
    }

    // ---- resolve to a single verdict
    const ordered = DIMENSION_PRIORITY
      .map(d => failures.find(f => f.dimension === d))
      .filter(Boolean);
    const primary = ordered[0] || null;

    const hardFail = ordered.find(f => f.hard);

    let verdict;
    if (hardFail) {
      // A known incompatibility still answers the question — don't send anyone to
      // the showroom to measure something that can't change the outcome.
      verdict = isBos ? VERDICT.DOESNT_FIT : VERDICT.LIKELY_NOT;
    } else if (measurements.length) {
      verdict = VERDICT.NEEDS_MEASUREMENT;
    } else if (!primary) {
      verdict = isBos ? VERDICT.FITS : VERDICT.UNKNOWN;
    } else if (primary.needSpec) {
      verdict = VERDICT.NEED_SPEC;
    } else if (isBos) {
      verdict = VERDICT.NEED_SPEC;
    } else {
      verdict = VERDICT.LIKELY_NOT;
    }

    // Inferred-only tubing never produces a closed answer — it's a measurement check.
    if (verdict === VERDICT.LIKELY_NOT && tubing.confidence === "inferred") {
      notes.push("This rests on an assumption about the tubing. Ask them to measure across the flat of one upright: 76.2 mm is ours, 75 mm is metric.");
    }

    let reason;
    if (primary) reason = primary.reason;
    else if (verdict === VERDICT.NEEDS_MEASUREMENT)
      reason = `We don't have ${measurements.map(m => m.spec_key.replace(/_/g, " ")).join(" or ")} recorded yet — this needs measuring before we can answer.`;
    else if (isBos) reason = `${attachment.name} fits ${rack.name}.`;
    else reason = "We only guarantee compatibility with our own racks.";

    return {
      verdict,
      dimension: primary ? primary.dimension : null,
      reason,
      all_failures: ordered,
      measurement_requests: hardFail ? [] : measurements,
      notes,
      tubing,
      guaranteed: isBos && verdict === VERDICT.FITS
    };
  }

  /* Roll many evaluations' requests into a showroom worklist: one row per thing
   * to measure, ordered by how many open questions it unblocks. Walking to the
   * Kraken once should clear every question waiting on the Kraken. */
  function buildWorklist(requests) {
    const by = new Map();
    for (const r of requests) {
      const key = `${r.subject_type}|${r.subject_id}|${r.spec_key}`;
      if (!by.has(key)) by.set(key, { ...r, blocking: 0, whys: new Set() });
      const e = by.get(key);
      e.blocking += 1;
      e.whys.add(r.why);
    }
    return [...by.values()]
      .map(e => ({ ...e, whys: [...e.whys] }))
      .sort((a, b) => b.blocking - a.blocking || a.subject_name.localeCompare(b.subject_name));
  }

  return { evaluate: evaluate, inferTubing: inferTubing, buildWorklist: buildWorklist,
           unknown: unknown, VERDICT: VERDICT, DIMENSION_PRIORITY: DIMENSION_PRIORITY };
});
