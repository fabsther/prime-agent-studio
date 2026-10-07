# Prime Fleet (Android)

Native Kotlin / Jetpack Compose client for the Fleet API v1. French is the default language; English follows the Android device language. Requires Android 8 (API 26) or later.

## Build

Use JDK 21, an Android SDK with platform **36.1** and build-tools 36.0.0, and the checked-in Gradle 9.6.1 wrapper. The app targets API 36; the installed 36.1 platform provides its compilation API without installing SDK packages.

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
.\gradlew.bat assembleDebug testDebugUnitTest
```

APK: `app/build/outputs/apk/debug/app-debug.apk`. Install with `adb install -r app/build/outputs/apk/debug/app-debug.apk` (with an authorized device).

## Connect

Enable Fleet pairing in each desktop Studio's Tailscale gateway. Add its `https://<pc>.<tailnet>.ts.net` base URL, current pairing PIN, and a phone/device name. Pairing does not use desktop-only routes. All subsequent API and SSE calls carry the gateway bearer token. Redirects are disabled and only HTTPS tailnet base URLs are accepted. Machine labels can be renamed locally. Removing a machine erases the phone's token; revoke the device in the desktop's device list to invalidate it server-side.

Tokens live in Keystore-backed EncryptedSharedPreferences, never in WorkManager input. Android backup is disabled. Project summaries and roadmap documents are cached in app-private files. Clearing app data removes the phone configuration and cache.

Machines poll independently every eight seconds while the activity is visible, or every four seconds on a project/conversation screen. Slow/offline machines do not block online updates. Studio caches summaries for five seconds; SSE status events update the conversation immediately and local status barriers reject stale cached summaries. Git projects merge using the server-normalized `originKey`; projects without an origin stay machine-and-cwd scoped. Offline rows retain cached state and remain read-only. Session messages and stop actions use the existing PWA routes; active runs stream the actual Studio SSE event format. Agent replies render native selectable CommonMark (headings, emphasis, lists, quotes, browser links and horizontally scrolling code); user messages stay plain text. HTML is not executed. App-owned errors use French/English string resources; JSON server details are preserved.

## Outputs

Downloads run in WorkManager with a foreground progress notification. Partial files are streamed to app-private storage and resume with `Range` + strong ETag `If-Range`. A changed file restarts from zero. Completed files publish to MediaStore Downloads (API 29+) or public Downloads with the legacy permission (26–28). Opening grants a read-only content URI to another app. Allow notifications; Android 8–9 also needs storage permission. The OS may stop a data-sync foreground job on recent Android versions; the worker preserves its partial file for retry. Free storage must fit the temporary file and final copy. An explicitly canceled job keeps its private partial file, but a new download uses a new job; clear app data to reclaim canceled partials (this also removes paired machines).

## Roadmap

Choose an owner per merged project. Read and cache its roadmap. Launch a step on a selected online checkout: the phone creates a delegated run on the target and then adds its external link on the owner with the document revision. It never checks a step automatically. If the second call fails, the run already exists: the UI reports the target session ID. Do not launch it again; repair the link from Studio. Owner-offline documents are cached/read-only.

## Demo

Use the Demo button on the machines screen. It displays a shared repository on an online laptop and an offline station, conversation, agent tree and roadmap without servers. Demo credentials are empty, not saved, and send/delegate actions do not start real runs. Pair a real machine or restart the app to leave demo mode.

## Verification limits

Unit tests cover contract JSON, Git merge/fallback isolation, URL credential boundaries and HTTP Range decisions. JVM tests and APK assembly do not prove device-specific Keystore, notifications, MediaStore, network routing or live interaction behavior. Test on API 26 and API 36 devices and two real gateways before production use.

## Previous build verification (initial app)

`assembleDebug testDebugUnitTest`: passed, 19 tests. `npm run check`: passed. `node --test test/fleet-android.test.mjs`: passed, 3 tests. Full `npm test`: 1008 tests, 1000 passed, 7 skipped, 1 host-permission failure in the unchanged `HTTP task file reads deny traversal and symlink escape` test (`EPERM` creating a Windows symlink). The same isolated existing test reproduces the failure. No emulator system image was installed, so device UI/runtime checks remain to do.


## Android live UX verification

`assembleDebug testDebugUnitTest`: passed, 38 JVM tests (status/cached-summary reducers, Markdown AST/styles/URL safety, localized error mapping and existing contract/Range checks). Debug APK: `app/build/outputs/apk/debug/app-debug.apk`. No APK was installed by the agent. Real-device live SSE, browser launching, API 26 desugaring and WorkManager behavior still require device checks. Markdown uses CommonMark core: HTML remains literal, images render alt text, and tables/task lists/syntax highlighting are not enabled.
