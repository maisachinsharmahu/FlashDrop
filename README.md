# FlashDrop

**Private, high-throughput file transfer for Android and macOS.**

FlashDrop sends large files directly between your devices on the same local
network. It uses private `192.168.x.x`/LAN addresses only: no cloud, account,
signaling service, relay, analytics, or Internet upload is involved.

FlashDrop is an independent open-source derivative of
[LocalSend](https://github.com/localsend/localsend). The fork point and license
attribution are recorded in [NOTICE](NOTICE).

> [!IMPORTANT]
> The current source tree is a developer preview, not a signed production
> release. LAN transfer and native share-sheet intake are functional. The
> restart-resume core is present but is not yet connected to every transfer UI
> path. Do not describe preview binaries as production-ready.

## What it does

- **Accepts Android shares natively.** Select one or many videos in Gallery or
  Files, tap Share, and choose FlashDrop. `content://` items are streamed via
  file descriptors instead of loading multi-gigabyte files into Dart memory.
- **Transfers directly on LAN.** Devices discover one another locally and send
  over HTTPS with certificate-fingerprint verification.
- **Keeps transfer memory bounded.** Rust streams files with 1 MiB buffers and
  backpressure, independent of the file's total size.
- **Provides native macOS sharing.** The macOS app includes a Share Extension
  and sandbox-aware file access.
- **Lays the foundation for durable resume.** Versioned journals are written
  atomically, validated before use, and can restart reading at the receiver's
  acknowledged byte offset without re-reading the beginning of a large file.
- **Stays local.** Discovery and transfer remain on the current LAN. The app
  does not connect to a public signaling or relay service.

## Install

### Download a release

Signed and notarized packages will appear on the
[Releases](../../releases/latest) page after the production release gates are
complete. Preview builds are intentionally not presented as production
downloads.

### Build from source

Requirements: Flutter 3.41.9, Rust 1.97.1, Android Studio/SDK for Android, and
Xcode with CocoaPods for macOS.

```bash
git clone https://github.com/maisachinsharmahu/FlashDrop.git
cd FlashDrop
fvm install
cd app
fvm flutter pub get
```

Build an optimized Android APK:

```bash
fvm flutter build apk --release --target-platform android-arm64
```

The APK is written to `app/build/app/outputs/flutter-apk/app-release.apk`.

Build a local macOS app:

```bash
fvm flutter build macos --release
open build/macos/Build/Products/Release/FlashDrop.app
```

The local build uses ad-hoc signing. Public distribution requires an Apple
Developer ID certificate and notarization.

## Speed expectations

Internet-plan speed does not set LAN speed. Actual throughput is limited by the
Wi-Fi link, phone storage, Mac storage, and the slower endpoint. Use 5 GHz or
6 GHz Wi-Fi and keep both devices near the access point. Release builds avoid
debug overhead and FlashDrop avoids unnecessary file copies or compression.

The full behavior and release criteria are documented in
[PRODUCT.md](PRODUCT.md).

## Development checks

```bash
cd app && fvm flutter analyze
cd ../packages/core && cargo test --features full
cd ../../server && cargo test
```

## Security

Do not report exploitable vulnerabilities in a public issue. Use GitHub's
private security-advisory flow for this repository. Never commit production
signing keys or keystores.

## Contributing

Issues and focused pull requests are welcome. Include a reproducible test for
networking, resume, or filesystem changes and test platform-specific behavior
on the affected operating system.

## License

[Apache License 2.0](LICENSE). FlashDrop retains the required LocalSend notices
and attribution in [NOTICE](NOTICE).
