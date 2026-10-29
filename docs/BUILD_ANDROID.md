# Building the Android app

> The author could not build the APK in the environment where this project was written (no Android SDK, and the
> network blocked Google's and Maven's servers). Everything below is the standard, pinned build; **no APK is shipped
> and no build success is claimed.** If a build step fails, the error message from Gradle is the thing to look at.

Pinned versions: Gradle 8.7 (wrapper) · Android Gradle Plugin 8.5.2 · Kotlin 1.9.24 · JDK 17 · compileSdk/targetSdk 34 · minSdk 26 (Android 8.0) · OkHttp 4.12.0.

## Option A — Cloud build with GitHub Actions (no Android Studio)

1. Create a free account at <https://github.com/> and a **new private repository** (for example `PhoneTouch`).
2. Unzip `PhoneTouch_Complete.zip`. In the unzipped `PhoneTouch` folder, open Command Prompt (it needs [Git for Windows](https://git-scm.com/download/win)) and run:

   ```bat
   git init -b main
   git add -A
   git commit -m "PhoneTouch"
   git remote add origin https://github.com/YOUR-NAME/PhoneTouch.git
   git push -u origin main
   ```

   (Make sure the hidden `.github` folder is included — `git add -A` does that. Uploading through the website by drag-and-drop may skip hidden folders.)
3. On GitHub open the repository → **Actions** tab → **Build PhoneTouch APK** → **Run workflow** (the push in step 2 also starts it).
4. When the run finishes (about 5–10 minutes) open it and download the artifact **PhoneTouch-debug-apk**. It contains `app-debug.apk`.
   The workflow also runs the receiver tests and the Android unit tests; if they fail, the run is red and tells you which.
5. Copy the APK to the phone (USB, cloud drive, or email to yourself).

Other cloud options work too (any CI with JDK 17 and the Android SDK): the commands are in Option C.

## Option B — Android Studio

1. Install Android Studio (<https://developer.android.com/studio>).
2. **File → Open** and select the `PhoneTouch\android` folder. Let it sync (it downloads Gradle, the SDK platform 34 and the dependencies).
3. **Build → Build Bundle(s) / APK(s) → Build APK(s)**. Android Studio shows a "locate" link when it is done.

## Option C — Command line

Requires JDK 17 and the Android SDK (`ANDROID_HOME` set, platform 34 and build-tools installed, licenses accepted).

```bat
cd PhoneTouch\android
gradlew.bat testDebugUnitTest
gradlew.bat assembleDebug
```

(On macOS/Linux: `./gradlew ...`.)

**Expected** output location (standard for a debug build; not verified here): `android/app/build/outputs/apk/debug/app-debug.apk`.

## Installing the APK on the phone

1. Copy `app-debug.apk` to the phone and open it.
2. Android will ask to allow installing apps from that source (your file manager/browser): allow it **for this install**, then revoke it afterwards.
3. Open **PhoneTouch**. It starts in landscape.

A debug APK is signed with a throw-away debug key. That is fine for personal use; it is not suitable for publishing.

## Troubleshooting

| Problem | Fix |
|---|---|
| `SDK location not found` | Create `android/local.properties` with `sdk.dir=C\:\\Users\\YOU\\AppData\\Local\\Android\\Sdk` (Android Studio does this for you). |
| `Unsupported class file major version` / Java errors | Use JDK 17 (Android Studio's bundled JDK is fine). |
| `Could not resolve com.squareup.okhttp3:okhttp` | The machine cannot reach Maven Central/Google. Use a normal network or the cloud build. |
| License errors | `sdkmanager --licenses`, or build with Android Studio which prompts for them. |
| App installs but cannot connect | See `WINDOWS_SETUP.md` (firewall, Wi-Fi isolation). |

## What the app needs

Only the `INTERNET` permission. No camera, location or storage permissions. Cleartext traffic is disabled; the app talks to the receiver over TLS.
