# FlashDrop product contract

FlashDrop is a private, high-throughput file transfer application for Android
and macOS. It is maintained as a fork of LocalSend at upstream commit
`6f6cd3ee496903e2206c51ffa3a13a5d10bc340b` and retains the upstream Apache
2.0 license and notices.

## Non-negotiable behavior

- Android appears in `ACTION_SEND` and `ACTION_SEND_MULTIPLE` share sheets.
- Shared `content://` URIs are streamed through Android file descriptors; large
  videos are never copied into Dart memory.
- Transport is local-network P2P only. No signaling, relay, account, analytics,
  or Internet upload service is contacted.
- TLS peer certificates are pinned to the selected device fingerprint.
- Transfers survive network changes and application restarts. Only receiver-
  acknowledged, durably-written offsets may be resumed.
- Pause, resume, retry, cancel, and remove are distinct queue operations.
- Every completed file is size checked and SHA-256 verified before its partial
  marker and journal are removed.
- Android uses a foreground data-sync service while transferring. macOS keeps
  the transfer active without requiring the window to remain focused.

## Resume protocol

1. The sender assigns a stable transfer ID and stable file IDs before prepare.
2. Both peers persist a versioned journal using an atomic temp-file + fsync +
   rename sequence.
3. On reconnect the peers mutually authenticate, exchange the transfer ID, and
   the receiver returns its durable byte offset per file.
4. The sender validates `offset <= current file size`, seeks at the Rust file
   layer, and streams only the remaining range.
5. The receiver appends to a `.flashdrop-part` target. Progress is journaled
   after flushed checkpoints, never merely after socket receipt.
6. Final size and SHA-256 must match before the file is renamed into place.

## Performance targets

- At least 90% of usable TCP LAN throughput for a single 2+ GB file.
- Bounded memory independent of file size; the core currently uses 1 MiB
  read/write buffers with channel backpressure.
- Parallelism is adaptive: one stream per large file on normal Wi-Fi and up to
  four concurrent files when storage and network measurements justify it.
- No compression for already-compressed media such as MP4/MKV; it wastes CPU
  and usually reduces throughput.

## Release gates

- Core unit/integration tests pass on macOS and Android targets.
- Instrumented Android tests cover cold-start and warm-start share intents,
  URI permission lifetime, foreground transfer, process death, and reconnect.
- macOS tests cover Share Extension handoff, sandbox bookmarks, sleep/wake, and
  atomic final rename.
- A 12 GB soak transfer is tested with Wi-Fi disabled/re-enabled, sender kill,
  receiver kill, duplicate filenames, low storage, and checksum corruption.
- Release builds are signed, notarized (macOS), reproducible, and contain an
  SBOM plus retained Apache 2.0 attribution.
