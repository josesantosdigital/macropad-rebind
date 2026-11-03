/**
 * Smoke test for index.html's device layer.
 *
 * test-protocol.mjs covers the message builders, but it slices out only the
 * pure core — which is how a `const` declared inside an `if` block and used
 * after it shipped and broke connecting entirely. Syntax checks pass on that;
 * only running the code catches it.
 *
 * So this loads the WHOLE script under a mock DOM and a mock WebHID device that
 * answers 0xFB and 0xFA the way real hardware does, then drives connect, read
 * and write end to end.
 *
 * Run:  node test-app.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");
const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];

let pass = 0, fail = 0;
const ok  = (n, c) => c ? (pass++, console.log("  ok    " + n))
                        : (fail++, console.log("  FAIL  " + n));
const eq  = (n, got, want) => ok(`${n} -> ${got}`, got === want) ||
                              (got !== want && console.log(`        want ${want}`));

/* ---- minimal DOM ---- */
const mkEl = () => {
  const t = {
    children: [], style: {}, dataset: {}, disabled: false, value: "",
    className: "", title: "", selected: false, hidden: false,
    classList: { _s: new Set(), toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
                 add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
                 contains(c) { return this._s.has(c); } },
    append(...k) { t.children.push(...k); }, appendChild(k) { t.children.push(k); return k; },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    focus() {}, click() {}, remove() {}, showModal() { t._open = true; }, close() { t._open = false; },
  };
  // Assigning textContent or innerHTML replaces everything inside the node.
  // The render functions all clear their container that way before refilling
  // it, so a plain property here made every list grow without bound.
  let text = "", html = "";
  Object.defineProperty(t, "textContent", {
    enumerable: true,
    get: () => text || t.children.map(c => c.textContent).join(""),
    set: v => { text = String(v); t.children.length = 0; },
  });
  Object.defineProperty(t, "innerHTML", {
    enumerable: true,
    get: () => html,
    set: v => { html = String(v); t.children.length = 0; },
  });
  return t;
};
// Controls that start disabled in the page must start disabled here too.
// Without this the mock hands back an enabled button no matter what, so a
// connect path that fails to enable one still looks like success — which is
// exactly how a regression that disabled writing on 4-encoder pads slipped
// past a green suite.
const initiallyDisabled = new Set(
  [...html.matchAll(/<(?:button|input|select)[^>]*>/g)]
    .filter(m => /\bdisabled\b/.test(m[0]))
    .map(m => /\bid="([^"]+)"/.exec(m[0])?.[1])
    .filter(Boolean));

const registry = new Map();
const document = {
  getElementById(id) {
    if (!registry.has(id)) {
      const e = mkEl();
      e.disabled = initiallyDisabled.has(id);
      registry.set(id, e);
    }
    return registry.get(id);
  },
  createElement: mkEl,
  createTextNode(t) { const e = mkEl(); e.textContent = String(t); return e; },
  addEventListener() {},
};
function Option(text, value) { const e = mkEl(); e.textContent = text; e.value = value ?? text; return e; }
const store = new Map();
const ls = { getItem: k => (store.has(k) ? store.get(k) : null),
             setItem: (k, v) => store.set(k, String(v)),
             removeItem: k => store.delete(k) };
const windowStub = { addEventListener() {} };

/* ---- a keypad that behaves like a 1189:8842 ----

   This mock *applies* what is written and replays it on the next read. That is
   the difference between testing the write path and testing that it does not
   throw: with a mock that ignored writes, the app's own read-back verification
   could only ever land in the "could not confirm" branch, and every assertion
   below would pass just as well with the verification inverted or its await
   dropped. `deaf` exists so the failing direction can be tested too.

   Records are stored keyed by (layer, slot). The write message and the read
   reply share one layout — only byte 0 differs, 0xFE vs 0xFA — so replaying a
   stored write means swapping that byte and nothing else. */
function makeDevice({ keys = 12, knobs = 2, pid = 0x8842, vid = 0x1189, silent = false, fbByte = 0xfb, knobSlotList = null,
                      descriptor = null, usagePage = 0xff00, productName = "USB Composite Device" } = {}) {
  const isCh3 = vid === 0x514c && pid === 0x8850 && keys === 16 && knobs === 3;
  const listeners = [];
  const sent = [];
  // `descriptor` ({ inputReports, outputReports, featureReports }) makes this
  // mock refuse writes the way Chrome does before they reach a device: no
  // output reports at all, a report longer than declared, or a report id
  // whose presence disagrees with the descriptor. Without a descriptor it
  // behaves as before, like a platform that reports no detail.
  const bytesOf = r => Math.ceil((r.items || [])
    .reduce((n, i) => n + i.reportSize * i.reportCount, 0) / 8);
  const declared = descriptor ? [...(descriptor.inputReports || []),
    ...(descriptor.outputReports || []), ...(descriptor.featureReports || [])] : [];
  const hasIds = declared.some(r => r.reportId);
  const bare = !!descriptor && !hasIds;     // no report ids: 0x03 travels as data
  const config = new Map();          // "layer:slot" -> 64 bytes, read-reply form
  const stagedCh3 = [];
  const key = (layer, slot) => `${layer}:${slot}`;

  // Seed a plausible factory config: every key on Mute, every knob action on
  // volume up, across all three layers.
  const seed = (layer, slot, media) =>
    config.set(key(layer, slot),
      [0xfa, slot, layer + 1, 2, 0, 0, 0, 0, 0, 1, media & 0xff, media >> 8]);
  for (let l = 0; l < 3; l++) {
    for (let slot = 1; slot <= keys; slot++) seed(l, slot, 0xe9);
    // Real encoder slots when the caller knows them; the generic run otherwise.
    const ks = knobSlotList || Array.from({ length: knobs * 3 }, (_, i) => (isCh3 ? 17 : 16) + i);
    for (const slot of ks) seed(l, slot, 0xea);
  }

  const emit = bytes => {
    const buf = new Uint8Array(64);
    buf.set((bare ? [0x03, ...bytes] : bytes).slice(0, 64));
    const data = new DataView(buf.buffer);
    for (const cb of listeners) cb({ reportId: bare ? 0 : 3, data });
  };
  return {
    vendorId: vid, productId: pid, productName,
    opened: false, collections: [{ usagePage, usage: 1, ...(descriptor || {}) }],
    refused: 0,
    sent,
    deaf: false,          // when true, accept writes and store nothing
    config,
    async open() { this.opened = true; },
    addEventListener(_ev, cb) { listeners.push(cb); },
    async sendReport(id, data) {
      if (descriptor) {
        const max = Math.max(0, ...(descriptor.outputReports || []).map(bytesOf));
        if (!max || data.length > max || hasIds !== (id !== 0)) {
          this.refused++;
          throw new Error("Failed to write the report.");
        }
      }
      const raw = Array.from(data);
      const b = bare && raw[0] === 0x03 ? raw.slice(1) : raw;
      sent.push({ id, b, raw });
      if (silent && (b[0] === 0xfb || b[0] === 0xfa)) return;
      if (b[0] === 0xfb) { emit([fbByte, keys, knobs]); return; }
      if (isCh3 && b[0] === 0xfe && b[1] === 0xb0) {
        if (this.rgbCorruptBinding) {
          config.set(key(0, 1), [0xfa, 1, 1, 1, 0, 1, 0, 0, 0x1d]);
          this.rgbCorruptBinding = false;
        }
        return;
      }
      if (isCh3 && b[0] === 0xfd) {
        if (b[1] === 0xfe && b[2] === 0xff) {
          if (!this.deaf)
            for (const item of stagedCh3)
              config.set(key(item.layer, item.slot), item.record);
          stagedCh3.length = 0;
          return;
        }
        if (!this.deaf && b[1] >= 1 && b[1] <= 25 && b[2] >= 1 && b[2] <= 3)
          stagedCh3.push({
            layer: b[2] - 1, slot: b[1],
            record: [0xfa, b[1], b[2], b[3], 1, ...b.slice(5)],
          });
        return;
      }
      if (b[0] === 0xfe && !this.deaf) {
        // b[1] slot, b[2] layer (1-based). Store it as the read reply.
        const layer = (b[2] || 1) - 1, slot = b[1];
        if (slot >= 1 && slot < 0xb0) config.set(key(layer, slot), [0xfa, ...b.slice(1)]);
        return;
      }
      if (b[0] === 0xfa) {
        const layer = (b[3] || 1) - 1;
        for (const [k, rec] of config) if (k.startsWith(`${layer}:`)) emit(rec);
      }
    },
  };
}

const device = makeDevice();
// Swappable so a second, differently shaped keypad can be plugged in mid-test.
let current = device;
// A physical keypad can hand back several interfaces from one pick, so
// `current` may be an array. The filters asked for are kept for inspection.
let lastFilters = null;
const navigator = { hid: {
  async requestDevice(opts) { lastFilters = opts.filters; return [].concat(current); },
  addEventListener() {} } };

/* ---- load the real script ---- */
let confirmResult = true;
const app = new Function(
  "document", "navigator", "window", "localStorage", "Option", "confirm", "alert", "Blob", "URL",
  script + "\nreturn { connect, writeAll, readAll, detect, bindingReports, preflight, applyXzkjRgb, " +
           "alignKnobBase, slotName, knobBase, knobSlotIn, knobAt, readCommand, " +
           "select, renderAll, renderLayoutPick, " +
           "posOfSlot, disconnected, LAYOUTS, effDialect, loadLayout, " +
           "setForced: d => { forcedDialect = d; }, setLayout, " +
           "profile: () => profile, setProfile: p => { profile = p; }, prewriteBackup: () => prewriteBackup, " +
           "layoutOf: () => layout, dialectOf: () => dialect, $ };"
)(document, navigator, windowStub, ls, Option, () => confirmResult, () => {}, class {}, { createObjectURL: () => "", revokeObjectURL() {} });

console.log("\nscript loads and renders without throwing");
eq("  the log element got content", typeof app.$("log").textContent, "string");

/* Read everything the app has logged. This is the assertion that matters:
   connect() catches its own errors and logs them, so a crash inside it leaves
   every button in the state it had already reached and looks like success. The
   first version of this test passed with the bug still in place. */
const logText = () => {
  const out = [];
  const walk = n => { if (!n) return;
    if (typeof n.textContent === "string" && !n.children?.length) out.push(n.textContent);
    (n.children || []).forEach(walk); };
  walk(app.$("log"));
  return out.join(" ");
};

console.log("\nconnect");
await app.connect(false);
const connectLog = logText();
ok("connect logged no failure", !/Connect failed/i.test(connectLog));
ok("  and no ReferenceError", !/is not defined/i.test(connectLog));
eq("status reads connected", app.$("status").textContent, "connected");
eq("connect enabled Write",  app.$("btnWrite").disabled, false);
eq("connect enabled Read",   app.$("btnRead").disabled, false);
eq("connect enabled Blank",  app.$("btnBlank").disabled, false);
eq("connect enabled Repair", app.$("btnRepair").disabled, false);
eq("dialect detected",       app.dialectOf(), "ch57x-1");
eq("layout adopted from the device", `${app.layoutOf().keys}/${app.layoutOf().knobs}`, "12/2");

console.log("\nread from keypad");
await app.readAll();
const p = app.profile();
eq("layer 1 bindings loaded", Object.keys(p.layers[0].bindings).length, 18);
eq("  slot 1 decoded as media", p.layers[0].bindings[1].type, "media");

// The diff dialog blocks until the user confirms, so stand in for that click.
// (That it blocks at all is worth knowing — an earlier version of this test
// hung here, which is the dialog doing its job.)
let dialogsShown = 0;
app.$("diffDlg").showModal = () => {
  dialogsShown++;
  setTimeout(() => app.$("diffGo").onclick?.(), 0);
};

console.log("\nwrite with nothing changed");
device.sent.length = 0;
await app.writeAll();
eq("  sends no records when editor matches device",
   device.sent.filter(s => s.b[0] === 0xfe).length, 0);

console.log("\nwrite after an edit");
// Change one binding so there is something to write.
p.layers[0].bindings[1] = { type: "key", steps: [{ mods: 0x01, code: 0x06 }], delay: 0 };
device.sent.length = 0;
await app.writeAll();
const recs = device.sent.filter(s => s.b[0] === 0xfe);
ok(`wrote records (${recs.length} 0xFE reports)`, recs.length > 0);
eq("  the changed slot was written", recs.some(r => r.b[1] === 1), true);
eq("  as a keyboard binding, ctrl+c",
   recs.some(r => r.b[1] === 1 && r.b[3] === 1 && r.b[10] === 0x01 && r.b[11] === 0x06), true);
ok("no 0xEF was ever sent", !device.sent.some(s => s.b[0] === 0xef));
ok("every report is 64 bytes", device.sent.every(s => s.b.length === 64));
ok("report id is always 3", device.sent.every(s => s.id === 3));
eq("the diff dialog was shown before writing", dialogsShown, 1);
// The app reads the device back after writing. With a mock that stores what it
// is told, that check has to come out clean — and this is the assertion that
// gives the ones above their teeth.
const writeLog = logText();
ok("the write was verified against the device", /Verified/.test(writeLog));
ok("  and confirmed every binding", !/Could not confirm/.test(writeLog));

console.log("\nverification catches a device that stores nothing");
// Same write against a keypad that acknowledges and discards. If this does not
// complain, the verification is decorative.
device.deaf = true;
p.layers[0].bindings[2] = { type: "key", steps: [{ mods: 0x02, code: 0x07 }], delay: 0 };
const beforeDeaf = logText().length;
await app.writeAll();
const deafLog = logText().slice(beforeDeaf);
ok("reports the bindings it could not confirm", /Could not confirm/.test(deafLog));
ok("  and does not claim success",              !/Verified/.test(deafLog));
ok("  and says the keypad is probably fine",    /probably fine/i.test(deafLog));
device.deaf = false;

console.log("\nCH3 writes stay locked on a different device");
// The CH3 reader/writer is scoped to the positively identified 514C:8850
// 16x3 board. A format override on a generic CH57x-1 device must not bypass it.
app.setForced("ch57x-3");
const pg = app.profile();
for (const l of pg.layers) l.bindings = {};
pg.layers[0].bindings[1] = { type: "media", media: 0xe9 };
device.sent.length = 0;
const beforeGate = logText().length;
await app.writeAll();
const gateLog = logText().slice(beforeGate);
eq("no configuration reports were sent", device.sent.length, 0);
eq("no backlight records for a format that has none",
   device.sent.filter(r => r.b[1] === 0xb0).length, 0);
ok("and it explains the device identification requirement", /writing is disabled/i.test(gateLog));
app.setForced(null);

console.log("\nbindings that cannot fit the format stop the write before it starts");
// Force a format that caps macros at 5 steps and has no delay record, then put
// a binding in the editor that breaks both rules. Nothing may reach the device:
// the encoders throw from inside the write loop, so without a pre-flight the
// earlier slots are already changed when it gives up.
app.setForced("ch57x-2");
const long = { type: "key", delay: 0,
               steps: Array.from({ length: 9 }, () => ({ mods: 0, code: 0x04 })) };
const pf = app.profile();
pf.layers[0].bindings[3] = long;
pf.layers[0].bindings[4] = { type: "key", steps: [{ mods: 0, code: 0x04 }], delay: 100 };
const bad = app.preflight();
eq("pre-flight names both offenders", bad.length, 2);
ok("  and says which key and layer", bad.every(m => /^L1 key \d+:/.test(m)));
device.sent.length = 0;
const beforePf = logText().length;
await app.writeAll();
const pfLog = logText().slice(beforePf);
eq("nothing was sent to the device", device.sent.length, 0);
ok("  and the log says so", /Nothing was sent/.test(pfLog));

console.log("\nthe editor survives a binding that cannot be encoded");
// renderEditor previews the bytes a binding will send. The encoders throw for
// the binding above, and unhandled that exception escapes renderEditor ->
// renderAll -> connect(), which then reports a healthy keypad as a failure.
let threw = null;
try { app.select(3, "key 3"); } catch (e) { threw = e; }
eq("selecting it does not throw", threw, null);
try { app.renderAll(); } catch (e) { threw = e; }
eq("re-rendering does not throw", threw, null);
delete pf.layers[0].bindings[3];
delete pf.layers[0].bindings[4];
app.setForced(null);

console.log("\nlayouts can be selected before connection but incompatible I/O stays locked");
app.renderLayoutPick();
const offered = (app.$("layoutPick").children || []).map(o => o.value);
ok("16-key layouts are available for selection", offered.includes("16/3"));
ok("the verified 12+2 layout is offered", offered.includes("12/2"));
app.$("layoutPick").onchange({ target: { value: "16/3" } });
eq("an incompatible layout disables Read", app.$("btnRead").disabled, true);
eq("an incompatible layout disables Write", app.$("btnWrite").disabled, true);
device.sent.length = 0;
await app.writeAll();
eq("an incompatible layout sends no reports", device.sent.length, 0);
app.$("layoutPick").onchange({ target: { value: "12/2" } });

console.log("\nthree-knob pads keep their third knob");
// Knob 3 lives at slots 22-24. A read ceiling of 21 dropped it, so those
// bindings never loaded and the write verification reported them missing on
// every single write — on hardware nobody here owns. Plug one in and read it.
const dev3 = makeDevice({ keys: 15, knobs: 3 });
eq("knob 3 cw is slot 24", 16 + 3 * 2 + 2, 24);
current = dev3;
app.disconnected();
await app.connect(false);
eq("the 15-key, 3-knob layout was adopted",
   `${app.layoutOf().keys}/${app.layoutOf().knobs}`, "15/3");
await app.readAll();
const p3 = app.profile().layers[0].bindings;
eq("slot 22 (knob 3 ccw) loaded",   p3[22]?.type, "media");
eq("slot 23 (knob 3 press) loaded", p3[23]?.type, "media");
eq("slot 24 (knob 3 cw) loaded",    p3[24]?.type, "media");
eq("all 15 keys plus 9 knob actions", Object.keys(p3).length, 24);
// And writing them back must verify, which is what used to cry wolf.
p3[24] = { type: "media", media: 0xe9 };
const before3 = logText().length;
await app.writeAll();
const log3 = logText().slice(before3);
ok("a knob-3 write verifies clean", /Verified/.test(log3));
ok("  with no false alarm",         !/Could not confirm/.test(log3));
current = device;
app.disconnected();

console.log("\nfour-encoder pads are addressable (PR #1, issue: writing was refused)");
// The SikaiCase 1189:8842 answers 0xFB with 12 keys and 4 encoders. A knob cap
// of 3 rejected that answer and disabled writing while telling the user their
// keypad had not identified itself. Verified on hardware by @geniosid.
const dev4 = makeDevice({
  keys: 12, knobs: 4,
  // 0x10-0x18 for encoders 1-3, then 0x0D-0x0F for encoder 4.
  knobSlotList: [0x10,0x11,0x12, 0x13,0x14,0x15, 0x16,0x17,0x18, 0x0D,0x0E,0x0F],
});
current = dev4;
app.disconnected();
await app.connect(false);
eq("the 12-key, 4-encoder layout is adopted",
   `${app.layoutOf().keys}/${app.layoutOf().knobs}`, "12/4");
eq("writing is enabled", app.$("btnWrite").disabled, false);
ok("and the device is not blamed", !/did not answer 0xFB/.test(logText()));

console.log("\n  its fourth encoder sits below the keys, not above them");
const lay4 = app.LAYOUTS.find(l => l.keys === 12 && l.knobs === 4);
eq("encoder 1 ccw is 0x10", app.knobSlotIn(lay4, 0, 0), 0x10);
eq("encoder 3 cw is 0x18",  app.knobSlotIn(lay4, 2, 2), 0x18);
eq("encoder 4 ccw is 0x0D", app.knobSlotIn(lay4, 3, 0), 0x0D);
eq("encoder 4 cw is 0x0F",  app.knobSlotIn(lay4, 3, 2), 0x0F);
// The generic rule would have put encoder 4 at 0x19-0x1B, past the records.
ok("which the generic rule would have got wrong",
   app.knobSlotIn(null, 3, 0) !== app.knobSlotIn(lay4, 3, 0));
const pos4 = app.posOfSlot(app.layoutOf());
eq("and it is named, not printed as a bare slot",
   app.slotName(0x0E, pos4), "knob 4 press");

console.log("\n  and it is read with the command its firmware answers to");
dev4.sent.length = 0;
await app.readAll();
const p4 = app.profile().layers[0].bindings;
eq("all 24 records loaded", Object.keys(p4).length, 24);
eq("  encoder 4 press came back", p4[0x0E]?.type, "media");
// 15 keys + 3 knobs and 12 keys + 4 knobs are both 24 records; the firmware
// counts keys + 3*knobs, and only the first form makes it reply.
const readCmds = dev4.sent.filter(r => r.b[0] === 0xfa);
ok("a read was issued", readCmds.length > 0);
eq("addressed as 15 keys", readCmds[0].b[1], 0x0F);
eq("  and 3 knobs",        readCmds[0].b[2], 0x03);
current = device;
app.disconnected();

console.log("\nsingle-key pads have a layout to choose (issue #2)");
// The reporter had a one-key pad, picked "0 keys, 1 knobs" as the nearest
// thing, and their Ctrl+S landed on a knob slot and did nothing.
app.renderLayoutPick();
const opts = (app.$("layoutPick").children || []).map(o => o.value);
ok("1 key, 0 knobs is offered", opts.includes("1/0"));
app.setLayout(app.LAYOUTS.find(l => l.keys === 1 && l.knobs === 0));
eq("its only key is slot 1", app.posOfSlot(app.layoutOf()).get(1), 1);
app.setLayout(app.LAYOUTS.find(l => l.keys === 12 && l.knobs === 2));

console.log("\nreport framing follows the descriptor (issue #3)");
// A 1189:8890 refused all three command formats in under a second with
// "Failed to write the report." — not one byte left the browser, because
// every device got report id 3 at 64 bytes whatever its descriptor said.
const out64 = n => ({ reportId: n, items: [{ reportSize: 8, reportCount: 64 }] });
const VENDOR_IDS_FOR_TEST = [0x1189, 0x514c];

// First, the guarantee: the verified descriptor gets exactly what it got before.
const devV = makeDevice({ descriptor: { inputReports: [out64(3)], outputReports: [out64(3)] } });
current = devV; app.disconnected(); await app.connect(false);
await app.readAll();
eq("verified descriptor: nothing refused", devV.refused, 0);
ok("  every report still id 3 at 64 bytes",
   devV.sent.length > 0 && devV.sent.every(r => r.id === 3 && r.raw.length === 64));
ok("  and no framing change is announced", !/Framing adjusted/.test(logText()));

// A keypad with no report ids. Chrome refuses id 3 outright.
const devB = makeDevice({ descriptor: { inputReports: [out64(0)], outputReports: [out64(0)] } });
current = devB; app.disconnected();
const beforeB = logText().length;
await app.connect(false);
const logB = logText().slice(beforeB);
ok("no report ids: the adjustment is announced", /Framing adjusted.*no report ids/.test(logB));
ok("  and the descriptor is shown", /Reports: in 0 \(64 bytes\), out 0 \(64 bytes\)/.test(logB));
eq("  identify got through and the layout was read",
   `${app.layoutOf().keys}/${app.layoutOf().knobs}`, "12/2");
eq("  so writing is enabled", app.$("btnWrite").disabled, false);
await app.readAll();
eq("  a full read comes back", Object.keys(app.profile().layers[0].bindings).length, 18);
app.profile().layers[0].bindings[1] = { type: "key", steps: [{ mods: 0x01, code: 0x06 }], delay: 0 };
const beforeW = logText().length;
await app.writeAll();
const logW = logText().slice(beforeW);
eq("  the browser refused nothing", devB.refused, 0);
ok("  and the write verified", /Verified/.test(logW));
ok("  every report sent as id 0 with 0x03 leading",
   devB.sent.every(r => r.id === 0 && r.raw[0] === 0x03));

// A keypad declaring only feature reports cannot be written with output
// reports at all. Say so on connect, and name the refusal when it happens.
const devF = makeDevice({ descriptor: { inputReports: [out64(3)], outputReports: [],
                                        featureReports: [out64(3)] } });
current = devF; app.disconnected();
const beforeF = logText().length;
await app.connect(false);
ok("feature-only: diagnosed on connect", /declares only feature reports/.test(logText().slice(beforeF)));
app.setLayout(app.LAYOUTS.find(l => l.keys === 12 && l.knobs === 2));
app.profile().layers[0].bindings[1] = { type: "media", media: 0xe9 };
const beforeF2 = logText().length;
await app.readAll();
ok("  and a refused write names what was sent and where to look",
   /Sent 0x[0-9a-f]{2} as report id 3, 64 bytes.*chrome:\/\/device-log/.test(logText().slice(beforeF2)));
current = device; app.disconnected();

console.log("\none pick, several interfaces: the configuration one is opened (issue #3)");
// Atom-66's 1189:8890 came back through "Device not listed?" as its
// media-key interface — Consumer page, one 2-byte input report — because the
// app opened whichever interface the picker listed first.
const mediaIface  = makeDevice({ pid: 0x8890, usagePage: 0x0c });
const configIface = makeDevice({ pid: 0x8842 });
current = [mediaIface, configIface];
app.disconnected();
const beforeI = logText().length;
await app.connect(true);                    // the "Device not listed?" path
const logI = logText().slice(beforeI);
eq("the unfiltered search really is unfiltered", JSON.stringify(lastFilters), "[]");
eq("the media interface was left alone",  mediaIface.opened, false);
eq("the configuration interface was opened", configIface.opened, true);
ok("  and the log lists both and says which", /2 HID interfaces: 1\) 0x000C, 2\) 0xFF00\. Using 2/.test(logI));
ok("  so the device was not written off", !/declares no output reports/.test(logI));
current = device; app.disconnected();
await app.connect(false);
ok("the normal search still asks for the vendor page only",
   lastFilters.every(f => f.usagePage === 0xff00 && VENDOR_IDS_FOR_TEST.includes(f.vendorId)));
app.disconnected();

console.log("\nan LCKEY gets LCTECH's own format, end to end");
// Decoded from the vendor's configurator: no report ids, one 12-byte report
// per binding starting with its type byte, no commit, no wake-up. The mock
// refuses mis-framed writes the way Chrome does.
const lc = makeDevice({ pid: 0x8890, productName: "LCKEY",
  descriptor: { outputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 12 }] }] } });
current = lc; app.disconnected();
const beforeLc = logText().length;
await app.connect(false);
eq("the format is chosen from the product name", app.effDialect(), "lctech");
eq("nothing was sent on connect (no wake-up)", lc.sent.length, 0);
app.setLayout(app.LAYOUTS.find(l => l.keys === 3 && l.knobs === 1));
const pl = app.profile();
for (const l of pl.layers) l.bindings = {};
pl.layers[0].bindings[1] = { type: "key", steps: [{ mods: 0x01, code: 0x06 }], delay: 0 };
pl.layers[1].bindings[2] = { type: "media", media: 0xe9 };
app.alignKnobBase();
await app.writeAll();
eq("the browser refused nothing", lc.refused, 0);
eq("one report per binding, nothing else", lc.sent.length, 2);
eq("  each 12 bytes, no report id", lc.sent.every(r => r.id === 0 && r.raw.length === 12), true);
eq("  Ctrl+C as LCTECH writes it", lc.sent[0].raw.join(), [1, 1, 1, 0, 1, 0, 6, 0, 0, 0, 0, 0].join());
eq("  volume up on layer 2", lc.sent[1].raw.join(), [2, 2, 2, 0, 0x80, 0, 0, 0, 0, 0, 0, 0].join());
eq("  and no ch57x commands at all",
   lc.sent.some(r => [0xfe, 0xfd, 0xaa, 0xfa, 0xfb, 0x03].includes(r.raw[0])), false);
current = device; app.disconnected();

console.log("\nthe 6-key layout opens the way it is held, and old saves are corrected");
app.setLayout(app.LAYOUTS.find(l => l.keys === 6 && l.knobs === 1));
eq("picking it starts knob-right (clockwise)", app.layoutOf().orientation, "clockwise");
store.set("macropad-rebind.layout.v1",
  JSON.stringify({ keys: 6, knobs: 1, cols: 3, rows: 2, orientation: "clockwise" }));
const reloaded = app.loadLayout();
eq("a layout saved with the old 3x2 shape loads as 2x3", `${reloaded.cols}x${reloaded.rows}`, "2x3");
eq("  keeping how it was held", reloaded.orientation, "clockwise");
app.setLayout(app.LAYOUTS.find(l => l.keys === 12 && l.knobs === 2));
app.setOrientation?.("normal");

console.log("\nknob bindings follow the dialect's numbering");
// Slot numbers are what gets persisted, and a knob's slot depends on the
// format (base 13, 16 or 17). Without a remap, saved knob bindings are written
// to real keys on the next keypad.
app.setProfile({
  knobBase: 13,
  layers: [{ bindings: { 5: { type: "media", media: 0xe9 },
                         13: { type: "media", media: 0xea } },
             led: { mode: "backlight", color: 1 } },
           { bindings: {}, led: { mode: "backlight", color: 1 } },
           { bindings: {}, led: { mode: "backlight", color: 1 } }],
});
const movedN = app.alignKnobBase();
eq("one knob binding moved", movedN, 1);
eq("  base 13 knob 1 ccw became slot 16",
   app.profile().layers[0].bindings[16]?.media, 0xea);
eq("  the old slot is gone", app.profile().layers[0].bindings[13], undefined);
eq("  the key binding stayed put", app.profile().layers[0].bindings[5]?.media, 0xe9);
eq("  and the base is stamped", app.profile().knobBase, 16);
eq("running it again moves nothing", app.alignKnobBase(), 0);

console.log("\nslot names survive a moved knob base");
const pos = app.posOfSlot(app.layoutOf());
eq("slot 16 is knob 1 ccw", app.slotName(16, pos), "knob 1 ccw");
eq("slot 24 is knob 3 cw",  app.slotName(24, pos), "knob 3 cw");
ok("a slot below the base is never a negative knob",
   !/knob 0|undefined/.test(app.slotName(13, pos)));

console.log("\na USB id filed under another format, but the keypad answers the standard one");
// 514c:8850 is reused across boards. The XZKJ 16x3 variant has a captured read
// path but no lighting command. A 12-key, 4-knob unit with that id answers 0xFB and 0xFA like the standard
// format, so the keypad's own answer should overrule the id table and enable the
// Standard reader and lighting controls.
const KNOBS4 = [0x10,0x11,0x12, 0x13,0x14,0x15, 0x16,0x17,0x18, 0x0D,0x0E,0x0F];
const d8850 = makeDevice({ vid: 0x514c, pid: 0x8850, keys: 12, knobs: 4, knobSlotList: KNOBS4 });
current = d8850; app.disconnected();
const before8850 = logText().length;
await app.connect(false);
const log8850 = logText().slice(before8850);
eq("it is treated as the standard format", app.effDialect(), "ch57x-1");
ok("  and the log says why", /answers the standard read commands/.test(log8850));
eq("  Read is enabled",            app.$("btnRead").disabled, false);
eq("  Detect is enabled",          app.$("btnDetect").disabled, false);
eq("  Apply lighting is enabled",  app.$("btnApplyLed").disabled, false);
eq("  Write is enabled",           app.$("btnWrite").disabled, false);
eq("  the 12+4 layout is adopted", `${app.layoutOf().keys}/${app.layoutOf().knobs}`, "12/4");
// Repair sends 0xFC with the chosen model; its description must name that
// model, not the "12 keys, 2 knobs" it used to say for every pad.
eq("  and Repair says what it would declare", app.$("repairShape").textContent, "12 keys, 4 knobs");
ok("  no 'untested format' warning", !/never been tried on real hardware/.test(log8850));
d8850.sent.length = 0;
await app.readAll();
eq("  a full read returns 24 records", Object.keys(app.profile().layers[0].bindings).length, 24);
app.profile().layers[0].bindings[1] = { type: "key", steps: [{ mods: 0x01, code: 0x06 }], delay: 0 };
d8850.sent.length = 0;
const before8850w = logText().length;
await app.writeAll();
ok("  a write verifies", /Verified/.test(logText().slice(before8850w)));
// 0xFD also begins the standard format's commit (FD FE FF); what marks the
// other format is a 0xFD *binding*, whose second byte is a slot, not 0xFE.
ok("  and was sent in the standard format (0xFE records), not as 0xFD bindings",
   d8850.sent.some(r => r.b[0] === 0xfe) &&
   !d8850.sent.some(r => r.b[0] === 0xfd && r.b[1] !== 0xfe));
current = device; app.disconnected();

console.log("\n  but a keypad that stays silent keeps the format its id says");
const mute = makeDevice({ vid: 0x514c, pid: 0x8850, silent: true });
current = mute; app.disconnected();
await app.connect(false);
eq("it stays ch57x-3", app.effDialect(), "ch57x-3");
eq("  Read stays disabled", app.$("btnRead").disabled, true);
eq("  Apply lighting stays disabled", app.$("btnApplyLed").disabled, true);
eq("  Repair stays disabled (nothing answered)", app.$("btnRepair").disabled, true);
ok("  only a wake-up and 0xFB were sent, no writes",
   mute.sent.every(r => r.b.every(x => x === 0) || r.b[0] === 0xfb));
console.log("\n  and picking a format by hand refreshes the controls");
app.$("formatPick").onchange({ target: { value: "ch57x-1" } });
eq("forcing Standard enables Read", app.$("btnRead").disabled, false);
eq("  but an unanswered device cannot receive lighting writes",
   app.$("btnApplyLed").disabled, true);
eq("  but not Repair — the keypad never answered", app.$("btnRepair").disabled, true);
eq("  nor Blank, for the same reason", app.$("btnBlank").disabled, true);
app.$("formatPick").onchange({ target: { value: "" } });
eq("back to automatic disables Read again", app.$("btnRead").disabled, true);
current = device; app.disconnected();

console.log("\n  and so does one whose only reply is not an answer to 0xFB");
const stray = makeDevice({ vid: 0x514c, pid: 0x8850, fbByte: 0xaa });
current = stray; app.disconnected();
const beforeStray = logText().length;
await app.connect(false);
eq("a reply not starting with 0xFB is not evidence", app.effDialect(), "ch57x-3");
ok("  and the log says why", /does not begin with 0xFB/.test(logText().slice(beforeStray)));
eq("  Read stays disabled", app.$("btnRead").disabled, true);
current = device; app.disconnected();

console.log("\n  and one whose answer describes a layout Standard cannot address");
// Answering 0xFB is evidence only if the layout fits the format being switched
// to: Standard stops at 15 keys, and a 4x4 pad of the other format answering
// "16 keys" must not be moved onto it, where key 16 would land on a knob slot.
const big = makeDevice({ vid: 0x514c, pid: 0x8850, keys: 16, knobs: 0 });
current = big; app.disconnected();
await app.connect(false);
eq("16 keys keeps the format the id says", app.effDialect(), "ch57x-3");
current = device; app.disconnected();

console.log("\n  and the probe is for 514c:8850 only: a 1189:8890 that answers 0xFB keeps its format");
// 8890 has key bindings confirmed under ch57x-2 on real hardware, and its format
// is disputed; being able to answer a read is not a reason to move it.
const p8890 = makeDevice({ pid: 0x8890, productName: "6 Key Pad" });
current = p8890; app.disconnected();
await app.connect(false);
eq("it stays ch57x-2", app.effDialect(), "ch57x-2");
ok("  and 0xFB was never sent to it", !p8890.sent.some(r => r.b[0] === 0xfb));
current = device; app.disconnected();

console.log("\nknob bindings are shown on the knobs, not only in a tooltip");
// Each knob lists turn-left, press and turn-right with what they are bound to,
// the way a keycap does. They used to be bare glyphs with the binding in a
// hover tooltip, so a pad's knobs could not be read at a glance.
app.setLayout({ ...app.LAYOUTS.find(l => l.keys === 12 && l.knobs === 4), natural: "normal" });
const kp = app.profile();
for (const l of kp.layers) l.bindings = {};
kp.layers[0].bindings[0x10] = { type: "key", steps: [{ mods: 0x01, code: 0x1d }], delay: 0 };  // knob 1 ccw: Ctrl+Z
kp.layers[0].bindings[0x12] = { type: "media", media: 0xe9 };                                    // knob 1 cw: volume up
kp.layers[0].bindings[0x0E] = { type: "key", steps: [{ mods: 0, code: 0x58 }], delay: 0 };       // knob 4 press: Num Enter
app.renderAll();
const rows = [];
const collect = n => { if (!n) return;
  if (/\bknob-act\b/.test(n.className || "")) rows.push(n);
  (n.children || []).forEach(collect); };
collect(app.$("knobs"));
eq("four knobs, three actions each", rows.length, 12);
eq("knob 1 turn left shows its shortcut",  rows[0].textContent.includes("Ctrl+Z"), true);
eq("knob 1 turn right shows its media key", rows[2].textContent.includes("Volume up"), true);
eq("knob 4 press shows its key (stored below the keys)", rows[10].textContent.includes("Num Enter"), true);
eq("an unbound action says so", rows[1].textContent.includes("unset"), true);
ok("  and is styled as empty", /\bempty\b/.test(rows[1].className));
ok("a bound action is styled as bound", /\bbound\b/.test(rows[0].className));
ok("the full text is still the tooltip", rows[0].title.includes("Ctrl+Z") && /turn left/.test(rows[0].title));
rows[4].onclick();                               // knob 2 press
eq("clicking a row selects that action", app.$("editorTitle").textContent, "Knob 2 press");

console.log("\nmouse numeric fields refresh their labels and packet preview");
kp.layers[0].bindings[0x10] = { type:"mouse", action:"wheel", wheel:1, mod:0 };
app.select(0x10, "Knob 1 turn left");
const descendants = root => [root, ...(root.children || []).flatMap(descendants)];
const wheelInput = descendants(app.$("editor")).find(node => node.type === "number" && node.min === "-127");
const wheelPreview = app.$("editor").children.find(node => node.innerHTML.includes("Sends <code>"));
ok("wheel editor has its numeric input and packet preview", !!wheelInput && !!wheelPreview);
wheelInput.value = "-3";
wheelInput.oninput();
eq("changing the wheel value updates the selected binding", kp.layers[0].bindings[0x10].wheel, -3);
ok("wheel input stays mounted while typing", descendants(app.$("editor")).includes(wheelInput));
ok("knob label updates without reselection", descendants(app.$("knobs")).some(node => /knob-act/.test(node.className || "") && node.textContent.includes("Wheel -3")));
const wheelPacket = Array.from(app.bindingReports(0x10, kp.layers[0].bindings[0x10])[0].subarray(0, 16), v => v.toString(16).padStart(2, "0")).join(" ");
ok("packet preview updates without reselection", wheelPreview.innerHTML.includes(wheelPacket));

console.log("\nXZKJ read, optional backup, import, write, and restore");
const xzkjFirst = makeDevice({ vid: 0x514c, pid: 0x8850, keys: 16, knobs: 3,
                               productName: "XZKJ-16key_3knob" });
// Give the mocked current device one distinct mapping to prove restore
// readback, while the remaining slots exercise opaque raw-report retention.
xzkjFirst.config.set("0:1", [0xfa, 1, 1, 1, 1, 1, 0, 0, 0x04]);
xzkjFirst.config.set("0:18", [0xfa, 18, 1, 3, 1, 4, 0, 0, 0, 0, 0, 1]);
xzkjFirst.config.set("0:21", [0xfa, 21, 1, 2, 1, 2, 0, 0, 0xcd, 0, 0, 0]);
xzkjFirst.config.set("0:23", [0xfa, 23, 1, 2, 1, 2, 0, 0, 0xea, 0, 0, 0]);
xzkjFirst.config.set("0:24", [0xfa, 24, 1, 2, 1, 2, 0, 0, 0xe2, 0, 0, 0]);
xzkjFirst.config.set("0:25", [0xfa, 25, 1, 2, 1, 2, 0, 0, 0xe9, 0, 0, 0]);
const vendorShift = "fa 05 01 01 00 01 00 00 f2 00 32 00 00 32 00 00 32 00 00 32 00 00 32 00 00 32 00 00 32 00 00 32 00 00 32 00 00 32 00 00 32 00 00 32 00 00 32 00 00 32 00 00 32 00 00 32 00 00 32 00 00 00 00 00".split(" ").map(x => parseInt(x, 16));
xzkjFirst.config.set("0:5", vendorShift);
current = xzkjFirst; app.disconnected();
await app.connect(false);
eq("identified the XZKJ protocol", app.effDialect(), "ch57x-3");
eq("write is enabled after identification without a manual backup", app.$("btnWrite").disabled, false);
const beforeXzkjRead = logText().length;
await app.readAll();
ok("device read warns that RGB colors and modes are not read", /Lighting was not read.*local draft/.test(logText().slice(beforeXzkjRead)));
const initial = app.profile();
eq("read all 25 records on all 3 layers",
   initial.deviceBackup?.responseReports?.length, 75);
eq("stored the 3 exact read queries", initial.deviceBackup?.queryReports?.length, 3);
eq("decoded the original Key 1 mapping", initial.layers[0].bindings[1]?.steps?.[0]?.code, 0x04);
eq("captured play/pause reads as media", initial.layers[0].bindings[21]?.media, 0xcd);
eq("captured volume down reads as media", initial.layers[0].bindings[23]?.media, 0xea);
eq("captured mute reads as media", initial.layers[0].bindings[24]?.media, 0xe2);
eq("captured volume up reads as media", initial.layers[0].bindings[25]?.media, 0xe9);
eq("captured left click reads as a mouse action", `${initial.layers[0].bindings[18]?.action}:${initial.layers[0].bindings[18]?.buttons}`, "click:1");
eq("decoded the vendor Shift-only record", JSON.stringify(initial.layers[0].bindings[5]?.steps), JSON.stringify([{mods:2,code:0}]));
eq("retained the complete vendor Shift reply", JSON.stringify(initial.layers[0].bindings[5]?._raw), JSON.stringify(vendorShift));
eq("write remains enabled without a backup export", app.$("btnWrite").disabled, false);
const originalProfile = JSON.parse(JSON.stringify(app.profile()));
const legacyActionsProfile = JSON.parse(JSON.stringify(originalProfile));
for (const slot of [18,21,23,24,25]) {
  const raw = legacyActionsProfile.layers[0].bindings[slot]._raw;
  legacyActionsProfile.layers[0].bindings[slot] = { type:"raw", raw, _raw:raw };
}
await app.$("fileImport").onchange({ target: { files: [{ text: async () => JSON.stringify(legacyActionsProfile) }], value: "" } });
eq("older backups promote a recognized raw media record", app.profile().layers[0].bindings[21]?.media, 0xcd);
eq("older backups promote a recognized raw mouse click", app.profile().layers[0].bindings[18]?.action, "click");
app.setProfile(JSON.parse(JSON.stringify(originalProfile)));
const unchangedReadback = xzkjFirst.sent.length;
await app.writeAll();
eq("unchanged captured media and mouse bindings send no writes", xzkjFirst.sent.slice(unchangedReadback).some(r => r.b[0] === 0xfd), false);
const legacyShiftProfile = JSON.parse(JSON.stringify(originalProfile));
legacyShiftProfile.layers[0].bindings[5] = { type: "raw", raw: vendorShift, _raw: vendorShift };
await app.$("fileImport").onchange({ target: { files: [{ text: async () => JSON.stringify(legacyShiftProfile) }], value: "" } });
eq("older raw backups import the vendor Shift record as a key", JSON.stringify(app.profile().layers[0].bindings[5]?.steps), JSON.stringify([{mods:2,code:0}]));
app.setProfile(initial);
const editedBeforeBackup = JSON.parse(JSON.stringify(originalProfile));
editedBeforeBackup.layers[0].bindings[1] =
  { type: "key", steps: [{ mods: 0, code: 0x05 }], delay: 0 };
app.setProfile(editedBeforeBackup);
app.$("btnExport").onclick();
eq("exporting an edited profile does not lock writing", app.$("btnWrite").disabled, false);
app.setProfile(initial);
// A prior-session profile can be used as a target without unlocking anything.
const xzkj = makeDevice({ vid: 0x514c, pid: 0x8850, keys: 16, knobs: 3,
                          productName: "XZKJ-16key_3knob" });
for (const [key, record] of xzkjFirst.config) xzkj.config.set(key, [...record]);
current = xzkj; app.disconnected();
await app.connect(false);
eq("reconnect enables writes after identification", app.$("btnWrite").disabled, false);
await app.$("fileImport").onchange({
  target: { files: [{ text: async () => JSON.stringify(originalProfile) }], value: "" },
});
eq("import leaves identified device writable", app.$("btnWrite").disabled, false);

const changedProfile = JSON.parse(JSON.stringify(originalProfile));
changedProfile.layers[0].bindings[1] =
  { type: "key", steps: [{ mods: 0, code: 0x05 }], delay: 0 };
await app.$("fileImport").onchange({
  target: { files: [{ text: async () => JSON.stringify(changedProfile) }], value: "" },
});
eq("import leaves writing enabled", app.$("btnWrite").disabled, false);
const beforeCh3Write = logText().length;
await app.writeAll();
const ch3WriteLog = logText().slice(beforeCh3Write);
eq("only the changed CH3 slot is sent",
   xzkj.sent.filter(r => r.b[0] === 0xfd && r.b[1] === 1 && r.b[2] === 1).length, 1);
eq("one terminator commits the batch",
   xzkj.sent.filter(r => r.b[0] === 0xfd && r.b[1] === 0xfe && r.b[2] === 0xff).length, 1);
eq("the mapping change is verified by readback", /Verified/.test(ch3WriteLog), true);
eq("Key 1 now stores B", xzkj.config.get("0:1")?.[8], 0x05);
eq("writing another key leaves the vendor Shift record untouched", JSON.stringify(xzkj.config.get("0:5")), JSON.stringify(vendorShift));
eq("writes remain enabled after an attempt", app.$("btnWrite").disabled, false);
eq("the automatic pre-write snapshot contains all 75 reports", app.prewriteBackup()?.deviceBackup?.responseReports?.length, 75);
eq("the automatic snapshot captured the original mapping", app.prewriteBackup()?.layers[0].bindings[1]?.steps?.[0]?.code, 4);
eq("the pre-write snapshot can be exported", app.$("btnExportPrewrite").disabled, false);
const beforePrewriteExport = xzkj.sent.length;
app.$("btnExportPrewrite").onclick();
eq("exporting the pre-write snapshot sends no device reports", xzkj.sent.length, beforePrewriteExport);

// Restore after a previous write without a manual read/export.
await app.$("fileImport").onchange({
  target: { files: [{ text: async () => JSON.stringify(originalProfile) }], value: "" },
});
eq("a saved target can be restored without a manual backup",
   app.$("btnWrite").disabled, false);
const beforeCh3Restore = logText().length;
await app.writeAll();
const ch3RestoreLog = logText().slice(beforeCh3Restore);
eq("the original mapping is verified after restore", /Verified/.test(ch3RestoreLog), true);
eq("Key 1 is back to A", xzkj.config.get("0:1")?.[8], 0x04);
eq("writing stays enabled after restore", app.$("btnWrite").disabled, false);

// Simulate applying a standalone Shift to an unbound slot. This only checks
// the app flow and captured record format, not physical modifier behavior.
xzkj.config.set("0:5", [0xfa, 5, 1, 1, 0, 0]);
await app.readAll();
app.$("btnExport").onclick();
const shiftTarget = JSON.parse(JSON.stringify(app.profile()));
shiftTarget.layers[0].bindings[5] = { type: "key", steps: [{ mods: 2, code: 0 }], delay: 0 };
app.setProfile(shiftTarget);
const sentBeforeShift = xzkj.sent.length;
const logBeforeShift = logText().length;
await app.writeAll();
const shiftWrites = xzkj.sent.slice(sentBeforeShift).filter(r => r.b[0] === 0xfd && r.b[1] === 5 && r.b[2] === 1);
eq("standalone Shift writes exactly one target slot", shiftWrites.length, 1);
eq("standalone Shift writes the one-token F2 record", JSON.stringify(shiftWrites[0]?.b.slice(0, 9)), JSON.stringify([0xfd,5,1,1,0,1,0,0,0xf2]));
eq("standalone Shift verifies against mocked readback", /Verified/.test(logText().slice(logBeforeShift)), true);
eq("normal key writes do not send RGB packets", xzkj.sent.slice(sentBeforeShift).some(r => r.b[0] === 0xfe && r.b[1] === 0xb0), false);

// Clear is an explicit intent, unlike a slot missing from a partial profile.
// It must go through the diff, send one count-0 record, and be verified.
await app.readAll();
app.$("btnExport").onclick();
app.select(1, "Key 13");
app.$("btnClearBinding").onclick();
eq("Clear marks exactly that slot for clearing", app.profile().layers[0].bindings[1]?.type, "clear");
const beforeClearState = new Map([...xzkj.config].map(([k, v]) => [k, JSON.stringify(v)]));
const beforeClearSent = xzkj.sent.length;
const beforeClearLog = logText().length;
await app.writeAll();
const clearWrites = xzkj.sent.slice(beforeClearSent).filter(r => r.b[0] === 0xfd && r.b[1] === 1 && r.b[2] === 1);
eq("Clear writes exactly one slot", clearWrites.length, 1);
eq("Clear uses the verified count-zero binding", JSON.stringify(clearWrites[0]?.b.slice(0, 6)), JSON.stringify([0xfd,1,1,1,0,0]));
eq("Clear reads back unbound", xzkj.config.get("0:1")?.[5], 0);
eq("Clear reports successful verification", /Verified/.test(logText().slice(beforeClearLog)), true);
eq("Clear preserves every other mocked slot", [...xzkj.config].every(([k,v]) => k === "0:1" || beforeClearState.get(k) === JSON.stringify(v)), true);

// If a keypad ignores the clear write, readback must report the failure.
xzkj.config.set("0:1", [0xfa,1,1,1,0,1,0,0,4]);
await app.readAll();
app.$("btnExport").onclick();
app.select(1, "Key 13");
app.$("btnClearBinding").onclick();
xzkj.deaf = true;
const beforeFailedClearLog = logText().length;
await app.writeAll();
eq("an ignored Clear is reported as unconfirmed", /Could not confirm/.test(logText().slice(beforeFailedClearLog)), true);
eq("an ignored Clear is not reported as verified", /Verified —/.test(logText().slice(beforeFailedClearLog)), false);
xzkj.deaf = false;

console.log("\nXZKJ RGB draft and guarded lighting path");
const keyProfileBeforeDraft = JSON.stringify(app.profile());
app.$("rgbFillColor").value = "#123456";
app.$("btnRgbFill").onclick();
ok("creating an RGB draft does not edit key bindings", JSON.stringify(app.profile()) === keyProfileBeforeDraft);
eq("RGB can be reviewed without a manual backup", app.$("btnRgbApply").disabled, false);
const beforeNoBackup = xzkj.sent.length;
confirmResult = false;
await app.applyXzkjRgb();
confirmResult = true;
eq("RGB confirmation still prevents unapproved output", xzkj.sent.length, beforeNoBackup);
eq("RGB editor exposes sixteen colour slots", app.$("rgbGrid").children.length, 16);
eq("RGB layout matches the physical grid with slots 1 and 13 at bottom corners", app.$("rgbGrid").children.map(c => c.textContent).join(","), "LED 4,LED 8,LED 12,LED 16,LED 3,LED 7,LED 11,LED 15,LED 2,LED 6,LED 10,LED 14,LED 1,LED 5,LED 9,LED 13");
app.$("rgbGrid").children.find(c => c.textContent === "LED 2").children[0].oninput({target:{value:"#abcdef"}});
app.$("rgbMode").onchange({target:{value:"2"}});
const rgbSavedDraft = JSON.parse(store.get("macropad-rebind.xzkj-rgb-draft.v1"));
eq("editing one RGB slot updates that layer's draft", rgbSavedDraft.layers[0][1], "#abcdef");
eq("editing one RGB slot leaves another layer's slot alone", rgbSavedDraft.layers[1][1], "#123456");
eq("changing mode affects only the selected layer", rgbSavedDraft.modes.join(","), "2,1,1");
app.$("orientPick").onchange({target:{value:"clockwise"}});
eq("RGB grid follows the orientation selector", app.$("rgbGrid").children.map(c => c.textContent).join(","), "LED 1,LED 2,LED 3,LED 4,LED 5,LED 6,LED 7,LED 8,LED 9,LED 10,LED 11,LED 12,LED 13,LED 14,LED 15,LED 16");
eq("rotating the RGB grid does not change its draft", store.get("macropad-rebind.xzkj-rgb-draft.v1"), JSON.stringify(rgbSavedDraft));
app.$("orientPick").onchange({target:{value:"normal"}});
const badRgbImportLog = logText().length;
await app.$("rgbImportFile").onchange({target:{files:[{text:async()=>JSON.stringify({format:"macropad-rebind-xzkj-rgb-draft",version:1,layers:[["#fff"]]})}],value:""}});
eq("invalid RGB drafts are rejected", /not a valid 3-layer XZKJ RGB draft/.test(logText().slice(badRgbImportLog)), true);
eq("invalid RGB import preserves the prior draft", JSON.parse(store.get("macropad-rebind.xzkj-rgb-draft.v1")).layers[0][1], "#abcdef");
await app.$("rgbImportFile").onchange({target:{files:[{text:async()=>JSON.stringify({format:"macropad-rebind-xzkj-rgb-draft",version:1,layers:rgbSavedDraft.layers})}],value:""}});
eq("older RGB drafts retain their original mode 1", JSON.parse(store.get("macropad-rebind.xzkj-rgb-draft.v1")).modes.join(","), "1,1,1");
await app.$("rgbImportFile").onchange({target:{files:[{text:async()=>JSON.stringify({format:"macropad-rebind-xzkj-rgb-draft",version:2,...rgbSavedDraft})}],value:""}});
eq("RGB v2 imports retain per-layer modes", JSON.parse(store.get("macropad-rebind.xzkj-rgb-draft.v1")).modes.join(","), "2,1,1");
const savedRgbBeforeRead = store.get("macropad-rebind.xzkj-rgb-draft.v1");
await app.readAll();
eq("reading bindings preserves the local RGB draft without claiming readback", store.get("macropad-rebind.xzkj-rgb-draft.v1"), savedRgbBeforeRead);
eq("RGB remains available without a manual backup", app.$("btnRgbApply").disabled, false);
const beforeConcurrent = xzkj.sent.length;
app.$("btnWrite").disabled = true;
await app.applyXzkjRgb();
eq("RGB cannot start while the key writer is busy", xzkj.sent.length, beforeConcurrent);
app.$("btnWrite").disabled = false;
const beforeCancel = xzkj.sent.length;
confirmResult = false;
await app.applyXzkjRgb();
confirmResult = true;
eq("cancelling RGB sends no reports", xzkj.sent.length, beforeCancel);

const missingRgbRecord = xzkj.config.get("2:25");
xzkj.config.delete("2:25");
const beforeIncomplete = xzkj.sent.length;
await app.applyXzkjRgb();
eq("an incomplete automatic preflight sends no RGB packets", xzkj.sent.slice(beforeIncomplete).some(r => r.b[0] === 0xfe && r.b[1] === 0xb0), false);
xzkj.config.set("2:25", missingRgbRecord);
xzkj.config.set("0:1", [0xfa,1,1,1,0,1,0,0,0x05]);
const keysBeforeRgb = JSON.stringify([...xzkj.config]);
const beforeRgb = xzkj.sent.length;
const beforeRgbLog = logText().length;
await app.applyXzkjRgb();
const rgbTraffic = xzkj.sent.slice(beforeRgb);
const rgbWrites = rgbTraffic.filter(r => r.b[0] === 0xfe && r.b[1] === 0xb0);
eq("RGB sends exactly three lighting packets", rgbWrites.length, 3);
eq("RGB packets address layers 0, 1, 2", rgbWrites.map(r => r.b[2]).join(","), "0,1,2");
eq("RGB packets use report ID 3", rgbWrites.every(r => r.id === 3), true);
eq("RGB packets carry the selected modes and exactly sixteen colours", rgbWrites.every((r,layer) => r.b[3] === (layer === 0 ? 2 : 1) && r.b.slice(4,52).every((v,i) => v === (layer === 0 && i >= 3 && i < 6 ? [0xab,0xcd,0xef][i-3] : [0x12,0x34,0x56][i%3])) && r.b.slice(52).every(v => v === 0)), true);
const rgbWriteIndexes = rgbTraffic.map((r, i) => r.b[0] === 0xfe && r.b[1] === 0xb0 ? i : -1).filter(i => i >= 0);
eq("RGB packets are consecutive without intervening device reads", rgbWriteIndexes.join(","), `${rgbWriteIndexes[0]},${rgbWriteIndexes[0]+1},${rgbWriteIndexes[0]+2}`);
eq("RGB sends no key binding or commit packets", rgbTraffic.some(r => r.b[0] === 0xfd), false);
ok("RGB leaves all mock binding records unchanged", JSON.stringify([...xzkj.config]) === keysBeforeRgb);
eq("RGB compares bindings after all three reports", /matched the pre-write snapshot afterward/.test(logText().slice(beforeRgbLog)), true);
eq("RGB snapshots the current mapping rather than an older backup", app.prewriteBackup()?.layers[0].bindings[1]?.steps?.[0]?.code, 5);
eq("RGB leaves key writing enabled", app.$("btnWrite").disabled, false);
eq("RGB remains available without another manual backup", app.$("btnRgbApply").disabled, false);

xzkj.rgbCorruptBinding = true;
const beforeChanged = xzkj.sent.length;
const beforeChangedLog = logText().length;
await app.applyXzkjRgb();
eq("RGB sends the three captured-sequence reports before checking bindings", xzkj.sent.slice(beforeChanged).filter(r => r.b[0] === 0xfe && r.b[1] === 0xb0).length, 3);
eq("RGB warns when post-write binding verification fails", /key mappings differ after the lighting reports/.test(logText().slice(beforeChangedLog)), true);
eq("RGB never sends an automatic key restore", xzkj.sent.slice(beforeChanged).some(r => r.b[0] === 0xfd), false);
current = device; app.disconnected();
const beforeWrongDeviceRgb = device.sent.length;
await app.applyXzkjRgb();
eq("RGB cannot send to a disconnected or different keypad", device.sent.length, beforeWrongDeviceRgb);

app.setLayout(app.LAYOUTS.find(l => l.keys === 16 && l.knobs === 3));
app.profile().layers[0].bindings[1] = { type: "key", steps: [{mods:0,code:4}], delay:0 };
app.select(1, "Key 13");
app.$("btnClearBinding").onclick();
eq("an offline 16x3 edit preserves explicit clear intent", app.profile().layers[0].bindings[1]?.type, "clear");
app.setLayout(app.LAYOUTS.find(l => l.keys === 12 && l.knobs === 2));

console.log("\nan override does not outlive the keypad it was set for");
app.setForced("ch57x-3");
eq("the override is in force", app.effDialect(), "ch57x-3");
app.disconnected();
eq("unplugging clears it", app.effDialect(), "ch57x-1");

const allLog = logText();
ok("nothing anywhere logged a ReferenceError", !/is not defined/i.test(allLog));
ok("nothing anywhere logged a TypeError",      !/undefined is not|cannot read/i.test(allLog));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
