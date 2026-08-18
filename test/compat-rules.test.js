/* Tests for the rack compatibility rules engine.
 * Run: node compat-rules.test.js
 *
 * Cases are real ones from the last few weeks of tickets and ClickUp, so a
 * failure here means the tool would have given a real agent a wrong answer.
 */
const { evaluate, inferTubing, VERDICT } = require("../_compat-rules");

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got:  ${got}\n         want: ${want}`); }
}

/* ---- fixtures ------------------------------------------------------- */
const racks = {
  hydra:      { id: "hydra", name: "Hydra", is_bos: true, tubing_class: "true-3x3", posts: 4, internal_width: 43 },
  hydraFlat:  { id: "hydra-flatfoot", name: "Hydra (flat foot)", is_bos: true, tubing_class: "true-3x3", posts: 2, internal_width: 43, flat_feet: true },
  manticore:  { id: "manticore", name: "Manticore", is_bos: true, tubing_class: "true-3x3", posts: 4, internal_width: 43 },
  oblivyon:   { id: "oblivyon-tower", name: "Oblivyon Tower", is_bos: true, tubing_class: "true-3x3", posts: 1, internal_width: 43 },
  residential:{ id: "residential", name: "Residential Rack", is_bos: true, tubing_class: "60mm", posts: 4, internal_width: 43, no_side_holes: true },
  dbRack:     { id: "res-dumbbell-rack-2", name: "Res Dumbbell Rack 2.0", is_bos: true, tubing_class: "60mm", posts: 1, internal_width: 43, verify_individually: true },
  myrack:     { id: "force-usa-myrack", name: "Force USA MyRack", is_bos: false, tubing_class: "60mm", posts: 4, internal_width: 43, hole_rejects_our_pin: true },
  repPr5000:  { id: "rep-pr-5000", name: "REP PR-5000", is_bos: false, tubing_class: "metric-3x3", posts: 4, internal_width: 43 },
  rogueMonster:{ id: "rogue-monster", name: "Rogue Monster", is_bos: false, tubing_class: "true-3x3", posts: 4, internal_width: 43 }
};

const att = {
  kraken:     { name: "Kraken Rack Attachment", tubing_class: "true-3x3", mount_points: 2, min_posts: 2, needs_side_holes: false, needs_lower_crossmember: true },
  smith:      { name: "Smith Machine Attachment", tubing_class: "true-3x3", mount_points: 2, min_posts: 2, needs_side_holes: true },
  latPulldown:{ name: "Lat Pulldown Attachment", tubing_class: "true-3x3", mount_points: 2, min_posts: 2, needs_side_holes: false, min_internal_width: 43, max_internal_width: 43 },
  singlePin:  { name: "Landmine Attachment", tubing_class: "true-3x3", mount_points: 1, min_posts: 1, needs_side_holes: false },
  jcup60:     { name: "J-Cups (2.3″)", tubing_class: "60mm", mount_points: 1, min_posts: 1, needs_side_holes: false }
};

/* ---- R1: inferring tubing from what the customer said ---------------- */
console.log("\nR1 — tubing inference");
check("'true 3x3' → true-3x3",        inferTubing("it's a true 3x3 rack").klass, "true-3x3");
check("'76.2mm' → true-3x3",          inferTubing("uprights are 76.2mm").klass, "true-3x3");
check("bare '3x3' → metric (assumed)",inferTubing("I have a 3x3 rack").klass, "metric-3x3");
check("bare '3x3' is inferred only",  inferTubing("I have a 3x3 rack").confidence, "inferred");
check("'75mm' → metric, stated",      inferTubing("75mm uprights").confidence, "stated");
check("'2.3 inch' → 60mm",            inferTubing("2.3\" tubing").klass, "60mm");
check("nothing said → null",          inferTubing("").klass, null);

/* ---- BOS racks: definite answers ------------------------------------- */
console.log("\nBOS racks");
check("Kraken on Hydra fits",
  evaluate(att.kraken, racks.hydra, "").verdict, VERDICT.FITS);
check("Kraken on Hydra is guaranteed",
  evaluate(att.kraken, racks.hydra, "").guaranteed, true);
check("Smith on Residential fails — no side holes",
  evaluate(att.smith, racks.residential, "").dimension, "side_holes");
check("Kraken on flat feet fails",
  evaluate(att.kraken, racks.hydraFlat, "").dimension, "flat_feet");
check("2-post attachment on Oblivyon fails — one upright",
  evaluate(att.smith, racks.oblivyon, "").dimension, "posts");
check("single-pin attachment on Oblivyon is fine",
  evaluate(att.singlePin, racks.oblivyon, "").verdict, VERDICT.FITS);
check("DB Rack 2.0 must be checked individually",
  evaluate(att.jcup60, racks.dbRack, "").dimension, "verify_pair");

/* ---- metric racks: the two failure modes ----------------------------- */
console.log("\nMetric racks — 1 pin vs 2 pins");
const twoPinMetric = evaluate(att.kraken, racks.repPr5000, "");
check("2-pin on metric fails on spacing", twoPinMetric.dimension, "spacing");
check("2-pin on metric is LIKELY_NOT (non-BOS never FITS)", twoPinMetric.verdict, VERDICT.LIKELY_NOT);

const onePinMetric = evaluate(att.singlePin, racks.repPr5000, "");
check("1-pin on metric flags tubing, not spacing", onePinMetric.dimension, "tubing");
check("1-pin reason mentions the capacity problem",
  /capacity/.test(onePinMetric.reason), true);

/* ---- Force USA MyRack ------------------------------------------------ */
console.log("\nForce USA MyRack");
const myrack = evaluate(att.jcup60, racks.myrack, "");
check("hole rejects our pin outranks tubing match", myrack.dimension, "hole_vs_pin");
check("MyRack is LIKELY_NOT", myrack.verdict, VERDICT.LIKELY_NOT);

/* ---- spec-identical competitor --------------------------------------- */
console.log("\nSpec-identical competitor");
const rogue = evaluate(att.kraken, racks.rogueMonster, "");
check("Rogue Monster never returns FITS", rogue.verdict, VERDICT.UNKNOWN);
check("Rogue Monster is not guaranteed", rogue.guaranteed, false);

/* ---- unknown rack, inferred from the customer's words ---------------- */
console.log("\nUnknown rack, inferred from phrasing");
const bare = evaluate(att.kraken, null, "I have a 3x3 rack with 1 inch holes");
check("bare 3x3 + 2 pins → LIKELY_NOT", bare.verdict, VERDICT.LIKELY_NOT);
check("adds a measurement-check note", bare.notes.some(n => /76\.2/.test(n)), true);

const trueClaim = evaluate(att.kraken, null, "it's a true 3x3, 76.2mm");
check("stated true 3x3 doesn't fail on tubing", trueClaim.dimension, null);
check("but still not guaranteed — not our rack", trueClaim.guaranteed, false);

/* ---- internal width -------------------------------------------------- */
console.log("\nInternal width");
const widthUnknown = evaluate(att.latPulldown, null, "true 3x3 76.2mm");
check("lat pulldown with unknown width → NEED_SPEC", widthUnknown.verdict, VERDICT.NEED_SPEC);
check("asks for INTERNAL width", /INTERNAL/i.test(widthUnknown.reason), true);

const narrow = evaluate(att.latPulldown, { name: "Some 41″ rack", is_bos: false, tubing_class: "true-3x3", posts: 4, internal_width: 41 }, "");
check("41″ rack fails lat pulldown on width", narrow.dimension, "internal_width");


/* ---- measurement queue ----------------------------------------------- */
const { buildWorklist } = require("../_compat-rules");
console.log("\nPending measurements");

const unmeasured = { name: "Y Dip Bar", tubing_class: "true-3x3", mount_points: "?", min_posts: 1, needs_side_holes: "?" };

const gap = evaluate(unmeasured, racks.hydra, "");
check("unknown mount_points → NEEDS_MEASUREMENT", gap.verdict, VERDICT.NEEDS_MEASUREMENT);
check("raises two requests", gap.measurement_requests.length, 2);
check("asks for mount_points", gap.measurement_requests.some(m => m.spec_key === "mount_points"), true);

// A known incompatibility answers the question — don't send anyone to measure.
const gapButFails = evaluate(
  { name: "Mystery side-mount", tubing_class: "true-3x3", mount_points: "?", min_posts: 1, needs_side_holes: true },
  racks.residential, "");
check("hard fail beats a measurement gap", gapButFails.verdict, VERDICT.DOESNT_FIT);
check("and raises no showroom work", gapButFails.measurement_requests.length, 0);

// One trip to the Kraken should clear every question waiting on the Kraken.
const many = [
  ...evaluate({ name: "Kraken", tubing_class: "true-3x3", mount_points: "?", min_posts: 1, needs_side_holes: false }, racks.hydra, "").measurement_requests,
  ...evaluate({ name: "Kraken", tubing_class: "true-3x3", mount_points: "?", min_posts: 1, needs_side_holes: false }, racks.manticore, "").measurement_requests,
  ...evaluate(unmeasured, racks.hydra, "").measurement_requests
];
const work = buildWorklist(many);
check("worklist dedupes to 3 distinct jobs", work.length, 3);
check("most-blocking job is first", work[0].blocking, 2);
check("most-blocking job is the Kraken", work[0].subject_name, "Kraken");

/* ---- mount type: pin vs bolt-on vs bespoke --------------------------- */
console.log("\nMount type");

const kraken = { name: "Kraken Rack Attachment", tubing_class: "true-3x3",
  mount_type: "bespoke", mount_points: "?", needs_side_holes: "?", min_posts: 2,
  fits_racks: "hydra,manticore" };

check("bespoke attachment isn't asked for a pin count",
  evaluate(kraken, racks.hydra, "").measurement_requests.some(m => m.spec_key === "mount_points"), false);
check("bespoke on a listed rack fits",
  evaluate(kraken, racks.hydra, "").verdict, VERDICT.FITS);
check("bespoke on an unlisted BOS rack won't fit",
  evaluate(kraken, racks.oblivyon, "").dimension, "not_listed");
check("bespoke with no rack named asks which rack",
  evaluate(kraken, null, "3x3 rack").verdict, VERDICT.NEED_SPEC);

/* Marking something bespoke without filling in the list is the likely mistake,
 * and the wrong behaviour there is a confident DOESNT_FIT on every rack. */
const bespokeNoList = { name: "Kraken", tubing_class: "true-3x3", mount_type: "bespoke",
  mount_points: "?", needs_side_holes: "?", min_posts: 2, fits_racks: "" };
const noList = evaluate(bespokeNoList, racks.hydra, "");
check("bespoke with no list never says DOESNT_FIT", noList.verdict === VERDICT.DOESNT_FIT, false);
check("bespoke with no list is not guaranteed", noList.guaranteed, false);
check("bespoke with no list flags the missing list", noList.dimension, "not_listed");

const boltOn = { name: "Bolt-on thing", tubing_class: "true-3x3", mount_type: "bolt-on",
  mount_points: "?", needs_side_holes: false, min_posts: 1 };
check("bolt-on isn't asked for a pin count",
  evaluate(boltOn, racks.hydra, "").measurement_requests.length, 0);
check("bolt-on on metric doesn't fail on pin spacing",
  evaluate(boltOn, racks.repPr5000, "").dimension, "tubing");


console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
