# Task 2: App 的 Android 接入、设备探测与 probe 冒烟

**冒烟关卡**：Step 9 或 Step 10 失败时，记 blocker 并停止，不进入 Task 3。

**Files:**
- Modify: `app/android/app/build.gradle.kts`
- Create: `app/android/app/duix-rules.pro`
- Modify: `app/android/app/src/main/kotlin/com/anyidea/avatar_app/MainActivity.kt`
- Create: `app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/DuixChannels.kt`
- Create: `app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/DeviceGate.kt`
- Create: `app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/DuixDiag.kt`
- Create: `app/android/app/src/noduix/kotlin/com/anyidea/avatar_app/duix/DuixPlatform.kt`
- Create: `app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/DuixPlatform.kt`
- Create: `app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/DuixHost.kt`（这次只有 probe，Task 3、Task 5 扩展）
- Create: `app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/DeviceGateTest.kt`
- Create: `app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/DiagFormatTest.kt`
- Create: `app/lib/spike/duix_probe_spike.dart`
- Modify: `app/lib/main.dart`、`app/lib/config.dart`
- Create: `app/test/duix_probe_spike_test.dart`
- Modify: `docs/testing/2026-10-25-duix-smoke.md`

**Interfaces:**
- Consumes: Task 1 产出的 `app/android/app/libs/duix-sdk-release.aar`
- Produces:
  - `DuixChannels.METHODS / EVENTS / VIEW`；
  - `DeviceGate.reason(...)` 和 4 个 reason 常量；
  - `DiagFormat.line(event, fields)` 和 `DuixDiag.log(event, vararg fields)`；
  - `DuixPlatform.attach(activity, engine): Closeable`；
  - `DuixHost(activity: Activity, messenger: BinaryMessenger, views: PlatformViewRegistry)`。

- [x] **Step 1: 写失败的 Kotlin 测试**

`app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/DeviceGateTest.kt`：

```kotlin
package com.anyidea.avatar_app.duix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeviceGateTest {
    private val gb8 = 7_600L * 1024 * 1024

    @Test
    fun supportedPhonePasses() {
        assertNull(DeviceGate.reason(listOf("arm64-v8a", "armeabi-v7a"), gb8, 7000, libraryLoaded = true, storageReady = true))
    }

    @Test
    fun reasonsAreReportedInPriorityOrder() {
        assertEquals(DeviceGate.ABI_UNSUPPORTED, DeviceGate.reason(listOf("x86_64"), 0, 7000, libraryLoaded = false, storageReady = false))
        assertEquals(DeviceGate.LOW_MEMORY, DeviceGate.reason(listOf("arm64-v8a"), 6_000L * 1024 * 1024, 7000, libraryLoaded = false, storageReady = false))
        assertEquals(DeviceGate.LIBRARY_MISSING, DeviceGate.reason(listOf("arm64-v8a"), gb8, 7000, libraryLoaded = false, storageReady = false))
        assertEquals(DeviceGate.STORAGE_UNAVAILABLE, DeviceGate.reason(listOf("arm64-v8a"), gb8, 7000, libraryLoaded = true, storageReady = false))
    }

    @Test
    fun memoryThresholdIsInclusive() {
        assertNull(DeviceGate.reason(listOf("arm64-v8a"), 7000L * 1024 * 1024, 7000, libraryLoaded = true, storageReady = true))
    }
}
```

`app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/DiagFormatTest.kt`：

```kotlin
package com.anyidea.avatar_app.duix

import org.junit.Assert.assertEquals
import org.junit.Test

class DiagFormatTest {
    @Test
    fun formatsLikeTheDartDiagLine() {
        assertEquals(
            "anyidea.diag event=duix_probe supported=true reason=none",
            DiagFormat.line("duix_probe", listOf("supported" to true, "reason" to "none")),
        )
    }

    @Test
    fun replacesUnsafeValues() {
        assertEquals(
            "anyidea.diag event=x code=invalid",
            DiagFormat.line("x", listOf("code" to "has space and 中文")),
        )
    }
}
```

- [x] **Step 2: 接 Gradle，跑测试确认失败**

把 `app/android/app/build.gradle.kts` 改成下面这样（只新增 `duixAar` 两行、`sourceSets`、release 的 `proguardFiles` 和 `dependencies`，其余保持原样）：

```kotlin
plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Built by scripts/duix/build-sdk.sh. Without it the app compiles a stub that reports library_missing.
val duixAar = file("libs/duix-sdk-release.aar")
val duixAvailable = duixAar.exists()

android {
    namespace = "com.anyidea.avatar_app"
    // permission_handler_android 14.1.0 requires compileSdk >= 37 (flutter default is 36).
    compileSdk = 37
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.anyidea.avatar_app"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    sourceSets {
        getByName("main") {
            java.srcDir(if (duixAvailable) "src/duix/kotlin" else "src/noduix/kotlin")
        }
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
            proguardFiles("duix-rules.pro")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    if (duixAvailable) implementation(files(duixAar))
    testImplementation("junit:junit:4.13.2")
}
```

`app/android/app/duix-rules.pro`：

```proguard
# JNI entry points and the reflection-based model loader inside the Duix AAR.
-keep class ai.guiji.duix.DuixNcnn { *; }
-keep class ai.guiji.duix.sdk.client.loader.** { *; }
-keep class ai.guiji.duix.sdk.client.render.** { *; }
-keep class ai.guiji.duix.sdk.client.bean.** { *; }
```

仓库里没有 `app/android/gradlew` 和 `local.properties`，它们由 Flutter 生成且被忽略。先在 `app/` 下跑一次 `flutter build apk --config-only` 生成它们（2026-10-25 已在 Flutter 3.47.6 上验证可行），然后：

```bash
cd app/android && ./gradlew :app:testDebugUnitTest --tests 'com.anyidea.avatar_app.duix.*'
```

Expected：编译失败，报 `Unresolved reference: DeviceGate` 和 `DiagFormat`。

- [x] **Step 3: 写纯逻辑**

`app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/DuixChannels.kt`：

```kotlin
package com.anyidea.avatar_app.duix

/** Channel names shared with lib/duix/duix_bridge.dart. */
object DuixChannels {
    const val METHODS = "anyidea/duix"
    const val EVENTS = "anyidea/duix/events"
    const val VIEW = "anyidea/duix_view"
}
```

`app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/DeviceGate.kt`：

```kotlin
package com.anyidea.avatar_app.duix

/** Decides whether this phone and build can run the Duix renderer. */
object DeviceGate {
    const val ABI_UNSUPPORTED = "abi_unsupported"
    const val LOW_MEMORY = "low_memory"
    const val LIBRARY_MISSING = "library_missing"
    const val STORAGE_UNAVAILABLE = "storage_unavailable"

    /** Null means supported; otherwise the first failing reason. */
    fun reason(
        abis: List<String>,
        totalMemBytes: Long,
        minTotalMemMb: Int,
        libraryLoaded: Boolean,
        storageReady: Boolean,
    ): String? = when {
        "arm64-v8a" !in abis -> ABI_UNSUPPORTED
        totalMemBytes < minTotalMemMb.toLong() * 1024L * 1024L -> LOW_MEMORY
        !libraryLoaded -> LIBRARY_MISSING
        !storageReady -> STORAGE_UNAVAILABLE
        else -> null
    }
}
```

`app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/DuixDiag.kt`：

```kotlin
package com.anyidea.avatar_app.duix

import android.util.Log

/** Same shape as the Dart formatDiag line; values that are not short tokens print as `invalid`. */
object DiagFormat {
    private val safe = Regex("^[A-Za-z0-9_.:-]{1,64}$")

    fun line(event: String, fields: List<Pair<String, Any>>): String = buildString {
        append("anyidea.diag event=").append(event)
        for ((key, value) in fields) {
            val text = value.toString()
            append(' ').append(key).append('=').append(if (safe.matches(text)) text else "invalid")
        }
    }
}

/** Content-free logcat diagnostics: `adb logcat -s anyidea.diag:I`. */
object DuixDiag {
    fun log(event: String, vararg fields: Pair<String, Any>) {
        Log.i("anyidea.diag", DiagFormat.line(event, fields.toList()))
    }
}
```

- [x] **Step 4: 写两个 `DuixPlatform` 和最小的 `DuixHost`**

`app/android/app/src/noduix/kotlin/com/anyidea/avatar_app/duix/DuixPlatform.kt`：

```kotlin
package com.anyidea.avatar_app.duix

import android.app.Activity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.Closeable

/** Build without the Duix AAR: probe says the library is missing and every other call fails. */
object DuixPlatform {
    @Suppress("UNUSED_PARAMETER")
    fun attach(activity: Activity, engine: FlutterEngine): Closeable {
        val channel = MethodChannel(engine.dartExecutor.binaryMessenger, DuixChannels.METHODS)
        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "probe" -> result.success(mapOf("supported" to false, "reason" to DeviceGate.LIBRARY_MISSING))
                "installStatus" -> result.success(emptyMap<String, Boolean>())
                else -> result.error(DeviceGate.LIBRARY_MISSING, null, null)
            }
        }
        return Closeable { channel.setMethodCallHandler(null) }
    }
}
```

`app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/DuixPlatform.kt`：

```kotlin
package com.anyidea.avatar_app.duix

import android.app.Activity
import io.flutter.embedding.engine.FlutterEngine
import java.io.Closeable

/** Build with the Duix AAR. */
object DuixPlatform {
    fun attach(activity: Activity, engine: FlutterEngine): Closeable =
        DuixHost(activity, engine.dartExecutor.binaryMessenger, engine.platformViewsController.registry)
}
```

`app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/DuixHost.kt`（Task 5 会整体替换成完整版）：

```kotlin
package com.anyidea.avatar_app.duix

import android.app.Activity
import android.app.ActivityManager
import android.os.Build
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.platform.PlatformViewRegistry
import java.io.Closeable

/** Owns the Duix channels for one Flutter engine. */
class DuixHost(
    private val activity: Activity,
    messenger: BinaryMessenger,
    @Suppress("unused") private val views: PlatformViewRegistry,
) : MethodChannel.MethodCallHandler, Closeable {
    private val methods = MethodChannel(messenger, DuixChannels.METHODS)

    init {
        methods.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "probe" -> result.success(probe(call.argument<Int>("minTotalMemMb") ?: Int.MAX_VALUE))
            else -> result.notImplemented()
        }
    }

    private fun probe(minTotalMemMb: Int): Map<String, Any?> {
        val memory = ActivityManager.MemoryInfo()
        activity.getSystemService(ActivityManager::class.java).getMemoryInfo(memory)
        val reason = DeviceGate.reason(
            abis = Build.SUPPORTED_ABIS.toList(),
            totalMemBytes = memory.totalMem,
            minTotalMemMb = minTotalMemMb,
            libraryLoaded = libraryLoaded(),
            storageReady = activity.getExternalFilesDir("duix") != null,
        )
        DuixDiag.log("duix_probe", "supported" to (reason == null), "reason" to (reason ?: "none"))
        return mapOf("supported" to (reason == null), "reason" to reason)
    }

    override fun close() {
        methods.setMethodCallHandler(null)
    }

    private fun libraryLoaded(): Boolean = try {
        System.loadLibrary("gjduix")
        true
    } catch (e: UnsatisfiedLinkError) {
        false
    }
}
```

`app/android/app/src/main/kotlin/com/anyidea/avatar_app/MainActivity.kt`：

```kotlin
package com.anyidea.avatar_app

import com.anyidea.avatar_app.duix.DuixPlatform
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import java.io.Closeable

class MainActivity : FlutterActivity() {
    private var duix: Closeable? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        duix = DuixPlatform.attach(this, flutterEngine)
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        duix?.close()
        duix = null
        super.cleanUpFlutterEngine(flutterEngine)
    }
}
```

- [x] **Step 5: 跑 Kotlin 测试确认通过**

```bash
cd app/android && ./gradlew :app:testDebugUnitTest --tests 'com.anyidea.avatar_app.duix.*'
```

Expected：`BUILD SUCCESSFUL`，5 个测试通过。测试报告在 `app/build/app/test-results/testDebugUnitTest/`（项目把构建目录改到了 `app/build`），XML 里 `failures="0"`。

- [x] **Step 6: 写 spike 页面的失败测试**

`app/test/duix_probe_spike_test.dart`：

```dart
import 'package:avatar_app/spike/duix_probe_spike.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const channel = MethodChannel('anyidea/duix');

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
  });

  testWidgets('shows the probe result', (tester) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      expect(call.method, 'probe');
      expect(call.arguments, {'minTotalMemMb': 7000});
      return {'supported': true, 'reason': null};
    });
    await tester.pumpWidget(const MaterialApp(home: DuixProbeSpikePage()));
    await tester.pumpAndSettle();
    expect(find.text('supported=true reason=none'), findsOneWidget);
  });

  testWidgets('shows a platform error code', (tester) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      throw PlatformException(code: 'library_missing');
    });
    await tester.pumpWidget(const MaterialApp(home: DuixProbeSpikePage()));
    await tester.pumpAndSettle();
    expect(find.text('error=library_missing'), findsOneWidget);
  });
}
```

```bash
cd app && flutter test test/duix_probe_spike_test.dart
```

Expected：FAIL，报 `duix_probe_spike.dart` 不存在。

- [x] **Step 7: 写 spike 页面并接入 main**

`app/lib/spike/duix_probe_spike.dart`：

```dart
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// SPIKE=duix_probe: shows whether this build and phone can run the Duix renderer.
class DuixProbeSpikePage extends StatefulWidget {
  const DuixProbeSpikePage({super.key});

  @override
  State<DuixProbeSpikePage> createState() => _DuixProbeSpikePageState();
}

class _DuixProbeSpikePageState extends State<DuixProbeSpikePage> {
  static const _channel = MethodChannel('anyidea/duix');
  String _result = '检测中…';

  @override
  void initState() {
    super.initState();
    _probe();
  }

  Future<void> _probe() async {
    String text;
    try {
      final r = await _channel.invokeMapMethod<String, Object?>('probe', {'minTotalMemMb': 7000});
      text = 'supported=${r?['supported']} reason=${r?['reason'] ?? 'none'}';
    } on PlatformException catch (e) {
      text = 'error=${e.code}';
    } on MissingPluginException {
      text = 'error=missing_plugin';
    }
    if (mounted) setState(() => _result = text);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(child: Text(_result, style: const TextStyle(fontSize: 22))),
  );
}
```

`app/lib/main.dart`：在 import 区加 `import 'spike/duix_probe_spike.dart';`，并在 `switch (AppConfig.spike)` 里 `'secure_storage'` 那一行下面加：

```dart
        'duix_probe' => const DuixProbeSpikePage(),
```

`app/lib/config.dart`：把 `spike` 的注释改为：

```dart
  /// 'native_audio' | 'secure_storage' | 'duix_probe' opens a spike page instead of the app.
```

- [x] **Step 8: 跑 Dart 测试**

```bash
cd app && flutter test test/duix_probe_spike_test.dart && flutter test && flutter analyze
```

Expected：spike 的 2 个测试通过；全量 `flutter test` 全部通过（数量 = 改动前 + 2）；`flutter analyze` 没有新增问题。

- [x] **Step 9: 编译冒烟（关卡 A1：AGP 9.1 引用本地 AAR）**

```bash
cd app && flutter build apk --debug --dart-define-from-file=dev.json --dart-define=SPIKE=duix_probe
unzip -l build/app/outputs/flutter-apk/app-debug.apk | grep -E 'lib/arm64-v8a/(libgjduix|libonnxruntime)\.so'
```

Expected：构建成功，`grep` 输出两行。

如果报 `More than one file was found with OS independent path 'lib/arm64-v8a/libc++_shared.so'`，就在 `android { }` 里加下面这段再重试，并在冒烟记录里写明：

```kotlin
    packaging {
        jniLibs {
            pickFirsts += "lib/*/libc++_shared.so"
        }
    }
```

再确认没有 AAR 时也能编：先把 AAR 挪开，编完挪回：

```bash
mv android/app/libs/duix-sdk-release.aar /tmp/duix-sdk-release.aar.bak
flutter build apk --debug --dart-define-from-file=dev.json && (cd android && ./gradlew :app:testDebugUnitTest)
mv /tmp/duix-sdk-release.aar.bak android/app/libs/duix-sdk-release.aar
```

Expected：两条命令都成功（这时编的是 noduix 的 stub）。

- [x] **Step 10: 真机 probe**

```bash
cd app && flutter build apk --debug --dart-define-from-file=dev.json --dart-define=SPIKE=duix_probe
adb install -r build/app/outputs/flutter-apk/app-debug.apk
adb logcat -c && adb shell am start -n com.anyidea.avatar_app/.MainActivity
sleep 3 && adb logcat -d -s anyidea.diag:I | tail -5
```

Expected：
- 手机屏幕显示 `supported=true reason=none`；
- logcat 有 `anyidea.diag event=duix_probe supported=true reason=none`；
- 没有 `UnsatisfiedLinkError`。

然后装回正常的 App（不带 SPIKE），确认 3D 模式能照常打开并对话：

```bash
flutter build apk --debug --dart-define-from-file=dev.json && adb install -r build/app/outputs/flutter-apk/app-debug.apk
```

请用户确认 3D 照常可用。

- [x] **Step 11: 更新冒烟记录并提交**

在 `docs/testing/2026-10-25-duix-smoke.md` 的「Task 2」段写入：两次编译结果（有 AAR 和无 AAR）、是否需要 `pickFirsts`、APK 里的 `.so` 列表、probe 屏幕和日志原文、用户对 3D 的确认。

```bash
git add app/android/app/build.gradle.kts app/android/app/duix-rules.pro \
  app/android/app/src/main/kotlin/com/anyidea/avatar_app/MainActivity.kt \
  app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/DuixChannels.kt \
  app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/DeviceGate.kt \
  app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/DuixDiag.kt \
  app/android/app/src/noduix/kotlin/com/anyidea/avatar_app/duix/DuixPlatform.kt \
  app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/DuixPlatform.kt \
  app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/DuixHost.kt \
  app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/DeviceGateTest.kt \
  app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/DiagFormatTest.kt \
  app/lib/spike/duix_probe_spike.dart app/lib/main.dart app/lib/config.dart \
  app/test/duix_probe_spike_test.dart docs/testing/2026-10-25-duix-smoke.md
git commit -m "feat(duix): wire the Duix AAR into the app and probe device support

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
