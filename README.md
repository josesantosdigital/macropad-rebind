# Macropad Rebind — XZKJ 16-key fork

This fork of [Macropad Rebind by jvspier](https://github.com/jvspier/macropad-rebind)
adds support for a wireless XZKJ macropad with **16 keys, 3 rotary encoders,
and 3 programmable layers**. It was created to read and back up the pad's
existing mappings before changing them, and to make this particular layout
usable from the browser without depending on its Windows configurator.

| Device detail | Value |
|---|---|
| PCB family / marking | XZKJ / `@XZKJ-16key_3knob` |
| USB VID:PID | `514C:8850` |
| Configuration interface | HID usage page `0xFF00`, report ID 3, 64-byte input and output payloads |
| Protocol | `ch57x-3` (Alternative B) |
| Original software | `MINI_KEYBOARD` |
| Connectivity | USB for configuration; Bluetooth / 2.4 GHz for wireless use |
| MCU | Not confirmed |

The fork captures all 25 key and encoder binding records for each of the three
layers and exports the raw replies in a JSON backup. It also adds the physical
4×4 layout, standalone modifier support, media and mouse readback, and an
experimental per-key RGB editor with the device's six lighting modes. The
original reply bytes are retained for records the editor cannot fully represent.

On one unit, the binding read path, a single-key write and restore, and one RGB
color change were verified. Other write cases and devices remain experimental.
**The device's current lighting settings cannot reliably be read or backed up:**
the RGB panel shows a local draft, and applying it sends lighting settings for
all three layers. Export a binding backup before making changes.

Run this fork locally with `node tools/serve-local.mjs`, then open the displayed
localhost URL in a Chromium-based browser. The [original hosted app](https://jvspier.github.io/macropad-rebind/)
is maintained by upstream and does not include this fork's changes.

<p align="center">
  <img src="images/screenshot.png"
       alt="Macropad Rebind: the on-screen keypad with two knobs and twelve keys, a binding editor, backlight controls and a device log"
       width="720">
</p>

The upstream app supports several other small macropads sold under many names.
Its single HTML page uses WebHID in a compatible Chromium-based browser. The
XZKJ read protocol in this fork was identified by observing the manufacturer's
software, which can also read bindings from the tested device.

---

## Will it work with my keypad?

<img src="images/examplekeypad.jpg"
     alt="A 12-key, 2-knob CH57x macropad with RGB backlighting"
     align="right" width="260">

If your keypad came with software called `MINI_KEYBOARD`, `KEY_PRO`,
`Mini Keyboard`, or a generic unbranded `.exe`, it is almost certainly one of
these. They all look roughly like the one on the right — a small slab of keys
with one to three knurled knobs along the top.

> **Cable warning first:** many of these pads lack USB-C CC pull-down resistors,
> so a **C-to-C cable will not work at all** — the device simply never appears.
> Use A-to-C.

**Check the USB ID.** The vendor is usually `1189`, sometimes `514c`:

| OS | How |
|---|---|
| Linux | `lsusb \| grep -Ei '1189\|514c'` |
| macOS | System Information → USB |
| Windows | Device Manager → Properties → Details → Hardware Ids |

Supported product ids: **`8830`, `8831`, `8832`, `8833`, `8840`, `8842`, `8850`,
`8851`, `8890`**, under vendor **`1189`** or **`514c`** — the same manufacturer
ships under both.

If your pad is not offered, press **Device not listed?** instead of **Connect
keypad**. That drops every filter and offers all HID devices, because a keypad
whose configuration sits on an unexpected interface would otherwise never
appear at all. Pick your keypad; the log prints its id and HID usage pages, so
a report is enough to get it added.

> **Not every model takes the same commands.** The tool selects a format from
> your keypad's USB id and, for the reused `514c:8850` id, checks the read-only
> identify response. The detected XZKJ 16-key/3-knob variant is locked to its
> captured format so a mistaken override cannot send a different protocol.
>
> | Your keypad | What to expect |
> |---|---|
> | `1189:8840`, `1189:8842`, `1189:8850`, `1189:8851`, `514c:8851` | Everything works. This is the format the tool was built and tested against. |
> | `1189:8890` | Writing works in principle, but is untested and sources disagree about this model — try both formats. No backlight control, and the tool cannot read the keypad back. |
> | `514c:8850`, 12 keys and 4 knobs | Everything works: reading, writing and backlight, confirmed on hardware. The id is listed under another format, but this keypad answers the identify command like a Standard one, so the tool switches to Standard when it connects. |
> | `514c:8850`, 16 keys and 3 knobs (`@XZKJ-16key_3knob`) | Reading all 3 layers, a one-key write-and-restore, and one RGB color change are confirmed on one unit. Other writes and lighting modes remain experimental. |
> | `514c:8850`, anything else | Writing works in principle, but is untested. No backlight control or confirmed read-back. |
>
> For the 16-key/3-knob unit, the read path is captured from the vendor app. The
> separate open-source writer has been reported working on this same PCB family.
> This app's writer completed a one-key A-to-B change, readback, and B-to-A
> restore on the user's unit. The restored mapping reads as A; one response
> header byte differs from its original raw value and remains unexplained. Once
> identified, the device can be written without a manual backup export. The app
> reads its current bindings automatically before each write and offers an
> optional **Export pre-write backup** button.
> The gory details are in [docs/PROTOCOL.md](docs/PROTOCOL.md#not-one-protocol--three-dialects).

To use a previously exported profile, connect and import it, then review the
device diff before clicking **Write**. A read-only snapshot of the device just
before that write can be exported independently; it stays in memory only until
the page closes or another pre-write snapshot replaces it.

On the XZKJ 16-key/3-knob unit, the **Clear** button marks a key or knob action
to become unbound. Review the clear in the write confirmation; a slot simply
missing from an imported profile is still
left alone. This uses a count-zero record verified for one slot on this unit;
other slots and layers use the same inferred format and are checked by readback.

On the XZKJ 16-key/3-knob unit, a vendor-configured standalone Shift now reads
as a Shift-only key step. To set one in the editor, choose the key, select the
keyboard action, enable **Shift**, choose **modifiers only**, and add the step.
The one-entry format matches a working vendor-configured readback; writes of
this form by this app have not yet been verified on hardware. The full raw
device reply is retained in a current-device backup.

Recognized XZKJ media keys and mouse actions are decoded on readback so they
appear as their actual bindings in the editor and write preview. The original
raw reply is retained; records the editor cannot represent remain opaque.

The XZKJ **RGB draft** editor keeps its draft separately from key bindings.
Choose a starting colour and **Fill all layers**, then use the layer tabs and
16 colour selectors to edit each layer. Choose from off, static, reactive,
ripple, column wave and row wave modes. The draft can be exported/imported as
its own JSON file. To apply it, connect and use the separate RGB button and
confirmation. Applying sends settings for all three lighting layers because
existing lighting cannot be read back. The app reads all 75 raw binding reports
before sending the three RGB reports consecutively and compares them afterward;
it cannot detect a binding change between those reports and does not restore
anything automatically. The pre-write snapshot is available for optional export
while the page remains open. A mode-2 color change was verified on one unit;
other colors, modes and firmware versions remain experimental. Other owners
reported lighting freezes. For protocol details, see the [research](https://github.com/kriomant/ch57x-keyboard-tool/pull/175).

### Run the modified copy locally

The upstream GitHub Pages site does not include this fork's changes. From the
repository directory, run:

```powershell
node tools/serve-local.mjs
```

Open the printed `http://localhost:8000/` address in Chrome or Edge. The small
static server binds only to this computer and has no HID access; device access
is provided by the browser page after you choose **Connect**.

These are sold as: *3 key macro pad*, *6 key macropad with knob*, *9 key RGB
keypad*, *12 key macro keyboard with 2 knobs*, *15 key shortcut pad*, *mini
gaming keypad*, *one-handed keyboard*, *Photoshop shortcut pad*, *streaming
keypad*, *volume knob keypad*.

**All 24 layouts are supported**, from 1 key up to 16 keys and 4 knobs — see
[Verified models](#verified-models) below. The layout is read from the keypad
itself; if the on-screen grid doesn't match your hardware, pick the right model
from the dropdown.

<br clear="all">

---

## Verified models

Every shape below is supported. The layout is read from the keypad where it can
be, but the **grid shape** — how the keys are physically arranged, and therefore
which slot is which key — has only been checked on the units marked *yes*. The
rest is inferred.

**If your model shows a dash, a one-minute check helps everyone:** connect, and
see whether the on-screen grid matches your hardware. Either answer is useful —
[open a layout report](../../issues/new?template=layout-report.yml) and it gets
marked confirmed, or corrected.

| Keys | Knobs | Grid | Confirmed on hardware |
|---:|---:|:---:|:---|
| — | 1 | — | — |
| — | 2 | — | — |
| 1 | 0 | 1×1 | — |
| 2 | 0 | 2×1 | — |
| 3 | 0 | 3×1 | — |
| 3 | 1 | 3×1 | — |
| 4 | 0 | 4×1 | — |
| 4 | 1 | 4×1 | — |
| 4 | 3 | 4×1 | — |
| 5 | 0 | 5×1 | — |
| 6 | 0 | 3×2 | — |
| 6 | 1 | 2×3 | yes — 1189:8890, reported by @wtown42; held knob-right it is 3×2 |
| 6 | 2 | 3×2 | — |
| 9 | 2 | 3×3 | — |
| 9 | 3 | 3×3 | — |
| 11 | 3 | 4×3 | — |
| 12 | 2 | 3×4 | yes — the unit this tool was written against |
| 12 | 4 | 3×4 | yes — SikaiCase 1189:8842, reported by @geniosid; also a 514c:8850 unit by @loudbeatproductions |
| 12 | 3 | 4×3 | — |
| 15 | 3 | 5×3 | — |
| 16 | 0 | 4×4 | — |
| 16 | 1 | 4×4 | — |
| 16 | 2 | 4×4 | — |
| 16 | 3 | 4×4 | yes — XZKJ `@XZKJ-16key_3knob`; column-major, bottom-to-top slot order |

2 of 24 confirmed so far. A wrong grid is a one-line fix, and the
tests catch it immediately.

---

## Quick start

### 1. Open it

It must be served over `http://localhost` or `https://` — browsers only
allow USB access from a secure origin.

For `514c:8850` with 16 keys and 3 knobs, use this modified local working tree:
the hosted link above points to the public upstream page and does not yet
contain these device-specific changes. Run the local server command below from
this repository, then open its localhost URL in a Chromium browser.

For other supported models, **the quickest route is [the hosted copy](https://jvspier.github.io/macropad-rebind/)** —
it is served over HTTPS, which is all the browser needs. Nothing is uploaded
anywhere; the page talks straight to the USB device.

To run it yourself instead, download or clone this repo, then in that folder run:

```bash
python3 -m http.server 8000
```

and open <http://localhost:8000/>. Python 3 is already installed on Linux and
macOS. On Windows use `py -m http.server 8000`, or `npx serve` if you have Node.

Or put `index.html` on any static host — GitHub Pages, Netlify, your own server.
There is no backend.

> **Browser support:** Chrome, Edge, Brave, Opera, Vivaldi, Arc — anything
> Chromium-based, on any OS including Android. **Firefox and Safari will not
> work**: they have not implemented WebHID and there is no workaround.

### 2. Linux only: allow access to the device

`/dev/hidraw*` is root-only by default, and your browser is not root. Install
the rule once:

```bash
sudo cp linux/60-ch57x-keypad.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
```

Then **unplug and replug the keypad**. To confirm:

```bash
getfacl -p /dev/hidraw* 2>/dev/null | grep -B4 $USER
```

Windows, macOS, ChromeOS and Android need nothing — they grant HID access
through the browser's own permission prompt.

<details>
<summary>Why the rule is numbered 60 and not 99</summary>

It uses `TAG+="uaccess"`, which hands the device to whoever is logged in at the
local seat. That is much narrower than adding yourself to the `input` group,
which would let any program you run read *every* keyboard on the machine.

systemd's `70-uaccess.rules` is what acts on that tag, so a rule numbered above
70 sets it too late and is silently ignored — the device stays root-only and
nothing tells you why.
</details>

### 3. Connect and configure

1. Click **Connect keypad** and pick your device from the browser prompt. Only
   the configuration interface is offered; the keyboard part of the device is
   deliberately invisible to the browser.

   If the on-screen grid does not match your hardware, use the **orientation**
   dropdown beside the model picker — normal, upside down, or rotated either way.
   Only one model's grid has been confirmed against a real unit, so this is the
   quickest fix if yours looks wrong.

   On connecting, the tool asks the device to identify itself (`0xFB`) and only
   enables the controls that write once it gets a sensible answer. The picker
   filter is a convenience, not a guarantee — other hardware exposes a vendor HID
   interface too, and writing to one of those could misconfigure it.
2. Click **Read from keypad** to pull in what is currently programmed.
3. Click a key or knob action, and bind it.
4. Click **Write to keypad**. It reads the device first and shows a diff — what
   is on each key now and what it will become — then reads back afterwards and
   confirms every binding actually stored. A write returning no error is not the
   same as the device having kept it.

> **Writing only sends what the editor holds.** It never clears a key the editor
> has no binding for, so bindings already on the keypad that you have not loaded
> are left exactly as they are. Use **Read from keypad** first if you want to see
> and edit them, or **Blank this layer** if you want them gone.

> **Programming needs the USB cable.** If your keypad also does Bluetooth, that
> is for *using* it, not configuring it — the configuration interface only exists
> over USB. Set it up wired, then unplug and go wireless if you like; the keypad
> remembers. (In Bluetooth mode it turns the backlight off to save battery.)

> **Layers are switched on the keypad**, with the button on its edge — not from
> this page. The indicator LEDs beside the knobs show which layer is live. If a
> binding writes and verifies but the key still does not type what you set, check
> you are on the layer you programmed.

Your bindings live in the keypad's own flash. Nothing runs in the background —
once written, the keypad works on any computer with no software at all.

---

## What you can bind

**Keyboard** — any key, with any combination of Ctrl, Shift, Alt and the GUI key,
left or right. That last one is labelled for whichever system you are configuring
from — **Win** on Windows, **Command** on macOS, **Super** on Linux — because it
is a single HID code with three names. The keypad sends the same byte wherever it
is plugged in. Two ways to enter it:

- Click the capture box and **press the shortcut you want**. It is read from
  your real keyboard and converted.
- Or type a string into **Or type the text you want** and it becomes a macro,
  with Shift applied to capitals and symbols automatically.

Up to 18 steps per key, with an optional delay between them.

**Media** — volume, mute, play/pause, next, previous, stop, brightness,
calculator, lock screen, browser navigation.

> F13–F24 exist in the protocol, but the **Bluetooth variants cannot emit them** —
> the vendor documentation says so outright. If you have a wireless model, avoid
> those and use ordinary combinations instead.

**Mouse** — left/right/middle click, wheel up/down, pointer movement, drag.

**Knobs** — each knob has three independent bindings: turn left, press, turn
right.

**Layers** — three complete sets of bindings.

**Backlight** — off, steady, shock, shock2, or light-up-on-press, in red,
orange, yellow, green, cyan, blue, purple or white, set per layer. Any colour
works with any mode.

For the Standard (`ch57x-1`) models, colour is global. The firmware does drive
keys individually for wave and press effects, but the host cannot choose each
key's colour using that protocol. For the XZKJ 16-key/3-knob `ch57x-3` unit,
[separate research](https://github.com/kriomant/ch57x-keyboard-tool/pull/175)
reports per-key RGB. The experimental XZKJ RGB editor is separate from the
binding writer, and the known binding backup does not include lighting.

---

## Things worth knowing

**It shows you the diff before writing.** It reads the device first and
lists exactly what will change on which key, so a write is never a leap of faith.

**Untouched bindings are preserved byte for byte.** Anything read off the keypad
and not edited is written back exactly as it came, so parts of the format this
tool doesn't fully decode survive a round trip.

**Export your config.** Bindings persist in the browser's `localStorage`, which
is a convenience, not a backup. **Export** writes a JSON file you can keep or
re-import.

> ⚠️ **Exported profiles contain whatever your macros type.** If a key types a
> password, it is in that file in plain text. The same is true of the keypad
> itself — anything that can open the device can read your macros back.

**If only some keys work or light up**, the keypad has been told it is a
different model. Press **Repair device identity**. Your bindings are unaffected.
[docs/PROTOCOL.md](docs/PROTOCOL.md) explains the cause.

---

## FAQ

**Is this VIA or Vial?** No, and it can't be — both require QMK firmware, and
these pads run WCH's own firmware on a CH57x. Every transport parameter differs
too: QMK Raw HID is usage page `0xFF60`, usage `0x61`, 32-byte reports; these are
usage page `0xFF00`, usage `0x01`, report ID `3`, 64-byte reports. It is a
proprietary vendor protocol, documented in [docs/PROTOCOL.md](docs/PROTOCOL.md).

**Do all these keypads use the same protocol?** Within the CH57x family — vendor
`0x1189`, products `8830`–`8833`, `8840`, `8842`, `8850` — yes: same record
format, same 15 recognised `(keys, knobs)` models. The older `1189:8890` units are
close but not identical.

**What are the macro limits?** 18 steps per key — measured on hardware, and the
same figure the retail listings quote — plus a 0–6000 ms delay between steps, and
3 layers. There is **no shared macro pool** — every control on every layer has its
own fixed-size record, so unlike QMK/VIA you cannot run out of total space. A
12-key/2-knob pad holds 54 independent bindings.

**What happens if I exceed them?** This tool refuses and tells you. The firmware
silently truncates instead — it drops every step past the 18th, and a too-long
macro simply types its first 18 actions. Measured, along with the exact byte
behaviour, in [docs/PROTOCOL.md](docs/PROTOCOL.md).

**What chip is in these? I heard many use a WCH CH552G.** Quite possibly. "CH57x"
is the name this ecosystem settled on rather than a verified fact about the
silicon, and the microcontroller can't be identified from software — USB
descriptors don't carry it and the vendor software never names it. It doesn't
affect compatibility either way: the protocol belongs to the **firmware**, not the
chip, so what matters is the USB vendor/product ID and the HID interface layout.
If your pad shows up as one of the IDs listed above, it should work regardless of
what is under the lid.

Note this is a different thing from the open-hardware CH552 macropads (the
wagiminator-style boards, and similar). Those run custom firmware you flash
yourself and are configured by reflashing — a different world entirely, and
nothing here applies to them.

**Is my data sent anywhere?** No. The page has no backend. It talks straight to
the USB device from your browser.

## If the keypad does not appear at all

Work down this list — the first item catches more people than the rest combined.

1. **Try an A-to-C cable rather than C-to-C.** Many of these keypads omit the
   USB-C CC pull-down resistors, so a C-to-C cable will not enumerate the device
   *at all* — no power, nothing in `lsusb`, nothing in the browser picker. It
   looks exactly like dead hardware. Swap the cable first.
2. **Plug it in.** Bluetooth models cannot be configured wirelessly; the
   configuration interface only exists over USB.
3. **Use a Chromium browser.** Firefox and Safari have no WebHID.
4. **Linux: install the udev rule** from `linux/`, and note the filename must
   sort below `70` or the `uaccess` tag is ignored. Replug afterwards.
5. **Check the USB id** — `lsusb | grep -Ei '1189|514c'`. If it reports something
   else, press **Device not listed?**, which drops the vendor filter, and the log
   will print the id so it can be added.

## Command line

`linux/probe.py` prints the keypad's current configuration. Python 3, no
dependencies:

```bash
python3 linux/probe.py
```

## Tests

```bash
node test-protocol.mjs     # protocol encoding, decoding, layouts, and documentation
node test-app.mjs          # mocked device flows, including XZKJ read, backup, write, and restore
```

No dependencies. Both extract from `index.html` itself, so they always check the
file that actually ships.

`test-protocol.mjs` asserts the message builders against two independent
sources: the byte vectors published in `ch57x-keyboard-tool`'s
`src/keyboard/k884x.rs`, and records captured from real hardware.

`test-app.mjs` loads the whole script under a mock DOM and a mock keypad that
answers `0xFB` and `0xFA` the way real hardware does, then drives connect, read
and write. It exists because a `const` declared inside an `if` block and used
after it once shipped and broke connecting entirely: `node --check` passes on
that, and the protocol tests only ever load the pure core.

It asserts on the app's own log — no `ReferenceError`, nothing reporting failure,
status reads connected — because `connect()` catches its own errors. The first
version of this test passed *with that bug still present*, since the buttons had
already been enabled on the lines above the throw.

## Protocol

[docs/PROTOCOL.md](docs/PROTOCOL.md) documents the full wire format: the two HID
interfaces, the 64-byte record layout, key and knob slot numbering, the physical
grid mapping, the lighting byte, and the XZKJ-specific read capture and its limits.

## Credits

This project owes a great deal to
[kriomant/ch57x-keyboard-tool](https://github.com/kriomant/ch57x-keyboard-tool)
(MIT, © 2023 Mikhail Trishchenkov). Specifically taken from it:

- **The ch57x-1 byte layout**, cross-checked against its unit-test vectors, which
  were themselves verified against real USB captures. This project's tests assert
  against those same vectors.
- **The ch57x-3 dialect** (`514c:8850`), ported from its `k8850_4x4.rs`. Untested
  here, apart from one 12-key, 4-knob unit with that id that turned out to speak
  the Standard format instead; that implementation is the only public description
  of the protocol.
- **The vendor/product to dialect mapping**, from its `SUPPORTED_DEVICES` table —
  including the detail that `1189:8850` and `514c:8850` differ despite sharing a
  product id.
- **The orientation idea.** Its config lets you declare how the pad is placed;
  that is the generic fix for not knowing a model's grid, and this tool now has
  the same four options.
- **Sending an all-zero report on connect**, which it does before anything else.

And separately, [PollRobots/ch57x-programmer](https://github.com/PollRobots/ch57x-programmer)
(MIT) — another browser-based tool for this hardware, also derived from
ch57x-keyboard-tool. No code is taken from it, but comparing against it
**independently confirmed** this project's read and write paths for ch57x-1, byte
for byte. It is also a third implementation whose LED model has no per-key colour.
Worth a look if you prefer its interface.

The ch57x-2 format was confirmed against
[soyunomas/macroknob](https://github.com/soyunomas/macroknob) (MIT), an
independent Go implementation researched with the hardware. And
[EScripts-content/mini-3key-configurator](https://github.com/EScripts-content/mini-3key-configurator)
documents the same device from decompiled *official* software, which describes a
different format again — the reason this tool has a format selector rather than a
guess.

The C-to-C cable gotcha comes from
[IISweetHeartII/brightdata-mini-keypad](https://github.com/IISweetHeartII/brightdata-mini-keypad)
(MIT), whose device check warns about it.

And [Palanx/CH57x-Whisperer](https://github.com/Palanx/CH57x-Whisperer), a native
macOS tool for this hardware. No licence is stated, so no code is taken from it —
but its decoder independently confirms this project's read offsets, and its media
list is where the launcher usages above were corroborated.

If you would rather have a command-line tool driven by a YAML file, use that one —
it is excellent, and it supports keyboards this page does not.

## Licence

MIT — see [LICENSE](LICENSE).

The product photograph in `images/` is the manufacturer's and is not covered by
that licence.

---

<sub>Keywords: macropad, macro pad, macro keyboard, mini keyboard, mini keypad,
shortcut keypad, hotkey pad, one-handed keyboard, programmable keypad, custom
keypad, volume knob, rotary encoder, CH57x, WCH, 1189:8842, 1189:8840,
1189:8850, MINI_KEYBOARD, KEY_PRO, AliExpress keypad, Temu macropad, WebHID,
hidraw, udev, Linux macropad software, macOS macropad software, Linux
alternative to Windows keypad software, remap keypad Linux, configure macropad
without Windows.</sub>
