# XZKJ 514C:8850 one-key write check — completed

The approved one-key check is complete. The app changed L1 slot 1 from A to B
and read B back; a guarded restore sent the same binding format with A and one
commit. A full subsequent read confirmed A on L1 slot 1 and the original decoded
mapping on all 75 slots. The backups and USB captures used for this local test
are not included in the repository because they contain device configuration.

## Evidence and limits

The matching-board research shows a `0xFD` record header, one three-byte entry
per key action, and an `FD FE FF` terminator. A user later reported successfully
configuring the same PCB family with the matching branch. See
[issue #153](https://github.com/kriomant/ch57x-keyboard-tool/issues/153) and the
[related implementation](https://raw.githubusercontent.com/yawor/ch57x-keyboard-tool/k8850_4x4/src/keyboard/k8850_4x4.rs).
That Rust implementation commits after each binding; the issue author reports
that the vendor app commits once after its batch. This app follows the reported
vendor behavior. The vendor capture preserved in this workspace contains reads
only, so it is not direct write evidence from this unit.

The single-key test confirms this write path on this unit only. The operation
changed stored bindings; it did not send bootloader `0xEF`, firmware, reset,
identity, LED, or erase commands. Other write types and firmware revisions are
not verified.

## Check steps and observed reports

For the historical test, layer 1 slot 1 held A (HID usage `0x04`). It was
temporarily changed to B (`0x05`), verified, then restored to A and verified
again. A different device can have different bindings; do not replay these
reports without first backing up and reviewing that device's actual state.

For the single-key change, the app sent report ID `03` with a 64-byte payload
beginning:

```text
FD 01 01 01 00 01 00 00 05
```

Then it sent report ID `03` with a 64-byte payload beginning `FD FE FF` once to
commit. On readback, layer 1 slot 1 returned:

```text
FA 01 01 01 00 01 00 00 05
```

Restoring A used the same report with the final byte changed from `05` to `04`,
followed by the same commit. The final readback was:

```text
FA 01 01 01 00 01 00 00 04
```

The first app write invalidated its write authorization. Before restoring, a
fresh full read was compared against the saved B-state capture and the original
baseline; all records except L1 slot 1 were byte-identical. The guarded restore
then required a second full immediate read matching the fresh capture before it
sent the exact A binding and one commit. If a write or readback fails, stop and
inspect the current configuration before sending anything else.

After restoration, all 75 slots decoded to the original bindings and all raw
responses except L1 slot 1 were byte-identical to baseline. The restored L1
slot-1 response has data byte 4 equal to `00`, where the original response had
`01`. Its meaning is unknown; the key binding itself reads as A (`0x04`). This
is recorded in the final backup rather than treated as an exact raw restore.

## Restore workflow in the app

For recovery from a saved profile, connect and read all three layers from the
device as it currently is. Export and save that fresh device backup, then import
the older JSON profile as the target. Check the diff before writing. The app
also reads a pre-write snapshot automatically and offers it for optional export.

The user explicitly approved this exact one-key change-and-restore. It is
complete; no further write was sent.
